// Service worker: lÆ°u giao diá»‡n app Ä‘á»ƒ má»Ÿ Ä‘Æ°á»£c khi khĂ´ng cĂ³ máº¡ng.
// Khi sá»­a app, tÄƒng sá»‘ phiĂªn báº£n nĂ y Ä‘á»ƒ Ä‘iá»‡n thoáº¡i táº£i báº£n má»›i.
const VERSION = 'v23';
const SHELL = ['./', './index.html', './manifest.webmanifest',
               './icon-192.png', './icon-512.png', './icon-maskable.png', './apple-touch-icon.png', './favicon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// CĂ³ máº¡ng: láº¥y báº£n má»›i nháº¥t rá»“i cáº­p nháº­t bá»™ nhá»› Ä‘á»‡m. Máº¥t máº¡ng: dĂ¹ng báº£n Ä‘Ă£ lÆ°u.
// KhĂ´ng Ä‘á»¥ng vĂ o /api/ (nháº¡c phĂ¡t theo tá»«ng Ä‘oáº¡n; app tá»± lÆ°u bĂ i vĂ o mĂ¡y theo cĂ¡ch riĂªng).
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if (res.ok && res.status === 200) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(e.request, copy)); }
        return res;
      })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then(r => r || caches.match('./index.html')))
  );
});
