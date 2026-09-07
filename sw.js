const CACHE = 'hardware-inventory-pwa-v5';
const APP_SHELL = ['./', './index.html', './manifest.json'];
const CDN = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    for (const url of APP_SHELL) {
      try { await cache.add(url); } catch (_) {}
    }
    try {
      const res = await fetch(CDN, { mode: 'cors', cache: 'no-store' });
      if (res.ok) await cache.put(CDN, res.clone());
    } catch (_) {}
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  const isApp = url.origin === self.location.origin;
  const isSupabaseCDN = url.href === CDN;

  if (req.mode === 'navigate' && isApp) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) await cache.put('./index.html', fresh.clone());
        return fresh;
      } catch (_) {
        return (await cache.match('./index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  if (isSupabaseCDN) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const hit = await cache.match(CDN);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok) await cache.put(CDN, res.clone());
        return res;
      } catch (_) {
        return Response.error();
      }
    })());
    return;
  }

  if (isApp) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      const cacheHit = await cache.match(req);
      try {
        const fresh = await fetch(req);
        if (fresh && fresh.ok) await cache.put(req, fresh.clone());
        return fresh;
      } catch (_) {
        return cacheHit || Response.error();
      }
    })());
  }
});
