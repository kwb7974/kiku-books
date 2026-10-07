const PREFIX = `reading-books-player:${new URL(self.registration.scope).pathname}:`;
const CACHE = `${PREFIX}v3`;
const SHELL = ['./', './index.html', './style.css', './app.mjs', './core.mjs', './storage.mjs', './config.mjs', './icon.svg', './icons/icon-180.png', './icons/icon-192.png', './icons/icon-512.png', './manifest.webmanifest'];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith(PREFIX) && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('message', event => {
  if (event.data?.type !== 'CHECK_OFFLINE' || !event.ports[0]) return;
  event.waitUntil(caches.open(CACHE).then(async cache => {
    const entries = await Promise.all(SHELL.map(path => cache.match(new URL(path, self.registration.scope))));
    event.ports[0].postMessage({ready: entries.every(Boolean)});
  }));
});
self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  const allowed = SHELL.some(path => new URL(path, self.registration.scope).pathname === new URL(request.url).pathname);
  if (!allowed) return;
  event.respondWith(fetch(request).then(response => {
    if (response.ok) { const copy = response.clone(); event.waitUntil(caches.open(CACHE).then(cache => cache.put(request, copy))); }
    return response;
  }).catch(() => caches.match(request).then(response => response || caches.match('./'))));
});
