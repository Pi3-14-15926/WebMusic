const CACHE = 'music-v1';

self.addEventListener('install', () => self.skipWaiting());

self.addEventListener('message', event => {
    if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(k => Promise.all(k.filter(i => i !== CACHE).map(i => caches.delete(i))))
    );
});

self.addEventListener('fetch', event => {
    if (event.request.url.includes('music.json')) {
        event.respondWith(
            fetch(event.request).then(r => {
                const c = r.clone();
                caches.open(CACHE).then(cache => cache.put(event.request, c));
                return r;
            }).catch(() => caches.match(event.request))
        );
        return;
    }
    event.respondWith(
        fetch(event.request).catch(() => caches.match(event.request))
    );
});
