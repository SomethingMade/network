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
const { RtcTokenBuilder, RtcRole } = require("agora-token");

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

// --- HABA AI (XAI/GROK CHAT) ---
//
// Callable the client hits as httpsCallable(functionsClient, "habaAIChat") with
// { messages: [{ role, content }, ...] } and gets back { text }. The xAI key and
// system prompt live only here — never sent to or stored on the client.
//
// Secret (set with `firebase functions:secrets:set NAME`):
//  - XAI_API_KEY — from https://console.x.ai
//
// Independent of anything else calling xAI elsewhere (e.g. Nuru) — separate secret
// binding, separate system prompt, no shared code.

const XAI_API_KEY = defineSecret("XAI_API_KEY");

const XAI_MODEL = "grok-4";
const XAI_ENDPOINT = "https://api.x.ai/v1/chat/completions";


const HABA_AI_SYSTEM_PROMPT = `You are Haba AI, the assistant built into the Haba messaging app.
You chat with users right inside their DMs, the same as any other contact would.
Be helpful, direct, and conversational — short, natural replies rather than long essays,
unless the user's question genuinely needs more depth. You can help with everyday questions,
drafting or improving messages, explaining things, and general conversation. You do not have
access to the user's other chats, contacts, or any private data in the app beyond what they
type directly to you in this conversation.`;

// Keeps the request small and well-formed: drops anything without real text, caps each
// message's length, and only keeps the most recent turns.
const HABA_AI_MAX_MESSAGE_CHARS = 4000;
const HABA_AI_MAX_HISTORY_TURNS = 30;

function sanitizeHabaAIMessages(rawMessages) {
    if (!Array.isArray(rawMessages)) return [];
    return rawMessages
        .filter((m) => m && typeof m.content === "string" && m.content.trim().length > 0)
        .map((m) => ({
            role: m.role === "assistant" ? "assistant" : "user",
            content: m.content.slice(0, HABA_AI_MAX_MESSAGE_CHARS),
        }))
        .slice(-HABA_AI_MAX_HISTORY_TURNS);
}

exports.habaAIChat = onCall(
    {
        secrets: [XAI_API_KEY],
        maxInstances: 20,
        timeoutSeconds: 60,
    },
    async (request) => {
        if (!request.auth) {
            throw new HttpsError("unauthenticated", "Sign in to use Haba AI.");
        }

        const messages = sanitizeHabaAIMessages(request.data && request.data.messages);
        if (messages.length === 0) {
            throw new HttpsError("invalid-argument", "No message content to send.");
        }

        const apiKey = XAI_API_KEY.value();
        if (!apiKey) {
            logger.error("habaAIChat: XAI_API_KEY secret is not set");
            throw new HttpsError("failed-precondition", "AI is not configured yet.");
        }

        let response;
        try {
            response = await fetch(XAI_ENDPOINT, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`,
                },
                body: JSON.stringify({
                    model: XAI_MODEL,
                    messages: [{ role: "system", content: HABA_AI_SYSTEM_PROMPT }, ...messages],
                }),
            });
        } catch (err) {
            logger.error("habaAIChat: network error reaching xAI", err);
            throw new HttpsError("unavailable", "Could not reach xAI.");
        }

        if (!response.ok) {
            const errBody = await response.text().catch(() => "");
            logger.error("habaAIChat: xAI returned an error", { status: response.status, errBody });
            throw new HttpsError("internal", `xAI request failed (${response.status}).`);
        }

        let data;
        try {
            data = await response.json();
        } catch (err) {
            logger.error("habaAIChat: failed to parse xAI response as JSON", err);
            throw new HttpsError("internal", "xAI returned an unreadable response.");
        }

        const text =
            data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
        if (!text) {
            logger.error("habaAIChat: unexpected xAI response shape", JSON.stringify(data));
            throw new HttpsError("internal", "xAI returned an empty response.");
        }

        return { text };
    }
);

// --- LIVE (Agora RTC token minting) ---
// The haba Agora project has its Primary Certificate enabled (mandatory — Agora no longer
// offers certificate-free projects), so every client join needs a signed token from here.
// Setup: cd functions && npm install agora-token
//        firebase functions:secrets:set AGORA_APP_CERTIFICATE
//        (paste the Primary certificate value from Agora Console → Project credentials —
//        tap the copy icon next to it; the console only shows it masked on screen)
const AGORA_APP_ID = "eb44e3788b4d4c5ea3f2cabc174b6341"; // haba's Agora App ID
const AGORA_APP_CERTIFICATE = defineSecret("AGORA_APP_CERTIFICATE");

exports.generateAgoraToken = onCall({ secrets: [AGORA_APP_CERTIFICATE] }, (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "Sign in required.");
    }

    const { channelName, uid } = request.data || {};
    if (!channelName || typeof channelName !== "string") {
        throw new HttpsError("invalid-argument", "channelName is required.");
    }
    if (typeof uid !== "number" || !Number.isInteger(uid) || uid < 0) {
        throw new HttpsError("invalid-argument", "uid must be a non-negative integer.");
    }

    const appCertificate = AGORA_APP_CERTIFICATE.value();
    const expireSeconds = 24 * 60 * 60; // 24h — comfortably longer than any single live session
    const nowTs = Math.floor(Date.now() / 1000);
    const privilegeExpireTs = nowTs + expireSeconds;

    // Every caller (host, guest, and audience alike) gets a PUBLISHER-privilege token — the
    // Agora client SDK's own audience/host role still gates who can actually publish, so this
    // lets the host promote a viewer to co-host later without a token re-fetch or rejoin.
    const token = RtcTokenBuilder.buildTokenWithUid(
        AGORA_APP_ID,
        appCertificate,
        channelName,
        uid,
        RtcRole.PUBLISHER,
        privilegeExpireTs,
        privilegeExpireTs
    );

    return { token, uid, appId: AGORA_APP_ID };
});

// --- HABA AI VOICE (Agora Conversational AI Engine) ---
//
// "Talk to Haba AI" voice feature. Starts/stops a Conversational AI Engine agent that joins
// the same Agora channel as the human (who joins client-side via generateAgoraToken above).
//
// Runs on Agora-managed OpenAI (credential_mode: "managed") — no API key, custom endpoint,
// or proxy needed on our side. This is deliberately NOT the same backend as habaAIChat's text
// chat (which uses xAI/Grok, see XAI_API_KEY/XAI_MODEL above): an earlier version tried
// routing this through xAI directly (and then through a proxy Cloud Function to work around
// xAI rejecting fields Agora sends, like stream_options) but managed OpenAI is simpler and
// has one less moving part to break. The system_messages/greeting/failure text below is what
// keeps the "Haba AI" persona consistent between the two even though the model differs.
//
// Reuses this file's existing AGORA_APP_ID and AGORA_APP_CERTIFICATE bindings. New secrets
// needed, only for these two functions:
//  - AGORA_CUSTOMER_ID     — RESTful API auth Customer ID (Agora Console), DIFFERENT from the
//                            App Certificate — used only to authenticate server-to-server calls
//                            to the Conversational AI REST API (start/stop the agent).
//  - AGORA_CUSTOMER_SECRET — the paired Customer Secret from the same place.
// Setup: enable "Conversational AI Engine" on the haba Agora project, create the Customer
// ID/Secret under RESTful API auth, then:
//   firebase functions:secrets:set AGORA_CUSTOMER_ID
//   firebase functions:secrets:set AGORA_CUSTOMER_SECRET
//   npm install agora-token   (already a dependency, used by generateAgoraToken above)

const AGORA_CUSTOMER_ID = defineSecret("AGORA_CUSTOMER_ID");
const AGORA_CUSTOMER_SECRET = defineSecret("AGORA_CUSTOMER_SECRET");

// Fixed numeric uid the agent joins as — the human's uid is always a random 1..1e8 value
// generated client-side (see generateAgoraToken call sites), so 0 never collides with it.
const AGENT_RTC_UID = 0;
const AGENT_TOKEN_TTL_SECONDS = 3600;

/**
 * Called after the human has already joined the Agora channel (client-side, using the
 * existing generateAgoraToken flow). Starts a Conversational AI Engine agent that joins the
 * same channel and begins talking with them.
 *
 * @param {{ channelName: string, remoteUid: number }} request.data
 * @returns {{ agentId: string }}
 */
exports.startHabaAIVoiceCall = onCall(
    { secrets: [AGORA_APP_CERTIFICATE, AGORA_CUSTOMER_ID, AGORA_CUSTOMER_SECRET] },
    async (request) => {
        if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
        const { channelName, remoteUid } = request.data || {};
        if (!channelName || !remoteUid) {
            throw new HttpsError("invalid-argument", "channelName and remoteUid are required.");
        }

        const appCertificate = AGORA_APP_CERTIFICATE.value();
        const expireTs = Math.floor(Date.now() / 1000) + AGENT_TOKEN_TTL_SECONDS;

        // Token the agent itself uses to authenticate when it joins the channel.
        const agentToken = RtcTokenBuilder.buildTokenWithUid(
            AGORA_APP_ID, appCertificate, channelName, AGENT_RTC_UID, RtcRole.PUBLISHER, expireTs, expireTs
        );

        const basicAuth = Buffer.from(`${AGORA_CUSTOMER_ID.value()}:${AGORA_CUSTOMER_SECRET.value()}`).toString("base64");

        const body = {
            name: `haba-ai-${request.auth.uid}-${Date.now()}`,
            properties: {
                channel: channelName,
                token: agentToken,
                agent_rtc_uid: String(AGENT_RTC_UID),
                remote_rtc_uids: [String(remoteUid)],
                idle_timeout: 60,
                asr: {
                    credential_mode: "managed",
                    vendor: "deepgram",
                    // Agora's join API requires this even in managed mode — omitting it fails
                    // validation with "Invalid value at properties.asr.params.url: required
                    // field is missing".
                    params: { url: "wss://api.deepgram.com/v1/listen", model: "nova-3", language: "en-US" }
                },
                llm: {
                    credential_mode: "managed", // Agora-hosted OpenAI — no API key or custom
                    vendor: "openai",           // endpoint needed, and no xAI compatibility
                    style: "openai",            // quirks to work around (see git history for
                    url: "https://api.openai.com/v1/chat/completions", // the xAI proxy this replaced).
                    params: { model: "gpt-4o-mini" },
                    system_messages: [{
                        role: "system",
                        content: "You are Haba AI, the friendly built-in voice assistant inside the Haba app. Keep replies short, warm, and conversational — you're being heard, not read."
                    }],
                    greeting_message: "Hey, it's Haba AI — what's up?",
                    failure_message: "Sorry, I didn't catch that — can you say it again?",
                    max_history: 10
                },
                tts: {
                    credential_mode: "managed",
                    vendor: "minimax",
                    // Same as asr.params.url above — Agora's join API requires this explicitly
                    // even in managed mode, or it fails with "Invalid value at
                    // properties.tts.params.url: required field is missing".
                    params: {
                        url: "wss://api.minimax.io/ws/v1/t2a_v2",
                        model: "speech-2.6-turbo",
                        voice_setting: { voice_id: "English_captivating_female1" }
                    }
                }
            }
        };

        const resp = await fetch(`https://api.agora.io/api/conversational-ai-agent/v2/projects/${AGORA_APP_ID}/join`, {
            method: "POST",
            headers: { Authorization: `Basic ${basicAuth}`, "Content-Type": "application/json" },
            body: JSON.stringify(body)
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
            logger.error("Agora Conversational AI join failed", { status: resp.status, data });
            throw new HttpsError("internal", data.message || data.detail || "Could not start Haba AI voice agent.");
        }

        return { agentId: data.agent_id };
    }
);

/**
 * Stops a running Conversational AI Engine agent.
 *
 * @param {{ agentId: string }} request.data
 * @returns {{ stopped: true }}
 */
exports.stopHabaAIVoiceCall = onCall(
    { secrets: [AGORA_CUSTOMER_ID, AGORA_CUSTOMER_SECRET] },
    async (request) => {
        if (!request.auth) throw new HttpsError("unauthenticated", "Sign in required.");
        const { agentId } = request.data || {};
        if (!agentId) throw new HttpsError("invalid-argument", "agentId is required.");

        const basicAuth = Buffer.from(`${AGORA_CUSTOMER_ID.value()}:${AGORA_CUSTOMER_SECRET.value()}`).toString("base64");

        const resp = await fetch(
            `https://api.agora.io/api/conversational-ai-agent/v2/projects/${AGORA_APP_ID}/agents/${agentId}/leave`,
            { method: "POST", headers: { Authorization: `Basic ${basicAuth}` } }
        );
        if (!resp.ok) {
            const data = await resp.json().catch(() => ({}));
            logger.error("Agora Conversational AI leave failed", { status: resp.status, data });
            // Don't throw — the client is already tearing its own UI down at this point, and a
            // stuck agent will still self-terminate via idle_timeout even if this call fails.
        }

        return { stopped: true };
    }
);
