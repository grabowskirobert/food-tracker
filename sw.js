// The whole app is precached at install, one consistent version per CACHE name. Requests go to the
// network first, bypassing the browser's HTTP cache (GitHub Pages sends max-age=600, so files fetched
// minutes apart could come from different deployments and no longer fit together). When the network
// fails, the precache answers. It is never written at runtime, so it can't mix versions.
// Bump CACHE with every change to a file below.
const CACHE = 'ft-v12';
const SHELL = ['./', 'index.html', 'style.css', 'boot.js', 'app.js', 'data.js', 'llm.js', 'sync.js',
  'vendor/anthropic-sdk-0.131.0.mjs', 'manifest.webmanifest', 'icons/icon-180.png', 'icons/icon-192.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(fetch(e.request, { cache: 'no-store' })
    .catch(() => caches.match(e.request, { ignoreSearch: true })));
});
