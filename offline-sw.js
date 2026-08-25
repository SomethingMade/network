// offline-sw.js
// Minimal app-shell cache so that reloading with no network connection serves
// the last-known-good copy of index.html instead of the browser's native
// "Web page not available" error page. This is separate from
// firebase-messaging-sw.js (which only handles push notifications) — a single
// service worker can't easily do both cleanly, and scoping this one to just
// caching keeps it simple and low-risk to change later.

const CACHE_NAME = 'haba-shell-v1';
const APP_SHELL = [
    './',
    './index.html'
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((names) =>
            Promise.all(
                names
                    .filter((name) => name !== CACHE_NAME)
                    .map((name) => caches.delete(name))
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    // Only handle top-level navigations (actual page loads/reloads). Everything
    // else (API calls, Firebase, images, etc.) passes straight through to the
    // network untouched.
    if (event.request.mode !== 'navigate') return;

    event.respondWith(
        fetch(event.request)
            .then((response) => {
                // Keep the cached shell fresh on every successful online load.
                const copy = response.clone();
                caches.open(CACHE_NAME).then((cache) => cache.put('./index.html', copy));
                return response;
            })
            .catch(() =>
                caches.match('./index.html').then((cached) => cached || caches.match('./'))
            )
    );
});
