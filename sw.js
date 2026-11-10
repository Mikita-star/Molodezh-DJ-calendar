// Офлайн-режим: страница берётся из сети, если она есть (так подтягиваются обновления),
// иначе из кэша. Данные календаря хранятся отдельно и кэш их не трогает.
const CACHE = 'mdjcal-v1';
const FILES = ['./', './index.html', './manifest.json', './apple-touch-icon.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  // Чужие адреса (например, скрипт Telegram) браузер загружает сам, без нашего кэша
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  // no-cache: всегда сверяемся с сервером, иначе браузер может отдать старую версию из своего кэша
  e.respondWith(
    fetch(e.request.url, { cache: 'no-cache' })
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
