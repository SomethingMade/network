// Add this alongside your existing sendDmPushNotification export in the same
// functions/index.js (it reuses the same previewFor() helper you already have,
// so don't duplicate that — just add this new export below it).
//
// Deploy with:
//   firebase deploy --only functions:sendGroupPushNotification

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
