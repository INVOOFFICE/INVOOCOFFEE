// ===================== DATA =====================
const STORAGE_KEY = 'cafeShop_articles';
const FACTURES_KEY = 'cafeShop_factures';
const SETTINGS_KEY = 'cafeShop_settings';
const OPFS_NAME = 'coffeeshop-backup.json';
const Z_SESSION_KEY = 'coffeeshop_z_session';
const LAST_BACKUP_KEY = 'coffeeshop_last_backup';
const CAISSE_LOCK_KEY = 'coffeeshop_lock';
const BACKUP_VERSION = 2;
const ACCESS_MODE_KEY = 'coffe_access_mode';
const FACTURES_COLD_AFTER_MONTHS = 6;
const NEXT_FACTURE_NUM_KEY = 'coffeeshop_next_facture_num';

const DEFAULT_CATEGORIES = ['Boissons chaudes', 'Boissons froides', 'Viennoiseries', 'Sandwichs', 'Snacks', 'Autre'];
const myTabId = 't' + Math.random().toString(36).slice(2) + Date.now().toString(36);

/** Dernière facture affichée (aperçu) — utilisée pour « Imprimer » */
let lastFactureForPrint = null;
let histoTableFilter = '';

// Cache mémoire des factures (récentes + archivées) pour éviter de dépendre uniquement
// de localStorage (qui peut saturer) tout en gardant l'historique complet.
// -> localStorage ne contient que les factures récentes.
let facturesAll = null;
let opfsWriteQueue = Promise.resolve();
let opfsWritesInFlight = 0;
let _cachedSettings = null;

let _nextFactureNumMem = null;

// UI : message de succès affiché une seule fois après restauration OPFS.
let opfsRestoreSucceeded = false;
let opfsRestoreUiShown = false;

function safeLocalGetItem(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeLocalSetItem(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function notifyLocalStorageUnavailableOnce(msg) {
  try {
    const k = 'coffe_notif_localstorage_unavailable';
    if (safeLocalGetItem(k) === '1') return;
    safeLocalSetItem(k, '1');
  } catch {
    /* ignore */
  }
  try {
    if (typeof showNotif === 'function') showNotif(msg, 'error');
  } catch {
    /* ignore */
  }
}

function recomputeNextFactureNumFromList(list) {
  const arr = Array.isArray(list) ? list : [];
  let maxNum = 0;
  for (const f of arr) {
    const n = Number(f && f.num);
    if (Number.isFinite(n) && n > maxNum) maxNum = n;
  }
  const next = maxNum + 1;
  _nextFactureNumMem = next;
  safeLocalSetItem(NEXT_FACTURE_NUM_KEY, String(next));
}

function getNextFactureNum() {
  if (_nextFactureNumMem !== null) {
    const current = _nextFactureNumMem;
    _nextFactureNumMem = current + 1;
    // si localStorage est disponible, on synchronise aussi
    safeLocalSetItem(NEXT_FACTURE_NUM_KEY, String(_nextFactureNumMem));
    return current;
  }

  let next = parseInt(safeLocalGetItem(NEXT_FACTURE_NUM_KEY) || '', 10);
  if (!Number.isFinite(next) || next < 1) {
    recomputeNextFactureNumFromList(loadFactures());
    next = _nextFactureNumMem;
  }

  const current = next;
  _nextFactureNumMem = current + 1;
  safeLocalSetItem(NEXT_FACTURE_NUM_KEY, String(_nextFactureNumMem));
  return current;
}

const COFFEE_ICONS = [
  '☕','🫖','🍵','🧋','🥤','🧃','🍊','🍋','🥛','💧','🧊','🍰','🧁','🥐','🥖','🍞','🥨','🧇','🥞','🧈','🥯','🍳','🥚','🥓','🍔','🍟','🌭','🥪','🌮','🌯','🥗','🍝','🍜','🍲','🍛','🍱','🍣','🍤','🍙','🍚','🍨','🍦','🍫','🍪','🍩','🥜','🍯','🍇','🍓','🫐','🍌','🥝','🍎','🍐','🫒','🥒','🥕','🌽','🫑','🥦','🍄','🫘','🧄','🧅','🥔','🫛','🍕','🫔','🥟','🥠','🥡','🍿','🧂','🍷','🍺','🍻','🥂','🥃','🍸','🫗','🍼','🍴','🥄','🍽️','🫖','🫙'
];

function defaultSettings() {
  return {
    nomCafe: 'Café Manager',
    adresse: '',
    tel: '',
    email: '',
    nbTables: '',
    messageTicket: 'Merci de votre visite !',
    serveurs: [],
    categories: null,
    supabaseSyncEnabled: false,
    supabaseUrl: '',
    supabaseAnonKey: '',
    supabaseLastRemoteUpdatedAt: '',
    supabaseLastPushedHash: '',
    supabaseDailySyncEnabled: false,
    supabaseDailySyncTime: '03:00'
  };
}

function loadSettings() {
  if (_cachedSettings) return { ..._cachedSettings };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) {
      _cachedSettings = defaultSettings();
      return { ..._cachedSettings };
    }
    _cachedSettings = { ...defaultSettings(), ...JSON.parse(raw) };
    return { ..._cachedSettings };
  } catch {
    _cachedSettings = defaultSettings();
    return { ..._cachedSettings };
  }
}

function saveSettings(s) {
  _cachedSettings = null;
  const ok = safeLocalSetItem(SETTINGS_KEY, JSON.stringify(s));
  if (!ok) {
    notifyLocalStorageUnavailableOnce('Stockage indisponible — données non sauvegardées');
  }
  syncToOpfs({ settingsOverride: s });
}

function migrateArticle(a) {
  const x = { ...a };
  if (x.stock === 999 || x.stockIllimite) {
    x.stockIllimite = true;
    x.stock = typeof x.stock === 'number' && x.stock !== 999 ? x.stock : 0;
  } else {
    x.stockIllimite = false;
    x.stock = x.stock ?? 0;
  }
  if (x.prixAchat != null && x.prixAchat !== '') x.prixAchat = Number(x.prixAchat);
  else x.prixAchat = null;
  if (typeof x.stockSeuil !== 'number' || Number.isNaN(x.stockSeuil)) x.stockSeuil = 5;
  return x;
}

function migrateFacture(f) {
  return {
    ...f,
    statut: f.statut || 'valide',
    modePaiement: f.modePaiement || 'especes',
    table: f.table != null ? String(f.table) : '',
    motifAnnulation: f.motifAnnulation || '',
    factureLieeId: f.factureLieeId || '',
    annuleLe: f.annuleLe || ''
  };
}

function getStockCategories() {
  const s = loadSettings();
  if (Array.isArray(s.categories) && s.categories.length) return s.categories.map(String).filter(Boolean);
  return [...DEFAULT_CATEGORIES];
}

function refreshCategorySelects() {
  const sel = document.getElementById('fCat');
  if (!sel) return;
  const cur = sel.value;
  const cats = getStockCategories();
  sel.innerHTML = cats.map((c) => `<option value="${escapeAttr(c)}">${escapeHtml(c)}</option>`).join('');
  if (cats.includes(cur)) sel.value = cur;
  syncCustomSelect('fCat');
}

function articleSeuil(a) {
  if (typeof a.stockSeuil === 'number' && a.stockSeuil < 0) return null;
  return typeof a.stockSeuil === 'number' ? a.stockSeuil : 5;
}

function isStockLow(a) {
  if (isUnlimited(a)) return false;
  const seuil = articleSeuil(a);
  if (seuil == null) return false;
  return a.stock <= seuil;
}

function factureCompteCA(f) {
  if (!f || f.statut === 'annulee') return 0;
  return Number(f.total) || 0;
}

function factureCompteStats(f) {
  return f && f.statut !== 'annulee';
}

function loadArticles() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (!Array.isArray(raw) || raw.length === 0) return getDefaultArticles();
    return raw.filter((x) => x && typeof x === 'object').map(migrateArticle);
  } catch {
    return getDefaultArticles();
  }
}

function saveArticles(arr) {
  const ok = safeLocalSetItem(STORAGE_KEY, JSON.stringify(arr));
  if (!ok) {
    notifyLocalStorageUnavailableOnce('Stockage indisponible — données non sauvegardées');
  }
  syncToOpfs({ articlesOverride: arr });
}

function loadFactures() {
  try {
    if (facturesAll) return facturesAll;
    const arr = JSON.parse(localStorage.getItem(FACTURES_KEY) || '[]');
    if (!Array.isArray(arr)) return [];
    return arr.filter((x) => x && typeof x === 'object').map(migrateFacture);
  } catch {
    return [];
  }
}

function saveFactures(arr) {
  // Conserver uniquement les factures récentes dans localStorage.
  const all = (Array.isArray(arr) ? arr : [])
    .filter((x) => x && typeof x === 'object')
    .map(migrateFacture);
  facturesAll = all;

  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - FACTURES_COLD_AFTER_MONTHS);

  const recent = [];
  for (const f of all) {
    const d = new Date(f.date);
    // Si date invalide : considérer comme récente pour ne pas perdre des données.
    if (!(d instanceof Date) || isNaN(d.getTime()) || d.getTime() >= cutoff.getTime()) recent.push(f);
  }

  const ok = safeLocalSetItem(FACTURES_KEY, JSON.stringify(recent));
  if (!ok) {
    notifyLocalStorageUnavailableOnce('Stockage indisponible — données non sauvegardées');
  }
  syncToOpfs({ facturesOverride: all });
}

function isUnlimited(a) {
  return !!(a && (a.stockIllimite || a.stock === 999));
}

function stockDisplay(a) {
  if (isUnlimited(a)) return '∞';
  return a.stock;
}

function getDefaultArticles() {
  const row = (nom, emoji, cat, prix, stock) => ({
    id: uid(),
    nom,
    emoji,
    cat,
    prix,
    stock,
    vendu: 0,
    stockIllimite: false,
    prixAchat: null,
    stockSeuil: 5
  });
  return [
    row('Espresso', '☕', 'Boissons chaudes', 12, 100),
    row('Café au lait', '☕', 'Boissons chaudes', 15, 100),
    row('Cappuccino', '☕', 'Boissons chaudes', 18, 100),
    row('Jus d\'orange', '🍊', 'Boissons froides', 20, 50),
    row('Eau minérale', '💧', 'Boissons froides', 8, 200),
    row('Croissant', '🥐', 'Viennoiseries', 10, 30),
    row('Pain au chocolat', '🍫', 'Viennoiseries', 12, 30),
    row('Sandwich Thon', '🥖', 'Sandwichs', 25, 20)
  ];
}

function uid() {
  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    return window.crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 8);
}

function getFullSnapshot(overrides = {}) {
  const articlesSnap =
    overrides.articlesOverride !== undefined
      ? overrides.articlesOverride
      : (() => {
          const raw = safeLocalGetItem(STORAGE_KEY) || '[]';
          try {
            return JSON.parse(raw);
          } catch {
            return [];
          }
        })();

  const facturesSnap =
    overrides.facturesOverride !== undefined
      ? overrides.facturesOverride
      : facturesAll
        ? facturesAll
        : (() => {
            const raw = safeLocalGetItem(FACTURES_KEY) || '[]';
            try {
              return JSON.parse(raw);
            } catch {
              return [];
            }
          })();

  const settingsSnap =
    overrides.settingsOverride !== undefined ? overrides.settingsOverride : loadSettings();

  const zSessionSnap = (() => {
    if (overrides.zSessionOverride !== undefined) return overrides.zSessionOverride;
    const raw = safeLocalGetItem(Z_SESSION_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  })();

  const lastBackupAtSnap =
    overrides.lastBackupAtOverride !== undefined ? overrides.lastBackupAtOverride : safeLocalGetItem(LAST_BACKUP_KEY) || '';

  return {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    articles: articlesSnap,
    factures: facturesSnap,
    settings: settingsSnap,
    zSession: zSessionSnap,
    lastBackupAt: lastBackupAtSnap
  };
}

function syncToOpfs(overrides = {}) {
  if (!navigator.storage?.getDirectory) return Promise.resolve(false);
  opfsWriteQueue = opfsWriteQueue
    .catch(() => {})
    .then(async () => {
      opfsWritesInFlight += 1;
      try {
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle(OPFS_NAME, { create: true });
        const w = await fh.createWritable();
        await w.write(JSON.stringify(getFullSnapshot(overrides)));
        await w.close();
        return true;
      } catch (e) {
        console.warn('OPFS sync', e);
        return false;
      } finally {
        opfsWritesInFlight = Math.max(0, opfsWritesInFlight - 1);
      }
    });
  return opfsWriteQueue;
}

/**
 * Restaure automatiquement depuis OPFS si localStorage est vide.
 * Objectif : éviter le "repart de zéro" si localStorage est nettoyé/corrompu.
 */
async function restoreFromOpfsOnStartup() {
  try {
    if (!navigator.storage?.getDirectory) return false;

    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle(OPFS_NAME);
    if (!fh) return false;

    const file = await fh.getFile();
    const text = await file.text();
    if (!text) return false;

    const snap = JSON.parse(text);
    if (!snap || typeof snap !== 'object') return false;

    const localHasArticles = !!safeLocalGetItem(STORAGE_KEY);
    const localHasFactures = !!safeLocalGetItem(FACTURES_KEY);

    // 1) Factures : on charge tout (récent + archive) dans la mémoire,
    // puis on ne garde que le récent en localStorage.
    if (snap.factures && Array.isArray(snap.factures)) {
      const opfsAll = snap.factures
        .filter((x) => x && typeof x === 'object')
        .map(migrateFacture);

      // Fusion par id avec localStorage (au cas où localStorage contient des entrées plus récentes que le dernier snapshot OPFS).
      let localRecent = [];
      if (localHasFactures) {
        try {
          const rawLocal = safeLocalGetItem(FACTURES_KEY) || '[]';
          const arr = JSON.parse(rawLocal);
          if (Array.isArray(arr)) localRecent = arr.filter((x) => x && typeof x === 'object').map(migrateFacture);
        } catch {
          localRecent = [];
        }
      }

      const byId = new Map();
      for (const f of opfsAll) byId.set(String(f.id), f);
      for (const f of localRecent) byId.set(String(f.id), f);
      facturesAll = Array.from(byId.values());

      // Met à jour le compteur de numéros de facture (évite les doublons sur double-clic rapide).
      recomputeNextFactureNumFromList(facturesAll);

      // Trim localStorage (garde uniquement les récentes)
      const cutoff = new Date();
      cutoff.setMonth(cutoff.getMonth() - FACTURES_COLD_AFTER_MONTHS);
      const recent = [];
      for (const f of facturesAll) {
        const d = new Date(f.date);
        if (!(d instanceof Date) || isNaN(d.getTime()) || d.getTime() >= cutoff.getTime()) recent.push(f);
      }
      // En mode Safari privé, localStorage peut être en écriture impossible :
      // on garde au moins facturesAll en mémoire.
      safeLocalSetItem(FACTURES_KEY, JSON.stringify(recent));
    }

    // 2) Articles / settings : seulement si localStorage est vide.
    if ((!localHasArticles || !localHasFactures) && snap.articles && Array.isArray(snap.articles) && !localHasArticles) {
      const restoredArticles = snap.articles.map(migrateArticle);
      // Essaye d'écrire localStorage, sinon restaure en mémoire
      safeLocalSetItem(STORAGE_KEY, JSON.stringify(restoredArticles));
      articles = restoredArticles;
    }
    if (snap.settings && typeof snap.settings === 'object') {
      // si localStorage est vide/cassé, on restaure les settings aussi
      if (!localHasArticles && !localHasFactures) {
        const merged = { ...defaultSettings(), ...snap.settings };
        // Ne pas planter si localStorage est inaccessible
        _cachedSettings = merged;
        safeLocalSetItem(SETTINGS_KEY, JSON.stringify(merged));
      }
    }
    if (snap.zSession !== undefined) {
      try {
        if (snap.zSession === null) localStorage.removeItem(Z_SESSION_KEY);
        else safeLocalSetItem(Z_SESSION_KEY, JSON.stringify(snap.zSession));
      } catch {
        /* ignore */
      }
    }
    if (typeof snap.lastBackupAt === 'string' && snap.lastBackupAt) {
      safeLocalSetItem(LAST_BACKUP_KEY, snap.lastBackupAt);
    }

    // Met à jour l’UI plus tard (l’INIT continue après await).
    await syncToOpfs();
    return true;
  } catch (e) {
    // Pas bloquant : on continue avec l'état localStorage (qui est peut-être vide mais correct).
    console.warn('OPFS restore', e);
    return false;
  }
}

async function refreshStorageUi() {
  const status = document.getElementById('opfsStatusLine');
  const quota = document.getElementById('quotaLine');
  if (!status) return;
  const opfsOk = !!(navigator.storage && navigator.storage.getDirectory);
  if (opfsOk) {
    status.innerHTML = '<strong>OPFS actif</strong> — données illimitées côté fichier ; copie miroir automatique.';
  } else {
    status.innerHTML = '<strong>Stockage localStorage</strong> — OPFS indisponible (ouvrez en HTTPS ou localhost).';
  }

  const opfsRestoreSuccessLine = document.getElementById('opfsRestoreSuccessLine');
  if (opfsRestoreSuccessLine) {
    const shouldShow = opfsRestoreSucceeded && !opfsRestoreUiShown;
    opfsRestoreSuccessLine.hidden = !shouldShow;
    if (shouldShow) opfsRestoreUiShown = true;
  }
  quota.textContent = 'Calcul en cours…';
  try {
    if (navigator.storage?.estimate) {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      const u = (usage / 1024 / 1024).toFixed(2);
      if (quota && quota < 1e12) {
        const q = (quota / 1024 / 1024).toFixed(1);
        quota.textContent = `Espace estimé : ${u} Mo utilisés / ${q} Mo quota navigateur`;
      } else {
        quota.textContent = `Espace estimé : ${u} Mo utilisés (quota très large ou illimité)`;
      }
    } else {
      quota.textContent = '';
    }
  } catch {
    quota.textContent = '';
  }
}

function buildIconPicker() {
  const el = document.getElementById('iconPicker');
  if (!el) return;
  const cur = (document.getElementById('fEmoji').value || '☕').trim();
  el.innerHTML = COFFEE_ICONS.map((ic, i) =>
    `<button type="button" class="icon-pick ${ic === cur ? 'selected' : ''}" data-icon-pick-index="${i}" aria-label="Icône">${escapeHtml(ic)}</button>`
  ).join('');
}

function pickIconAt(i) {
  const ic = COFFEE_ICONS[i];
  if (!ic) return;
  document.getElementById('fEmoji').value = ic;
  buildIconPicker();
}

function toggleStockField() {
  const ill = document.getElementById('fStockIllimite').checked;
  document.getElementById('fStock').disabled = ill;
}

// ===================== MENUS DÉROULANTS (liste HTML — pas de popup native grise Windows) =====================
let customSelectGlobalsBound = false;

function closeAllCustomSelects() {
  document.querySelectorAll('.custom-select.is-open').forEach((root) => {
    root.classList.remove('is-open');
    const btn = root.querySelector('.custom-select__trigger');
    const list = root.querySelector('.custom-select__list');
    if (btn) btn.setAttribute('aria-expanded', 'false');
    if (list) {
      list.hidden = true;
      list.style.cssText = '';
    }
  });
}

function positionCustomSelectList(root) {
  const btn = root.querySelector('.custom-select__trigger');
  const list = root.querySelector('.custom-select__list');
  if (!btn || !list || list.hidden) return;
  const r = btn.getBoundingClientRect();
  list.style.position = 'fixed';
  list.style.left = `${Math.round(r.left)}px`;
  list.style.top = `${Math.round(r.bottom + 4)}px`;
  list.style.width = `${Math.round(r.width)}px`;
  list.style.zIndex = '500';
  requestAnimationFrame(() => {
    const lr = list.getBoundingClientRect();
    if (lr.bottom > window.innerHeight - 12) {
      list.style.top = `${Math.round(r.top - lr.height - 4)}px`;
    }
    if (lr.right > window.innerWidth - 8) {
      list.style.left = `${Math.max(8, window.innerWidth - lr.width - 8)}px`;
    }
  });
}

function openCustomSelect(root) {
  closeAllCustomSelects();
  root.classList.add('is-open');
  const btn = root.querySelector('.custom-select__trigger');
  const list = root.querySelector('.custom-select__list');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  if (list) list.hidden = false;
  positionCustomSelectList(root);
}

function toggleCustomSelect(root) {
  if (root.classList.contains('is-open')) closeAllCustomSelects();
  else openCustomSelect(root);
}

function refreshCustomSelectLabel(root) {
  const sel = root.querySelector('select');
  const valEl = root.querySelector('.custom-select__value');
  if (!sel || !valEl) return;
  const opt = sel.options[sel.selectedIndex];
  valEl.textContent = opt ? opt.textContent : '';
}

function refreshCustomSelectOptions(root) {
  const sel = root.querySelector('select');
  const list = root.querySelector('.custom-select__list');
  if (!sel || !list) return;
  list.innerHTML = '';
  for (let i = 0; i < sel.options.length; i++) {
    const o = sel.options[i];
    const li = document.createElement('li');
    li.setAttribute('role', 'option');
    li.className = 'custom-select__option';
    li.dataset.value = o.value;
    li.textContent = o.textContent;
    li.setAttribute('aria-selected', o.selected ? 'true' : 'false');
    if (o.selected) li.classList.add('is-selected');
    li.addEventListener('mousedown', (e) => e.preventDefault());
    li.addEventListener('click', (e) => {
      e.stopPropagation();
      sel.value = o.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      Array.from(list.children).forEach((c) => {
        const on = c === li;
        c.classList.toggle('is-selected', on);
        c.setAttribute('aria-selected', on ? 'true' : 'false');
      });
      refreshCustomSelectLabel(root);
      closeAllCustomSelects();
    });
    list.appendChild(li);
  }
}

function bindCustomSelectGlobals() {
  if (customSelectGlobalsBound) return;
  customSelectGlobalsBound = true;
  document.addEventListener('click', () => closeAllCustomSelects());
  window.addEventListener('resize', () => {
    document.querySelectorAll('.custom-select.is-open').forEach((r) => positionCustomSelectList(r));
  });
  window.addEventListener('scroll', () => closeAllCustomSelects(), true);
}

function ensureCustomSelect(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel || sel.tagName !== 'SELECT') return;

  bindCustomSelectGlobals();

  let root = sel.closest('.custom-select');
  if (!root) {
    root = document.createElement('div');
    root.className = 'custom-select';
    sel.parentNode.insertBefore(root, sel);
    root.appendChild(sel);

    const triggerId = `${selectId}_csTrigger`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'custom-select__trigger';
    btn.id = triggerId;
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    const span = document.createElement('span');
    span.className = 'custom-select__value';
    btn.appendChild(span);
    const caret = document.createElement('span');
    caret.className = 'custom-select__caret';
    caret.textContent = '▾';
    caret.setAttribute('aria-hidden', 'true');
    btn.appendChild(caret);

    const ul = document.createElement('ul');
    ul.className = 'custom-select__list';
    ul.setAttribute('role', 'listbox');
    ul.hidden = true;

    root.insertBefore(btn, sel);
    root.insertBefore(ul, sel);

    sel.classList.add('select-native-hidden');
    sel.setAttribute('aria-hidden', 'true');
    sel.setAttribute('tabindex', '-1');

    const lab = document.querySelector(`label[for="${selectId}"]`);
    if (lab) lab.setAttribute('for', triggerId);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      toggleCustomSelect(root);
    });
    btn.addEventListener('keydown', (e) => {
      const k = e.key;
      if (k === 'Escape') {
        if (root.classList.contains('is-open')) {
          e.preventDefault();
          closeAllCustomSelects();
        }
        return;
      }
      if (k === 'Enter' || k === ' ') {
        e.preventDefault();
        toggleCustomSelect(root);
        return;
      }
      if (k !== 'ArrowDown' && k !== 'ArrowUp') return;
      e.preventDefault();
      const dir = k === 'ArrowDown' ? 1 : -1;
      const idx = Math.max(0, sel.selectedIndex);
      const next = Math.max(0, Math.min(sel.options.length - 1, idx + dir));
      if (next !== idx) {
        sel.selectedIndex = next;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        refreshCustomSelectLabel(root);
        refreshCustomSelectOptions(root);
      }
      if (!root.classList.contains('is-open')) openCustomSelect(root);
    });
  }

  refreshCustomSelectOptions(root);
  refreshCustomSelectLabel(root);
}

function syncCustomSelect(selectId) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const root = sel.closest('.custom-select');
  if (root) {
    if (root.classList.contains('is-open')) closeAllCustomSelects();
    refreshCustomSelectOptions(root);
    refreshCustomSelectLabel(root);
  } else {
    ensureCustomSelect(selectId);
  }
}

function renderServeurSelect() {
  const sel = document.getElementById('serveurSelect');
  if (!sel) return;
  const s = loadSettings();
  const list = (s.serveurs || []).filter(x => (x.prenom || '').trim());
  sel.innerHTML = '<option value="">— Serveur (optionnel) —</option>' +
    list.map(x => `<option value="${escapeAttr(x.prenom)}">${escapeHtml(x.prenom)}</option>`).join('');
  syncCustomSelect('serveurSelect');
}

function renderTableSelectForCaisse() {
  const sel = document.getElementById('tableSelect');
  if (!sel) return;
  const s = loadSettings();
  const n = parseInt(String(s.nbTables || '').trim(), 10) || 0;
  let html = '<option value="">— Sans table —</option>';
  if (n > 0) {
    for (let i = 1; i <= n; i++) html += `<option value="${i}">Table ${i}</option>`;
  }
  sel.innerHTML = html;
  syncCustomSelect('tableSelect');
}

function populateHistoTableFilter() {
  const sel = document.getElementById('histoTableFilter');
  if (!sel) return;
  const keep = histoTableFilter;
  const s = loadSettings();
  const n = parseInt(String(s.nbTables || '').trim(), 10) || 0;
  const seen = new Set();
  let html = '<option value="">Toutes les tables</option>';
  if (n > 0) {
    for (let i = 1; i <= n; i++) {
      const v = String(i);
      seen.add(v);
      html += `<option value="${v}">Table ${i}</option>`;
    }
  }
  loadFactures().forEach((f) => {
    const t = (f.table || '').trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    html += `<option value="${escapeAttr(t)}">${escapeHtml(t)}</option>`;
  });
  html += '<option value="__vide__">Sans table</option>';
  sel.innerHTML = html;
  if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
  else {
    sel.value = '';
    histoTableFilter = '';
  }
  syncCustomSelect('histoTableFilter');
}

function setHistoTableFilter(v) {
  histoTableFilter = v;
  renderHistorique();
}

function applyHistoriqueTableFilter(filtered) {
  if (histoTableFilter === '__vide__') return filtered.filter((f) => !(f.table || '').trim());
  if (histoTableFilter) return filtered.filter((f) => String(f.table || '') === histoTableFilter);
  return filtered;
}

// ===================== Z DE CAISSE =====================
function loadZSession() {
  try {
    return JSON.parse(localStorage.getItem(Z_SESSION_KEY) || 'null');
  } catch {
    return null;
  }
}

function saveZSession(obj) {
  if (obj == null) localStorage.removeItem(Z_SESSION_KEY);
  else {
    const ok = safeLocalSetItem(Z_SESSION_KEY, JSON.stringify(obj));
    if (!ok) notifyLocalStorageUnavailableOnce('Stockage indisponible — données non sauvegardées');
  }
  updateZHeader();
  renderZPanel();
  syncToOpfs();
}

function dayBoundsFromKey(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  const start = new Date(y, m - 1, d, 0, 0, 0, 0);
  const end = new Date(y, m - 1, d, 23, 59, 59, 999);
  return { start, end };
}

function getVentesEspecesForDay(dayKey) {
  const { start, end } = dayBoundsFromKey(dayKey);
  return loadFactures().reduce((s, f) => {
    if (!factureInRange(f, start, end)) return s;
    if ((f.modePaiement || 'especes') !== 'especes') return s;
    return s + factureCompteCA(f);
  }, 0);
}

function updateZHeader() {
  const el = document.getElementById('zHeaderStatus');
  if (!el) return;
  const z = loadZSession();
  if (z && z.state === 'open') {
    el.textContent = '● Caisse ouverte';
    el.classList.add('z-open');
  } else {
    el.textContent = '';
    el.classList.remove('z-open');
  }
}

function renderZPanel() {
  const desc = document.getElementById('zSessionDesc');
  const fondInp = document.getElementById('zFondOuverture');
  const closePanel = document.getElementById('zCloturePanel');
  if (!desc) return;
  const z = loadZSession();
  if (closePanel) closePanel.hidden = true;
  if (fondInp && (!z || z.state !== 'open')) fondInp.disabled = false;

  if (!z || z.state === 'closed') {
    desc.textContent = z && z.fermeLe
      ? `Dernière clôture : ${new Date(z.fermeLe).toLocaleString('fr-FR')} — jour ${z.jour} · Théorique ${Number(z.theorique).toFixed(2)} MAD · Compté ${Number(z.montantCompte).toFixed(2)} · Écart ${Number(z.ecart).toFixed(2)} MAD`
      : 'Aucune session ouverte. Indiquez le fond de caisse puis ouvrez.';
    return;
  }

  if (z.state === 'open') {
    const ventes = getVentesEspecesForDay(z.jour);
    const theorProv = Number(z.fondOuverture) + ventes;
    desc.textContent = `Session ouverte (${z.jour}) — fond ${Number(z.fondOuverture).toFixed(2)} MAD · espèces encaissées ce jour : ${ventes.toFixed(2)} MAD · caisse théorique actuelle : ${theorProv.toFixed(2)} MAD`;
    if (fondInp) fondInp.disabled = true;
  }
}

function ouvrirCaisseZ() {
  const z = loadZSession();
  if (z && z.state === 'open') {
    showNotif('La caisse est déjà ouverte — clôturez d’abord', 'error');
    return;
  }
  const fond = parseFloat(String(document.getElementById('zFondOuverture').value || '0'));
  if (Number.isNaN(fond) || fond < 0) {
    showNotif('Fond d’ouverture invalide', 'error');
    return;
  }
  const jour = localDateKey(new Date());
  saveZSession({
    state: 'open',
    jour,
    fondOuverture: fond,
    ouvertLe: new Date().toISOString()
  });
  showNotif('Caisse ouverte', 'success');
}

function cloturerCaisseZ() {
  const z = loadZSession();
  if (!z || z.state !== 'open') {
    showNotif('Aucune session ouverte', 'error');
    return;
  }
  const ventes = getVentesEspecesForDay(z.jour);
  const theorique = Number(z.fondOuverture) + ventes;
  const panel = document.getElementById('zCloturePanel');
  const line = document.getElementById('zTheoriqueLine');
  const compteInp = document.getElementById('zMontantCompte');
  if (panel) panel.hidden = false;
  if (line) {
    line.textContent = `Fond ${Number(z.fondOuverture).toFixed(2)} + espèces du ${z.jour} (${ventes.toFixed(2)}) = théorique ${theorique.toFixed(2)} MAD`;
  }
  if (compteInp) compteInp.value = '';
}

function validerClotureZ() {
  const z = loadZSession();
  if (!z || z.state !== 'open') {
    showNotif('Aucune session ouverte', 'error');
    return;
  }
  const ventes = getVentesEspecesForDay(z.jour);
  const theorique = Number(z.fondOuverture) + ventes;
  const compte = parseFloat(String(document.getElementById('zMontantCompte').value || ''), 10);
  if (Number.isNaN(compte) || compte < 0) {
    showNotif('Montant compté invalide', 'error');
    return;
  }
  const ecart = compte - theorique;
  saveZSession({
    state: 'closed',
    jour: z.jour,
    fondOuverture: z.fondOuverture,
    ouvertLe: z.ouvertLe,
    fermeLe: new Date().toISOString(),
    montantCompte: compte,
    theorique,
    ecart,
    ventesEspeces: ventes
  });
  const panel = document.getElementById('zCloturePanel');
  if (panel) panel.hidden = true;
  const fondInp = document.getElementById('zFondOuverture');
  if (fondInp) fondInp.disabled = false;
  showNotif(`Clôture enregistrée — écart ${ecart.toFixed(2)} MAD`, 'success');
}

function exportZJourPdf() {
  const z = loadZSession();
  const todayKey = localDateKey(new Date());
  let jour = todayKey;
  let fond = 0;
  let ventes = getVentesEspecesForDay(todayKey);
  let theorique = fond + ventes;
  let montantCompte = null;
  let ecart = null;
  let titre = `Z du jour — ${todayKey}`;

  if (z && z.state === 'open') {
    jour = z.jour;
    fond = Number(z.fondOuverture);
    ventes = getVentesEspecesForDay(z.jour);
    theorique = fond + ventes;
    titre = `Z — session ouverte (${z.jour})`;
  } else if (z && z.state === 'closed') {
    jour = z.jour;
    fond = Number(z.fondOuverture);
    ventes = Number(z.ventesEspeces);
    theorique = Number(z.theorique);
    montantCompte = Number(z.montantCompte);
    ecart = Number(z.ecart);
    titre = `Z clôturée — ${z.jour}`;
  }

  const cfg = loadSettings();
  const esc = escapeTicketHtml;
  const rows = `
<tr><td>Jour</td><td style="text-align:right">${esc(jour)}</td></tr>
<tr><td>Fond ouverture</td><td style="text-align:right">${fond.toFixed(2)} MAD</td></tr>
<tr><td>Encaissements espèces (CA net jour)</td><td style="text-align:right">${ventes.toFixed(2)} MAD</td></tr>
<tr><td><strong>Caisse théorique</strong></td><td style="text-align:right"><strong>${theorique.toFixed(2)} MAD</strong></td></tr>
${montantCompte != null && !Number.isNaN(montantCompte) ? `<tr><td>Montant compté</td><td style="text-align:right">${montantCompte.toFixed(2)} MAD</td></tr>` : ''}
${ecart != null && !Number.isNaN(ecart) ? `<tr><td>Écart</td><td style="text-align:right">${ecart.toFixed(2)} MAD</td></tr>` : ''}
`;

  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Z caisse</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;font-size:11pt;color:#111;margin:16mm}
h1{font-size:15pt} .sub{color:#555;font-size:10pt;margin-bottom:12px}
table{width:100%;border-collapse:collapse;margin:12px 0}
th,td{border-bottom:1px solid #ddd;padding:8px;text-align:left}
@media print{body{margin:12mm}}
</style></head><body>
<h1>${esc(titre)}</h1>
<div class="sub">${esc(cfg.nomCafe || 'Café')} · généré ${new Date().toLocaleString('fr-FR')}</div>
<table><tbody>${rows}</tbody></table>
<p style="font-size:9pt;color:#666">Enregistrez au format PDF depuis la boîte d’impression.</p>
<script>setTimeout(function(){window.focus();window.print();},400)<\/script>
</body></html>`;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('title', 'Z PDF');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  doc.open();
  doc.write(html);
  doc.close();
  const cleanup = () => {
    try {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    } catch (e) { /* ignore */ }
  };
  win.addEventListener('afterprint', cleanup);
  setTimeout(cleanup, 120000);
  showNotif('Impression Z : choisissez « Enregistrer au format PDF »', 'success');
}

function updateBackupReminder() {
  const el = document.getElementById('backupReminderLine');
  if (!el) return;
  const raw = safeLocalGetItem(LAST_BACKUP_KEY);
  if (!raw) {
    el.textContent = 'Aucune exportation complète enregistrée — pensez à télécharger un JSON de sauvegarde.';
    return;
  }
  const days = Math.floor((Date.now() - new Date(raw).getTime()) / 86400000);
  let recentCount = 0;
  let archivedCount = 0;
  if (Array.isArray(facturesAll)) {
    // facturesAll contient tout (récentes + archivées).
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - FACTURES_COLD_AFTER_MONTHS);
    const cutoffMs = cutoff.getTime();
    for (const f of facturesAll) {
      if (!f || !f.date) continue;
      const d = new Date(f.date);
      if (!(d instanceof Date) || isNaN(d.getTime())) continue;
      if (d.getTime() >= cutoffMs) recentCount++;
      else archivedCount++;
    }
  } else {
    // Fallback : on ne connait pas l'archivé si facturesAll n'est pas en mémoire.
    try {
      const recent = loadFactures();
      if (Array.isArray(recent)) recentCount = recent.length;
    } catch {
      /* ignore */
    }
  }

  if (days <= 0) el.textContent = 'Dernière sauvegarde complète : aujourd’hui.';
  else if (days === 1) el.textContent = 'Dernière sauvegarde complète : il y a 1 jour.';
  else el.textContent = `Dernière sauvegarde complète : il y a ${days} jours — un nouvel export est recommandé.`;
  el.textContent += ` · Récentes : ${recentCount} · Archivées : ${archivedCount}`;
}

const LOCK_HEARTBEAT_MS = 4000;

function startCaisseLockHeartbeat() {
  const applyWarn = (other) => {
    const warn = document.getElementById('multiTabWarn');
    if (!warn) return;
    warn.hidden = !other;
  };
  const beat = () => {
    try {
      const raw = localStorage.getItem(CAISSE_LOCK_KEY);
      let o = raw ? JSON.parse(raw) : null;
      const now = Date.now();
      if (!o || now - (o.t || 0) > LOCK_HEARTBEAT_MS * 2) {
        safeLocalSetItem(CAISSE_LOCK_KEY, JSON.stringify({ id: myTabId, t: now }));
        applyWarn(false);
      } else if (o.id !== myTabId) {
        applyWarn(true);
      } else {
        safeLocalSetItem(CAISSE_LOCK_KEY, JSON.stringify({ id: myTabId, t: now }));
        applyWarn(false);
      }
    } catch (e) {
      /* ignore */
    }
  };
  beat();
  setInterval(beat, LOCK_HEARTBEAT_MS);
  window.addEventListener('storage', (e) => {
    if (e.key === CAISSE_LOCK_KEY) beat();
  });
  window.addEventListener('beforeunload', (e) => {
    try {
      const raw = localStorage.getItem(CAISSE_LOCK_KEY);
      const o = raw ? JSON.parse(raw) : null;
      if (o && o.id === myTabId) localStorage.removeItem(CAISSE_LOCK_KEY);
    } catch (e) {
      /* ignore */
    }
    // Si une écriture OPFS est en cours, demander confirmation avant fermeture.
    if (opfsWritesInFlight > 0) {
      e.preventDefault();
      e.returnValue = 'Sauvegarde en cours. Voulez-vous vraiment quitter ?';
    }
  });
}

function escapeHtml(t) {
  const d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}
function escapeAttr(t) {
  return String(t).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
}

/** Emoji / picto affiché en HTML : évite XSS si le champ article contient du HTML. */
function escapeEmojiDisplay(t) {
  const s = String(t || '').trim().slice(0, 24);
  if (!s) return '☕';
  return escapeHtml(s);
}

function applyHeaderBranding() {
  const s = loadSettings();
  const name = (s.nomCafe || 'Caisse').trim();
  const el = document.getElementById('headerLogoName');
  if (el) el.textContent = name;
}

let articles = loadArticles();
let panier = [];
let currentCat = 'Tous';
let editMode = false;
const RUSH_MODE_KEY = 'coffeeshop_rush';
let modalPreviousFocus = null;
let modalDialogPending = null;
let stockSearchDebounceTimer = null;

function isRushMode() {
  return localStorage.getItem(RUSH_MODE_KEY) === '1';
}

function toggleRushModeFromUi() {
  const el = document.getElementById('rushModeCheck');
  const on = !!(el && el.checked);
  const ok = safeLocalSetItem(RUSH_MODE_KEY, on ? '1' : '0');
  if (!ok) notifyLocalStorageUnavailableOnce('Stockage indisponible — données non sauvegardées');
  renderArticles();
}

function syncRushCheckbox() {
  const el = document.getElementById('rushModeCheck');
  if (el) el.checked = isRushMode();
}

function setCaisseMobilePane(pane) {
  const root = document.getElementById('caisseRoot');
  if (!root) return;
  root.classList.remove('caisse-pane-active-articles', 'caisse-pane-active-panier');
  root.classList.add(pane === 'panier' ? 'caisse-pane-active-panier' : 'caisse-pane-active-articles');
  const t1 = document.getElementById('caisseTabArticles');
  const t2 = document.getElementById('caisseTabPanier');
  if (t1) {
    t1.classList.toggle('active', pane !== 'panier');
    t1.setAttribute('aria-selected', pane !== 'panier' ? 'true' : 'false');
  }
  if (t2) {
    t2.classList.toggle('active', pane === 'panier');
    t2.setAttribute('aria-selected', pane === 'panier' ? 'true' : 'false');
  }
}

function updateCaissePanierBadge() {
  const badge = document.getElementById('caissePanierBadge');
  if (!badge) return;
  const n = panier.reduce((s, p) => s + p.qty, 0);
  if (n > 0) {
    badge.textContent = String(n);
    badge.hidden = false;
  } else {
    badge.hidden = true;
  }
}

// ===================== CAISSE =====================
function getCategoriesFilterList() {
  const fromArticles = [...new Set(articles.map((a) => a.cat).filter(Boolean))];
  const fromSettings = getStockCategories();
  const merged = [...new Set([...fromSettings, ...fromArticles])];
  return ['Tous', ...merged];
}

function renderCatFilter() {
  const div = document.getElementById('catFilter');
  div.innerHTML = getCategoriesFilterList().map((c) =>
    `<button type="button" class="cat-btn ${c === currentCat ? 'active' : ''}" data-filter-cat="${escapeAttr(c)}">${escapeHtml(c)}</button>`
  ).join('');
}

function filterCat(cat) {
  currentCat = cat;
  renderCatFilter();
  renderArticles();
}

function bindUiClickDelegates() {
  if (document.body.dataset.uiDelegatesBound) return;
  document.body.dataset.uiDelegatesBound = '1';

  const catFilter = document.getElementById('catFilter');
  if (catFilter) {
    catFilter.addEventListener('click', (e) => {
      const b = e.target.closest('[data-filter-cat]');
      if (!b) return;
      filterCat(b.getAttribute('data-filter-cat'));
    });
  }

  // Débouncer la recherche stock : éviter de reconstruire tout le tableau à chaque frappe.
  const stockSearch = document.getElementById('stockSearch');
  if (stockSearch) {
    stockSearch.addEventListener('input', () => {
      clearTimeout(stockSearchDebounceTimer);
      stockSearchDebounceTimer = setTimeout(() => {
        renderStock();
      }, 180);
    });
  }

  const articlesGrid = document.getElementById('articlesGrid');
  if (articlesGrid) {
    articlesGrid.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-art-id]');
      if (!btn || btn.disabled) return;
      ajouterAuPanier(btn.getAttribute('data-art-id'));
    });
  }

  const stockBody = document.getElementById('stockBody');
  if (stockBody) {
    stockBody.addEventListener('click', (e) => {
      const ed = e.target.closest('[data-stock-edit]');
      if (ed) {
        editArticle(ed.getAttribute('data-stock-edit'));
        return;
      }
      const del = e.target.closest('[data-stock-del]');
      if (del) supprimerArticle(del.getAttribute('data-stock-del'));
    });
  }

  const serveursList = document.getElementById('serveursList');
  if (serveursList) {
    serveursList.addEventListener('click', (e) => {
      const rm = e.target.closest('[data-remove-sid]');
      if (!rm) return;
      removeServeurRow(rm.getAttribute('data-remove-sid'));
    });
  }

  const facturesList = document.getElementById('facturesList');
  if (facturesList) {
    facturesList.addEventListener('click', (e) => {
      const hdr = e.target.closest('.fc-header');
      if (hdr && !e.target.closest('button')) {
        const id = hdr.getAttribute('data-fc-toggle');
        if (id != null && id !== '') toggleFacture(id);
        return;
      }
      const ticket = e.target.closest('[data-facture-ticket]');
      if (ticket) {
        e.stopPropagation();
        openTicketById(ticket.getAttribute('data-facture-ticket'));
        return;
      }
      const ann = e.target.closest('[data-facture-annuler]');
      if (ann) {
        e.stopPropagation();
        annulerFacture(ann.getAttribute('data-facture-annuler'));
        return;
      }
      const av = e.target.closest('[data-facture-avoir]');
      if (av) {
        e.stopPropagation();
        creerAvoir(av.getAttribute('data-facture-avoir'));
      }
    });
    facturesList.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const hdr = e.target.closest('.fc-header');
      if (!hdr || e.target.closest('button')) return;
      e.preventDefault();
      const id = hdr.getAttribute('data-fc-toggle');
      if (id != null && id !== '') toggleFacture(id);
    });
  }

  const panierItems = document.getElementById('panierItems');
  if (panierItems) {
    panierItems.addEventListener('click', (e) => {
      const dec = e.target.closest('[data-panier-dec]');
      if (dec) {
        changeQty(parseInt(dec.getAttribute('data-panier-dec'), 10), -1);
        return;
      }
      const inc = e.target.closest('[data-panier-inc]');
      if (inc) {
        changeQty(parseInt(inc.getAttribute('data-panier-inc'), 10), 1);
        return;
      }
      const rm = e.target.closest('[data-panier-rm]');
      if (rm) removeFromPanier(parseInt(rm.getAttribute('data-panier-rm'), 10));
    });
  }

  const iconPicker = document.getElementById('iconPicker');
  if (iconPicker) {
    iconPicker.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-icon-pick-index]');
      if (!btn) return;
      const i = parseInt(btn.getAttribute('data-icon-pick-index'), 10);
      if (!Number.isNaN(i)) pickIconAt(i);
    });
  }
}

function renderArticles() {
  const grid = document.getElementById('articlesGrid');
  if (!grid) return;
  if (!articles.length) {
    grid.className = 'articles-grid';
    grid.innerHTML = `<div class="empty-state caisse-empty-articles">
      <div class="empty-state-title">Aucun article en caisse</div>
      <p class="empty-state-text">Ajoutez des articles dans l’onglet <strong>Stock</strong> pour commencer à encaisser.</p>
    </div>`;
    return;
  }
  const filtered = currentCat === 'Tous' ? articles : articles.filter((a) => a.cat === currentCat);
  const rush = isRushMode();
  grid.className = 'articles-grid' + (rush ? ' articles-grid--rush' : '');
  if (!filtered.length) {
    grid.innerHTML =
      '<div class="empty-state"><p class="empty-state-text">Aucun article dans cette catégorie. Choisissez une autre catégorie ou ajoutez des articles dans <strong>Stock</strong>.</p></div>';
    return;
  }
  if (rush) {
    grid.innerHTML = filtered
      .map((a) => {
        const unl = isUnlimited(a);
        const oos = !unl && a.stock <= 0;
        const low = isStockLow(a);
        return `
      <button type="button" class="article-row ${oos ? 'out-of-stock' : ''}" data-art-id="${escapeAttr(a.id)}" ${oos ? 'disabled' : ''}>
        ${low ? '<span class="stock-badge">Faible</span>' : ''}
        <span class="ar-emoji">${escapeEmojiDisplay(a.emoji)}</span>
        <span class="ar-name">${escapeHtml(a.nom)}</span>
        <span class="ar-price">${a.prix.toFixed(2)} MAD</span>
        <span class="ar-stock">Stock ${stockDisplay(a)}</span>
      </button>`;
      })
      .join('');
    return;
  }
  grid.innerHTML = filtered
    .map((a) => {
      const unl = isUnlimited(a);
      const oos = !unl && a.stock <= 0;
      const low = isStockLow(a);
      return `
      <button type="button" class="article-btn ${oos ? 'out-of-stock' : ''}" data-art-id="${escapeAttr(a.id)}" ${oos ? 'disabled' : ''}>
        ${low ? '<span class="stock-badge">Faible</span>' : ''}
        <span class="art-emoji">${escapeEmojiDisplay(a.emoji)}</span>
        <span class="art-name">${escapeHtml(a.nom)}</span>
        <span class="art-price">${a.prix.toFixed(2)} MAD</span>
        <span class="art-stock">Stock: ${stockDisplay(a)}</span>
      </button>`;
    })
    .join('');
}

function ajouterAuPanier(id) {
  const art = articles.find(a => String(a.id) === String(id));
  if (!art || (!isUnlimited(art) && art.stock <= 0)) return;
  const existing = panier.find(p => String(p.id) === String(art.id));
  if (existing) {
    if (!isUnlimited(art) && existing.qty >= art.stock) { showNotif('Stock insuffisant!', 'error'); return; }
    existing.qty++;
  } else {
    panier.push({ id: art.id, nom: art.nom, prix: art.prix, qty: 1, emoji: art.emoji });
  }
  renderPanier();
  showNotif(`${art.emoji} ${art.nom} ajouté`, 'success');
}

function renderPanier() {
  const div = document.getElementById('panierItems');
  const num = document.getElementById('panierId');
  num.textContent = `#${new Date().toLocaleDateString('fr')}`;

  if (!panier.length) {
    div.innerHTML = `<div class="panier-empty"><span class="empty-icon">🛒</span>Panier vide<br><span class="panier-empty-hint">Revenez sur <strong>Articles</strong> pour ajouter des produits.</span></div>`;
    document.getElementById('btnFacturer').disabled = true;
    document.getElementById('grandTotal').textContent = '0.00 MAD';
    updateCaissePanierBadge();
    return;
  }

  div.innerHTML = panier.map((p, i) => `
    <div class="panier-item">
      <span>${escapeEmojiDisplay(p.emoji)}</span>
      <span class="pi-name">${escapeHtml(p.nom)}</span>
      <div class="pi-controls">
        <button type="button" class="qty-btn" aria-label="Diminuer ${escapeAttr(p.nom)}" data-panier-dec="${i}">−</button>
        <span class="pi-qty">${p.qty}</span>
        <button type="button" class="qty-btn" aria-label="Augmenter ${escapeAttr(p.nom)}" data-panier-inc="${i}">+</button>
      </div>
      <span class="pi-total">${(p.prix * p.qty).toFixed(2)}</span>
      <button type="button" class="pi-del" aria-label="Retirer ${escapeAttr(p.nom)}" data-panier-rm="${i}">✕</button>
    </div>
  `).join('');

  const total = panier.reduce((s, p) => s + p.prix * p.qty, 0);
  document.getElementById('grandTotal').textContent = total.toFixed(2) + ' MAD';
  document.getElementById('btnFacturer').disabled = false;
  updateCaissePanierBadge();
}

function changeQty(idx, delta) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= panier.length) return;
  const line = panier[idx];
  const art = articles.find(a => String(a.id) === String(line.id));
  const maxQ = art && isUnlimited(art) ? 9999 : (art ? art.stock : 9999);
  panier[idx].qty = Math.max(1, Math.min(panier[idx].qty + delta, maxQ));
  renderPanier();
}

function removeFromPanier(idx) {
  if (!Number.isInteger(idx) || idx < 0 || idx >= panier.length) return;
  panier.splice(idx, 1);
  renderPanier();
}

function viderPanier() {
  panier = [];
  renderPanier();
}

function facturer() {
  if (!panier.length) return;
  const total = panier.reduce((s, p) => s + p.prix * p.qty, 0);
  const client = document.getElementById('clientName').value.trim() || 'Client';
  const factures = loadFactures();
  const num = getNextFactureNum();
  const date = new Date();

  const serveur = (document.getElementById('serveurSelect') && document.getElementById('serveurSelect').value) || '';
  const tableEl = document.getElementById('tableSelect');
  const table = tableEl ? tableEl.value.trim() : '';
  const payEl = document.getElementById('payModeSelect');
  const modePaiement = payEl ? payEl.value : 'especes';

  const facture = {
    id: uid(),
    num,
    client,
    serveur,
    table,
    modePaiement,
    statut: 'valide',
    date: date.toISOString(),
    items: panier.map((p) => ({ ...p })),
    total,
    motifAnnulation: '',
    factureLieeId: '',
    annuleLe: ''
  };

  // Décrémenter le stock
  panier.forEach(p => {
    const art = articles.find(a => String(a.id) === String(p.id));
    if (art && !isUnlimited(art)) {
      art.stock = Math.max(0, art.stock - p.qty);
      art.vendu = (art.vendu || 0) + p.qty;
    }
  });
  saveArticles(articles);

  factures.push(facture);
  saveFactures(factures);

  afficherFactureModal(facture);
  panier = [];
  renderPanier();
  renderArticles();
  document.getElementById('clientName').value = '';
  const tbl = document.getElementById('tableSelect');
  if (tbl) tbl.value = '';
  const pay = document.getElementById('payModeSelect');
  if (pay) pay.value = 'especes';
  showNotif('✓ Facture créée #' + String(num).padStart(4, '0') + ' avec succès', 'success');
}

function restoreStockFromItems(items) {
  (items || []).forEach((p) => {
    const art = articles.find((a) => String(a.id) === String(p.id));
    const q = Math.abs(p.qty);
    if (art && !isUnlimited(art)) {
      art.stock += q;
      art.vendu = Math.max(0, (art.vendu || 0) - q);
    }
  });
}

async function annulerFacture(factureId) {
  const factures = loadFactures();
  const f = factures.find((x) => String(x.id) === String(factureId));
  if (!f || f.statut !== 'valide') {
    showNotif('Seules les ventes valides peuvent être annulées', 'error');
    return;
  }
  const motif = await showModalPromptText({
    title: 'Motif d\'annulation',
    label: 'Motif',
    placeholder: 'Ex: erreur de caisse, remboursement…',
    confirmText: 'Confirmer',
    cancelText: 'Annuler'
  });
  if (motif === null) return;
  f.statut = 'annulee';
  f.motifAnnulation = motif.trim() || 'Annulé';
  f.annuleLe = new Date().toISOString();
  restoreStockFromItems(f.items);
  saveArticles(articles);
  saveFactures(factures);
  renderHistorique();
  renderArticles();
  renderStock();
  showNotif('Vente annulée — stock réintégré', 'success');
}

async function creerAvoir(factureId) {
  const factures = loadFactures();
  const f = factures.find((x) => String(x.id) === String(factureId));
  if (!f || f.statut !== 'valide') {
    showNotif('Avoir possible uniquement sur une vente valide', 'error');
    return;
  }
  const motif = await showModalPromptText({
    title: 'Motif de l\'avoir',
    label: 'Motif',
    placeholder: 'Ex: échange, retour client, remboursement…',
    confirmText: 'Confirmer',
    cancelText: 'Annuler'
  });
  if (motif === null) return;
  const motifTxt = motif.trim() || 'Avoir';
  const items = (f.items || []).map((p) => ({ ...p, qty: -Math.abs(p.qty) }));
  const total = items.reduce((s, p) => s + Number(p.prix) * p.qty, 0);
  const avoir = {
    id: uid(),
    num: getNextFactureNum(),
    client: f.client,
    serveur: f.serveur || '',
    table: f.table || '',
    modePaiement: f.modePaiement || 'especes',
    statut: 'avoir',
    date: new Date().toISOString(),
    items,
    total,
    motifAnnulation: motifTxt,
    factureLieeId: f.id,
    annuleLe: ''
  };
  restoreStockFromItems(f.items);
  saveArticles(articles);
  factures.push(avoir);
  saveFactures(factures);
  renderHistorique();
  renderArticles();
  renderStock();
  afficherFactureModal(avoir);
  showNotif('Avoir enregistré', 'success');
}

function escapeTicketHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * HTML du ticket seul (aperçu ou impression). Noms / textes échappés pour éviter coupures et injections.
 */
function buildTicketWrapHtml(f) {
  if (!f || !f.items) return '';
  const date = new Date(f.date);
  const dateStr = date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const timeStr = date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const numStr = String(f.num).padStart(4, '0');
  const cfg = loadSettings();
  const esc = escapeTicketHtml;
  const shopName = esc(cfg.nomCafe || 'Café');
  const shopSub = esc([cfg.adresse, cfg.tel].filter(Boolean).join(' · ') || ' ');
  const footerMsg = esc(cfg.messageTicket || 'Merci de votre visite !').replace(/\n/g, '<br>');
  const barcode = String(f.id).toUpperCase().replace(/[^A-Z0-9]/g, '').substring(0, 16).padEnd(16, '0');
  const st = f.statut || 'valide';
  const docType = st === 'avoir' ? 'Avoir / remboursement' : st === 'annulee' ? 'Ticket annulé' : 'Ticket de caisse';
  const payLbl = { especes: 'Espèces', carte: 'Carte', autre: 'Autre' }[f.modePaiement] || 'Espèces';

  const lines = f.items.map((p) => {
    const nom = esc(p.nom || '');
    return `
          <div class="t-item">
            <div class="t-item-left">
              <div class="t-item-name">${nom}</div>
              <div class="t-item-sub">${p.qty} × ${Number(p.prix).toFixed(2)} MAD</div>
            </div>
            <div class="t-item-price">${(Number(p.prix) * p.qty).toFixed(2)}</div>
          </div>`;
  }).join('');

  const extraMeta =
    (f.table ? `<div class="t-meta-row"><span class="t-meta-k">Table</span> <span class="t-meta-v">${esc(f.table)}</span></div>` : '') +
    `<div class="t-meta-row"><span class="t-meta-k">Paiement</span> <span class="t-meta-v">${esc(payLbl)}</span></div>` +
    (st === 'annulee' && f.motifAnnulation ? `<div class="t-meta-row"><span class="t-meta-k">Motif</span> <span class="t-meta-v">${esc(f.motifAnnulation)}</span></div>` : '') +
    (st === 'avoir' && f.motifAnnulation ? `<div class="t-meta-row"><span class="t-meta-k">Motif</span> <span class="t-meta-v">${esc(f.motifAnnulation)}</span></div>` : '');

  return `
    <div class="ticket-wrap ticket-pro">
      <div class="t-doc-type">${esc(docType)}</div>
      <div class="t-shop-name">${shopName}</div>
      <div class="t-shop-sub">${shopSub}</div>
      <hr class="t-divider">
      <div class="t-meta">
        <div class="t-meta-row"><span class="t-meta-k">N°</span> <span class="t-meta-v">${numStr}</span></div>
        <div class="t-meta-row"><span class="t-meta-k">Date</span> <span class="t-meta-v">${dateStr} ${timeStr}</span></div>
        <div class="t-meta-row"><span class="t-meta-k">Client</span> <span class="t-meta-v">${esc(f.client)}</span></div>
        ${f.serveur ? `<div class="t-meta-row"><span class="t-meta-k">Serveur</span> <span class="t-meta-v">${esc(f.serveur)}</span></div>` : ''}
        ${extraMeta}
      </div>
      <hr class="t-divider">
      <div class="t-items-head">
        <span>Désignation</span>
        <span class="t-items-head-price">Montant</span>
      </div>
      <div class="t-items">${lines}
      </div>
      <hr class="t-divider">
      <div class="t-total-block">
        <div class="t-total-row"><span>Articles (unités)</span><span>${f.items.reduce((s, p) => s + p.qty, 0)}</span></div>
        <div class="t-total-grand"><span>TOTAL TTC</span><span>${Number(f.total).toFixed(2)} MAD</span></div>
      </div>
      <hr class="t-divider">
      <div class="t-merci">${footerMsg}</div>
      <div class="t-ref">Réf. ${barcode}</div>
    </div>`;
}

/** Styles autonomes pour l’iframe d’impression (thermique ~80 mm, sans dépendre du CSS de l’app) */
function getTicketPrintDocumentCss() {
  return `
@page { margin: 3mm; size: auto; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
*, *::before, *::after { box-sizing: border-box; }
body {
  margin: 0;
  padding: 0;
  background: #fff !important;
  color: #111 !important;
  font-family: "Segoe UI", system-ui, -apple-system, sans-serif;
  font-size: 10px;
  line-height: 1.45;
  width: 72mm;
  max-width: 100%;
}
.ticket-wrap {
  background: #fff;
  padding: 8px 6px 10px;
  position: relative;
  word-wrap: break-word;
  overflow-wrap: break-word;
  border-top: 2px solid #000;
  border-bottom: 1px solid #ccc;
}
.t-doc-type {
  text-align: center;
  font-size: 8px;
  font-weight: 600;
  letter-spacing: 0.14em;
  text-transform: uppercase;
  color: #666;
  margin-bottom: 6px;
}
.t-shop-name {
  text-align: center;
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  margin-bottom: 4px;
  color: #000;
}
.t-shop-sub { text-align: center; font-size: 9px; color: #444; line-height: 1.4; margin-bottom: 8px; }
.t-divider { border: none; border-top: 1px solid #ccc; margin: 8px 0; }
.t-meta { font-size: 9px; color: #222; }
.t-meta-row { display: flex; justify-content: space-between; gap: 8px; padding: 2px 0; border-bottom: 1px solid #eee; }
.t-meta-row:last-child { border-bottom: none; }
.t-meta-k { color: #555; font-weight: 600; flex: 0 0 auto; }
.t-meta-v { text-align: right; flex: 1; word-break: break-word; }
.t-items-head {
  display: flex;
  justify-content: space-between;
  font-size: 8px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #333;
  padding: 4px 0 6px;
  border-bottom: 1px solid #000;
}
.t-items-head-price { text-align: right; }
.t-items { margin: 0 0 4px; }
.t-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 6px;
  font-size: 10px;
  padding: 4px 0;
  border-bottom: 1px solid #eee;
  page-break-inside: avoid;
}
.t-item:last-child { border-bottom: none; }
.t-item-left { flex: 1; min-width: 0; }
.t-item-name { font-weight: 600; }
.t-item-sub { font-size: 9px; color: #666; }
.t-item-price { font-weight: 700; white-space: nowrap; }
.t-total-row { display: flex; justify-content: space-between; font-size: 9px; color: #444; padding: 2px 0; }
.t-total-grand {
  display: flex; justify-content: space-between; font-size: 12px; font-weight: 700;
  padding: 6px 0 2px; margin-top: 4px; border-top: 2px solid #000;
}
.t-merci { text-align: center; font-size: 9px; color: #444; margin-top: 8px; line-height: 1.4; }
.t-ref { text-align: center; font-size: 8px; color: #888; margin-top: 8px; letter-spacing: 0.04em; font-family: ui-monospace, Consolas, monospace; }
`;
}

/**
 * Impression fiable : document dédié dans une iframe (évite page blanche, barre d’outils, mauvaise largeur).
 * Dans la boîte d’impression, choisir l’imprimante ticket / 80 mm si disponible.
 */
function printReceipt() {
  const f = lastFactureForPrint;
  if (!f) {
    showNotif('Aucun ticket à imprimer', 'error');
    return;
  }
  const bodyInner = buildTicketWrapHtml(f);
  if (!bodyInner) return;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('title', 'Impression ticket');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none';
  document.body.appendChild(iframe);

  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  const css = getTicketPrintDocumentCss();
  doc.open();
  doc.write(`<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Ticket</title><style>${css}</style></head><body>${bodyInner}</body></html>`);
  doc.close();

  const cleanup = () => {
    try {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    } catch (e) { /* ignore */ }
  };

  win.addEventListener('afterprint', cleanup);

  const runPrint = () => {
    try {
      win.focus();
      win.print();
    } catch (e) {
      showNotif('Impression impossible sur ce navigateur', 'error');
      cleanup();
    }
  };

  if (iframe.contentDocument.readyState === 'complete') {
    setTimeout(runPrint, 50);
  } else {
    iframe.onload = () => setTimeout(runPrint, 50);
  }

  setTimeout(cleanup, 60000);
}

function afficherFactureModal(f) {
  modalPreviousFocus = document.activeElement;
  modalDialogPending = null;
  lastFactureForPrint = f;
  const wrap = buildTicketWrapHtml(f);
  const html = `${wrap}
    <div class="modal-actions">
      <button type="button" id="modalPrimaryBtn" class="modal-btn modal-btn-print">Imprimer le ticket</button>
      <button type="button" id="modalCloseBtn" class="modal-btn modal-btn-close">Fermer</button>
    </div>`;
  const modal = document.getElementById('modalContent');
  modal.innerHTML = html;
  const printBtn = document.getElementById('modalPrimaryBtn');
  const closeBtn = document.getElementById('modalCloseBtn');
  if (printBtn) printBtn.addEventListener('click', printReceipt);
  if (closeBtn) closeBtn.addEventListener('click', closeModal);
  document.getElementById('modalOverlay').classList.add('open');
  requestAnimationFrame(() => {
    const btn = document.getElementById('modalPrimaryBtn');
    if (btn) btn.focus();
    else modal.focus();
  });
}

function closeModal() {
  document.getElementById('modalOverlay').classList.remove('open');
  // Si une modale "prompt/confirm" était en attente, on annule (null).
  const pending = modalDialogPending;
  modalDialogPending = null;
  if (pending && typeof pending.resolve === 'function') {
    try {
      pending.resolve(null);
    } catch {
      /* ignore */
    }
  }

  const prev = modalPreviousFocus;
  modalPreviousFocus = null;
  if (prev && typeof prev.focus === 'function') {
    try {
      prev.focus();
    } catch (e) {
      /* ignore */
    }
  }

  // Variants d'apparence (confirm/prompt) — à enlever après fermeture.
  try {
    document.getElementById('modalContent')?.classList.remove('modal--saas');
  } catch {
    /* ignore */
  }
}

document.getElementById('modalOverlay').addEventListener('click', function(e) {
  if (e.target === this) closeModal();
});

function openModalWithHtml(html, focusEl) {
  modalPreviousFocus = document.activeElement;
  const modal = document.getElementById('modalContent');
  if (!modal) return;
  modal.innerHTML = html;
  document.getElementById('modalOverlay').classList.add('open');
  requestAnimationFrame(() => {
    const el = focusEl ? document.getElementById(focusEl) : null;
    if (el && typeof el.focus === 'function') {
      el.focus();
      if (typeof el.select === 'function') el.select();
    } else {
      modal.focus();
    }
  });
}

function showModalConfirm({ title, message, confirmText = 'Confirmer', cancelText = 'Annuler' }) {
  return new Promise((resolve) => {
    modalDialogPending = { resolve };
    try {
      document.getElementById('modalContent')?.classList.add('modal--saas');
    } catch {
      /* ignore */
    }
    openModalWithHtml(`
      <div class="modal-saas-body">
        <div class="modal-saas-title">${title || 'Confirmation'}</div>
        <div class="modal-saas-message">${message ? String(message) : ''}</div>
        <div class="modal-actions">
          <button type="button" id="modalCancelBtn" class="modal-btn modal-btn-close">${cancelText}</button>
          <button type="button" id="modalPrimaryBtn" class="modal-btn modal-btn-print">${confirmText}</button>
        </div>
      </div>
    `);

    const cancelBtn = document.getElementById('modalCancelBtn');
    cancelBtn?.addEventListener('click', () => {
      const pending = modalDialogPending;
      modalDialogPending = null;
      try { pending?.resolve(false); } catch { /* ignore */ }
      closeModal();
    });
    const confirmBtn = document.getElementById('modalPrimaryBtn');
    confirmBtn?.addEventListener('click', () => {
      const pending = modalDialogPending;
      modalDialogPending = null;
      try { pending?.resolve(true); } catch { /* ignore */ }
      closeModal();
    });
  });
}

function showModalPromptText({
  title,
  label = 'Motif',
  placeholder = '',
  confirmText = 'Confirmer',
  cancelText = 'Annuler',
  defaultValue = ''
}) {
  return new Promise((resolve) => {
    modalDialogPending = { resolve };
    const inputId = 'modalPromptInput';
    try {
      document.getElementById('modalContent')?.classList.add('modal--saas');
    } catch {
      /* ignore */
    }
    openModalWithHtml(`
      <div class="modal-saas-body">
        <div class="modal-saas-title">${title || 'Saisie'}</div>
        <label for="${inputId}" class="modal-saas-label">${escapeHtml(label)}</label>
        <textarea id="${inputId}" class="form-input modal-saas-textarea" rows="3" maxlength="200" placeholder="${escapeAttr(placeholder)}">${escapeHtml(defaultValue)}</textarea>
        <div class="modal-actions">
          <button type="button" id="modalCancelBtn" class="modal-btn modal-btn-close">${cancelText}</button>
          <button type="button" id="modalPrimaryBtn" class="modal-btn modal-btn-print">${confirmText}</button>
        </div>
      </div>
    `, inputId);

    const cancelBtn = document.getElementById('modalCancelBtn');
    cancelBtn?.addEventListener('click', () => {
      const pending = modalDialogPending;
      modalDialogPending = null;
      try { pending?.resolve(null); } catch { /* ignore */ }
      closeModal();
    });
    const confirmBtn = document.getElementById('modalPrimaryBtn');
    confirmBtn?.addEventListener('click', () => {
      const pending = modalDialogPending;
      modalDialogPending = null;
      const el = document.getElementById(inputId);
      const val = el ? (el.value || '').trim() : '';
      try { pending?.resolve(val); } catch { /* ignore */ }
      closeModal();
    });
  });
}

// ===================== STOCK =====================
function margePct(a) {
  const pa = a.prixAchat;
  if (pa == null || pa === '' || Number.isNaN(Number(pa)) || Number(pa) <= 0 || !a.prix) return null;
  return ((Number(a.prix) - Number(pa)) / Number(a.prix)) * 100;
}

function updateStockAlertBox() {
  const box = document.getElementById('stockAlertBox');
  if (!box) return;
  const need = articles.filter((a) => !isUnlimited(a) && isStockLow(a));
  if (!need.length) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.innerHTML =
    '<strong>À commander / stock bas</strong> — ' +
    need.map((a) => `${escapeHtml(a.nom)} (${stockDisplay(a)})`).join(', ');
}

function renderStock() {
  updateStockAlertBox();
  const tbody = document.getElementById('stockBody');
  if (!articles.length) {
    tbody.innerHTML =
      '<tr><td colspan="8" class="td-empty-state"><strong>Aucun article en stock</strong><br>Ajoutez des fiches via le formulaire à droite, ou importez une sauvegarde JSON dans <strong>Paramètres</strong>.</td></tr>';
    return;
  }
  const q = document.getElementById('stockSearch').value.toLowerCase();
  const filtered = articles.filter(
    (a) =>
      (a.nom || '').toLowerCase().includes(q) || (a.cat || '').toLowerCase().includes(q)
  );
  tbody.innerHTML =
    filtered
      .map((a) => {
        const m = margePct(a);
        const pa = a.prixAchat != null && !Number.isNaN(Number(a.prixAchat)) ? Number(a.prixAchat).toFixed(2) : '—';
        const mStr = m != null ? `${m.toFixed(0)} %` : '—';
        const low = isStockLow(a);
        return `
    <tr>
      <td>${escapeEmojiDisplay(a.emoji)} ${escapeHtml(a.nom)}</td>
      <td style="color:var(--text2);font-size:0.78rem">${escapeHtml(a.cat)}</td>
      <td class="td-prix">${a.prix.toFixed(2)} MAD</td>
      <td class="td-stock" style="color:var(--text2)">${pa}</td>
      <td class="td-stock" style="color:var(--teal2)">${mStr}</td>
      <td class="td-stock ${low ? 'stock-low' : 'stock-ok'}">${stockDisplay(a)}</td>
      <td class="td-stock" style="color:var(--text2)">${a.vendu || 0}</td>
      <td>
        <button type="button" class="action-btn" data-stock-edit="${escapeAttr(a.id)}">✏ Modifier</button>
        <button type="button" class="action-btn danger" data-stock-del="${escapeAttr(a.id)}">✕</button>
      </td>
    </tr>`;
      })
      .join('') ||
    '<tr><td colspan="8" style="text-align:center;padding:24px;color:var(--text2)">Aucun article trouvé</td></tr>';
}

function editArticle(id) {
  const a = articles.find(x => String(x.id) === String(id));
  if (!a) return;
  document.getElementById('editId').value = a.id;
  document.getElementById('fNom').value = a.nom;
  document.getElementById('fEmoji').value = a.emoji || '';
  document.getElementById('fPrix').value = a.prix;
  document.getElementById('fPrixAchat').value = a.prixAchat != null && !Number.isNaN(Number(a.prixAchat)) ? a.prixAchat : '';
  document.getElementById('fStockSeuil').value = typeof a.stockSeuil === 'number' ? a.stockSeuil : 5;
  document.getElementById('fStockIllimite').checked = isUnlimited(a);
  document.getElementById('fStock').value = isUnlimited(a) ? (a.stock || 0) : a.stock;
  refreshCategorySelects();
  document.getElementById('fCat').value = a.cat;
  toggleStockField();
  buildIconPicker();
  editMode = true;
  document.getElementById('btnStockSave').textContent = '✓ Mettre à jour';
  showPage('stock');
}

function annulerEdit() {
  document.getElementById('editId').value = '';
  document.getElementById('fNom').value = '';
  document.getElementById('fEmoji').value = '';
  refreshCategorySelects();
  const cats = getStockCategories();
  if (cats.length) document.getElementById('fCat').value = cats[0];
  document.getElementById('fPrix').value = '';
  document.getElementById('fPrixAchat').value = '';
  document.getElementById('fStockSeuil').value = '5';
  document.getElementById('fStock').value = '';
  document.getElementById('fStockIllimite').checked = false;
  toggleStockField();
  buildIconPicker();
  editMode = false;
  document.getElementById('btnStockSave').textContent = '✓ Sauvegarder l\'article';
}

function sauvegarderArticle() {
  const nom = document.getElementById('fNom').value.trim();
  const emojiRaw = document.getElementById('fEmoji').value.trim() || '☕';
  const emoji = emojiRaw.replace(/[<>]/g, '').slice(0, 24) || '☕';
  const cat = document.getElementById('fCat').value;
  const prix = parseFloat(document.getElementById('fPrix').value);
  const stockIllimite = document.getElementById('fStockIllimite').checked;
  const stock = stockIllimite ? 0 : (parseInt(document.getElementById('fStock').value, 10) || 0);
  const editId = document.getElementById('editId').value;
  const paRaw = document.getElementById('fPrixAchat').value.trim();
  const prixAchat = paRaw === '' ? null : parseFloat(paRaw);
  let stockSeuil = parseInt(document.getElementById('fStockSeuil').value, 10);
  if (Number.isNaN(stockSeuil)) stockSeuil = 5;

  if (!nom || isNaN(prix) || prix < 0) {
    showNotif('Veuillez remplir tous les champs obligatoires (*)', 'error');
    return;
  }
  if (prixAchat != null && (Number.isNaN(prixAchat) || prixAchat < 0)) {
    showNotif('Prix d\'achat invalide', 'error');
    return;
  }

  if (editId) {
    const idx = articles.findIndex(a => String(a.id) === String(editId));
    if (idx !== -1) {
      articles[idx] = {
        ...articles[idx],
        nom,
        emoji,
        cat,
        prix,
        prixAchat,
        stockSeuil,
        stock,
        stockIllimite,
        vendu: articles[idx].vendu || 0
      };
    }
  } else {
    articles.push({
      id: uid(),
      nom,
      emoji,
      cat,
      prix,
      prixAchat,
      stockSeuil,
      stock,
      stockIllimite,
      vendu: 0
    });
  }

  saveArticles(articles);
  renderStock();
  renderArticles();
  renderCatFilter();
  annulerEdit();
  showNotif('✓ Article sauvegardé!', 'success');
}

async function supprimerArticle(id) {
  const ok = await showModalConfirm({
    title: 'Supprimer un article',
    message: 'Supprimer cet article de votre stock ?',
    confirmText: 'Supprimer',
    cancelText: 'Annuler'
  });
  if (!ok) return;
  articles = articles.filter(a => String(a.id) !== String(id));
  saveArticles(articles);
  renderStock();
  renderArticles();
  renderCatFilter();
  showNotif('Article supprimé', '');
}

// ===================== HISTORIQUE =====================
let histoPreset = 'month';

function startEndOfDay(d) {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  const e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);
  return { start: s, end: e };
}

function startOfWeekMonday(d) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const day = x.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  x.setDate(x.getDate() + diff);
  x.setHours(0, 0, 0, 0);
  return x;
}

function toInputDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function localDateKey(d) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;
}

function factureInRange(f, start, end) {
  const t = new Date(f.date).getTime();
  return t >= start.getTime() && t <= end.getTime();
}

function getHistoriqueRange(allFactures) {
  const now = new Date();
  if (histoPreset === 'custom') {
    const fromVal = document.getElementById('histoDateFrom') && document.getElementById('histoDateFrom').value;
    const toVal = document.getElementById('histoDateTo') && document.getElementById('histoDateTo').value;
    if (!fromVal || !toVal) {
      const s = new Date(now.getFullYear(), now.getMonth(), 1);
      const e = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
      return { start: s, end: e };
    }
    const start = new Date(fromVal + 'T00:00:00');
    const end = new Date(toVal + 'T23:59:59.999');
    if (start > end) return null;
    return { start, end };
  }
  if (histoPreset === 'today') return startEndOfDay(now);
  if (histoPreset === 'week') {
    const s = startOfWeekMonday(now);
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    e.setHours(23, 59, 59, 999);
    return { start: s, end: e };
  }
  if (histoPreset === 'month') {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    const e = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return { start: s, end: e };
  }
  if (histoPreset === 'lastmonth') {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const e = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { start: s, end: e };
  }
  if (histoPreset === 'all') {
    if (!allFactures.length) {
      const { start, end } = startEndOfDay(now);
      return { start, end };
    }
    const times = allFactures.map((f) => new Date(f.date).getTime());
    return { start: new Date(Math.min(...times)), end: new Date(Math.max(...times)) };
  }
  return startEndOfDay(now);
}

function syncHistoDateInputs(range, allFactures) {
  const fromEl = document.getElementById('histoDateFrom');
  const toEl = document.getElementById('histoDateTo');
  if (!fromEl || !toEl || !range) return;
  if (histoPreset === 'custom') return;
  if (histoPreset === 'all' && allFactures.length) {
    const times = allFactures.map((f) => new Date(f.date).getTime());
    fromEl.value = toInputDate(new Date(Math.min(...times)));
    toEl.value = toInputDate(new Date(Math.max(...times)));
    return;
  }
  fromEl.value = toInputDate(range.start);
  toEl.value = toInputDate(range.end);
}

function formatRangeLabel(range) {
  const o = { day: '2-digit', month: 'short', year: 'numeric' };
  return `${range.start.toLocaleDateString('fr-FR', o)} — ${range.end.toLocaleDateString('fr-FR', o)}`;
}

function buildCaSeries(filtered, rangeStart, rangeEnd) {
  const dayMs = 86400000;
  const d0 = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), rangeStart.getDate());
  const d1 = new Date(rangeEnd.getFullYear(), rangeEnd.getMonth(), rangeEnd.getDate());
  const nDays = Math.round((d1 - d0) / dayMs) + 1;

  if (nDays > 90) {
    const map = new Map();
    filtered.forEach((f) => {
      const d = new Date(f.date);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      map.set(key, (map.get(key) || 0) + factureCompteCA(f));
    });
    const keys = [...map.keys()].sort();
    return keys.map((k) => {
      const [Y, M] = k.split('-');
      const dt = new Date(Number(Y), Number(M) - 1, 1);
      return {
        label: dt.toLocaleDateString('fr-FR', { month: 'short', year: '2-digit' }),
        ca: map.get(k),
        sortKey: k
      };
    });
  }

  const map = new Map();
  const cur = new Date(d0);
  while (cur <= d1) {
    map.set(localDateKey(cur), 0);
    cur.setDate(cur.getDate() + 1);
  }
  filtered.forEach((f) => {
    const k = localDateKey(new Date(f.date));
    const v = factureCompteCA(f);
    if (map.has(k)) map.set(k, map.get(k) + v);
    else map.set(k, (map.get(k) || 0) + v);
  });
  return [...map.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([key, ca]) => {
      const [y, m, day] = key.split('-');
      const short = `${day}/${m}`;
      return { label: nDays <= 7 ? new Date(Number(y), Number(m) - 1, Number(day)).toLocaleDateString('fr-FR', { weekday: 'short', day: 'numeric' }) : short, ca, sortKey: key };
    });
}

function drawHistoriqueChart(series) {
  const canvas = document.getElementById('histoChartCanvas');
  if (!canvas) return;
  const wrap = canvas.parentElement;
  const w = Math.max(wrap.clientWidth || 400, 280);
  const h = 220;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(0, 0, w, h);

  if (!series.length) {
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12px system-ui,sans-serif';
    ctx.fillText('Aucune vente sur la période', 16, h / 2);
    return;
  }

  const max = Math.max(...series.map((s) => s.ca), 1);
  const pad = { l: 8, r: 8, t: 16, b: 36 };
  const innerW = w - pad.l - pad.r;
  const innerH = h - pad.t - pad.b;
  const n = series.length;
  const bw = innerW / Math.max(n, 1);

  series.forEach((s, i) => {
    const bh = (s.ca / max) * innerH;
    const x = pad.l + i * bw + bw * 0.12;
    const y = pad.t + innerH - bh;
    const barW = bw * 0.76;
    const grd = ctx.createLinearGradient(0, y, 0, y + bh);
    grd.addColorStop(0, '#0ECFA0');
    grd.addColorStop(1, '#07a378');
    ctx.fillStyle = grd;
    if (bh < 2 && s.ca > 0) ctx.fillRect(x, pad.t + innerH - 2, barW, 2);
    else ctx.fillRect(x, y, barW, bh);

    ctx.fillStyle = '#94a3b8';
    ctx.font = '9px ui-monospace, monospace';
    ctx.textAlign = 'center';
    const lx = x + barW / 2;
    ctx.save();
    ctx.translate(lx, h - 10);
    ctx.rotate(n > 14 ? -0.45 : 0);
    const lab = String(s.label);
    ctx.fillText(lab.length > 12 ? lab.slice(0, 10) + '…' : lab, 0, 0);
    ctx.restore();
  });

  ctx.textAlign = 'left';
  ctx.fillStyle = '#64748b';
  ctx.font = '10px system-ui,sans-serif';
  ctx.fillText(`Max ${max.toFixed(0)} MAD`, pad.l, 12);
}

function getTopArticles(filtered) {
  const m = new Map();
  filtered.forEach((f) => {
    if (!factureCompteStats(f)) return;
    (f.items || []).forEach((p) => {
      const k = p.nom || 'Article';
      const prev = m.get(k) || { qty: 0, ca: 0 };
      prev.qty += p.qty;
      prev.ca += Number(p.prix) * p.qty;
      m.set(k, prev);
    });
  });
  return [...m.entries()].sort((a, b) => b[1].qty - a[1].qty).slice(0, 5);
}

function getServerPerformance(filtered) {
  const m = new Map();
  filtered.forEach((f) => {
    if (!factureCompteStats(f)) return;
    const srv = (f.serveur && String(f.serveur).trim()) || '(Non assigné)';
    const prev = m.get(srv) || { count: 0, ca: 0 };
    prev.count += 1;
    prev.ca += factureCompteCA(f);
    m.set(srv, prev);
  });
  return [...m.entries()].sort((a, b) => b[1].ca - a[1].ca);
}

function setHistoPreset(p) {
  histoPreset = p;
  document.querySelectorAll('.histo-chip').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-preset') === p);
  });
  renderHistorique();
}

function applyHistoCustomRange() {
  histoPreset = 'custom';
  document.querySelectorAll('.histo-chip').forEach((btn) => btn.classList.remove('active'));
  renderHistorique();
}

function exportHistoPdf() {
  const all = loadFactures();
  const range = getHistoriqueRange(all);
  if (!range) {
    showNotif('Indiquez une période valide (du … au …)', 'error');
    return;
  }
  let filtered = all.filter((f) => factureInRange(f, range.start, range.end));
  filtered = applyHistoriqueTableFilter(filtered);
  const todayR = startEndOfDay(new Date());
  const todayFacts = all.filter((f) => factureInRange(f, todayR.start, todayR.end));
  const caPeriode = filtered.reduce((s, f) => s + factureCompteCA(f), 0);
  const caToday = todayFacts.reduce((s, f) => s + factureCompteCA(f), 0);
  const caTotal = all.reduce((s, f) => s + factureCompteCA(f), 0);
  const series = buildCaSeries(filtered, range.start, range.end);
  const top5 = getTopArticles(filtered);
  const servers = getServerPerformance(filtered);
  const cfg = loadSettings();
  const esc = escapeTicketHtml;

  const rowsCa = series.map((s) => `<tr><td>${esc(s.label)}</td><td style="text-align:right">${s.ca.toFixed(2)} MAD</td></tr>`).join('');
  const rowsTop = top5.map(([nom, v], i) => `<tr><td>${i + 1}</td><td>${esc(nom)}</td><td style="text-align:right">${v.qty}</td><td style="text-align:right">${v.ca.toFixed(2)}</td></tr>`).join('');
  const maxSrvCa = servers.length ? Math.max(...servers.map((x) => x[1].ca), 1) : 1;
  const rowsSrv = servers.map(([name, v]) => {
    const pct = Math.round((v.ca / maxSrvCa) * 100);
    return `<tr><td>${esc(name)}</td><td style="text-align:right">${v.count}</td><td style="text-align:right">${v.ca.toFixed(2)} MAD</td><td><div style="background:#eee;height:8px;border-radius:4px"><div style="width:${pct}%;height:8px;background:#09BC8A;border-radius:4px"></div></div></td></tr>`;
  }).join('');
  const d0 = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate());
  const d1 = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate());
  const pdfSpanDays = Math.round((d1 - d0) / 86400000) + 1;
  const caPdfTitle = pdfSpanDays > 90 ? 'par mois' : 'par jour';

  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Rapport ventes</title>
<style>
body{font-family:Segoe UI,system-ui,sans-serif;font-size:11pt;color:#111;margin:16mm;max-width:190mm}
h1{font-size:16pt;margin:0 0 4px} .sub{color:#555;font-size:10pt;margin-bottom:16px}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin:16px 0}
.box{border:1px solid #ccc;padding:10px;border-radius:6px}
.box b{display:block;font-size:18pt}.box span{font-size:9pt;color:#666;text-transform:uppercase}
table{width:100%;border-collapse:collapse;margin:12px 0}
th,td{border-bottom:1px solid #ddd;padding:6px 8px;text-align:left;font-size:10pt}
th{background:#f5f5f5} h2{font-size:12pt;margin-top:20px;border-bottom:1px solid #ccc;padding-bottom:4px}
@media print{body{margin:12mm}}
</style></head><body>
<h1>Rapport de vente</h1>
<div class="sub">${esc(cfg.nomCafe || 'Café')} · ${formatRangeLabel(range)}${histoTableFilter === '__vide__' ? ' · sans table' : histoTableFilter ? ` · table ${esc(histoTableFilter)}` : ''} · généré le ${new Date().toLocaleString('fr-FR')}</div>
<div class="grid">
<div class="box"><b>${filtered.length}</b><span>Factures (période)</span></div>
<div class="box"><b>${caPeriode.toFixed(0)}</b><span>CA période (MAD)</span></div>
<div class="box"><b>${todayFacts.length}</b><span>Factures aujourd'hui</span></div>
<div class="box"><b>${caToday.toFixed(0)}</b><span>CA aujourd'hui (MAD)</span></div>
<div class="box"><b>${all.length}</b><span>Factures total</span></div>
<div class="box"><b>${caTotal.toFixed(0)}</b><span>CA total (MAD)</span></div>
</div>
<h2>Chiffre d'affaires (${caPdfTitle})</h2>
<table><thead><tr><th>Période</th><th style="text-align:right">CA (MAD)</th></tr></thead><tbody>${rowsCa || '<tr><td colspan="2">Aucune donnée</td></tr>'}</tbody></table>
<h2>Top 5 articles</h2>
<table><thead><tr><th>#</th><th>Article</th><th style="text-align:right">Qté</th><th style="text-align:right">CA</th></tr></thead><tbody>${rowsTop || '<tr><td colspan="4">Aucune vente</td></tr>'}</tbody></table>
<h2>Performance par serveur</h2>
<table><thead><tr><th>Serveur</th><th style="text-align:right">Factures</th><th style="text-align:right">CA</th><th style="width:35%">Part</th></tr></thead><tbody>${rowsSrv || '<tr><td colspan="4">Aucune donnée</td></tr>'}</tbody></table>
<p style="font-size:9pt;color:#666;margin-top:16px">Enregistrez au format PDF depuis la boîte d'impression.</p>
<script>setTimeout(function(){window.focus();window.print();},400)<\/script>
</body></html>`;

  const iframe = document.createElement('iframe');
  iframe.setAttribute('title', 'Rapport PDF');
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;opacity:0;pointer-events:none';
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;
  doc.open();
  doc.write(html);
  doc.close();
  const cleanup = () => {
    try {
      if (iframe.parentNode) iframe.parentNode.removeChild(iframe);
    } catch (e) { /* ignore */ }
  };
  win.addEventListener('afterprint', cleanup);
  setTimeout(cleanup, 120000);
  showNotif('Impression : choisissez « Enregistrer au format PDF »', 'success');
}

function renderHistorique() {
  populateHistoTableFilter();
  const all = loadFactures();
  if (!all.length) {
    let range = getHistoriqueRange(all);
    if (!range) {
      const n = new Date();
      range = {
        start: new Date(n.getFullYear(), n.getMonth(), 1),
        end: new Date(n.getFullYear(), n.getMonth() + 1, 0, 23, 59, 59, 999)
      };
    }
    syncHistoDateInputs(range, all);
    document.querySelectorAll('.histo-chip').forEach((btn) => {
      const pr = btn.getAttribute('data-preset');
      btn.classList.toggle('active', histoPreset !== 'custom' && pr === histoPreset);
    });
    const labelEl = document.getElementById('histoRangeLabel');
    if (labelEl) labelEl.textContent = `Période sélectionnée : ${formatRangeLabel(range)}`;
    document.getElementById('histoStats').innerHTML = `
    <div class="stat-card"><span class="stat-val">0</span><span class="stat-lbl">Factures (période)</span></div>
    <div class="stat-card"><span class="stat-val">0</span><span class="stat-lbl">CA période (MAD)</span></div>
    <div class="stat-card"><span class="stat-val">0</span><span class="stat-lbl">Factures aujourd'hui</span></div>
    <div class="stat-card"><span class="stat-val">0</span><span class="stat-lbl">CA aujourd'hui (MAD)</span></div>
    <div class="stat-card"><span class="stat-val">0</span><span class="stat-lbl">Factures total</span></div>
    <div class="stat-card"><span class="stat-val">0</span><span class="stat-lbl">CA total (MAD)</span></div>`;
    requestAnimationFrame(() => drawHistoriqueChart([]));
    const top5El = document.getElementById('histoTop5');
    if (top5El) {
      top5El.innerHTML =
        '<p class="histo-empty-hint">Aucune vente enregistrée. Les statistiques apparaîtront après des ventes à la caisse.</p>';
    }
    const srvEl = document.getElementById('histoServers');
    if (srvEl) {
      srvEl.innerHTML = '<p class="histo-empty-hint">Pas encore de données serveur.</p>';
    }
    const cnt = document.getElementById('histoFacturesCount');
    if (cnt) cnt.textContent = '';
    document.getElementById('facturesList').innerHTML = `<div class="empty-state histo-empty-factures">
      <div class="empty-state-title">Aucune facture</div>
      <p class="empty-state-text">Passez des commandes dans l’onglet <strong>Caisse</strong> pour alimenter l’historique et les rapports.</p>
    </div>`;
    return;
  }

  let range = getHistoriqueRange(all);
  if (!range) {
    const n = new Date();
    range = { start: new Date(n.getFullYear(), n.getMonth(), 1), end: new Date(n.getFullYear(), n.getMonth() + 1, 0, 23, 59, 59, 999) };
    showNotif('Dates invalides — affichage du mois en cours', 'error');
  }
  syncHistoDateInputs(range, all);

  document.querySelectorAll('.histo-chip').forEach((btn) => {
    const pr = btn.getAttribute('data-preset');
    btn.classList.toggle('active', histoPreset !== 'custom' && pr === histoPreset);
  });

  const byDate = all.filter((f) => factureInRange(f, range.start, range.end));
  const filtered = applyHistoriqueTableFilter(byDate);
  const todayR = startEndOfDay(new Date());
  const todayFacts = all.filter((f) => factureInRange(f, todayR.start, todayR.end));

  const facturesTotal = all.length;
  const caTotal = all.reduce((s, f) => s + factureCompteCA(f), 0);
  const facturesToday = todayFacts.length;
  const caToday = todayFacts.reduce((s, f) => s + factureCompteCA(f), 0);
  const facturesPeriode = filtered.length;
  const caPeriode = filtered.reduce((s, f) => s + factureCompteCA(f), 0);

  const labelEl = document.getElementById('histoRangeLabel');
  if (labelEl) {
    const tf =
      histoTableFilter === '__vide__'
        ? ' · filtre : sans table'
        : histoTableFilter
          ? ` · filtre : table ${histoTableFilter}`
          : '';
    labelEl.textContent = `Période sélectionnée : ${formatRangeLabel(range)}${tf}`;
  }

  document.getElementById('histoStats').innerHTML = `
    <div class="stat-card">
      <span class="stat-val">${facturesPeriode}</span>
      <span class="stat-lbl">Factures (période)</span>
    </div>
    <div class="stat-card">
      <span class="stat-val">${caPeriode.toFixed(0)}</span>
      <span class="stat-lbl">CA période (MAD)</span>
    </div>
    <div class="stat-card">
      <span class="stat-val">${facturesToday}</span>
      <span class="stat-lbl">Factures aujourd'hui</span>
    </div>
    <div class="stat-card">
      <span class="stat-val">${caToday.toFixed(0)}</span>
      <span class="stat-lbl">CA aujourd'hui (MAD)</span>
    </div>
    <div class="stat-card">
      <span class="stat-val">${facturesTotal}</span>
      <span class="stat-lbl">Factures total</span>
    </div>
    <div class="stat-card">
      <span class="stat-val">${caTotal.toFixed(0)}</span>
      <span class="stat-lbl">CA total (MAD)</span>
    </div>
  `;

  const series = buildCaSeries(filtered, range.start, range.end);
  requestAnimationFrame(() => drawHistoriqueChart(series));

  const top5 = getTopArticles(filtered);
  const top5El = document.getElementById('histoTop5');
  if (top5El) {
    top5El.innerHTML = top5.length
      ? `<table class="histo-mini-table"><thead><tr><th>#</th><th>Article</th><th class="num">Qté</th><th class="num">CA</th></tr></thead><tbody>${top5
          .map(
            ([nom, v], i) =>
              `<tr><td>${i + 1}</td><td>${escapeHtml(nom)}</td><td class="num">${v.qty}</td><td class="num">${v.ca.toFixed(2)}</td></tr>`
          )
          .join('')}</tbody></table>`
      : '<p style="color:var(--text2);font-size:0.82rem">Aucune vente sur la période.</p>';
  }

  const servers = getServerPerformance(filtered);
  const srvEl = document.getElementById('histoServers');
  if (srvEl) {
    const maxCa = servers.length ? Math.max(...servers.map((x) => x[1].ca), 1) : 1;
    srvEl.innerHTML = servers.length
      ? servers
          .map(([name, v]) => {
            const pct = Math.round((v.ca / maxCa) * 100);
            return `<div class="histo-bar-row"><span class="histo-bar-name" title="${escapeAttr(name)}">${escapeHtml(name)}</span><div class="histo-bar-track"><div class="histo-bar-fill" style="width:${pct}%"></div></div><span class="histo-bar-val">${v.ca.toFixed(0)} <small style="color:var(--text3)">(${v.count} f.)</small></span></div>`;
          })
          .join('')
      : '<p style="color:var(--text2);font-size:0.82rem">Aucun serveur sur la période.</p>';
  }

  const list = document.getElementById('facturesList');
  const cnt = document.getElementById('histoFacturesCount');
  if (cnt) cnt.textContent = filtered.length ? `(${filtered.length} sur la période)` : '';

  if (!filtered.length) {
    list.innerHTML = `<div class="empty-state histo-empty-period">
      <div class="empty-state-title">Aucune facture sur cette période</div>
      <p class="empty-state-text">Élargissez les dates ou le filtre table, ou enregistrez des ventes à la <strong>Caisse</strong>.</p>
    </div>`;
    return;
  }

  const sorted = [...filtered].sort((a, b) => new Date(b.date) - new Date(a.date));
  list.innerHTML = sorted
    .map((f, idx) => {
      const d = new Date(f.date);
      const dateStr = d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const idAttr = (String(f.id).replace(/[^a-zA-Z0-9_-]/g, '_') || 'f') + '_' + idx;
      const st = f.statut || 'valide';
      const badge =
        st === 'annulee'
          ? '<span class="fc-badge annulee">Annulé</span>'
          : st === 'avoir'
            ? '<span class="fc-badge avoir">Avoir</span>'
            : '';
      const tbl = (f.table || '').trim()
        ? ` <span style="color:var(--text3);font-size:0.78rem">· Table ${escapeHtml(f.table)}</span>`
        : '';
      return `
      <div class="facture-card">
        <div class="fc-header" data-fc-toggle="${escapeAttr(idAttr)}" role="button" tabindex="0">
          <div>
            <div class="fc-num">#${String(f.num).padStart(4, '0')}</div>
            <div class="fc-client">${escapeHtml(f.client)}${tbl}${badge}${f.serveur ? ` <span style="color:var(--text3);font-size:0.78rem">· ${escapeHtml(f.serveur)}</span>` : ''}</div>
          </div>
          <div class="fc-meta">
            <div class="fc-date">${dateStr}</div>
            <div class="fc-total">${Number(f.total).toFixed(2)} MAD</div>
            <button type="button" class="btn-outline" data-facture-ticket="${escapeAttr(f.id)}">Aperçu ticket</button>
          </div>
        </div>
        <div class="fc-body" id="fc-${idAttr}">
          ${(f.items || [])
            .map(
              (p) => `
            <div class="fc-item-row">
              <span>${escapeHtml(p.nom || '')}</span>
              <span style="color:var(--text2)">x${p.qty}</span>
              <span style="font-family:'DM Mono',monospace">${(Number(p.prix) * p.qty).toFixed(2)} MAD</span>
            </div>
          `
            )
            .join('')}
          ${
            st === 'valide'
              ? `<div class="fc-actions-row">
            <button type="button" class="btn-outline" data-facture-annuler="${escapeAttr(f.id)}">Annuler vente</button>
            <button type="button" class="btn-outline" data-facture-avoir="${escapeAttr(f.id)}">Faire un avoir</button>
          </div>`
              : ''
          }
          ${
            st === 'annulee' && f.motifAnnulation
              ? `<p class="fc-motif">Motif : ${escapeHtml(f.motifAnnulation)}</p>`
              : ''
          }
          ${
            st === 'avoir' && f.motifAnnulation
              ? `<p class="fc-motif">Motif : ${escapeHtml(f.motifAnnulation)}</p>`
              : ''
          }
        </div>
      </div>`;
    })
    .join('');
}

function openTicketById(id) {
  const f = loadFactures().find((x) => String(x.id) === String(id));
  if (f) afficherFactureModal(f);
}

function toggleFacture(id) {
  const el = document.getElementById('fc-' + id);
  if (el) el.classList.toggle('open');
}

let histoResizeTimer;
window.addEventListener('resize', () => {
  const page = document.getElementById('page-historique');
  if (!page || !page.classList.contains('active')) return;
  clearTimeout(histoResizeTimer);
  histoResizeTimer = setTimeout(() => {
    const all = loadFactures();
    const range = getHistoriqueRange(all);
    if (!range) return;
    const filtered = applyHistoriqueTableFilter(all.filter((f) => factureInRange(f, range.start, range.end)));
    drawHistoriqueChart(buildCaSeries(filtered, range.start, range.end));
  }, 200);
});

// ===================== EXPORTS =====================
function exportJSON() {
  const blob = new Blob([JSON.stringify(articles, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `stock_cafe_${new Date().toLocaleDateString('fr').replace(/\//g,'-')}.json`;
  a.click();
  showNotif('✓ Export JSON téléchargé!', 'success');
}

function exportCSV() {
  const header = 'Nom,Emoji,Catégorie,Prix,Stock,Vendu';
  const rows = articles.map(a => `"${a.nom}","${a.emoji}","${a.cat}",${a.prix},${a.stock},${a.vendu||0}`);
  const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8;' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `stock_cafe_${new Date().toLocaleDateString('fr').replace(/\//g,'-')}.csv`;
  a.click();
  showNotif('✓ Export CSV téléchargé!', 'success');
}

function exportFacturesJSON() {
  const factures = loadFactures();
  const blob = new Blob([JSON.stringify(factures, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `factures_cafe_${new Date().toLocaleDateString('fr').replace(/\//g,'-')}.json`;
  a.click();
  showNotif('✓ Factures exportées!', 'success');
}

// ===================== SUPABASE SYNC (multi-appareils) =====================
const SUPABASE_SETUP_SQL = `-- COFFE — exécuter UNE FOIS dans Supabase → SQL Editor
-- Puis : Settings → API → Project URL + clé anon public

create table if not exists public.coffeeshop_data (
  id text primary key default 'default',
  articles jsonb not null default '[]'::jsonb,
  factures jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.coffeeshop_data enable row level security;

drop policy if exists "coffeeshop_anon_all" on public.coffeeshop_data;

create policy "coffeeshop_anon_all"
  on public.coffeeshop_data
  for all
  to anon
  using (true)
  with check (true);

grant usage on schema public to anon;
grant select, insert, update, delete on table public.coffeeshop_data to anon;

insert into public.coffeeshop_data (id, articles, factures)
values ('default', '[]'::jsonb, '[]'::jsonb)
on conflict (id) do nothing;`;

let supabaseSyncTimer = null;
let supabaseScheduleTimer = null;
let supabaseSyncInFlight = false;

const SUPABASE_SCHEDULE_MARKER_KEY = 'coffe_supabase_schedule_fired';

function getSupabaseConfig() {
  const s = loadSettings();
  const url = (s.supabaseUrl || '').trim().replace(/\/$/, '');
  const key = (s.supabaseAnonKey || '').trim();
  return { url, key, ok: !!(url && key) };
}

function supabaseAuthHeaders(key) {
  return {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json'
  };
}

function payloadHash() {
  const a = localStorage.getItem(STORAGE_KEY) || '[]';
  const f = localStorage.getItem(FACTURES_KEY) || '[]';
  return fnv1aHex(a + '::' + f);
}

function fnv1aHex(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

async function supabaseRestFetch(path, opts = {}) {
  const { url, key, ok } = getSupabaseConfig();
  if (!ok) throw new Error('URL ou clé Supabase manquante');
  const res = await fetch(url + '/rest/v1/' + path, {
    ...opts,
    headers: { ...supabaseAuthHeaders(key), ...opts.headers }
  });
  return res;
}

async function supabasePullRow() {
  const res = await supabaseRestFetch('coffeeshop_data?select=articles,factures,updated_at&id=eq.default');
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(errText || res.statusText || String(res.status));
  }
  const text = await res.text();
  const rows = text ? JSON.parse(text) : [];
  return rows[0] || null;
}

async function supabasePushRow() {
  const body = {
    articles: loadArticles(),
    factures: loadFactures(),
    updated_at: new Date().toISOString()
  };
  let res = await supabaseRestFetch('coffeeshop_data?id=eq.default', {
    method: 'PATCH',
    headers: { Prefer: 'return=representation' },
    body: JSON.stringify(body)
  });
  let row = null;
  if (res.ok) {
    const t = await res.text();
    const parsed = t ? JSON.parse(t) : [];
    row = Array.isArray(parsed) && parsed[0] ? parsed[0] : null;
  }
  if (!row) {
    res = await supabaseRestFetch('coffeeshop_data', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify({ id: 'default', ...body })
    });
    if (!res.ok) throw new Error((await res.text()) || res.statusText);
    const t = await res.text();
    const parsed = t ? JSON.parse(t) : [];
    row = Array.isArray(parsed) ? parsed[0] : parsed;
  }
  if (!row) throw new Error('Réponse Supabase invalide après envoi');
  if (!row.updated_at) row.updated_at = body.updated_at;
  return row;
}

function applySupabaseRemoteRow(remote) {
  const arts = Array.isArray(remote.articles)
    ? remote.articles.filter((x) => x && typeof x === 'object').map(migrateArticle)
    : [];
  const facts = Array.isArray(remote.factures)
    ? remote.factures.filter((x) => x && typeof x === 'object').map(migrateFacture)
    : [];
  saveArticles(arts);
  saveFactures(facts);
  articles = loadArticles();
}

function refreshUiAfterSupabasePull() {
  renderArticles();
  renderStock();
  renderCatFilter();
  renderPanier();
  const histoPage = document.getElementById('page-historique');
  if (histoPage && histoPage.classList.contains('active')) renderHistorique();
  updateZHeader();
  renderZPanel();
}

function updateSupabaseStatusLine(text, isError) {
  const el = document.getElementById('supabaseSyncStatus');
  if (!el) return;
  if (text === undefined || text === null) {
    const s = loadSettings();
    if (!s.supabaseSyncEnabled) {
      el.textContent = 'Sync désactivée.';
      el.classList.remove('supabase-sync-status--error');
      return;
    }
    if (!getSupabaseConfig().ok) {
      el.textContent = 'Renseignez l’URL et la clé anon, puis connectez.';
      el.classList.remove('supabase-sync-status--error');
      return;
    }
    let line = s.supabaseLastRemoteUpdatedAt
      ? 'Prêt — dernière donnée cloud : ' +
        new Date(s.supabaseLastRemoteUpdatedAt).toLocaleString('fr-FR')
      : 'Prêt — pas encore de synchronisation.';
    if (s.supabaseDailySyncEnabled && (s.supabaseDailySyncTime || '').trim()) {
      line +=
        ' — synchro auto quotidienne à ' +
        (s.supabaseDailySyncTime || '').trim() +
        ' (heure locale, onglet ouvert).';
    }
    el.textContent = line;
    el.classList.remove('supabase-sync-status--error');
    return;
  }
  el.textContent = text;
  el.classList.toggle('supabase-sync-status--error', !!isError);
}

function stopSupabaseScheduleTimer() {
  if (supabaseScheduleTimer) {
    clearInterval(supabaseScheduleTimer);
    supabaseScheduleTimer = null;
  }
}

function stopSupabaseSyncTimer() {
  if (supabaseSyncTimer) {
    clearInterval(supabaseSyncTimer);
    supabaseSyncTimer = null;
  }
  stopSupabaseScheduleTimer();
}

function startSupabaseScheduleTimerIfNeeded() {
  stopSupabaseScheduleTimer();
  const s = loadSettings();
  if (!s.supabaseSyncEnabled || !getSupabaseConfig().ok || !s.supabaseDailySyncEnabled) return;
  const raw = (s.supabaseDailySyncTime || '').trim();
  if (!raw) return;
  supabaseScheduleTimer = setInterval(() => {
    supabaseMaybeScheduledSync();
  }, 20000);
  supabaseMaybeScheduledSync();
}

/** Synchro planifiée : une fois par jour à l’heure locale configurée (tant que l’onglet reste ouvert). */
function supabaseMaybeScheduledSync() {
  const s = loadSettings();
  if (!s.supabaseSyncEnabled || !getSupabaseConfig().ok || !s.supabaseDailySyncEnabled) return;
  const raw = (s.supabaseDailySyncTime || '').trim();
  if (!raw) return;
  const parts = raw.split(':');
  if (parts.length < 2) return;
  const sh = parseInt(parts[0], 10);
  const sm = parseInt(parts[1], 10);
  if (sh < 0 || sh > 23 || sm < 0 || sm > 59) return;
  const now = new Date();
  if (now.getHours() !== sh || now.getMinutes() !== sm) return;
  const day =
    now.getFullYear() +
    '-' +
    String(now.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(now.getDate()).padStart(2, '0');
  const token = day + '|' + raw;
  if (localStorage.getItem(SUPABASE_SCHEDULE_MARKER_KEY) === token) return;
  safeLocalSetItem(SUPABASE_SCHEDULE_MARKER_KEY, token);
  supabaseSyncTick({ silent: true, manual: false });
}

function startSupabaseSyncTimer(options) {
  const immediate = !options || options.immediate !== false;
  stopSupabaseSyncTimer();
  const s = loadSettings();
  if (!s.supabaseSyncEnabled || !getSupabaseConfig().ok) return;
  supabaseSyncTimer = setInterval(() => {
    supabaseSyncTick({ silent: true, manual: false });
  }, 30000);
  if (immediate) supabaseSyncTick({ silent: true, manual: false });
  startSupabaseScheduleTimerIfNeeded();
}

async function supabaseSyncTick(opts) {
  const silent = !!(opts && opts.silent);
  const manual = !!(opts && opts.manual);
  const s = loadSettings();
  if (!s.supabaseSyncEnabled || !getSupabaseConfig().ok) {
    if (manual) {
      updateSupabaseStatusLine('Activez la sync et enregistrez URL + clé.', true);
      return { ok: false, msg: 'Sync inactive ou configuration incomplète' };
    }
    return { ok: false };
  }
  if (supabaseSyncInFlight) return { ok: true, skipped: true };
  supabaseSyncInFlight = true;
  if (manual) updateSupabaseStatusLine('Synchronisation en cours…');
  try {
    const remote = await supabasePullRow();
    const lastSeen = s.supabaseLastRemoteUpdatedAt
      ? new Date(s.supabaseLastRemoteUpdatedAt).getTime()
      : 0;
    let pulled = false;
    if (remote && remote.updated_at) {
      const remoteT = new Date(remote.updated_at).getTime();
      const hasRemote =
        (Array.isArray(remote.articles) && remote.articles.length > 0) ||
        (Array.isArray(remote.factures) && remote.factures.length > 0);
      const localEmpty = loadArticles().length === 0 && loadFactures().length === 0;
      if (remoteT > lastSeen && (hasRemote || localEmpty)) {
        applySupabaseRemoteRow(remote);
        pulled = true;
        const s2 = loadSettings();
        saveSettings({
          ...s2,
          supabaseLastRemoteUpdatedAt: remote.updated_at,
          supabaseLastPushedHash: payloadHash()
        });
        refreshUiAfterSupabasePull();
        if (manual && !silent) showNotif('Données reçues depuis Supabase', 'success');
      }
    }
    const s3 = loadSettings();
    const h = payloadHash();
    if (h !== (s3.supabaseLastPushedHash || '')) {
      const row = await supabasePushRow();
      saveSettings({
        ...loadSettings(),
        supabaseLastRemoteUpdatedAt: row.updated_at || loadSettings().supabaseLastRemoteUpdatedAt,
        supabaseLastPushedHash: payloadHash()
      });
      if (manual && !silent) showNotif('✓ Données envoyées vers Supabase', 'success');
    } else if (manual && !silent && !pulled) {
      showNotif('Déjà à jour avec le cloud', 'success');
    }
    updateSupabaseStatusLine();
    return { ok: true };
  } catch (e) {
    console.warn('Supabase sync', e);
    const msg = e && e.message ? e.message : String(e);
    updateSupabaseStatusLine('Erreur : ' + msg, true);
    if (manual) showNotif('Sync : ' + msg, 'error');
    return { ok: false, msg };
  } finally {
    supabaseSyncInFlight = false;
  }
}

function initSupabaseSqlTextarea() {
  const ta = document.getElementById('supabaseSqlTa');
  if (ta && !ta.value.trim()) ta.value = SUPABASE_SETUP_SQL.trim();
}

function toggleSupabaseHelpPanel() {
  const p = document.getElementById('supabaseHelpPanel');
  const btn = document.getElementById('supabaseHelpToggle');
  if (!p || !btn) return;
  const open = p.hidden;
  p.hidden = !open;
  btn.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function copySupabaseSql() {
  initSupabaseSqlTextarea();
  const ta = document.getElementById('supabaseSqlTa');
  if (!ta) return;
  ta.select();
  ta.setSelectionRange(0, ta.value.length);
  try {
    navigator.clipboard.writeText(ta.value);
    showNotif('Script SQL copié', 'success');
  } catch {
    try {
      document.execCommand('copy');
      showNotif('Script SQL copié', 'success');
    } catch {
      showNotif('Copie manuelle : Ctrl+C', '');
    }
  }
}

function onSupabaseSyncToggleChange() {
  const on = document.getElementById('supabaseSyncEnabled').checked;
  const prev = loadSettings();
  saveSettings({ ...prev, supabaseSyncEnabled: on });
  if (on && getSupabaseConfig().ok) {
    startSupabaseSyncTimer();
  } else {
    stopSupabaseSyncTimer();
    if (on && !getSupabaseConfig().ok) {
      showNotif('Renseignez l’URL et la clé anon, puis « Connecter & synchroniser »', '');
    }
  }
  updateSupabaseStatusLine();
}

function onSupabaseDailySyncToggleChange() {
  const el = document.getElementById('supabaseDailySyncEnabled');
  const on = el && el.checked;
  const prev = loadSettings();
  saveSettings({ ...prev, supabaseDailySyncEnabled: !!on });
  localStorage.removeItem(SUPABASE_SCHEDULE_MARKER_KEY);
  if (loadSettings().supabaseSyncEnabled && getSupabaseConfig().ok) {
    startSupabaseScheduleTimerIfNeeded();
  }
  updateSupabaseStatusLine();
}

function onSupabaseDailySyncTimeChange() {
  const el = document.getElementById('supabaseDailySyncTime');
  const t = el && el.value ? el.value : '';
  const prev = loadSettings();
  saveSettings({ ...prev, supabaseDailySyncTime: t });
  localStorage.removeItem(SUPABASE_SCHEDULE_MARKER_KEY);
  if (loadSettings().supabaseSyncEnabled && getSupabaseConfig().ok) {
    startSupabaseScheduleTimerIfNeeded();
  }
  updateSupabaseStatusLine();
}

async function connectSupabaseSync() {
  const url = document.getElementById('supabaseUrl').value.trim();
  const key = document.getElementById('supabaseAnonKey').value.trim();
  if (!url || !key) {
    showNotif('URL et clé anon obligatoires', 'error');
    return;
  }
  if (!/^https:\/\/.+/i.test(url)) {
    showNotif('L’URL doit commencer par https://', 'error');
    return;
  }
  const prev = loadSettings();
  const dailyCb = document.getElementById('supabaseDailySyncEnabled');
  const dailyTm = document.getElementById('supabaseDailySyncTime');
  saveSettings({
    ...prev,
    supabaseUrl: url,
    supabaseAnonKey: key,
    supabaseSyncEnabled: true,
    supabaseDailySyncEnabled: !!(dailyCb && dailyCb.checked),
    supabaseDailySyncTime:
      dailyTm && dailyTm.value ? dailyTm.value : prev.supabaseDailySyncTime || '03:00'
  });
  const chk = document.getElementById('supabaseSyncEnabled');
  if (chk) chk.checked = true;
  updateSupabaseStatusLine();
  const r = await supabaseSyncTick({ silent: false, manual: true });
  if (r.ok) {
    startSupabaseSyncTimer({ immediate: false });
  } else {
    const cur = loadSettings();
    saveSettings({ ...cur, supabaseSyncEnabled: false });
    if (chk) chk.checked = false;
    updateSupabaseStatusLine();
  }
}

async function syncSupabaseNow() {
  await supabaseSyncTick({ silent: false, manual: true });
}

function disconnectSupabaseSync() {
  stopSupabaseSyncTimer();
  localStorage.removeItem(SUPABASE_SCHEDULE_MARKER_KEY);
  const prev = loadSettings();
  saveSettings({
    ...prev,
    supabaseSyncEnabled: false,
    supabaseUrl: '',
    supabaseAnonKey: '',
    supabaseLastRemoteUpdatedAt: '',
    supabaseLastPushedHash: '',
    supabaseDailySyncEnabled: false,
    supabaseDailySyncTime: '03:00'
  });
  const chk = document.getElementById('supabaseSyncEnabled');
  if (chk) chk.checked = false;
  const u = document.getElementById('supabaseUrl');
  const k = document.getElementById('supabaseAnonKey');
  if (u) u.value = '';
  if (k) k.value = '';
  const sbD = document.getElementById('supabaseDailySyncEnabled');
  const sbT = document.getElementById('supabaseDailySyncTime');
  if (sbD) sbD.checked = false;
  if (sbT) sbT.value = '03:00';
  updateSupabaseStatusLine('Déconnecté — identifiants effacés de cet appareil.');
  showNotif('Supabase déconnecté', 'success');
}

function refreshCaissePasswordUi() {
  const statusEl = document.getElementById('caissePwStatusLine');
  if (!statusEl) return;
  const hasFn = typeof window.appLockHasCaissePassword === 'function';
  const hasPw = hasFn ? !!window.appLockHasCaissePassword() : false;
  if (!hasFn) {
    statusEl.textContent = 'État indisponible : module de sécurité non chargé.';
    return;
  }
  statusEl.textContent = hasPw
    ? 'Mot de passe caisse : configuré.'
    : 'Mot de passe caisse : non défini (mot de passe admin utilisé).';
}

async function saveCaissePasswordUi() {
  const aEl = document.getElementById('sCaissePw');
  const bEl = document.getElementById('sCaissePw2');
  const a = aEl ? String(aEl.value || '') : '';
  const b = bEl ? String(bEl.value || '') : '';
  if (!a || a.length < 4) {
    showNotif('Le mot de passe caisse doit contenir au moins 4 caractères', 'error');
    return;
  }
  if (a !== b) {
    showNotif('Les deux mots de passe ne correspondent pas', 'error');
    return;
  }
  if (typeof window.appLockSetCaissePassword !== 'function') {
    showNotif('Module de sécurité indisponible', 'error');
    return;
  }
  try {
    await window.appLockSetCaissePassword(a);
    if (aEl) aEl.value = '';
    if (bEl) bEl.value = '';
    refreshCaissePasswordUi();
    showNotif('✓ Mot de passe caisse enregistré', 'success');
  } catch (e) {
    showNotif((e && e.message) || 'Impossible d’enregistrer le mot de passe caisse', 'error');
  }
}

async function clearCaissePasswordUi() {
  if (typeof window.appLockClearCaissePassword !== 'function') {
    showNotif('Module de sécurité indisponible', 'error');
    return;
  }
  const ok = await showModalConfirm({
    title: 'Supprimer le mot de passe caisse',
    message: 'La connexion Caisse utilisera ensuite le mot de passe administrateur. Continuer ?',
    confirmText: 'Supprimer',
    cancelText: 'Annuler'
  });
  if (!ok) return;
  try {
    window.appLockClearCaissePassword();
    const aEl = document.getElementById('sCaissePw');
    const bEl = document.getElementById('sCaissePw2');
    if (aEl) aEl.value = '';
    if (bEl) bEl.value = '';
    refreshCaissePasswordUi();
    showNotif('Mot de passe caisse supprimé', 'success');
  } catch {
    showNotif('Impossible de supprimer le mot de passe caisse', 'error');
  }
}

function fillSettingsForm() {
  const s = loadSettings();
  document.getElementById('sNomCafe').value = s.nomCafe || '';
  document.getElementById('sAdresse').value = s.adresse || '';
  document.getElementById('sTel').value = s.tel || '';
  document.getElementById('sEmail').value = s.email || '';
  document.getElementById('sNbTables').value = s.nbTables !== undefined && s.nbTables !== null ? s.nbTables : '';
  document.getElementById('sMsgTicket').value = s.messageTicket || '';
  const catTa = document.getElementById('sCategories');
  if (catTa) catTa.value = getStockCategories().join('\n');
  initSupabaseSqlTextarea();
  const sbUrl = document.getElementById('supabaseUrl');
  const sbKey = document.getElementById('supabaseAnonKey');
  const sbEn = document.getElementById('supabaseSyncEnabled');
  if (sbUrl) sbUrl.value = s.supabaseUrl || '';
  if (sbKey) sbKey.value = s.supabaseAnonKey || '';
  if (sbEn) sbEn.checked = !!s.supabaseSyncEnabled;
  const sbDaily = document.getElementById('supabaseDailySyncEnabled');
  const sbTime = document.getElementById('supabaseDailySyncTime');
  if (sbDaily) sbDaily.checked = !!s.supabaseDailySyncEnabled;
  if (sbTime) sbTime.value = s.supabaseDailySyncTime || '03:00';
  const caissePw = document.getElementById('sCaissePw');
  const caissePw2 = document.getElementById('sCaissePw2');
  if (caissePw) caissePw.value = '';
  if (caissePw2) caissePw2.value = '';
  refreshCaissePasswordUi();
  updateSupabaseStatusLine();
  updateBackupReminder();
}

function saveCategoriesUi() {
  const raw = document.getElementById('sCategories').value;
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const prev = loadSettings();
  saveSettings({ ...prev, categories: lines.length ? lines : null });
  refreshCategorySelects();
  renderCatFilter();
  renderArticles();
  showNotif('✓ Catégories enregistrées', 'success');
}

function saveSettingsUi() {
  const prev = loadSettings();
  const next = {
    ...prev,
    nomCafe: document.getElementById('sNomCafe').value.trim(),
    adresse: document.getElementById('sAdresse').value.trim(),
    tel: document.getElementById('sTel').value.trim(),
    email: document.getElementById('sEmail').value.trim(),
    nbTables: document.getElementById('sNbTables').value.trim(),
    messageTicket: document.getElementById('sMsgTicket').value.trim() || 'Merci de votre visite !',
    serveurs: prev.serveurs || []
  };
  saveSettings(next);
  applyHeaderBranding();
  renderServeurSelect();
  renderTableSelectForCaisse();
  populateHistoTableFilter();
  showNotif('✓ Informations enregistrées', 'success');
}

function renderServeursEditor() {
  const s = loadSettings();
  const list = s.serveurs && s.serveurs.length ? s.serveurs : [{ id: uid(), prenom: '' }];
  const box = document.getElementById('serveursList');
  box.innerHTML = list.map((x, i) => {
    const sid = String(x.id != null ? x.id : i);
    return `
    <div class="serveur-row" data-sid="${escapeAttr(sid)}">
      <input class="form-input" type="text" placeholder="Prénom" value="${escapeAttr(x.prenom || '')}">
      <button type="button" class="btn-small danger" data-remove-sid="${escapeAttr(sid)}">✕</button>
    </div>`;
  }).join('');
}

function addServeurRow() {
  const s = loadSettings();
  const inputs = [...document.querySelectorAll('#serveursList .serveur-row input')].map((inp, i) => ({
    id: inp.closest('.serveur-row').dataset.sid || uid(),
    prenom: inp.value.trim()
  }));
  inputs.push({ id: uid(), prenom: '' });
  s.serveurs = inputs;
  saveSettings(s);
  renderServeursEditor();
}

function removeServeurRow(sid) {
  const s = loadSettings();
  const target = String(sid);
  const rows = [...document.querySelectorAll('#serveursList .serveur-row')];
  const kept = [];
  rows.forEach(row => {
    if (row.dataset.sid === target) return;
    const inp = row.querySelector('input');
    kept.push({ id: row.dataset.sid, prenom: inp ? inp.value.trim() : '' });
  });
  s.serveurs = kept.length ? kept : [{ id: uid(), prenom: '' }];
  saveSettings(s);
  renderServeursEditor();
}

function saveServeursUi() {
  const prev = loadSettings();
  const rows = [...document.querySelectorAll('#serveursList .serveur-row')];
  const serveurs = rows.map(row => ({
    id: row.dataset.sid || uid(),
    prenom: (row.querySelector('input') && row.querySelector('input').value.trim()) || ''
  })).filter(x => x.prenom);
  saveSettings({ ...prev, serveurs });
  renderServeurSelect();
  showNotif('✓ Serveurs enregistrés', 'success');
}

function exportFullBackup() {
  const snap = getFullSnapshot();
  const blob = new Blob([JSON.stringify(snap, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `coffe_caisse_backup_${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  const ok = safeLocalSetItem(LAST_BACKUP_KEY, new Date().toISOString());
  if (!ok) notifyLocalStorageUnavailableOnce('Stockage indisponible — données non sauvegardées');
  updateBackupReminder();
  syncToOpfs();
  showNotif('✓ Sauvegarde exportée', 'success');
}

function importFullBackup(ev) {
  const f = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const data = JSON.parse(r.result);
      if (!data || typeof data !== 'object') throw new Error('Fichier invalide');
      if (data.articles && Array.isArray(data.articles)) {
        const ok = safeLocalSetItem(STORAGE_KEY, JSON.stringify(data.articles.map(migrateArticle)));
        if (!ok) notifyLocalStorageUnavailableOnce('Stockage indisponible — données non sauvegardées');
        articles = loadArticles();
      }
      if (data.factures && Array.isArray(data.factures)) {
        saveFactures(data.factures);
        // Factures chargées en mémoire via saveFactures() -> mise à jour compteur.
        recomputeNextFactureNumFromList(facturesAll || loadFactures());
      }
      if (data.settings && typeof data.settings === 'object') {
        saveSettings({ ...defaultSettings(), ...data.settings });
      }
      if (data.zSession !== undefined && data.zSession !== null) {
        const ok = safeLocalSetItem(Z_SESSION_KEY, JSON.stringify(data.zSession));
        if (!ok) notifyLocalStorageUnavailableOnce('Stockage indisponible — données non sauvegardées');
      } else if (data.zSession === null) {
        localStorage.removeItem(Z_SESSION_KEY);
      }
      if (typeof data.lastBackupAt === 'string' && data.lastBackupAt) {
        const ok = safeLocalSetItem(LAST_BACKUP_KEY, data.lastBackupAt);
        if (!ok) notifyLocalStorageUnavailableOnce('Stockage indisponible — données non sauvegardées');
      }
      syncToOpfs();
      renderCatFilter();
      renderArticles();
      renderStock();
      renderServeurSelect();
      renderTableSelectForCaisse();
      populateHistoTableFilter();
      applyHeaderBranding();
      updateZHeader();
      renderZPanel();
      updateBackupReminder();
      showNotif('✓ Données importées', 'success');
    } catch (e) {
      showNotif('Import impossible : fichier JSON invalide', 'error');
    }
  };
  r.readAsText(f);
}

// ===================== NAV =====================
function getAccessMode() {
  return sessionStorage.getItem(ACCESS_MODE_KEY) || 'admin';
}

function refreshAccessModeUi() {
  const mode = getAccessMode();
  const isPlatform = mode === 'platform';
  document.body.classList.toggle('access-mode-platform', isPlatform);
  document.querySelectorAll('.tab[data-page]').forEach((tab) => {
    const page = tab.getAttribute('data-page');
    const allow = !isPlatform || page === 'caisse';
    tab.hidden = !allow;
    tab.disabled = !allow;
    tab.setAttribute('aria-hidden', allow ? 'false' : 'true');
  });
  if (isPlatform) showPage('caisse');
}

function showPage(id) {
  if (getAccessMode() === 'platform' && id !== 'caisse') id = 'caisse';
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  const pageEl = document.getElementById('page-' + id);
  if (pageEl) pageEl.classList.add('active');
  document.querySelectorAll('.tab').forEach(t => {
    if (t.getAttribute('data-page') === id) t.classList.add('active');
  });
  if (id === 'historique') renderHistorique();
  if (id === 'stock') { refreshCategorySelects(); renderStock(); buildIconPicker(); }
  if (id === 'caisse') {
    syncRushCheckbox();
    setCaisseMobilePane('articles');
    renderArticles();
    renderServeurSelect();
    renderTableSelectForCaisse();
    syncCustomSelect('payModeSelect');
    renderPanier();
    applyHeaderBranding();
    updateZHeader();
  }
  if (id === 'parametres') {
    fillSettingsForm();
    renderServeursEditor();
    refreshStorageUi();
    renderZPanel();
    updateBackupReminder();
  }
}

// ===================== NOTIF =====================
let notifTimer;
let deferredInstallPromptEvent = null;
const INSTALL_BANNER_DISMISSED_KEY = 'coffe_install_banner_dismissed';
function showNotif(msg, type) {
  const el = document.getElementById('notif');
  el.textContent = msg;
  el.className = 'notif show ' + type;
  clearTimeout(notifTimer);
  notifTimer = setTimeout(() => el.classList.remove('show'), 2500);
}

function isRunningStandalone() {
  const mediaStandalone = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  const iosStandalone = window.navigator && window.navigator.standalone === true;
  return !!(mediaStandalone || iosStandalone);
}

function setInstallBannerVisible(visible) {
  const el = document.getElementById('installBanner');
  if (!el) return;
  el.hidden = !visible;
}

function maybeShowInstallBanner() {
  const dismissed = safeLocalGetItem(INSTALL_BANNER_DISMISSED_KEY) === '1';
  const canPrompt = !!deferredInstallPromptEvent;
  if (dismissed || isRunningStandalone() || !canPrompt) {
    setInstallBannerVisible(false);
    return;
  }
  setInstallBannerVisible(true);
}

function bindInstallBanner() {
  const btnInstall = document.getElementById('installBannerBtn');
  const btnClose = document.getElementById('installBannerClose');
  if (btnInstall && !btnInstall.dataset.bound) {
    btnInstall.dataset.bound = '1';
    btnInstall.addEventListener('click', async () => {
      if (!deferredInstallPromptEvent) return;
      try {
        await deferredInstallPromptEvent.prompt();
        await deferredInstallPromptEvent.userChoice;
      } catch {
        /* ignore */
      } finally {
        deferredInstallPromptEvent = null;
        setInstallBannerVisible(false);
      }
    });
  }
  if (btnClose && !btnClose.dataset.bound) {
    btnClose.dataset.bound = '1';
    btnClose.addEventListener('click', () => {
      safeLocalSetItem(INSTALL_BANNER_DISMISSED_KEY, '1');
      setInstallBannerVisible(false);
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPromptEvent = e;
    maybeShowInstallBanner();
  });

  window.addEventListener('appinstalled', () => {
    deferredInstallPromptEvent = null;
    safeLocalSetItem(INSTALL_BANNER_DISMISSED_KEY, '1');
    setInstallBannerVisible(false);
  });
}

// ===================== DATE =====================
function updateDate() {
  const now = new Date();
  document.getElementById('headerDate').textContent = now.toLocaleDateString('fr-FR', {
    weekday: 'short', day: '2-digit', month: 'short'
  }) + ' ' + now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

// ===================== INIT =====================
(async function initApp() {
  if (typeof initAppLock === 'function') initAppLock();
  // D'abord : restauration depuis OPFS (si localStorage a été nettoyé).
  const didRestore = await restoreFromOpfsOnStartup();
  opfsRestoreSucceeded = !!didRestore;
  opfsRestoreUiShown = false;
  if (didRestore) {
    // Confirmation UI après restauration automatique.
    try {
      showNotif('Restauration OPFS : données restaurées', 'success');
    } catch {
      /* ignore */
    }
  }

  refreshAccessModeUi();
  bindUiClickDelegates();
  updateDate();
  setInterval(updateDate, 30000);
  applyHeaderBranding();
  renderServeurSelect();
  renderTableSelectForCaisse();
  syncCustomSelect('payModeSelect');
  refreshCategorySelects();
  buildIconPicker();
  renderCatFilter();
  syncRushCheckbox();
  renderArticles();
  renderPanier();
  updateZHeader();
  renderZPanel();
  updateBackupReminder();
  startCaisseLockHeartbeat();
  syncToOpfs();
  initSupabaseSqlTextarea();
  bindInstallBanner();
  maybeShowInstallBanner();
  if (loadSettings().supabaseSyncEnabled && getSupabaseConfig().ok) startSupabaseSyncTimer();
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    closeAllCustomSelects();
    const ov = document.getElementById('modalOverlay');
    if (ov && ov.classList.contains('open')) closeModal();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') syncToOpfs();
  });
  // Mobile/iOS : pagehide est plus fiable que beforeunload pour déclencher une dernière sync.
  window.addEventListener('pagehide', () => {
    syncToOpfs();
  });
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {});
  }
})();
