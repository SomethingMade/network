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
const SW_VERSION = '2026-10-04-c';
self.addEventListener('message', (e) => {
    if (e.data && e.data.type === 'version' && e.ports && e.ports[0]) e.ports[0].postMessage({ v: SW_VERSION });
});
const NOTIF_ICON = "https://i.postimg.cc/Bv3sQWxd/1783111354171.png";
const DB_URL = "https://newstart-64c43-default-rtdb.firebaseio.com";

// =========================================================================
// 2. FIREBASE CLOUD MESSAGING (BACKGROUND HANDLER)
// =========================================================================
// Resolve the sender's avatar (and name) from the database so the notification
// shows who the message is from. Cached in memory for the life of the worker.
const profileCache = {};
const isHttps = (u) => typeof u === 'string' && /^https:\/\//i.test(u);

async function fetchJson(path, token) {
    const url = `${DB_URL}/${path}.json` + (token ? `?auth=${token}` : '');
    const res = await fetch(url);
    if (!res.ok) throw new Error(res.status);
    return res.json();
}

async function lookupProfile(chatUid, groupId) {
    const key = groupId ? 'g:' + groupId : 'u:' + chatUid;
    if (profileCache[key]) return profileCache[key];
    const cached = await getCachedAuth();
    const token = cached && cached.token;
    const path = groupId ? `groups/${groupId}` : `users/${chatUid}`;
    let data = null;
    try { data = await fetchJson(path, token); }
    catch (e) {
        // token may be expired/missing — retry once without auth (works if rules allow)
        if (token) { try { data = await fetchJson(path, null); } catch (_) {} }
    }
    const out = data ? { name: data.name, photoURL: isHttps(data.photoURL) ? data.photoURL : null } : null;
    if (out) profileCache[key] = out;
    return out;
}

// Encrypted/garbled text reads as spam to Chrome's on-device notification filter,
// so never show ciphertext — fall back to a plain readable line.
function cleanBody(b) {
    const t = (b || '').trim();
    if (!t || t.includes('\u27e6e2e') || /^[A-Za-z0-9+\/=_-]{24,}$/.test(t)) return 'Sent you a message';
    return t;
}

// -------------------------------------------------------------------------
// Decrypt end-to-end encrypted pushes so the notification shows the real text.
// Uses the key pair the app keeps in IndexedDB ("haba-messenger" / "keys"),
// the peer public key the app cached ("peerpub-<me>-<peer>"), or a fresh
// fetch of it from the database using the cached login token.
// -------------------------------------------------------------------------
const E2E_PREFIX = '\u27e6e2e1\u27e7';
const KEYS_DB = 'haba-messenger', KEYS_STORE = 'keys';
const MEDIA_LABEL = { image: '\ud83d\udcf7 Photo', video: '\ud83c\udfa5 Video', audio: '\ud83c\udfa4 Voice message', document: '\ud83d\udcc4 Document', gif: 'GIF', sticker: 'Sticker' };

// Key pairs live in IndexedDB. The messenger page uses "haba-messenger", the main Haba app
// uses "haba-e2ee" (same store + key names), so look in both. Opening never creates a DB.
const KEY_DBS = ['haba-messenger', 'haba-e2ee'];
function keysGet(key, dbName) {
    return new Promise((resolve) => {
        let req;
        try { req = indexedDB.open(dbName || KEY_DBS[0], 1); } catch (e) { resolve(null); return; }
        req.onupgradeneeded = () => { try { req.transaction.abort(); } catch (_) {} };
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
            const db = req.result;
            try {
                const r = db.transaction(KEYS_STORE, 'readonly').objectStore(KEYS_STORE).get(key);
                r.onsuccess = () => { db.close(); resolve(r.result || null); };
                r.onerror = () => { db.close(); resolve(null); };
            } catch (e) { db.close(); resolve(null); }
        };
    });
}
async function loadKeyPair(uid) {
    for (const name of KEY_DBS) {
        const kp = await keysGet('keypair-' + uid, name);
        if (kp && kp.privateKey) return { kp, name };
    }
    return null;
}

const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0)).buffer;

async function decryptWithPeerKey(privateKey, peerJwk, payload) {
    const pub = await crypto.subtle.importKey('jwk', peerJwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const key = await crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, privateKey, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
    const [iv, ct] = payload.slice(E2E_PREFIX.length).split(':');
    return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(fromB64(iv)) }, key, fromB64(ct)));
}

// Plain text of an encrypted 1:1 push, or null if it can't be decrypted here.
async function decryptPushBody(body, chatUid, groupId) {
    try {
        if (typeof body !== 'string' || !body.startsWith(E2E_PREFIX) || !chatUid || groupId) return null;
        const auth = await getCachedAuth();
        const uid = auth && auth.uid;
        if (!uid) return null;
        const found = await loadKeyPair(uid);
        if (!found) return null;
        const kp = found.kp;
        const cached = await keysGet('peerpub-' + uid + '-' + chatUid, found.name);
        if (cached) { try { return await decryptWithPeerKey(kp.privateKey, cached, body); } catch (_) {} }
        if (!auth.token) return null;
        const fresh = await fetchJson('users/' + chatUid + '/e2ee/publicKey', auth.token); // new sender, or their key changed
        return fresh ? await decryptWithPeerKey(kp.privateKey, fresh, body) : null;
    } catch (_) { return null; }
}


const toB64 = (buf) => { let t = ''; new Uint8Array(buf).forEach((c) => (t += String.fromCharCode(c))); return btoa(t); };

// Encrypts text exactly like enc() in the app (AES-GCM over the ECDH shared key).
// Throws when it can't, so a reply is never sent as plain text.
async function encryptForPeer(text, myUid, peerUid, token) {
    const found = await loadKeyPair(myUid);
    if (!found) throw new Error('no key pair on this device');
    const kp = found.kp;
    let jwk = await keysGet('peerpub-' + myUid + '-' + peerUid, found.name);
    if (!jwk) jwk = await fetchJson('users/' + peerUid + '/e2ee/publicKey', token);
    if (!jwk) throw new Error('peer has no public key');
    const pub = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
    const key = await crypto.subtle.deriveKey({ name: 'ECDH', public: pub }, kp.privateKey, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(text));
    return E2E_PREFIX + toB64(iv) + ':' + toB64(ct);
}

// Never let the lookup delay the notification for long
const withTimeout = (p, ms) => Promise.race([p, new Promise((r) => setTimeout(() => r(null), ms))]);

messaging.onBackgroundMessage((payload) => {
    // Extract variables directly from our data-only payload
    const { title, body, icon, url, chatUid, groupId, mediaType } = payload.data || {};

    return (async () => {
        let profile = null;
        if (chatUid || groupId) {
            try { profile = await withTimeout(lookupProfile(chatUid, chatUid ? null : groupId), 2500); } catch (_) {}
            // group message with no usable sender avatar: fall back to the group photo
            if (groupId && chatUid && !(profile && profile.photoURL)) {
                try { profile = await withTimeout(lookupProfile(null, groupId), 2500); } catch (_) {}
            }
        }

        const plain = await withTimeout(decryptPushBody(body, chatUid, groupId), 2500);
        const shownBody = plain || ((body || '').includes('\u27e6e2e') && MEDIA_LABEL[mediaType]) || cleanBody(body);

        const avatar = (profile && profile.photoURL) || (isHttps(icon) ? icon : null) || NOTIF_ICON;

        const notificationOptions = {
            body: shownBody,
            icon: avatar,
            badge: NOTIF_ICON,
            tag: groupId ? ('group-' + groupId) : (chatUid ? ('chat-' + chatUid) : 'new-message'),
            data: {
                url: url || '/',
                uid: chatUid,
                groupId: groupId
            },
            actions: [
                { action: 'reply', title: 'Reply', type: 'text', placeholder: 'Type a message…' },
                { action: 'close', title: 'Dismiss' }
            ]
        };

        return self.registration.showNotification(
            title || (profile && profile.name) || 'New Message',
            notificationOptions
        );
    })();
});

// =========================================================================
// 3. AUTH TOKEN CACHE (read-only here — index.html writes it)
// =========================================================================
const AUTH_CACHE_DB = 'gozaAuthCache';
const AUTH_CACHE_STORE = 'tokens';

function getCachedAuth() {
    return new Promise((resolve) => {
        const req = indexedDB.open(AUTH_CACHE_DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(AUTH_CACHE_STORE);
        req.onsuccess = () => {
            const db = req.result;
            try {
                const tx = db.transaction(AUTH_CACHE_STORE, 'readonly');
                const getReq = tx.objectStore(AUTH_CACHE_STORE).get('current');
                getReq.onsuccess = () => resolve(getReq.result || null);
                getReq.onerror = () => resolve(null);
            } catch (e) { resolve(null); }
        };
        req.onerror = () => resolve(null);
    });
}

async function restPost(path, body, token) {
    const res = await fetch(`${DB_URL}/${path}.json?auth=${token}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error('REST POST ' + path + ' failed: ' + res.status);
    return res.json(); // { name: "<new key>" }
}

async function restPatch(updates, token) {
    const res = await fetch(`${DB_URL}/.json?auth=${token}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates)
    });
    if (!res.ok) throw new Error('REST PATCH failed: ' + res.status);
    return res.json();
}

async function restGet(path, token) {
    const res = await fetch(`${DB_URL}/${path}.json?auth=${token}`);
    if (!res.ok) throw new Error('REST GET ' + path + ' failed: ' + res.status);
    return res.json();
}

// --- DM reply: mirrors sendMsg() in the main app (encrypted, honours blocks + disappearing messages) ---
async function sendDmReplyFromSW(text, myUid, otherUid, token) {
    const threadId = [myUid, otherUid].sort().join('_');
    const createdAt = Date.now();
    const e = await encryptForPeer(text, myUid, otherUid, token); // throws -> caller opens the app instead

    let blockedByPeer = false, disSec = 0;
    try { blockedByPeer = (await restGet(`users/${otherUid}/blocked/${myUid}`, token)) === true; } catch (_) {}
    try { disSec = +(await restGet(`dm_threads/${threadId}/settings/disappearingSeconds`, token)) || 0; } catch (_) {}

    const msgPayload = { text: e, senderUid: myUid, createdAt };
    if (disSec > 0) msgPayload.expiresAt = createdAt + disSec * 1000;

    await restPost(`dm_threads/${threadId}/messages`, msgPayload, token);

    const updates = { [`user_chats/${myUid}/${otherUid}`]: { text: e, timestamp: createdAt, unreadCount: 0, senderUid: myUid } };
    if (!blockedByPeer) {
        updates[`user_chats/${otherUid}/${myUid}/text`] = e;
        updates[`user_chats/${otherUid}/${myUid}/timestamp`] = createdAt;
        updates[`user_chats/${otherUid}/${myUid}/unreadCount`] = { '.sv': { increment: 1 } };
        updates[`user_chats/${otherUid}/${myUid}/senderUid`] = myUid;
    }
    await restPatch(updates, token);
}

// --- Group reply: mirrors sendGroupMessage() in the main app ---
async function sendGroupReplyFromSW(text, myUid, groupId, token) {
    const group = await restGet(`groups/${groupId}`, token);
    if (!group || !group.members || !group.members[myUid]) return; // not a member, bail silently
    if (group.onlyOwnerCanPost && group.ownerUid !== myUid) return; // respect owner-only posting

    const createdAt = Date.now();
    const senderName = group.memberNames?.[myUid] || 'Someone'; // best-effort; falls back if unknown
    const msgPayload = { text, senderUid: myUid, senderName, createdAt };

    await restPost(`group_threads/${groupId}/messages`, msgPayload, token);

    const updates = {};
    Object.keys(group.members).forEach((memberUid) => {
        if (memberUid === myUid) {
            updates[`user_group_chats/${memberUid}/${groupId}`] = {
                groupName: group.name || 'Group',
                groupPhotoURL: group.photoURL || '',
                text, senderUid: myUid, senderName, timestamp: createdAt, unreadCount: 0
            };
        } else {
            updates[`user_group_chats/${memberUid}/${groupId}/groupName`] = group.name || 'Group';
            updates[`user_group_chats/${memberUid}/${groupId}/groupPhotoURL`] = group.photoURL || '';
            updates[`user_group_chats/${memberUid}/${groupId}/text`] = text;
            updates[`user_group_chats/${memberUid}/${groupId}/senderUid`] = myUid;
            updates[`user_group_chats/${memberUid}/${groupId}/senderName`] = senderName;
            updates[`user_group_chats/${memberUid}/${groupId}/timestamp`] = createdAt;
            updates[`user_group_chats/${memberUid}/${groupId}/unreadCount`] = { '.sv': { increment: 1 } };
        }
    });
    await restPatch(updates, token);
}

// =========================================================================
// 4. NOTIFICATION CLICK HANDLER (default open/focus + reply action)
// =========================================================================
self.addEventListener('notificationclick', (event) => {
    const data = event.notification.data || {};

    // --- "Dismiss" action: just close, nothing else to do ---
    if (event.action === 'close') {
        event.notification.close();
        return;
    }

    // --- "Reply" action: send the message directly, no app launch ---
    if (event.action === 'reply') {
        const text = (event.reply || '').trim();
        event.notification.close();
        if (!text) return;

        event.waitUntil((async () => {
            const cached = await getCachedAuth();
            if (!cached || !cached.token) return; // no cached session — nothing we can do headlessly
            try {
                if (data.groupId) {
                    await sendGroupReplyFromSW(text, cached.uid, data.groupId, cached.token);
                } else if (data.uid) {
                    await sendDmReplyFromSW(text, cached.uid, data.uid, cached.token);
                }
            } catch (err) {
                console.error('SW reply send failed', err);
                // Fallback: open/focus the app to that chat so the person can retry manually
                const clientList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
                for (const client of clientList) {
                    if ('focus' in client) {
                        if (data.uid) client.postMessage({ type: 'open-chat', uid: data.uid });
                        return client.focus();
                    }
                }
                if (self.clients.openWindow) return self.clients.openWindow(data.url || '/');
            }
        })());
        return;
    }

    // --- Default (body) click: existing open/focus-chat behavior, unchanged ---
    event.notification.close();
    const urlToOpen = data.url;
    const chatUid = data.uid;

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
// 5. PWA CACHING LOGIC (APP SHELL)
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
