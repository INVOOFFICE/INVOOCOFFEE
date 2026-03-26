/**
 * Écran d'accès — rôles (admin / plateforme / démo), mot de passe local, clé d'accès.
 * Clés valides : encodées en base64, jamais affichées dans l'interface.
 */
(function () {
  const STORAGE_HASH = 'coffe_app_pw_hash';
  const STORAGE_SALT = 'coffe_app_pw_salt';
  const STORAGE_CAISSE_HASH = 'coffe_caisse_pw_hash';
  const STORAGE_CAISSE_SALT = 'coffe_caisse_pw_salt';
  const STORAGE_CAISSE_KDF = 'coffe_caisse_pw_kdf';
  const STORAGE_DEMO_UNTIL = 'coffe_demo_until';
  const SESSION_UNLOCK = 'coffe_unlocked';
  const SESSION_DEMO = 'coffe_demo_session';
  const SESSION_LICENSE_GATE = 'coffe_license_setup_ok';
  const SESSION_ACCESS_MODE = 'coffe_access_mode';
  const SESSION_LOGIN_MODE = 'coffe_login_mode';
  const SESSION_LOGIN_FAIL_COUNT = 'coffe_login_fail_count';
  const SESSION_LOGIN_LOCK_UNTIL = 'coffe_login_lock_until';
  const DEMO_MS = 20 * 60 * 1000;

  const STORAGE_PW_KDF = 'coffe_app_pw_kdf';
  const KDF_PBKDF2 = 'pbkdf2-200000-sha256';
  const KDF_SHA256 = 'sha256';
  const PBKDF2_ITERATIONS = 200000;

  // Clés autorisées : on stocke uniquement le SHA-256 (hex) des clés.
  // Ainsi, la valeur originale de la clé n'est pas lisible depuis le code source.
  const LICENSE_SHA256_HEX = [
    'a0a8239b2d325b0ed4acbffa830b7e5fe874e0da2ba55a206e637863a4b18fc1', // INVO3388
    '48e33069b0dad2b244377a423eb03ca041e488e5e935a88cec3fd1c820a5a697' // INVOO3388
  ];

  const WA_PHONE = (window.COFFEE_LOCK_CONFIG && window.COFFEE_LOCK_CONFIG.WA_PHONE ? String(window.COFFEE_LOCK_CONFIG.WA_PHONE) : '').trim();
  const WA_TEXT =
    (window.COFFEE_LOCK_CONFIG && window.COFFEE_LOCK_CONFIG.WA_TEXT ? String(window.COFFEE_LOCK_CONFIG.WA_TEXT) : '').trim() ||
    "Bonjour, je souhaite obtenir une clé d'accès ou de l'aide pour l'application COFFE (caisse).";

  let demoWatchTimer = null;
  let demoCountdownTimer = null;
  let loginLockUiTimer = null;

  function $(id) {
    return document.getElementById(id);
  }

  function hasPassword() {
    return !!(localStorage.getItem(STORAGE_HASH) && localStorage.getItem(STORAGE_SALT));
  }

  function hasCaissePassword() {
    return !!(localStorage.getItem(STORAGE_CAISSE_HASH) && localStorage.getItem(STORAGE_CAISSE_SALT));
  }

  function currentMode() {
    return sessionStorage.getItem(SESSION_ACCESS_MODE) || 'admin';
  }

  function setMode(mode) {
    sessionStorage.setItem(SESSION_ACCESS_MODE, mode);
    if (typeof window.refreshAccessModeUi === 'function') window.refreshAccessModeUi();
  }

  function isSessionUnlocked() {
    return sessionStorage.getItem(SESSION_UNLOCK) === '1';
  }

  function isDemoActive() {
    const u = parseInt(localStorage.getItem(STORAGE_DEMO_UNTIL) || '0', 10);
    return u > 0 && Date.now() < u;
  }

  function updateDemoCountdownUi() {
    const el = $('demoCountdown');
    if (!el) return;
    const until = parseInt(localStorage.getItem(STORAGE_DEMO_UNTIL) || '0', 10);
    const now = Date.now();
    const passwordUnlock = sessionStorage.getItem(SESSION_UNLOCK) === '1';
    if (!until || now >= until || passwordUnlock || currentMode() !== 'demo') {
      el.hidden = true;
      el.textContent = '';
      el.removeAttribute('title');
      el.removeAttribute('aria-label');
      el.classList.remove('demo-countdown--warn', 'demo-countdown--urgent');
      return;
    }
    el.hidden = false;
    const sec = Math.max(0, Math.floor((until - now) / 1000));
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    el.textContent = '\u23f1 ' + m + ':' + String(s).padStart(2, '0');
    el.title = 'Essai gratuit — ' + m + ' min ' + s + ' s restantes';
    el.setAttribute('aria-label', 'Temps restant sur l’essai gratuit : ' + m + ' minutes et ' + s + ' secondes');
    el.classList.toggle('demo-countdown--warn', sec <= 120 && sec > 30);
    el.classList.toggle('demo-countdown--urgent', sec <= 30);
  }

  function startDemoCountdownTicker() {
    if (demoCountdownTimer) clearInterval(demoCountdownTimer);
    demoCountdownTimer = setInterval(updateDemoCountdownUi, 1000);
    updateDemoCountdownUi();
  }

  async function sha256Hex(input) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(String(input)));
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async function validateLicenseInput(value) {
    try {
      const normalized = String(value || '').trim().toUpperCase();
      if (!normalized) return false;
      const h = await sha256Hex(normalized);
      return LICENSE_SHA256_HEX.includes(h);
    } catch {
      return false;
    }
  }

  function showOverlay() {
    const o = $('appLockOverlay');
    if (!o) return;
    o.classList.remove('app-lock-overlay--hidden');
    o.setAttribute('aria-hidden', 'false');
    document.body.classList.add('app-lock-active');
    // Focus "premium" : viser un élément pertinent quand c'est possible.
    if (!focusPreferredForViewId('appLockViewChoose')) focusFirstInOverlay();
  }

  function hideOverlay() {
    const o = $('appLockOverlay');
    if (!o) return;
    o.classList.add('app-lock-overlay--hidden');
    o.setAttribute('aria-hidden', 'true');
    document.body.classList.remove('app-lock-active');
    clearErr();
  }

  function isOverlayVisible() {
    const o = $('appLockOverlay');
    return !!(o && !o.classList.contains('app-lock-overlay--hidden'));
  }

  function getFocusableElementsInOverlay() {
    const overlay = $('appLockOverlay');
    if (!overlay) return [];
    const candidates = overlay.querySelectorAll(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    const list = [];
    candidates.forEach((el) => {
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (el.hidden) return;
      if (el.getAttribute && el.getAttribute('aria-hidden') === 'true') return;
      if (el.disabled) return;
      // Filtre si l'élément est dans un conteneur hidden
      if (el.closest && el.closest('[hidden]')) return;
      // Filtre si display:none (offsetParent null est souvent plus fiable que computedStyle)
      if (typeof el.offsetParent === 'undefined' || el.offsetParent !== null) {
        // pour les <a> sans href actif
        if (tag === 'a' && !el.getAttribute('href')) return;
        list.push(el);
      }
    });
    return list;
  }

  function focusFirstInOverlay() {
    if (!isOverlayVisible()) return;
    const list = getFocusableElementsInOverlay();
    if (!list.length) return;
    // Ne pas voler le focus si on est déjà sur un élément correct
    const active = document.activeElement;
    if (active && list.includes(active)) return;
    requestAnimationFrame(() => {
      try {
        list[0].focus();
      } catch {
        /* ignore */
      }
    });
  }

  function focusPreferredForView(viewId) {
    // Retourne l'élément à focaliser (ou null).
    switch (viewId) {
      case 'appLockViewChoose':
        return $('appLockChooseAdmin');
      case 'appLockViewLicense':
        return $('appLockLicenseInput');
      case 'appLockViewLogin':
        return $('appLockPassword');
      case 'appLockViewSetup':
        return $('appLockNewPw');
      case 'appLockViewForgot':
        return $('appLockMasterForgot');
      case 'appLockViewDemoEnd':
        return $('appLockDemoEndLogin');
      default:
        return null;
    }
  }

  function focusPreferredForViewId(viewId) {
    if (!isOverlayVisible()) return false;
    const el = focusPreferredForView(viewId);
    if (!el || typeof el.focus !== 'function' || el.disabled) return false;
    try {
      el.focus();
      if (typeof el.select === 'function') el.select();
      return true;
    } catch {
      return false;
    }
  }

  function handleOverlayTabTrap(e) {
    if (e.key !== 'Tab') return;
    if (!isOverlayVisible()) return;

    const list = getFocusableElementsInOverlay();
    if (!list.length) return;

    const active = document.activeElement;
    const idx = active ? list.indexOf(active) : -1;

    if (e.shiftKey) {
      if (idx <= 0) {
        e.preventDefault();
        list[list.length - 1].focus();
      }
    } else {
      if (idx === -1 || idx >= list.length - 1) {
        e.preventDefault();
        list[0].focus();
      }
    }
  }

  function clearErr() {
    const e = $('appLockErr');
    if (e) {
      e.textContent = '';
      e.hidden = true;
    }
  }

  function setErr(msg) {
    const e = $('appLockErr');
    if (e) {
      e.textContent = msg;
      e.hidden = !msg;
    }
  }

  function bytesToHex(bytes) {
    return Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }

  function hexToBytes(hex) {
    const h = String(hex || '').trim().toLowerCase();
    if (!h || h.length % 2 !== 0) throw new Error('Invalid hex salt');
    const out = new Uint8Array(h.length / 2);
    for (let i = 0; i < out.length; i++) {
      out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    }
    return out;
  }

  function randomSaltHex(byteLen = 16) {
    return Array.from(crypto.getRandomValues(new Uint8Array(byteLen)))
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('');
  }

  // PBKDF2 peut prendre un peu de temps (200k itérations selon la machine).
  // On affiche un petit message de progression pour éviter que l'utilisateur
  // pense que l'interface a gelé.
  let pbkdf2BusyCount = 0;
  let pbkdf2UiSnapshot = null;
  function setPbkdf2Busy(on) {
    const hint = $('appLockLoginHint');
    const btnIds = ['appLockSubmitLogin', 'appLockSavePw', 'appLockSavePwForgot'];

    if (on) {
      pbkdf2BusyCount++;
      if (pbkdf2BusyCount !== 1) return;

      pbkdf2UiSnapshot = {
        hintText: hint ? hint.textContent : '',
        buttonsDisabled: new Map()
      };

      if (hint) {
        hint.textContent = 'Veuillez patienter… calcul du mot de passe (sécurisation).';
      }

      for (const id of btnIds) {
        const b = $(id);
        if (!b) continue;
        pbkdf2UiSnapshot.buttonsDisabled.set(id, !!b.disabled);
        b.disabled = true;
      }
      return;
    }

    if (pbkdf2BusyCount > 0) pbkdf2BusyCount--;
    if (pbkdf2BusyCount !== 0) return;

    if (pbkdf2UiSnapshot) {
      if (hint) hint.textContent = pbkdf2UiSnapshot.hintText;
      for (const [id, wasDisabled] of pbkdf2UiSnapshot.buttonsDisabled.entries()) {
        const b = $(id);
        if (b) b.disabled = wasDisabled;
      }
    }
    pbkdf2UiSnapshot = null;
  }

  async function sha256PasswordHex(password, saltHex) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(saltHex + '::' + password));
    return bytesToHex(new Uint8Array(buf));
  }

  async function pbkdf2PasswordHex(password, saltHex) {
    setPbkdf2Busy(true);
    try {
      const enc = new TextEncoder();
      const saltBytes = hexToBytes(saltHex);
      const baseKey = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits(
        {
          name: 'PBKDF2',
          salt: saltBytes,
          iterations: PBKDF2_ITERATIONS,
          hash: 'SHA-256'
        },
        baseKey,
        256
      );
      return bytesToHex(new Uint8Array(bits));
    } finally {
      setPbkdf2Busy(false);
    }
  }

  function getStoredKdf() {
    return localStorage.getItem(STORAGE_PW_KDF) || KDF_SHA256;
  }

  function getStoredCaisseKdf() {
    return localStorage.getItem(STORAGE_CAISSE_KDF) || KDF_SHA256;
  }

  function getLoginFailCount() {
    const n = parseInt(sessionStorage.getItem(SESSION_LOGIN_FAIL_COUNT) || '0', 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  }

  function setLoginFailCount(n) {
    const v = Math.max(0, parseInt(String(n || 0), 10) || 0);
    if (v <= 0) sessionStorage.removeItem(SESSION_LOGIN_FAIL_COUNT);
    else sessionStorage.setItem(SESSION_LOGIN_FAIL_COUNT, String(v));
  }

  function getLoginLockUntil() {
    const t = parseInt(sessionStorage.getItem(SESSION_LOGIN_LOCK_UNTIL) || '0', 10);
    return Number.isFinite(t) && t > 0 ? t : 0;
  }

  function setLoginLockUntil(msEpoch) {
    const t = Math.max(0, parseInt(String(msEpoch || 0), 10) || 0);
    if (!t) sessionStorage.removeItem(SESSION_LOGIN_LOCK_UNTIL);
    else sessionStorage.setItem(SESSION_LOGIN_LOCK_UNTIL, String(t));
  }

  function getLoginLockRemainingMs() {
    const until = getLoginLockUntil();
    return until > Date.now() ? until - Date.now() : 0;
  }

  function clearLoginRateLimit() {
    setLoginFailCount(0);
    setLoginLockUntil(0);
  }

  function refreshLoginRateLimitUi() {
    const btn = $('appLockSubmitLogin');
    if (!btn) return;
    const remainingMs = getLoginLockRemainingMs();
    const baseLabel = btn.dataset.baseLabel || btn.textContent || 'Accéder à l’interface';
    btn.dataset.baseLabel = baseLabel;
    if (remainingMs <= 0) {
      btn.disabled = false;
      btn.textContent = baseLabel;
      if (loginLockUiTimer) {
        clearInterval(loginLockUiTimer);
        loginLockUiTimer = null;
      }
      return;
    }
    btn.disabled = true;
    const sec = Math.max(1, Math.ceil(remainingMs / 1000));
    btn.textContent = `Réessayez dans ${sec}s`;
    if (!loginLockUiTimer) {
      loginLockUiTimer = setInterval(() => {
        refreshLoginRateLimitUi();
      }, 250);
    }
  }

  const VIEW_IDS = [
    'appLockViewChoose',
    'appLockViewLicense',
    'appLockViewLogin',
    'appLockViewSetup',
    'appLockViewForgot',
    'appLockViewDemoEnd'
  ];

  function showView(viewId) {
    VIEW_IDS.forEach((id) => {
      const el = $(id);
      if (el) el.hidden = id !== viewId;
    });
    const fs1 = $('appLockForgotStep1');
    const fs2 = $('appLockForgotStep2');
    if (viewId === 'appLockViewForgot') {
      if (fs1) fs1.hidden = false;
      if (fs2) fs2.hidden = true;
      if ($('appLockMasterForgot')) $('appLockMasterForgot').value = '';
    }
    if (viewId === 'appLockViewLicense' && $('appLockLicenseInput')) {
      $('appLockLicenseInput').value = '';
    }
    if (viewId === 'appLockViewSetup') {
      if ($('appLockNewPw')) $('appLockNewPw').value = '';
      if ($('appLockNewPw2')) $('appLockNewPw2').value = '';
    }
    if (viewId === 'appLockViewLogin') refreshLoginRateLimitUi();
    clearErr();
    if (!focusPreferredForViewId(viewId)) focusFirstInOverlay();
  }

  function unlockSession() {
    sessionStorage.removeItem(SESSION_LICENSE_GATE);
    sessionStorage.setItem(SESSION_UNLOCK, '1');
    const pendingMode = sessionStorage.getItem(SESSION_LOGIN_MODE) || 'admin';
    setMode(pendingMode);
    sessionStorage.removeItem(SESSION_LOGIN_MODE);
    hideOverlay();
    startDemoWatcher();
    updateDemoCountdownUi();
  }

  function startDemo() {
    setMode('demo');
    localStorage.setItem(STORAGE_DEMO_UNTIL, String(Date.now() + DEMO_MS));
    sessionStorage.setItem(SESSION_DEMO, '1');
    sessionStorage.removeItem(SESSION_UNLOCK);
    hideOverlay();
    startDemoWatcher();
    updateDemoCountdownUi();
  }

  function startDemoWatcher() {
    if (demoWatchTimer) clearInterval(demoWatchTimer);
    demoWatchTimer = setInterval(() => {
      const u = parseInt(localStorage.getItem(STORAGE_DEMO_UNTIL) || '0', 10);
      if (!u || Date.now() < u) return;
      localStorage.removeItem(STORAGE_DEMO_UNTIL);
      const wasDemo = sessionStorage.getItem(SESSION_DEMO) === '1';
      sessionStorage.removeItem(SESSION_DEMO);
      sessionStorage.removeItem(SESSION_UNLOCK);
      setMode('admin');
      if (wasDemo) {
        showOverlay();
        showView('appLockViewDemoEnd');
      }
      updateDemoCountdownUi();
    }, 2000);
  }

  function logoutAppLock() {
    sessionStorage.removeItem(SESSION_UNLOCK);
    sessionStorage.removeItem(SESSION_LICENSE_GATE);
    sessionStorage.removeItem(SESSION_LOGIN_MODE);
    sessionStorage.removeItem(SESSION_DEMO);
    setMode('admin');
    localStorage.removeItem(STORAGE_DEMO_UNTIL);
    if (demoWatchTimer) {
      clearInterval(demoWatchTimer);
      demoWatchTimer = null;
    }
    try {
      if (typeof closeAllCustomSelects === 'function') closeAllCustomSelects();
      if (typeof closeModal === 'function') closeModal();
    } catch (e) {
      /* ignore */
    }
    showOverlay();
    clearErr();
    showView('appLockViewChoose');
    if (typeof showNotif === 'function') {
      showNotif('Session fermée. Reconnectez-vous pour continuer.', 'ok');
    }
    updateDemoCountdownUi();
  }

  function refreshLockState() {
    let until = parseInt(localStorage.getItem(STORAGE_DEMO_UNTIL) || '0', 10);
    const now = Date.now();
    const demoExpired = until > 0 && now >= until;
    if (demoExpired) {
      localStorage.removeItem(STORAGE_DEMO_UNTIL);
      until = 0;
    }

    const wasDemoSession = sessionStorage.getItem(SESSION_DEMO) === '1';
    if (wasDemoSession && demoExpired && !isSessionUnlocked()) {
      sessionStorage.removeItem(SESSION_DEMO);
      sessionStorage.removeItem(SESSION_UNLOCK);
      setMode('admin');
      showOverlay();
      showView('appLockViewDemoEnd');
      return;
    }
    if (wasDemoSession && !until) {
      sessionStorage.removeItem(SESSION_DEMO);
      if (!isSessionUnlocked()) setMode('admin');
    }

    if (isSessionUnlocked()) {
      hideOverlay();
      startDemoWatcher();
      return;
    }
    if (until > 0 && now < until) {
      hideOverlay();
      startDemoWatcher();
      return;
    }

    showOverlay();
    showView('appLockViewChoose');
  }

  async function submitLicenseFlow() {
    clearErr();
    const raw = ($('appLockLicenseInput') && $('appLockLicenseInput').value) || '';
    if (!(await validateLicenseInput(raw))) {
      setErr('Clé de licence non reconnue.');
      return;
    }
    sessionStorage.setItem(SESSION_LOGIN_MODE, 'admin');
    if (hasPassword()) {
      const hint = $('appLockLoginHint');
      if (hint) hint.textContent = 'Clé validée. Entrez le mot de passe administrateur.';
      showView('appLockViewLogin');
    } else {
      sessionStorage.setItem(SESSION_LICENSE_GATE, '1');
      showView('appLockViewSetup');
    }
  }

  async function submitLogin() {
    clearErr();
    const lockRemaining = getLoginLockRemainingMs();
    if (lockRemaining > 0) {
      const sec = Math.max(1, Math.ceil(lockRemaining / 1000));
      setErr(`Trop d'essais. Réessayez dans ${sec} secondes.`);
      refreshLoginRateLimitUi();
      return;
    }
    const pw = ($('appLockPassword') && $('appLockPassword').value) || '';
    if (!pw) {
      setErr('Saisissez votre mot de passe.');
      return;
    }
    const loginMode = sessionStorage.getItem(SESSION_LOGIN_MODE) || 'admin';
    const useCaissePassword = loginMode === 'platform' && hasCaissePassword();
    const salt = localStorage.getItem(useCaissePassword ? STORAGE_CAISSE_SALT : STORAGE_SALT);
    const stored = localStorage.getItem(useCaissePassword ? STORAGE_CAISSE_HASH : STORAGE_HASH);
    if (!salt || !stored) {
      setErr('Configuration invalide. Recommencez depuis l’accueil.');
      showView('appLockViewChoose');
      return;
    }

    const storedKdf = useCaissePassword ? getStoredCaisseKdf() : getStoredKdf();
    let ok = false;
    if (storedKdf === KDF_PBKDF2) {
      const h = await pbkdf2PasswordHex(pw, salt);
      ok = h === stored;
    } else {
      const h = await sha256PasswordHex(pw, salt);
      ok = h === stored;
    }

    if (!ok) {
      const fails = getLoginFailCount() + 1;
      if (fails >= 5) {
        setLoginFailCount(0);
        setLoginLockUntil(Date.now() + 30000);
        setErr("Trop d'essais. Connexion bloquée 30 secondes.");
        refreshLoginRateLimitUi();
      } else {
        setLoginFailCount(fails);
        setErr(useCaissePassword ? 'Mot de passe caisse incorrect.' : 'Mot de passe incorrect.');
      }
      return;
    }

    clearLoginRateLimit();
    refreshLoginRateLimitUi();

    // Upgrade auto : si ancien SHA-256, on convertit en PBKDF2 (mot de passe ne change pas).
    if (storedKdf !== KDF_PBKDF2) {
      const newSalt = randomSaltHex(16);
      const newHash = await pbkdf2PasswordHex(pw, newSalt);
      if (useCaissePassword) {
        localStorage.setItem(STORAGE_CAISSE_SALT, newSalt);
        localStorage.setItem(STORAGE_CAISSE_HASH, newHash);
        localStorage.setItem(STORAGE_CAISSE_KDF, KDF_PBKDF2);
      } else {
        localStorage.setItem(STORAGE_SALT, newSalt);
        localStorage.setItem(STORAGE_HASH, newHash);
        localStorage.setItem(STORAGE_PW_KDF, KDF_PBKDF2);
      }
    }

    if ($('appLockPassword')) $('appLockPassword').value = '';
    unlockSession();
  }

  function openAdminLogin() {
    clearErr();
    sessionStorage.setItem(SESSION_LOGIN_MODE, 'admin');
    const hint = $('appLockLoginHint');
    if (hint) hint.textContent = 'Administration : entrez le mot de passe administrateur.';
    showView('appLockViewLogin');
  }

  function openPlatformLogin() {
    clearErr();
    // Le mode plateforme doit passer par la vérification admin (submitLogin()).
    sessionStorage.setItem(SESSION_LOGIN_MODE, 'platform');
    const hint = $('appLockLoginHint');
    if (hint) {
      hint.textContent = hasCaissePassword()
        ? 'Caisse : entrez le mot de passe caisse.'
        : 'Caisse : entrez le mot de passe administrateur.';
    }
    // Coupe court à d’éventuelles sessions précédentes, mais ne déverrouille rien.
    sessionStorage.removeItem(SESSION_DEMO);
    localStorage.removeItem(STORAGE_DEMO_UNTIL);
    sessionStorage.removeItem(SESSION_LICENSE_GATE);
    showView('appLockViewLogin');
  }

  function bind() {
    const waUrl = WA_PHONE
      ? 'https://wa.me/' + WA_PHONE + '?text=' + encodeURIComponent(WA_TEXT)
      : '';
    if (waUrl) {
      $('appLockWaBtn')?.setAttribute('href', waUrl);
      $('appLockWaOrder')?.setAttribute('href', waUrl);
    } else {
      // Si la conf n'est pas fournie, on évite d'exposer une URL invalide.
      if ($('appLockWaBtn')) $('appLockWaBtn').hidden = true;
      if ($('appLockWaOrder')) $('appLockWaOrder').hidden = true;
    }

    $('appLockChooseAdmin')?.addEventListener('click', () => {
      openAdminLogin();
    });

    $('appLockChoosePlatform')?.addEventListener('click', () => {
      openPlatformLogin();
    });

    $('appLockChooseDemo')?.addEventListener('click', () => {
      clearErr();
      startDemo();
    });

    $('appLockChooseLicense')?.addEventListener('click', () => {
      clearErr();
      showView('appLockViewLicense');
    });

    $('appLockLicenseBack')?.addEventListener('click', () => {
      clearErr();
      showView('appLockViewChoose');
    });

    $('appLockLicenseSubmit')?.addEventListener('click', () => submitLicenseFlow());
    $('appLockLicenseInput')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitLicenseFlow();
    });

    $('appLockSubmitLogin')?.addEventListener('click', () => submitLogin());
    $('appLockPassword')?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') submitLogin();
    });

    $('appLockForgot')?.addEventListener('click', () => {
      showView('appLockViewForgot');
    });

    $('appLockForgotBack')?.addEventListener('click', () => {
      const loginMode = sessionStorage.getItem(SESSION_LOGIN_MODE) || 'admin';
      if (hasPassword()) {
        const hint = $('appLockLoginHint');
        if (hint) {
          hint.textContent =
            loginMode === 'admin'
              ? 'Administration : entrez le mot de passe administrateur.'
              : 'Entrez le mot de passe pour continuer.';
        }
        showView('appLockViewLogin');
      } else {
        showView('appLockViewChoose');
      }
    });

    $('appLockSavePw')?.addEventListener('click', async () => {
      clearErr();
      if (sessionStorage.getItem(SESSION_LICENSE_GATE) !== '1') {
        setErr('Validez d’abord votre clé de licence.');
        showView('appLockViewChoose');
        return;
      }
      const a = ($('appLockNewPw') && $('appLockNewPw').value) || '';
      const b = ($('appLockNewPw2') && $('appLockNewPw2').value) || '';
      if (a.length < 6) {
        setErr('Le mot de passe doit contenir au moins 6 caractères.');
        return;
      }
      if (a !== b) {
        setErr('Les deux mots de passe ne correspondent pas.');
        return;
      }
      const salt = randomSaltHex(16);
      const h = await pbkdf2PasswordHex(a, salt);
      localStorage.setItem(STORAGE_SALT, salt);
      localStorage.setItem(STORAGE_HASH, h);
      localStorage.setItem(STORAGE_PW_KDF, KDF_PBKDF2);
      if ($('appLockNewPw')) $('appLockNewPw').value = '';
      if ($('appLockNewPw2')) $('appLockNewPw2').value = '';
      sessionStorage.setItem(SESSION_LOGIN_MODE, 'admin');
      unlockSession();
    });

    $('appLockMasterForgotBtn')?.addEventListener('click', async () => {
      clearErr();
      if (!(await validateLicenseInput($('appLockMasterForgot') && $('appLockMasterForgot').value))) {
        setErr('Clé de licence incorrecte.');
        return;
      }
      $('appLockForgotStep1').hidden = true;
      $('appLockForgotStep2').hidden = false;
    });

    $('appLockSavePwForgot')?.addEventListener('click', async () => {
      clearErr();
      const a = ($('appLockNewPwForgot') && $('appLockNewPwForgot').value) || '';
      const b = ($('appLockNewPw2Forgot') && $('appLockNewPw2Forgot').value) || '';
      if (a.length < 6) {
        setErr('Le mot de passe doit contenir au moins 6 caractères.');
        return;
      }
      if (a !== b) {
        setErr('Les deux mots de passe ne correspondent pas.');
        return;
      }
      const salt = randomSaltHex(16);
      const h = await pbkdf2PasswordHex(a, salt);
      localStorage.setItem(STORAGE_SALT, salt);
      localStorage.setItem(STORAGE_HASH, h);
      localStorage.setItem(STORAGE_PW_KDF, KDF_PBKDF2);
      if ($('appLockNewPwForgot')) $('appLockNewPwForgot').value = '';
      if ($('appLockNewPw2Forgot')) $('appLockNewPw2Forgot').value = '';
      if ($('appLockMasterForgot')) $('appLockMasterForgot').value = '';
      sessionStorage.setItem(SESSION_LOGIN_MODE, 'admin');
      unlockSession();
    });

    $('appLockDemoEndLogin')?.addEventListener('click', () => {
      sessionStorage.removeItem(SESSION_DEMO);
      clearErr();
      if (hasPassword()) openAdminLogin();
      else showView('appLockViewChoose');
    });

    $('appLockDemoEndMaster')?.addEventListener('click', () => {
      sessionStorage.removeItem(SESSION_DEMO);
      clearErr();
      showView('appLockViewLicense');
    });

    $('headerLogoutBtn')?.addEventListener('click', () => logoutAppLock());
  }

  window.initAppLock = function () {
    if (!$('appLockOverlay')) return;
    if (!sessionStorage.getItem(SESSION_ACCESS_MODE)) setMode('admin');
    bind();
    refreshLockState();
    startDemoCountdownTicker();
    refreshLoginRateLimitUi();
  };

  window.logoutAppLock = logoutAppLock;
  window.appLockHasCaissePassword = function () {
    return hasCaissePassword();
  };
  window.appLockSetCaissePassword = async function (password) {
    const pw = String(password || '');
    if (pw.length < 4) throw new Error('Le mot de passe caisse doit contenir au moins 4 caractères.');
    const salt = randomSaltHex(16);
    const h = await pbkdf2PasswordHex(pw, salt);
    localStorage.setItem(STORAGE_CAISSE_SALT, salt);
    localStorage.setItem(STORAGE_CAISSE_HASH, h);
    localStorage.setItem(STORAGE_CAISSE_KDF, KDF_PBKDF2);
    return true;
  };
  window.appLockClearCaissePassword = function () {
    localStorage.removeItem(STORAGE_CAISSE_SALT);
    localStorage.removeItem(STORAGE_CAISSE_HASH);
    localStorage.removeItem(STORAGE_CAISSE_KDF);
    return true;
  };

  // Trap Tab sur overlay login (doit rester dans la IIFE pour accéder à handleOverlayTabTrap).
  document.addEventListener('keydown', handleOverlayTabTrap, true);
})();
