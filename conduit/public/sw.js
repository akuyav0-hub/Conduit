// Service worker: lets Conduit install as an app, open instantly, and receive files shared
// from other apps (Android share sheet). It never touches transfer data.

const VERSION = 'conduit-v4';
const SHELL = [
  '/', '/app.css', '/app.js', '/opfs-worker.js', '/manifest.webmanifest',
  '/lib/util.js', '/lib/db.js', '/lib/identity.js', '/lib/signal.js', '/lib/peer.js',
  '/lib/transfer.js', '/lib/sinks.js', '/lib/ui.js', '/lib/zip.js', '/vendor/uqr.mjs',
  '/icons/icon.svg', '/icons/icon-192.png',
  '/fonts/overpass-latin-wght-normal.woff2', '/fonts/overpass-mono-latin-400-normal.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('conduit-v') && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  if (e.request.method === 'POST' && url.pathname === '/share-target') {
    e.respondWith(receiveShare(e.request));
    return;
  }
  if (e.request.method !== 'GET' || url.pathname === '/ws' || url.pathname.startsWith('/api/')) return;
  // Network first so updates show up right away; the cache is only a fallback.
  e.respondWith((async () => {
    try {
      const res = await fetch(e.request);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy)).catch(() => {});
      }
      return res;
    } catch {
      const hit = await caches.match(e.request, { ignoreSearch: true });
      if (hit) return hit;
      if (e.request.mode === 'navigate') return (await caches.match('/')) || Response.error();
      return Response.error();
    }
  })());
});

async function receiveShare(request) {
  try {
    const form = await request.formData();
    const files = form.getAll('files').filter((f) => f && typeof f === 'object' && 'size' in f);
    const cache = await caches.open('conduit-share');
    for (const k of await cache.keys()) await cache.delete(k);
    let i = 0;
    for (const f of files) {
      await cache.put(`/__shared/${i++}`, new Response(f, {
        headers: { 'content-type': f.type || 'application/octet-stream', 'x-name': encodeURIComponent(f.name || 'shared-file') },
      }));
    }
  } catch { /* nothing usable was shared */ }
  return Response.redirect('/?shared=1', 303);
}

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((list) => (list.length ? list[0].focus() : self.clients.openWindow('/'))),
  );
});
