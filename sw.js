const CACHE = 'lh-captura-v2';
const ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.json', './icons/icon.svg'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (u.pathname.includes('/api/')) return;
  e.respondWith(caches.match(e.request).then((r) => r || fetch(e.request)));
});
