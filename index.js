const { onValueCreated } = require("firebase-functions/v2/database");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();

const MAX_PREVIEW_LEN = 80;

function previewFor(msg) {
    if (msg.text) {
        return msg.text.length > MAX_PREVIEW_LEN
            ? msg.text.slice(0, MAX_PREVIEW_LEN) + "…"
            : msg.text;
    }

    // Checks msg.mediaType to align with your frontend DM payload structure
    const type = msg.mediaType || msg.type;

    if (type === "image") return "📷 Photo";
    if (type === "video") return "🎥 Video";
    if (type === "voice" || type === "audio") return "🎤 Voice note";
    if (type === "document" || type === "raw") return "📄 Document";

    return "New message";
}

// Triggers on: /dm_threads/{threadId}/messages/{messageId}
// threadId is built client-side as [uidA, uidB].sort().join('_')
exports.sendDmPushNotification = onValueCreated(
    "/dm_threads/{threadId}/messages/{messageId}",
    async (event) => {
        const msg = event.data.val();
        if (!msg || !msg.senderUid) return;

        const threadId = event.params.threadId;
        const uids = threadId.split("_");
        if (uids.length !== 2) return;

        const senderUid = msg.senderUid;
        const recipientUid = uids.find((u) => u !== senderUid);
        if (!recipientUid) return;

        const db = getDatabase();

        const [recipientTokensSnap, senderProfileSnap] = await Promise.all([
            db.ref(`users/${recipientUid}/fcmTokens`).get(),
            db.ref(`users/${senderUid}`).get(),
        ]);

        if (!recipientTokensSnap.exists()) return;

        const tokens = Object.keys(recipientTokensSnap.val());
        if (tokens.length === 0) return;

        const senderProfile = senderProfileSnap.val() || {};
        const senderName = senderProfile.name || "Someone";
        const body = previewFor(msg);

        const messaging = getMessaging();

        const response = await messaging.sendEachForMulticast({
            tokens,
            // STRICTLY DATA-ONLY: No 'notification' or 'webpush' fields here.
            // This prevents Firebase from auto-generating a second notification.
            data: {
                title: senderName,
                body,
                chatUid: senderUid,
                icon: senderProfile.photoURL || "https://i.postimg.cc/Bv3sQWxd/1783111354171.png",
                url: "https://somethingmade.github.io/network/"
            }
        });

        // Clean up dead/unregistered tokens so they stop accumulating
        const staleTokenUpdates = {};
        response.responses.forEach((res, idx) => {
            if (!res.success) {
                const code = res.error && res.error.code;
                if (
                    code === "messaging/registration-token-not-registered" ||
                    code === "messaging/invalid-registration-token"
                ) {
                    staleTokenUpdates[`users/${recipientUid}/fcmTokens/${tokens[idx]}`] = null;
                }
            }
        });

        if (Object.keys(staleTokenUpdates).length > 0) {
            await db.ref().update(staleTokenUpdates);
        }
    }
);

// Triggers on: /group_threads/{groupId}/messages/{messageId}
exports.sendGroupPushNotification = onValueCreated(
    "/group_threads/{groupId}/messages/{messageId}",
    async (event) => {
        const msg = event.data.val();
        if (!msg || !msg.senderUid) return;

        const groupId = event.params.groupId;
        const senderUid = msg.senderUid;
        const db = getDatabase();

        const [groupSnap, senderProfileSnap] = await Promise.all([
            db.ref(`groups/${groupId}`).get(),
            db.ref(`users/${senderUid}`).get(),
        ]);

        const group = groupSnap.val();
        if (!group || !group.members) return;

        const recipientUids = Object.keys(group.members).filter((u) => u !== senderUid);
        if (recipientUids.length === 0) return;

        const tokenSnaps = await Promise.all(
            recipientUids.map((uid) => db.ref(`users/${uid}/fcmTokens`).get())
        );

        // Flatten to a single token list, remembering which uid each token belongs to
        // (needed later for targeted cleanup of dead tokens).
        const tokens = [];
        const tokenOwner = [];
        tokenSnaps.forEach((snap, i) => {
            if (!snap.exists()) return;
            Object.keys(snap.val()).forEach((token) => {
                tokens.push(token);
                tokenOwner.push(recipientUids[i]);
            });
        });
        if (tokens.length === 0) return;

        const senderProfile = senderProfileSnap.val() || {};
        const senderName = senderProfile.name || msg.senderName || "Someone";
        const body = previewFor(msg);

        const messaging = getMessaging();

        const response = await messaging.sendEachForMulticast({
            tokens,
            // STRICTLY DATA-ONLY: same reasoning as the DM function — a top-level
            // 'notification' field would cause a duplicate auto-generated popup
            // alongside the one your service worker/onMessage handler shows.
            data: {
                title: `${senderName} in ${group.name || "Group"}`,
                body,
                groupId,
                icon: group.photoURL || senderProfile.photoURL || "https://i.postimg.cc/Bv3sQWxd/1783111354171.png",
                url: "https://somethingmade.github.io/network/"
            }
        });

        // Clean up dead/unregistered tokens so they stop accumulating.
        const staleTokenUpdates = {};
        response.responses.forEach((res, idx) => {
            if (!res.success) {
                const code = res.error && res.error.code;
                if (
                    code === "messaging/registration-token-not-registered" ||
                    code === "messaging/invalid-registration-token"
                ) {
                    staleTokenUpdates[`users/${tokenOwner[idx]}/fcmTokens/${tokens[idx]}`] = null;
                }
            }
        });

        if (Object.keys(staleTokenUpdates).length > 0) {
            await db.ref().update(staleTokenUpdates);
        }
    }
);
