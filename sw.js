// Offline cache. The page itself is fetched fresh when online (so updates show
// up right away) and falls back to the cached copy when offline. Icons and other
// files are served from cache and refreshed in the background.
// One worker for the whole portal. When you add a game, add its page and icon here.
const CACHE = 'games-v3';
const FILES = [
  './', 'index.html', 'manifest.webmanifest',
  'shared/font.js', 'shared/cpu6502.js', 'shared/apple2.js', 'shared/disk-game.js', 'shared/disk-game.css',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-32.png',
  'planets/', 'planets/index.html', 'planets/icons/icon-192.png', 'planets/icons/favicon-32.png', 'planets/icons/apple-touch-icon.png',
  'munchers/', 'munchers/index.html', 'munchers/munchers.dsk', 'munchers/icons/icon-192.png', 'munchers/icons/favicon-32.png',
  'odell/', 'odell/index.html', 'odell/odell.dsk', 'odell/icons/icon-192.png', 'odell/icons/favicon-32.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async c => {
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; });
    if (e.request.mode === 'navigate') {
      return net.catch(async () => (await c.match(e.request, { ignoreSearch: true })) || c.match('./'));
    }
    const hit = await c.match(e.request, { ignoreSearch: true });
    if (hit) { e.waitUntil(net.catch(() => {})); return hit; }
    return net;
  }));
});
