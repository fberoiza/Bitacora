/* Service worker: guarda la app en el teléfono para abrirla sin conexión.
 * Los datos (asistencias/logias) viven en el almacenamiento local de la app.
 * Sube el número de versión cada vez que publiques cambios. */
var CACHE = 'bitacora-v1.0.0';
var SHELL = ['./', 'index.html', 'app.js', 'styles.css', 'manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  var propio = url.origin === location.origin;
  var fuente = /fonts\.(googleapis|gstatic)\.com|cdnjs\.cloudflare\.com/.test(url.host);
  if (!propio && !fuente) return; // la API de Google va siempre directo a la red

  // Stale-while-revalidate: responde desde caché y actualiza en segundo plano
  e.respondWith(caches.open(CACHE).then(function (cache) {
    return cache.match(req, { ignoreSearch: propio }).then(function (hit) {
      var red = fetch(req).then(function (res) {
        if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
        return res;
      }).catch(function () { return hit || (req.mode === 'navigate' ? cache.match('index.html') : undefined); });
      return hit || red;
    });
  }));
});
