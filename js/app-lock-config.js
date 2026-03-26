// Configuration sécurité & maintenabilité pour l'écran d'accès.
// Le code applicatif (app-lock.js) lit uniquement depuis window.COFFEE_LOCK_CONFIG.
// Ce fichier doit être chargé AVANT `app-lock.js`.
(function () {
  window.COFFEE_LOCK_CONFIG = window.COFFEE_LOCK_CONFIG || {};
  window.COFFEE_LOCK_CONFIG.WA_PHONE = window.COFFEE_LOCK_CONFIG.WA_PHONE || '212630230803';
  window.COFFEE_LOCK_CONFIG.WA_TEXT =
    window.COFFEE_LOCK_CONFIG.WA_TEXT ||
    "Bonjour, je souhaite obtenir une clé d'accès ou de l'aide pour l'application COFFE (caisse).";
})();

