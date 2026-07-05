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
    if (msg.type === "image") return "📷 Photo";
    if (msg.type === "video") return "🎥 Video";
    if (msg.type === "voice") return "🎤 Voice note";
    if (msg.type === "document" || msg.type === "raw") return "📄 Document";
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
            notification: {
                title: senderName,
                body,
            },
            data: {
                title: senderName,
                body,
                chatUid: senderUid,
                icon: senderProfile.photoURL || "",
            },
            webpush: {
                fcmOptions: {
                    link: "/",
                },
            },
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
                    staleTokenUpdates[`users/${recipientUid}/fcmTokens/${tokens[idx]}`] = null;
                }
            }
        });

        if (Object.keys(staleTokenUpdates).length > 0) {
            await db.ref().update(staleTokenUpdates);
        }
    }
);
