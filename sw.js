const APP_VERSION = 'v2.10.0';
const CACHE_NAME = 'timetasks-cache-' + APP_VERSION;
const ASSETS_TO_CACHE = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './icon-192.png',
  './icon-512.png',
  './icon-512-maskable.png',
  './apple-touch-icon.png',
  './favicon-32.png',
  './favicon-16.png'
];

self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      /* Promise.all + cache.add فردية: فشل ملف واحد لا يُلغي الباقي */
      return Promise.all(
        ASSETS_TO_CACHE.map(function(url) {
          return cache.add(url).catch(function(err) {
            console.warn('Precache failed for:', url, err);
          });
        })
      );
    }).then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames.map(function(cache) {
          if (cache !== CACHE_NAME) return caches.delete(cache);
        })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(event) {
  var req = event.request;
  if (req.method !== 'GET') return;
  var url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (url.origin !== location.origin) return;

  /* التنقل → network-first للبقاء محدَّثًا */
  if (req.mode === 'navigate' || req.destination === 'document') {
    event.respondWith(
      fetch(req).then(function(res) {
        if (res && res.ok) {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(req, clone).catch(function() {});
          }).catch(function() {});
        }
        return res;
      }).catch(function() {
        return caches.match(req).then(function(r) {
          return r || caches.match('./index.html');
        });
      })
    );
    return;
  }

  /* الأصول الثابتة → cache-first */
  event.respondWith(
    caches.match(req).then(function(cached) {
      if (cached) return cached;
      return fetch(req).then(function(res) {
        if (res && res.ok && res.type === 'basic') {
          var clone = res.clone();
          caches.open(CACHE_NAME).then(function(cache) {
            cache.put(req, clone).catch(function() {});
          }).catch(function() {});
        }
        return res;
      });
    })
  );
});