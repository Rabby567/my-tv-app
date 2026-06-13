/**
 * StreamVault — sw.js
 * Service Worker for PWA / offline shell caching
 */

const CACHE = 'streamvault-v1';
const SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  // Network-first for the M3U playlist, cache-first for shell assets
  const url = e.request.url;

  if (url.includes('iptv-org.github.io')) {
    // Always try network for playlist data
    e.respondWith(
      fetch(e.request).catch(() => caches.match(e.request))
    );
    return;
  }

  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
