/**
 * Supervision COFFE — Supabase + filtres historique (comme l’onglet Historique de la caisse).
 */
const LS_URL = 'coffe_controle_supabase_url';
const LS_KEY = 'coffe_controle_supabase_key';
const MAX_FACTURES_RENDER = 200;
const LS_LAST_DATA = 'coffe_controle_last_data';

let cachedArticles = [];
let cachedFactures = [];
let cachedUpdatedAt = null;
let controlePreset = 'month';
let controleTableFilter = '';
let deferredInstallPrompt = null;

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(t) {
  const d = document.createElement('div');
  d.textContent = t == null ? '' : String(t);
  return d.innerHTML;
}

function escapeAttr(t) {
  return String(t).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeTicketHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadSavedConfig() {
  try {
    $('cfgUrl').value = localStorage.getItem(LS_URL) || '';
    $('cfgKey').value = localStorage.getItem(LS_KEY) || '';
  } catch {
    /* ignore */
  }
}

function saveConfig(url, key) {
  try {
    localStorage.setItem(LS_URL, url);
    localStorage.setItem(LS_KEY, key);
  } catch {
    /* ignore */
  }
}

function saveLastDataCache() {
  try {
    const payload = {
      articles: cachedArticles,
      factures: cachedFactures,
      updatedAt: cachedUpdatedAt,
      savedAt: new Date().toISOString()
    };
    localStorage.setItem(LS_LAST_DATA, JSON.stringify(payload));
  } catch {
    /* ignore */
  }
}

function loadLastDataCache() {
  try {
    const raw = localStorage.getItem(LS_LAST_DATA);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function setStatus(type, message) {
  const el = $('syncStatus');
  el.className = 'status-banner visible ' + (type === 'ok' ? 'ok' : 'err');
  el.textContent = message;
}

function clearStatus() {
  const el = $('syncStatus');
  el.className = 'status-banner';
  el.textContent = '';
}

function isPwaInstalled() {
  const mq = window.matchMedia && window.matchMedia('(display-mode: standalone)').matches;
  return mq || window.navigator.standalone === true;
}

function updatePwaInstallState() {
  const banner = $('pwaBanner');
  const text = $('pwaStateText');
  const btn = $('btnInstallPwa');
  if (!banner || !text || !btn) return;
  banner.hidden = false;
  const installed = isPwaInstalled();
  if (installed) {
    text.textContent = 'Application installee.';
    btn.hidden = true;
    return;
  }
  text.textContent = deferredInstallPrompt
    ? "Application non installee. Vous pouvez l'installer."
    : "Application non installee. Utilisez le menu du navigateur pour l'installer.";
  btn.hidden = !deferredInstallPrompt;
}

async function handleInstallClick() {
  if (!deferredInstallPrompt) {
    updatePwaInstallState();
    return;
  }
  deferredInstallPrompt.prompt();
  try {
    await deferredInstallPrompt.userChoice;
  } catch {
    /* ignore */
  }
  deferredInstallPrompt = null;
  updatePwaInstallState();
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./service-worker.js').catch(() => {
      /* ignore */
    });
  });
}

async function fetchSupabaseRow(url, key) {
  const base = url.replace(/\/$/, '');
  const res = await fetch(
    base + '/rest/v1/coffeeshop_data?select=articles,factures,updated_at&id=eq.default',
    {
      headers: {
        apikey: key,
        Authorization: 'Bearer ' + key
      }
    }
  );
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || res.statusText || String(res.status));
  }
  const rows = text ? JSON.parse(text) : [];
  return rows[0] || null;
}

/* ---------- Dates & filtres (aligné app caisse) ---------- */
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

function getControleRange(allFactures) {
  const now = new Date();
  if (controlePreset === 'custom') {
    const fromVal = $('controleDateFrom') && $('controleDateFrom').value;
    const toVal = $('controleDateTo') && $('controleDateTo').value;
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
  if (controlePreset === 'today') return startEndOfDay(now);
  if (controlePreset === 'week') {
    const s = startOfWeekMonday(now);
    const e = new Date(s);
    e.setDate(e.getDate() + 6);
    e.setHours(23, 59, 59, 999);
    return { start: s, end: e };
  }
  if (controlePreset === 'month') {
    const s = new Date(now.getFullYear(), now.getMonth(), 1);
    const e = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999);
    return { start: s, end: e };
  }
  if (controlePreset === 'lastmonth') {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const e = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
    return { start: s, end: e };
  }
  if (controlePreset === 'all') {
    if (!allFactures.length) {
      const { start, end } = startEndOfDay(now);
      return { start, end };
    }
    const times = allFactures.map((f) => new Date(f.date).getTime());
    return { start: new Date(Math.min(...times)), end: new Date(Math.max(...times)) };
  }
  return startEndOfDay(now);
}

function syncControleDateInputs(range, allFactures) {
  const fromEl = $('controleDateFrom');
  const toEl = $('controleDateTo');
  if (!fromEl || !toEl || !range) return;
  if (controlePreset === 'custom') return;
  if (controlePreset === 'all' && allFactures.length) {
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

function applyControleTableFilter(filtered) {
  if (controleTableFilter === '__vide__') return filtered.filter((f) => !(f.table || '').trim());
  if (controleTableFilter) return filtered.filter((f) => String(f.table || '') === controleTableFilter);
  return filtered;
}

function populateControleTableFilter() {
  const sel = $('controleTableFilter');
  if (!sel) return;
  const keep = controleTableFilter;
  const seen = new Set();
  let html = '<option value="">Toutes les tables</option>';
  (cachedFactures || []).forEach((f) => {
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
    controleTableFilter = '';
  }
}

function factureCompteCA(f) {
  if (!f || f.statut === 'annulee') return 0;
  return Number(f.total) || 0;
}

function factureCompteStats(f) {
  return f && f.statut !== 'annulee';
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
      return {
        label:
          nDays <= 7
            ? new Date(Number(y), Number(m) - 1, Number(day)).toLocaleDateString('fr-FR', {
                weekday: 'short',
                day: 'numeric'
              })
            : short,
        ca,
        sortKey: key
      };
    });
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

function setControlePreset(p) {
  controlePreset = p;
  document.querySelectorAll('.controle-chip').forEach((btn) => {
    btn.classList.toggle('active', btn.getAttribute('data-preset') === p);
  });
  refreshFilteredView();
}

function applyControleCustomRange() {
  controlePreset = 'custom';
  document.querySelectorAll('.controle-chip').forEach((b) => b.classList.remove('active'));
  refreshFilteredView();
}

function setupCalendarOnlyDateInputs() {
  const ids = ['controleDateFrom', 'controleDateTo'];
  ids.forEach((id) => {
    const el = $(id);
    if (!el) return;
    el.setAttribute('inputmode', 'none');
    el.addEventListener('keydown', (e) => e.preventDefault());
    el.addEventListener('paste', (e) => e.preventDefault());
    el.addEventListener('drop', (e) => e.preventDefault());
    const openPicker = () => {
      if (typeof el.showPicker === 'function') {
        try {
          el.showPicker();
        } catch {
          /* ignore */
        }
      }
    };
    el.addEventListener('focus', openPicker);
    el.addEventListener('click', openPicker);
  });
}

function refreshFilteredView() {
  const all = cachedFactures;
  const toolbar = $('controleHistoToolbar');
  const rangeLbl = $('controleRangeLabel');
  if (!all.length) {
    if (toolbar) toolbar.hidden = true;
    if (rangeLbl) rangeLbl.hidden = true;
    $('statFacturesPeriod').textContent = '0';
    $('statCaPeriod').textContent = '0 MAD';
    $('statFacturesTotal').textContent = '0';
    renderFactures([]);
    return;
  }
  if (toolbar) toolbar.hidden = false;
  if (rangeLbl) rangeLbl.hidden = false;

  let range = getControleRange(all);
  if (!range) {
    const n = new Date();
    range = {
      start: new Date(n.getFullYear(), n.getMonth(), 1),
      end: new Date(n.getFullYear(), n.getMonth() + 1, 0, 23, 59, 59, 999)
    };
  }
  syncControleDateInputs(range, all);

  let filtered = all.filter((f) => factureInRange(f, range.start, range.end));
  filtered = applyControleTableFilter(filtered);

  const tf =
    controleTableFilter === '__vide__'
      ? ' · filtre : sans table'
      : controleTableFilter
        ? ` · filtre : table ${controleTableFilter}`
        : '';
  rangeLbl.textContent = `Période affichée : ${formatRangeLabel(range)}${tf}`;

  const na = Array.isArray(cachedArticles) ? cachedArticles.length : 0;
  const caPeriod = filtered.reduce((s, f) => s + factureCompteCA(f), 0);
  $('statArticles').textContent = String(na);
  $('statFacturesPeriod').textContent = String(filtered.length);
  $('statCaPeriod').textContent = caPeriod.toFixed(0) + ' MAD';
  $('statFacturesTotal').textContent = String(all.length);

  renderFactures(filtered);
}

function updateCloudTimestamp(updatedAt) {
  if (updatedAt) {
    const d = new Date(updatedAt);
    $('statUpdated').textContent = Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('fr-FR');
  } else {
    $('statUpdated').textContent = '—';
  }
}

/* ---------- Rendu stock / factures ---------- */
function stockIllimite(a) {
  return !!(a && (a.stockIllimite || a.stock === 999));
}

function stockLabel(a) {
  if (stockIllimite(a)) return '∞';
  return a.stock != null ? String(a.stock) : '—';
}

function renderStock(articles) {
  const wrap = $('stockTableWrap');
  if (!Array.isArray(articles) || articles.length === 0) {
    wrap.innerHTML = '<p class="empty-placeholder">Aucun article dans les données synchronisées.</p>';
    return;
  }
  const rows = articles
    .map((a) => {
      const nom = escapeHtml(a.nom || '');
      const cat = escapeHtml(a.cat || '');
      const emoji = escapeHtml(a.emoji || '☕');
      const prix = Number(a.prix);
      const p = Number.isFinite(prix) ? prix.toFixed(2) : '—';
      const st = stockLabel(a);
      const vendu = a.vendu != null ? String(a.vendu) : '0';
      return `<tr>
        <td>${emoji}</td>
        <td>${nom}</td>
        <td>${cat}</td>
        <td class="num">${p}</td>
        <td class="num">${escapeHtml(st)}</td>
        <td class="num">${escapeHtml(vendu)}</td>
      </tr>`;
    })
    .join('');
  wrap.innerHTML = `
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th></th>
            <th>Article</th>
            <th>Catégorie</th>
            <th class="num">Prix (MAD)</th>
            <th class="num">Stock</th>
            <th class="num">Vendu</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderFactures(factures) {
  const wrap = $('facturesList');
  if (!Array.isArray(factures) || factures.length === 0) {
    wrap.innerHTML =
      '<p class="empty-placeholder">Aucune facture pour cette période / ce filtre.</p>';
    return;
  }
  const sorted = [...factures].sort((a, b) => new Date(b.date) - new Date(a.date));
  const visible = sorted.slice(0, MAX_FACTURES_RENDER);
  const isTruncated = sorted.length > MAX_FACTURES_RENDER;
  const cardsHtml = visible
    .map((f) => {
      const st = f.statut || 'valide';
      const badgeClass =
        st === 'annulee' ? 'badge-annulee' : st === 'avoir' ? 'badge-avoir' : 'badge-valide';
      const badgeText = st === 'annulee' ? 'Annulé' : st === 'avoir' ? 'Avoir' : 'Valide';
      const d = f.date ? new Date(f.date) : null;
      const dateStr = d
        ? d.toLocaleDateString('fr-FR') + ' ' + d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })
        : '—';
      const num = String(f.num != null ? f.num : '').padStart(4, '0');
      const total = Number(f.total);
      const totStr = Number.isFinite(total) ? total.toFixed(2) + ' MAD' : '—';
      const items = (f.items || [])
        .map((p) => {
          const line = escapeHtml(p.nom || '') + ' ×' + (p.qty != null ? p.qty : '');
          const sub = Number(p.prix) * Number(p.qty);
          const subStr = Number.isFinite(sub) ? sub.toFixed(2) : '—';
          return `<li><span>${line}</span><span class="num">${escapeHtml(subStr)}</span></li>`;
        })
        .join('');
      const tbl = f.table ? ` · Table ${escapeHtml(String(f.table))}` : '';
      const srv = f.serveur ? ` · ${escapeHtml(String(f.serveur))}` : '';
      return `
      <article class="facture-card">
        <div class="facture-card-head">
          <span class="facture-num">#${escapeHtml(num)}</span>
          <span class="facture-total">${escapeHtml(totStr)}</span>
        </div>
        <div class="facture-meta">
          <span class="badge ${badgeClass}">${badgeText}</span>
          ${escapeHtml(String(f.client || 'Client'))}${tbl}${srv}
          <br><span style="color:var(--text3)">${escapeHtml(dateStr)}</span>
        </div>
        ${items ? `<ul class="facture-items">${items}</ul>` : ''}
      </article>`;
    })
    .join('');
  const limitMsg = isTruncated
    ? `<p class="hint" style="margin:0 0 8px">Affichage limité aux ${MAX_FACTURES_RENDER} factures les plus récentes (${sorted.length} sur la période). Exportez en JSON pour consulter tout l’historique.</p>`
    : '';
  wrap.innerHTML = limitMsg + cardsHtml;
}

/* ---------- Exports ---------- */
function getFilteredFacturesForExport() {
  const all = cachedFactures;
  let range = getControleRange(all);
  if (!range) return [];
  let filtered = all.filter((f) => factureInRange(f, range.start, range.end));
  return applyControleTableFilter(filtered);
}

function exportControlePdf() {
  const all = cachedFactures;
  if (!all.length) {
    setStatus('err', 'Synchronisez d’abord les données.');
    return;
  }
  const range = getControleRange(all);
  if (!range) {
    setStatus('err', 'Indiquez une période valide (du … au …).');
    return;
  }
  let filtered = all.filter((f) => factureInRange(f, range.start, range.end));
  filtered = applyControleTableFilter(filtered);
  const todayR = startEndOfDay(new Date());
  const todayFacts = all.filter((f) => factureInRange(f, todayR.start, todayR.end));
  const caPeriode = filtered.reduce((s, f) => s + factureCompteCA(f), 0);
  const caToday = todayFacts.reduce((s, f) => s + factureCompteCA(f), 0);
  const caTotal = all.reduce((s, f) => s + factureCompteCA(f), 0);
  const series = buildCaSeries(filtered, range.start, range.end);
  const top5 = getTopArticles(filtered);
  const servers = getServerPerformance(filtered);
  const esc = escapeTicketHtml;

  const rowsCa = series
    .map((s) => `<tr><td>${esc(s.label)}</td><td style="text-align:right">${s.ca.toFixed(2)} MAD</td></tr>`)
    .join('');
  const rowsTop = top5
    .map(
      ([nom, v], i) =>
        `<tr><td>${i + 1}</td><td>${esc(nom)}</td><td style="text-align:right">${v.qty}</td><td style="text-align:right">${v.ca.toFixed(2)}</td></tr>`
    )
    .join('');
  const maxSrvCa = servers.length ? Math.max(...servers.map((x) => x[1].ca), 1) : 1;
  const rowsSrv = servers
    .map(([name, v]) => {
      const pct = Math.round((v.ca / maxSrvCa) * 100);
      return `<tr><td>${esc(name)}</td><td style="text-align:right">${v.count}</td><td style="text-align:right">${v.ca.toFixed(2)} MAD</td><td><div style="background:#eee;height:8px;border-radius:4px"><div style="width:${pct}%;height:8px;background:#09BC8A;border-radius:4px"></div></div></td></tr>`;
    })
    .join('');
  const d0 = new Date(range.start.getFullYear(), range.start.getMonth(), range.start.getDate());
  const d1 = new Date(range.end.getFullYear(), range.end.getMonth(), range.end.getDate());
  const pdfSpanDays = Math.round((d1 - d0) / 86400000) + 1;
  const caPdfTitle = pdfSpanDays > 90 ? 'par mois' : 'par jour';

  const tableNote =
    controleTableFilter === '__vide__'
      ? ' · sans table'
      : controleTableFilter
        ? ` · table ${esc(controleTableFilter)}`
        : '';

  const html = `<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><title>Rapport ventes — Supervision</title>
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
<h1>Rapport de vente (supervision)</h1>
<div class="sub">COFFE · ${esc(formatRangeLabel(range))}${tableNote} · généré le ${new Date().toLocaleString('fr-FR')}</div>
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

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const blobUrl = URL.createObjectURL(blob);
  const printWin = window.open(blobUrl, '_blank', 'noopener,noreferrer');
  if (!printWin) {
    URL.revokeObjectURL(blobUrl);
    setStatus(
      'err',
      'Fenêtre bloquée par le navigateur. Autorisez les pop-ups puis relancez « Exporter PDF ».'
    );
    return;
  }
  const cleanup = () => {
    try {
      URL.revokeObjectURL(blobUrl);
    } catch (e) {
      /* ignore */
    }
  };
  // afterprint may not fire consistently on all browsers.
  printWin.addEventListener('afterprint', cleanup, { once: true });
  setTimeout(cleanup, 120000);
  setStatus('ok', 'Rapport ouvert. Dans la fenêtre, enregistrez en PDF depuis Imprimer.');
}

function exportControleJson() {
  const all = cachedFactures;
  if (!all.length) {
    setStatus('err', 'Synchronisez d’abord les données.');
    return;
  }
  const data = getFilteredFacturesForExport();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  const tag = new Date().toISOString().slice(0, 10);
  a.download = `factures_controle_${tag}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus('ok', `Export JSON : ${data.length} facture(s) (période et filtre actuels).`);
}

/* ---------- Sync ---------- */
async function synchroniser() {
  const url = $('cfgUrl').value.trim();
  const key = $('cfgKey').value.trim();
  clearStatus();
  if (!url || !key) {
    setStatus('err', 'Renseignez l’URL du projet et la clé anon.');
    return;
  }
  if (!/^https:\/\/.+/i.test(url)) {
    setStatus('err', 'L’URL doit commencer par https://');
    return;
  }
  const btn = $('btnSync');
  btn.disabled = true;
  btn.textContent = 'Chargement…';
  try {
    const row = await fetchSupabaseRow(url, key);
    saveConfig(url, key);
    if (!row) {
      cachedArticles = [];
      cachedFactures = [];
      cachedUpdatedAt = null;
      $('controleHistoToolbar').hidden = true;
      $('controleRangeLabel').hidden = true;
      updateCloudTimestamp(null);
      $('statFacturesPeriod').textContent = '0';
      $('statCaPeriod').textContent = '0 MAD';
      $('statFacturesTotal').textContent = '0';
      $('statArticles').textContent = '0';
      renderStock([]);
      renderFactures([]);
      setStatus('err', 'Aucune ligne « default » dans coffeeshop_data.');
      return;
    }
    cachedArticles = Array.isArray(row.articles) ? row.articles : [];
    cachedFactures = Array.isArray(row.factures) ? row.factures : [];
    cachedUpdatedAt = row.updated_at;
    saveLastDataCache();
    renderStock(cachedArticles);
    updateCloudTimestamp(cachedUpdatedAt);
    populateControleTableFilter();
    document.querySelectorAll('.controle-chip').forEach((b) => {
      b.classList.toggle('active', b.getAttribute('data-preset') === controlePreset);
    });
    refreshFilteredView();
    setStatus(
      'ok',
      'Données chargées. Dernière mise à jour côté cloud : ' +
        (row.updated_at ? new Date(row.updated_at).toLocaleString('fr-FR') : '—')
    );
  } catch (e) {
    console.warn(e);
    setStatus('err', e.message || String(e));
  } finally {
    btn.disabled = false;
    btn.textContent = 'Synchroniser';
  }
}

function clearLocalConfig() {
  try {
    localStorage.removeItem(LS_URL);
    localStorage.removeItem(LS_KEY);
  } catch {
    /* ignore */
  }
  $('cfgUrl').value = '';
  $('cfgKey').value = '';
  clearStatus();
  cachedArticles = [];
  cachedFactures = [];
  cachedUpdatedAt = null;
  controlePreset = 'month';
  controleTableFilter = '';
  $('controleHistoToolbar').hidden = true;
  $('controleRangeLabel').hidden = true;
  $('statArticles').textContent = '0';
  $('statFacturesPeriod').textContent = '0';
  $('statCaPeriod').textContent = '0 MAD';
  $('statFacturesTotal').textContent = '0';
  $('statUpdated').textContent = '—';
  const sel = $('controleTableFilter');
  if (sel) sel.innerHTML = '<option value="">Toutes les tables</option>';
  renderStock([]);
  renderFactures([]);
  document.querySelectorAll('.controle-chip').forEach((b) => {
    b.classList.toggle('active', b.getAttribute('data-preset') === 'month');
  });
  try {
    localStorage.removeItem(LS_LAST_DATA);
  } catch {
    /* ignore */
  }
  setStatus('ok', 'Déconnecté : URL et clé locales effacées sur cet appareil.');
}

document.addEventListener('DOMContentLoaded', () => {
  loadSavedConfig();
  registerServiceWorker();
  setupCalendarOnlyDateInputs();
  updatePwaInstallState();
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    updatePwaInstallState();
  });
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    updatePwaInstallState();
  });
  const displayModeQuery = window.matchMedia ? window.matchMedia('(display-mode: standalone)') : null;
  if (displayModeQuery && typeof displayModeQuery.addEventListener === 'function') {
    displayModeQuery.addEventListener('change', updatePwaInstallState);
  }

  $('btnSync').addEventListener('click', synchroniser);
  $('btnClear').addEventListener('click', clearLocalConfig);
  $('btnInstallPwa')?.addEventListener('click', handleInstallClick);

  document.querySelectorAll('.controle-chip').forEach((btn) => {
    btn.addEventListener('click', () => setControlePreset(btn.getAttribute('data-preset')));
  });
  $('btnControleApply').addEventListener('click', applyControleCustomRange);
  $('controleTableFilter').addEventListener('change', () => {
    controleTableFilter = $('controleTableFilter').value;
    refreshFilteredView();
  });
  $('btnControlePdf').addEventListener('click', exportControlePdf);
  $('btnControleJson').addEventListener('click', exportControleJson);

  $('statArticles').textContent = '0';
  $('statFacturesPeriod').textContent = '0';
  $('statCaPeriod').textContent = '0 MAD';
  $('statFacturesTotal').textContent = '0';
  $('statUpdated').textContent = '—';
  const cached = loadLastDataCache();
  if (cached && Array.isArray(cached.articles) && Array.isArray(cached.factures)) {
    cachedArticles = cached.articles;
    cachedFactures = cached.factures;
    cachedUpdatedAt = cached.updatedAt || null;
    renderStock(cachedArticles);
    updateCloudTimestamp(cachedUpdatedAt);
    populateControleTableFilter();
    refreshFilteredView();
    setStatus('ok', 'Mode hors ligne: affichage des dernieres donnees synchronisees.');
  } else {
    renderStock([]);
    renderFactures([]);
  }
  document.querySelector('.controle-chip[data-preset="month"]')?.classList.add('active');
});
