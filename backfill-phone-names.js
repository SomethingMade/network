/**
 * backfill-phone-names.js
 *
 * One-off admin script: finds existing Haba accounts whose public `name` field is actually
 * their raw phone number (the bug fixed client-side in index.html — see promptSetName() and
 * the onAuthStateChanged safety-net fallback), and resets each one to a safe placeholder.
 *
 * It does NOT try to guess a real name for anyone — there's no way to know what they'd want
 * to be called. Instead it:
 *   1. Replaces the exposed name with a private-looking placeholder ("User" + last 4 of uid).
 *   2. Sets `needsNamePrompt: true` on that account, so the next time that person opens the
 *      app, the client (see the needsNamePrompt check in onAuthStateChanged) forces them
 *      through the same "What should we call you?" step a brand-new signup goes through,
 *      before the app UI appears.
 *
 * WHAT THIS DOES NOT DO
 *   - It does not touch Firebase Auth's displayName, only the Realtime Database `name` field
 *     the app actually reads for public display. If displayName was already set for some of
 *     these accounts, the client's promptSetName() re-prompt will overwrite it again anyway
 *     once they log back in and go through the prompt.
 *   - It does not send any notification — the person just sees the new-name prompt next time
 *     they open the app, same UX as a fresh signup.
 *
 * SETUP
 *   1. npm install firebase-admin
 *   2. Download a service account key from:
 *      Firebase Console -> Project Settings -> Service Accounts -> Generate New Private Key
 *   3. Set the two constants below (or pass as env vars — see bottom of file).
 *
 * USAGE
 *   node backfill-phone-names.js            # dry run — logs what WOULD change, writes nothing
 *   node backfill-phone-names.js --apply    # actually writes the changes
 *
 * Always run the dry run first and read the output before using --apply.
 */

const admin = require('firebase-admin');

// ── CONFIG ──────────────────────────────────────────────────────────────────────────────
const SERVICE_ACCOUNT_PATH = process.env.SERVICE_ACCOUNT_PATH || './serviceAccountKey.json';
const DATABASE_URL = process.env.DATABASE_URL || 'https://YOUR-PROJECT-ID-default-rtdb.firebaseio.com';
// ────────────────────────────────────────────────────────────────────────────────────────

const APPLY = process.argv.includes('--apply');

// Matches a `name` field that is nothing but a phone number: optional leading +, then 7-15
// digits, allowing spaces/dashes/parens/dots as separators (how phone numbers commonly get
// stored/displayed). Deliberately conservative — a false negative (missing a genuine phone-
// number-as-name) just means it isn't fixed by this pass; a false positive would wrongly
// reset someone's real chosen name, which is the worse mistake to make here.
const PHONE_LIKE_NAME = /^\+?[\d\s\-().]{7,20}$/;

function looksLikePhoneNumber(name) {
    if (!name || typeof name !== 'string') return false;
    const digitCount = (name.match(/\d/g) || []).length;
    return PHONE_LIKE_NAME.test(name.trim()) && digitCount >= 7;
}

function placeholderNameFor(uid) {
    return 'User' + uid.slice(-4);
}

async function main() {
    admin.initializeApp({
        credential: admin.credential.cert(require(SERVICE_ACCOUNT_PATH)),
        databaseURL: DATABASE_URL,
    });

    const db = admin.database();
    const usersSnap = await db.ref('users').once('value');
    if (!usersSnap.exists()) {
        console.log('No users node found — check DATABASE_URL.');
        return;
    }

    const affected = [];
    usersSnap.forEach((childSnap) => {
        const uid = childSnap.key;
        const data = childSnap.val() || {};
        if (looksLikePhoneNumber(data.name)) {
            affected.push({ uid, exposedName: data.name });
        }
    });

    console.log(`Scanned ${usersSnap.numChildren()} accounts.`);
    console.log(`Found ${affected.length} account(s) with a phone-number-shaped public name:\n`);
    affected.forEach(({ uid, exposedName }) => {
        console.log(`  ${uid}  ->  "${exposedName}"  ->  will become "${placeholderNameFor(uid)}"`);
    });

    if (!affected.length) {
        console.log('\nNothing to do.');
        return;
    }

    if (!APPLY) {
        console.log(`\nDry run only — no writes made. Re-run with --apply to fix these ${affected.length} account(s).`);
        return;
    }

    console.log(`\nApplying fixes to ${affected.length} account(s)...`);
    const updates = {};
    affected.forEach(({ uid }) => {
        updates[`users/${uid}/name`] = placeholderNameFor(uid);
        updates[`users/${uid}/needsNamePrompt`] = true;
    });
    await db.ref().update(updates);
    console.log('Done. Each affected account will be prompted to choose a real name on next login.');
}

main()
    .then(() => process.exit(0))
    .catch((err) => {
        console.error('Backfill failed:', err);
        process.exit(1);
    });
