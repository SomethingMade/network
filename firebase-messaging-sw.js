/* firebase-messaging-sw.js — Haba service worker: offline app shell + asset cache.
 * (index.html registers this file at ./firebase-messaging-sw.js. Push-notification
 * handling can be added to this same file later.)
 *
 *  • index.html  → opens instantly from the on-device copy, refreshed quietly in the background.
 *  • Firebase SDK modules, Google Fonts, same-origin static files → cached for offline boot.
 *  • Firebase Storage images → cached on first view (latest 250).
 * Never touches non-GET / range requests, RTDB/Auth/Firestore traffic, or /__/ routes.
 */
const HABA_SW_VERSION = 'v1';
const HABA_SHELL = 'haba-shell-' + HABA_SW_VERSION;
const HABA_LIBS = 'haba-libs-' + HABA_SW_VERSION;
const HABA_IMGS = 'haba-imgs-' + HABA_SW_VERSION;
const HABA_IMG_MAX = 250;

const habaScopeUrl = self.registration.scope;                 // e.g. https://app.example.com/
const habaScopePath = new URL(habaScopeUrl).pathname;         // e.g. /

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(HABA_SHELL)
            .then((cache) => cache.add(new Request(habaScopeUrl, { cache: 'reload' })))
            .catch(() => { /* offline install: shell gets cached on the next online open */ })
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys
                .filter((k) => k.startsWith('haba-') && ![HABA_SHELL, HABA_LIBS, HABA_IMGS].includes(k))
                .map((k) => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

async function habaTrim(cache, max) {
    const keys = await cache.keys();
    for (let i = 0; i < keys.length - max; i++) await cache.delete(keys[i]); // oldest first
}

// index.html: serve the saved copy now, refresh it in the background.
async function habaNavigate(event) {
    const cache = await caches.open(HABA_SHELL);
    const cached = await cache.match(habaScopeUrl, { ignoreSearch: true });
    const refresh = fetch(new Request(habaScopeUrl, { cache: 'no-cache' }))
        .then((res) => {
            if (res && res.ok && !res.redirected) cache.put(habaScopeUrl, res.clone());
            return res;
        })
        .catch(() => null);
    if (cached) { event.waitUntil(refresh); return cached; }
    const fresh = await refresh;
    return fresh || new Response('You are offline and Haba has not been saved on this device yet.', {
        status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
}

// Generic stale-while-revalidate for static files / SDK modules / fonts.
async function habaStaleWhileRevalidate(event, cacheName) {
    const req = event.request;
    const cache = await caches.open(cacheName);
    const cached = await cache.match(req);
    const refresh = fetch(req)
        .then((res) => {
            if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
            return res;
        })
        .catch(() => null);
    if (cached) { event.waitUntil(refresh); return cached; }
    return (await refresh) || Response.error();
}

// Storage images: cache-first (their URLs carry an immutable access token).
async function habaImage(event) {
    const req = event.request;
    const cache = await caches.open(HABA_IMGS);
    const hit = await cache.match(req.url);
    if (hit) return hit;
    try {
        // A CORS fetch gives a normal (non-opaque) response, so it stores at its real size.
        const res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
        if (res && res.status === 200) {
            event.waitUntil(cache.put(req.url, res.clone()).then(() => habaTrim(cache, HABA_IMG_MAX)));
        }
        return res;
    } catch (e) {
        try { return await fetch(req); } catch (e2) { return Response.error(); }
    }
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET' || req.headers.has('range')) return;
    let url;
    try { url = new URL(req.url); } catch (e) { return; }

    if (url.origin === self.location.origin) {
        if (url.pathname.startsWith('/__/')) return;                                   // Firebase Hosting reserved routes
        if (/\/(firebase-messaging-sw|haba-offline)\.js$/.test(url.pathname)) return;  // let the browser manage SW scripts
        if (req.mode === 'navigate') {
            const isShell = url.pathname === habaScopePath || url.pathname === habaScopePath + 'index.html';
            if (isShell) event.respondWith(habaNavigate(event));
            return;
        }
        event.respondWith(habaStaleWhileRevalidate(event, HABA_SHELL));
        return;
    }

    if ((url.hostname === 'www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) ||
        url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
        event.respondWith(habaStaleWhileRevalidate(event, HABA_LIBS));
        return;
    }

    if (url.hostname === 'firebasestorage.googleapis.com' && req.destination === 'image') {
        event.respondWith(habaImage(event));
    }
});
