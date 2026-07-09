// Cloud Function v2 (2nd gen) — add this to your Cloud Functions codebase alongside your existing
// push-notification functions, then deploy from Cloud Shell as usual.
//
// Set your Yoco SECRET key (starts with sk_) as a secret, never as plain env var:
//   firebase functions:secrets:set YOCO_SECRET_KEY
// then paste the secret key value when prompted.

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineSecret } = require("firebase-functions/params");
const { getDatabase } = require("firebase-admin/database");
const admin = require("firebase-admin");

if (!admin.apps.length) admin.initializeApp();

const YOCO_SECRET_KEY = defineSecret("YOCO_SECRET_KEY");

exports.chargeYocoVerified = onCall({ secrets: [YOCO_SECRET_KEY] }, async (request) => {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "You must be signed in.");
    }
    const uid = request.auth.uid;
    const { chargeToken, amountInCents, currency } = request.data || {};

    if (!chargeToken || !amountInCents || !currency) {
        throw new HttpsError("invalid-argument", "Missing chargeToken, amountInCents, or currency.");
    }

    // Charge the token via Yoco's Charges API using the SECRET key (server-side only — this key
    // must never reach the client). Docs: https://developer.yoco.com/online/resources/api/charge
    const response = await fetch("https://online.yoco.com/v1/charges/", {
        method: "POST",
        headers: {
            "X-Auth-Secret-Key": YOCO_SECRET_KEY.value(),
            "Content-Type": "application/json"
        },
        body: JSON.stringify({
            token: chargeToken,
            amountInCents,
            currency
        })
    });

    const result = await response.json();

    if (!response.ok || result.status !== "successful") {
        console.error("Yoco charge failed", result);
        throw new HttpsError("failed-precondition", result.displayMessage || "Payment could not be processed.");
    }

    // Charge succeeded — this is the only place isVerified should ever be set to true.
    await getDatabase().ref(`users/${uid}`).update({ isVerified: true });

    return { success: true, chargeId: result.id };
});
