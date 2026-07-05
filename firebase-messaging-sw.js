// firebase-messaging-sw.js
// This file MUST be uploaded as a real static file at the ROOT of your site
// (same folder as index.html, served at https://yourdomain.com/firebase-messaging-sw.js).
// It cannot be created dynamically from a blob URL like the in-app notification
// service worker — FCM needs to fetch and re-fetch this exact URL to receive
// push events even when the app/tab is completely closed.

importScripts("https://www.gstatic.com/firebasejs/10.8.1/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.8.1/firebase-messaging-compat.js");

// Must match the firebaseConfig used in index.html
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

// Called when a push arrives while there is no focused tab for this origin.
messaging.onBackgroundMessage((payload) => {
    const data = payload.data || {};
    const title = data.title || (payload.notification && payload.notification.title) || 'New message';
    const body = data.body || (payload.notification && payload.notification.body) || '';
    const chatUid = data.chatUid || '';

    self.registration.showNotification(title, {
        body: body,
        icon: data.icon || NOTIF_ICON,
        badge: NOTIF_ICON,
        tag: chatUid ? ('chat-' + chatUid) : undefined,
        data: { uid: chatUid }
    });
});

// Reuse the same click behavior as the in-app notification SW: focus/open the
// app and let index.html's own message listener route to the right chat.
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const chatUid = (event.notification.data && event.notification.data.uid) || '';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
            for (const client of clientList) {
                if ('focus' in client) {
                    client.postMessage({ type: 'open-chat', uid: chatUid });
                    return client.focus();
                }
            }
            if (self.clients.openWindow) {
                return self.clients.openWindow('/');
            }
        })
    );
});
