const CACHE = 'coffe-caisse-v29';
const ASSETS = [
  './',
  './index.html',
  './css/app.css',
  './js/app-lock.js',
  './js/app-lock-config.js',
  './js/app.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/ic-invoocoffee.svg',
  './icons/invoocoffee-access.svg',
  './controle/index.html',
  './controle/controle.css',
  './controle/controle.js'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      .then((cache) =>
        Promise.allSettled(
          ASSETS.map((url) =>
            cache.add(url).catch(() => {
              /* asset optionnel manquant: ignorer pour ne pas bloquer l'installation SW */
            })
          )
        )
      )
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) return hit;
      return fetch(e.request).catch(() => {
        /* Ne pas servir index.html pour les images/CSS/JS : le navigateur recevrait du HTML à la place du fichier. */
        if (e.request.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 503, statusText: 'Unavailable' });
      });
    })
  );
});
