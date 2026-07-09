const { onValueCreated } = require("firebase-functions/v2/database");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getMessaging } = require("firebase-admin/messaging");
const admin = require("firebase-admin");

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

// --- YOCO CHECKOUT (VERIFIED BADGE — ONE-TIME LIFETIME PAYMENT) ---

// Set with: firebase functions:secrets:set YOCO_SECRET_KEY
// Yoco Business Portal > Online Payments > API Keys (starts with sk_live_ / sk_test_)
const YOCO_SECRET_KEY = defineSecret("YOCO_SECRET_KEY");

// Price in ZAR cents for the lifetime Verified badge. Keep this in sync with
// VERIFIED_BADGE_PRICE_CENTS in index.html — the client never sends the amount,
// so this is the only source of truth for what gets charged.
const VERIFIED_BADGE_PRICE_CENTS = 4900;

/**
 * Callable: creates a Yoco Checkout session for the signed-in user and returns the
 * hosted checkout redirectUrl + checkoutId. The client stashes checkoutId and, after
 * being redirected back, calls verifyYocoCheckout with it to confirm the payment.
 */
exports.createYocoCheckout = onCall({ secrets: [YOCO_SECRET_KEY] }, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be signed in to purchase Verified.");
    }
    const uid = request.auth.uid;
    const successUrl = request.data && request.data.successUrl;
    const cancelUrl = request.data && request.data.cancelUrl;
    if (!successUrl || !cancelUrl) {
        throw new HttpsError("invalid-argument", "Missing successUrl/cancelUrl.");
    }

    const db = getDatabase();
    const existing = await db.ref(`users/${uid}/isVerified`).get();
    if (existing.exists() && existing.val() === true) {
        throw new HttpsError("already-exists", "You're already verified.");
    }

    try {
        const res = await fetch("https://payments.yoco.com/api/checkouts", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${YOCO_SECRET_KEY.value()}`,
            },
            body: JSON.stringify({
                amount: VERIFIED_BADGE_PRICE_CENTS,
                currency: "ZAR",
                successUrl,
                cancelUrl,
                failureUrl: cancelUrl,
                // reference carries the uid so verifyYocoCheckout can confirm this checkout
                // actually belongs to the person asking us to verify it.
                reference: uid,
                metadata: { uid, product: "verified_badge" },
            }),
        });

        const data = await res.json();
        if (!res.ok) {
            logger.error("Yoco checkout creation failed", data);
            throw new HttpsError("internal", "Yoco rejected the checkout request.");
        }

        return { redirectUrl: data.redirectUrl, checkoutId: data.id };
    } catch (err) {
        if (err instanceof HttpsError) throw err;
        logger.error("createYocoCheckout error", err);
        throw new HttpsError("internal", "Could not create Yoco checkout.");
    }
});

/**
 * Callable: called by the client right after Yoco redirects back to successUrl.
 * Looks the checkout up directly with Yoco (server-to-server, using the secret key)
 * rather than trusting the redirect itself, confirms it belongs to the caller and
 * that it actually succeeded, then flips users/{uid}/isVerified to true.
 */
exports.verifyYocoCheckout = onCall({ secrets: [YOCO_SECRET_KEY] }, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be signed in.");
    }
    const uid = request.auth.uid;
    const checkoutId = request.data && request.data.checkoutId;
    if (!checkoutId) {
        throw new HttpsError("invalid-argument", "Missing checkoutId.");
    }

    try {
        const res = await fetch(`https://payments.yoco.com/api/checkouts/${checkoutId}`, {
            headers: { "Authorization": `Bearer ${YOCO_SECRET_KEY.value()}` },
        });
        const checkout = await res.json();
        if (!res.ok) {
            logger.error("Could not fetch Yoco checkout", checkoutId, checkout);
            return { verified: false };
        }

        // Make sure this checkout was actually created for the person asking us to verify it.
        if (checkout.reference !== uid) {
            logger.warn(`Checkout ${checkoutId} reference does not match caller ${uid}`);
            throw new HttpsError("permission-denied", "This checkout does not belong to you.");
        }

        if (checkout.status !== "succeeded") {
            return { verified: false, status: checkout.status };
        }

        const db = getDatabase();
        await db.ref(`users/${uid}`).update({
            isVerified: true,
            verifiedAt: admin.database.ServerValue.TIMESTAMP,
            yocoPaymentId: checkout.paymentId || null,
        });

        logger.info(`Verified badge granted to ${uid} via Yoco checkout ${checkoutId}`);
        return { verified: true };
    } catch (err) {
        if (err instanceof HttpsError) throw err;
        logger.error("verifyYocoCheckout error", err);
        throw new HttpsError("internal", "Could not verify payment.");
    }
});
