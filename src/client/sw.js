'use strict';

// App-shell precaching only. This deliberately does NOT try to cache or
// intercept the WebSocket control/audio connection — service workers
// can't intercept ws:// traffic anyway, and rig state should never be
// served stale from cache.

const CACHE_NAME = 'icom-rig-pwa-shell-v67';

const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/app.js',
  '/rpc.js',
  '/audio.js',
  '/scope.js',
  '/smeter.js',
  '/vswr.js',
  '/ft8-qso.js',
  '/mic-capture-processor.js',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  '/icons/favicon.ico',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  // Only handle same-origin GET requests for the app shell; let
  // everything else (in particular, nothing — WS isn't fetch) pass
  // through untouched.
  if (event.request.method !== 'GET') return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Opportunistically cache anything else same-origin we fetch
        // (e.g. a future asset not in the precache list), best-effort.
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
