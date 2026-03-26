const CACHE_NAME = 'coffe-controle-v1';
const APP_SHELL = [
  './',
  './index.html',
  './controle.css',
  './controle.js',
  './manifest.webmanifest',
  './icons/ic-controlecoffee.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
          return null;
        })
      )
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  event.respondWith(
    fetch(request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {
          /* ignore */
        });
        return res;
      })
      .catch(() => caches.match(request).then((cached) => cached || caches.match('./index.html')))
  );
});
