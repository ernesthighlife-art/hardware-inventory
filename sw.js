const CACHE='hardware-inventory-v20260907-20';
const CORE=['./','./index.html','./manifest.json'];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => cache.addAll(CORE))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // 絕對不要攔截 Supabase、CDN、Edge Function 等跨網域請求。
  // 這是避免線上資料被 Service Worker 舊快取覆蓋的關鍵。
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;

      return fetch(request).then(response => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then(cache => cache.put(request, copy)).catch(() => {});
        }
        return response;
      }).catch(() => {
        // 僅在導覽請求失敗時回首頁；其他資源直接失敗，避免錯誤資料互相冒充。
        if (request.mode === 'navigate') return caches.match('./index.html');
        throw new Error('Network request failed');
      });
    })
  );
});
