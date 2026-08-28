const { onValueCreated } = require("firebase-functions/v2/database");
const { onCall, onRequest, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const logger = require("firebase-functions/logger");
const { initializeApp } = require("firebase-admin/app");
const { getDatabase } = require("firebase-admin/database");
const { getFirestore } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");
const admin = require("firebase-admin");
const crypto = require("crypto");

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

// --- HABA VERIFICATION (BUSINESS ACCOUNT — DIDIT IDENTITY CHECK) ---
//
// Self-serve KYC a user goes through when switching to / creating a Business
// Account in Settings (see the "Haba Verification" sheet in index.html). Three
// pieces:
//  - startBusinessVerification (callable) — starts a Didit session for the caller's
//    own uid only, stores it in Firestore under businessVerifications/{uid}.
//  - refreshBusinessVerification (callable) — manual "check now" fallback that polls
//    Didit directly, for the rare case a webhook was missed.
//  - diditWebhook (HTTPS) — Didit calls this on every status change. We verify the
//    HMAC signature, update businessVerifications/{uid}, and on Approved flip
//    users/{uid}/isBusinessAccount in the Realtime Database so the gold badge shows
//    up everywhere the rest of the app already reads it from.
//
// Secrets (set with `firebase functions:secrets:set NAME`):
//  - DIDIT_API_KEY         — x-api-key for verification.didit.me
//  - DIDIT_WEBHOOK_SECRET  — secret_shared_key from the webhook destination you
//                            create in the Didit Business Console
//  - DIDIT_WORKFLOW_ID     — the workflow to run sessions against

const DIDIT_API_KEY = defineSecret("DIDIT_API_KEY");
const DIDIT_WEBHOOK_SECRET = defineSecret("DIDIT_WEBHOOK_SECRET");
const DIDIT_WORKFLOW_ID = defineSecret("DIDIT_WORKFLOW_ID");

const DIDIT_BASE_URL = "https://verification.didit.me";
const WEBHOOK_TOLERANCE_SECONDS = 300; // reject anything older than 5 minutes

/** Masks an ID/passport number for anything that isn't the raw compliance record. */
function maskIdNumber(idNumber) {
    if (!idNumber) return null;
    const digits = String(idNumber);
    if (digits.length <= 4) return "••••";
    return `${"•".repeat(digits.length - 4)}${digits.slice(-4)}`;
}

exports.startBusinessVerification = onCall(
    { secrets: [DIDIT_API_KEY, DIDIT_WORKFLOW_ID] },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Sign in required.");
        }
        const uid = request.auth.uid;
        const { fullName, firstName, lastName, email, idNumber, phone } = request.data || {};

        if (!idNumber || !String(idNumber).trim()) {
            throw new HttpsError("invalid-argument", "An ID number is required.");
        }
        if (!fullName && !(firstName && lastName)) {
            throw new HttpsError("invalid-argument", "Your full legal name is required.");
        }

        const firestore = getFirestore();

        // Reuse an in-flight or already-approved session instead of spawning a
        // duplicate every time the user re-opens the Business Account flow.
        const existingSnap = await firestore.collection("businessVerifications").doc(uid).get();
        if (existingSnap.exists) {
            const existing = existingSnap.data();
            if (existing.url && existing.status && existing.status !== "Declined") {
                return {
                    sessionId: existing.sessionId,
                    url: existing.url,
                    status: existing.status,
                    reused: true,
                };
            }
        }

        const [derivedFirst, ...rest] = (fullName || "").trim().split(/\s+/);
        const derivedLast = rest.join(" ");

        const payload = {
            workflow_id: DIDIT_WORKFLOW_ID.value(),
            vendor_data: `biz:${uid}`,
            metadata: { source: "haba-business-verification", uid },
            contact_details: email
                ? { email, send_notification_emails: true, email_lang: "en" }
                : undefined,
            expected_details: {
                first_name: firstName || derivedFirst || undefined,
                last_name: lastName || derivedLast || undefined,
                identification_number: String(idNumber).trim(),
            },
        };

        const diditRes = await fetch(`${DIDIT_BASE_URL}/v3/session/`, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "x-api-key": DIDIT_API_KEY.value(),
            },
            body: JSON.stringify(payload),
        });

        if (!diditRes.ok) {
            const errBody = await diditRes.text();
            logger.error("Didit business session creation failed", { status: diditRes.status, errBody });
            throw new HttpsError("internal", "Couldn't start verification. Please try again shortly.");
        }

        const session = await diditRes.json();

        await firestore
            .collection("businessVerifications")
            .doc(uid)
            .set({
                uid,
                sessionId: session.session_id,
                sessionToken: session.session_token,
                workflowId: session.workflow_id,
                url: session.url,
                status: session.status || "Not Started",
                applicantName: fullName || [firstName, lastName].filter(Boolean).join(" ") || null,
                email: email || null,
                phone: phone || null,
                idNumberMasked: maskIdNumber(idNumber),
                idNumberLast4: String(idNumber).trim().slice(-4),
                decision: null,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });

        return {
            sessionId: session.session_id,
            url: session.url,
            status: session.status || "Not Started",
        };
    }
);

exports.refreshBusinessVerification = onCall(
    { secrets: [DIDIT_API_KEY] },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Sign in required.");
        }
        const uid = request.auth.uid;
        const firestore = getFirestore();

        const docSnap = await firestore.collection("businessVerifications").doc(uid).get();
        if (!docSnap.exists) {
            throw new HttpsError("not-found", "No verification session found for this account.");
        }
        const { sessionId } = docSnap.data();

        const diditRes = await fetch(`${DIDIT_BASE_URL}/v3/session/${sessionId}/decision/`, {
            headers: { "x-api-key": DIDIT_API_KEY.value() },
        });

        if (!diditRes.ok) {
            throw new HttpsError("internal", "Could not fetch the verification status from Didit.");
        }

        const decision = await diditRes.json();

        await firestore
            .collection("businessVerifications")
            .doc(uid)
            .set(
                {
                    status: decision.status || null,
                    decision,
                    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
                },
                { merge: true }
            );

        if (decision.status === "Approved") {
            try {
                await getDatabase().ref(`users/${uid}`).update({
                    isBusinessAccount: true,
                    businessVerifiedAt: admin.database.ServerValue.TIMESTAMP,
                });
            } catch (e) {
                logger.error("Could not flip isBusinessAccount after approval", { uid, error: e.message });
            }
        }

        return { status: decision.status || null };
    }
);

exports.diditWebhook = onRequest(
    { secrets: [DIDIT_WEBHOOK_SECRET] },
    async (req, res) => {
        if (req.method !== "POST") {
            res.status(405).send("Method not allowed");
            return;
        }

        const signatureHeader = req.headers["x-signature"];
        const timestampHeader = req.headers["x-timestamp"];
        const rawBody = req.rawBody; // Buffer — Functions v2 preserves this before JSON parsing

        if (!signatureHeader || !timestampHeader || !rawBody) {
            res.status(400).send("Missing webhook headers or body.");
            return;
        }

        const timestamp = parseInt(timestampHeader, 10);
        const now = Math.floor(Date.now() / 1000);
        if (!timestamp || Math.abs(now - timestamp) > WEBHOOK_TOLERANCE_SECONDS) {
            logger.warn("Rejected webhook: stale or invalid timestamp", { timestamp, now });
            res.status(400).send("Stale timestamp.");
            return;
        }

        const expectedSignature = crypto
            .createHmac("sha256", DIDIT_WEBHOOK_SECRET.value())
            .update(rawBody)
            .digest("hex");

        const signatureValid =
            expectedSignature.length === String(signatureHeader).length &&
            crypto.timingSafeEqual(Buffer.from(expectedSignature), Buffer.from(String(signatureHeader)));

        if (!signatureValid) {
            logger.warn("Rejected webhook: signature mismatch");
            res.status(401).send("Invalid signature.");
            return;
        }

        const event = req.body; // safe to trust now that the signature checked out
        const { session_id: sessionId, status, webhook_type: webhookType, decision, vendor_data: vendorData } = event;

        if (!sessionId) {
            res.status(400).send("Missing session_id.");
            return;
        }

        // Only Haba's self-serve Business Account sessions reach this webhook — they're
        // always tagged vendor_data: "biz:<uid>" by startBusinessVerification above.
        if (!vendorData || !String(vendorData).startsWith("biz:")) {
            logger.warn("Ignoring webhook with unrecognized vendor_data", { sessionId, vendorData });
            res.status(200).send("ignored");
            return;
        }

        const uid = String(vendorData).slice(4);
        const firestore = getFirestore();
        const bizRef = firestore.collection("businessVerifications").doc(uid);

        await bizRef.set(
            {
                sessionId,
                status: status || null,
                decision: decision || null,
                lastWebhookType: webhookType || null,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            },
            { merge: true }
        );

        // Audit trail — every webhook delivery, kept as its own record.
        await bizRef.collection("events").add({
            webhookType: webhookType || null,
            status: status || null,
            decision: decision || null,
            receivedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        if (status === "Approved") {
            try {
                await getDatabase().ref(`users/${uid}`).update({
                    isBusinessAccount: true,
                    businessVerifiedAt: admin.database.ServerValue.TIMESTAMP,
                });
            } catch (e) {
                logger.error("Could not flip isBusinessAccount after approval", { uid, error: e.message });
            }
        }

        res.status(200).send("ok");
    }
);
