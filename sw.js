// Web Messenger Service Worker
// Caches the app shell so the PWA can install and reopen instantly.
// Firebase Realtime Database calls go straight to the network (not cached),
// so chats/stories always stay live.

const CACHE_NAME = "web-messenger-shell-v1";
const APP_SHELL = [
  "./",
  "./index.html",
  "./manifest.json"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => {})
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = event.request.url;

  // Never cache Firebase/Cloudinary/API calls — always go to network for live data.
  if (
    url.includes("firebaseio.com") ||
    url.includes("googleapis.com") ||
    url.includes("firebasestorage") ||
    url.includes("cloudinary.com")
  ) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      return (
        cached ||
        fetch(event.request)
          .then((response) => {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone)).catch(() => {});
            return response;
          })
          .catch(() => cached)
      );
    })
  );
});
