importScripts("https://www.gstatic.com/firebasejs/10.8.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.8.1/firebase-messaging-compat.js");

// =========================================================================
// 1. INITIALIZE FIREBASE
// =========================================================================
firebase.initializeApp({
    apiKey: "AIzaSyBQSPwpVbGrdCuOoyitAeWQHIeipj2MgIY",
    authDomain: "newstart-64c43.firebaseapp.com",
    databaseURL: "https://newstart-64c43-default-rtdb.firebaseio.com",
    projectId: "newstart-64c43",
    storageBucket: "newstart-64c43.firebasestorage.app",
    messagingSenderId: "941619830061",
    appId: "1:941619830061:web:de9e0f791eb8f6eacf87a4"
});

const messaging = firebase.messaging();
const NOTIF_ICON = "https://i.postimg.cc/Bv3sQWxd/1783111354171.png";

// =========================================================================
// 2. FIREBASE CLOUD MESSAGING (BACKGROUND HANDLER)
// =========================================================================
messaging.onBackgroundMessage((payload) => {
    // Extract variables directly from our data-only payload
    const { title, body, icon, url, chatUid } = payload.data || {};

    const notificationOptions = {
        body: body || 'Sent you a message',
        icon: icon || NOTIF_ICON,
        badge: NOTIF_ICON,
        tag: chatUid ? ('chat-' + chatUid) : 'new-message',
        data: { 
            url: url || '/',
            uid: chatUid 
        }
    };

    // Manually trigger the singular notification
    self.registration.showNotification(title || 'New Message', notificationOptions);
});

// =========================================================================
// 3. NOTIFICATION CLICK HANDLER
// =========================================================================
self.addEventListener('notificationclick', (event) => {
    event.notification.close(); // Immediately close the notification UI

    const urlToOpen = event.notification.data.url;
    const chatUid = event.notification.data.uid;

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            // If the app is already open in a tab, focus it and tell the frontend to open the specific chat
            for (const client of clientList) {
                if ('focus' in client) {
                    if (chatUid) client.postMessage({ type: 'open-chat', uid: chatUid });
                    return client.focus();
                }
            }
            // If no app window is open, launch a new one
            if (self.clients.openWindow) {
                return self.clients.openWindow(urlToOpen);
            }
        })
    );
});

// =========================================================================
// 4. PWA CACHING LOGIC (APP SHELL)
// =========================================================================
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
