// functions/index.js
//
// Server-side half of Trakka's Google Play Billing subscription. The
// Android app (a PWABuilder-generated TWA) collects a purchase via the
// Digital Goods / Payment Request APIs; that only proves a purchase flow
// completed on-device, not that it's real or still active — Play purchase
// tokens are opaque strings a client could fabricate or replay. So the
// client sends the token here, and only this function (running as a
// trusted server, never as the user's own browser) calls the Google Play
// Developer API to confirm it, and is the only thing allowed to write
// entitlements/{uid} — see firestore.rules, which denies client writes to
// that collection entirely.
//
// Auth to the Play Developer API: no service-account JSON key is bundled
// here on purpose (one more secret to leak). Instead this relies on
// Application Default Credentials — the Cloud Functions runtime's own
// service account. For that to work, its email (shown as
// "<project-id>@appspot.gserviceaccount.com" for older gen-1 style
// projects, or check the Cloud Functions console for this one) must be
// added in Play Console under Setup → API access, then granted at least
// "View financial data" + "Manage orders and subscriptions" permission for
// this app. Without that grant, every call below fails with a 403 from
// Google, not from this code.
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { onSchedule } = require("firebase-functions/v2/scheduler");
const { setGlobalOptions } = require("firebase-functions/v2");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");
const { google } = require("googleapis");

admin.initializeApp();
const db = admin.firestore();

setGlobalOptions({ region: "us-central1", maxInstances: 10 });

// Must match the Android package PWABuilder generated (see .well-known/
// assetlinks.json's package_name) — Play verifies purchase tokens against
// one specific app package, not just any app on your account.
const PACKAGE_NAME = "ng.com.trakka.twa";

// Play Console → Monetize → Subscriptions → product ID. Keep this in sync
// with whatever's actually configured there.
const PREMIUM_SUBSCRIPTION_ID = "trakka_premium_monthly";

async function androidPublisher() {
  const auth = new google.auth.GoogleAuth({
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  const client = await auth.getClient();
  return google.androidpublisher({ version: "v3", auth: client });
}

// Reads a subscription purchase from Play and normalizes the fields this
// file actually cares about. Throws if Play doesn't recognize the token
// (wrong package, fabricated token, or a token from a different app).
async function fetchSubscription(purchaseToken, subscriptionId) {
  const publisher = await androidPublisher();
  const res = await publisher.purchases.subscriptions.get({
    packageName: PACKAGE_NAME,
    subscriptionId,
    token: purchaseToken,
  });
  const p = res.data;
  const expiryMs = Number(p.expiryTimeMillis || 0);
  // paymentState: 0 = pending, 1 = received, 2 = free trial, 3 = pending deferred upgrade/downgrade.
  // cancelReason present + expiry in the past means it's actually over, not just "will not renew".
  const active = expiryMs > Date.now() && p.paymentState !== 0;
  return { active, expiryMs, raw: p };
}

exports.verifyPlayPurchase = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) {
    throw new HttpsError("unauthenticated", "Sign in before verifying a purchase.");
  }
  const purchaseToken = String(request.data && request.data.purchaseToken || "");
  const subscriptionId = String(request.data && request.data.subscriptionId || PREMIUM_SUBSCRIPTION_ID);
  if (!purchaseToken) {
    throw new HttpsError("invalid-argument", "Missing purchaseToken.");
  }

  let result;
  try {
    result = await fetchSubscription(purchaseToken, subscriptionId);
  } catch (err) {
    logger.error("Play purchase verification failed", { uid, err: String(err) });
    throw new HttpsError("failed-precondition", "Could not verify this purchase with Google Play.");
  }

  if (!result.active) {
    throw new HttpsError("failed-precondition", "This subscription is not currently active.");
  }

  // acknowledgementState 0 = not yet acknowledged. Play auto-refunds a
  // subscription that's never acknowledged within 3 days, so this has to
  // happen as part of verifying it, not as a separate manual step.
  if (result.raw.acknowledgementState === 0) {
    const publisher = await androidPublisher();
    await publisher.purchases.subscriptions.acknowledge({
      packageName: PACKAGE_NAME,
      subscriptionId,
      token: purchaseToken,
    });
  }

  await db.collection("entitlements").doc(uid).set({
    premium: true,
    productId: subscriptionId,
    purchaseToken,
    expiryTimeMillis: result.expiryMs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return { premium: true, expiryTimeMillis: result.expiryMs };
});

// Play does not push renewal/cancellation events here unless Real-time
// Developer Notifications (a separate Pub/Sub setup) is wired up — until
// that's added, this daily sweep is what catches a lapsed or cancelled
// subscription and turns premium back off, instead of it silently staying
// true forever after the first successful verify.
exports.refreshEntitlements = onSchedule("every 24 hours", async () => {
  const snap = await db.collection("entitlements").where("premium", "==", true).get();
  if (snap.empty) return;

  const publisher = await androidPublisher();
  const results = await Promise.allSettled(snap.docs.map(async (docSnap) => {
    const data = docSnap.data();
    if (!data.purchaseToken || !data.productId) return;
    const res = await publisher.purchases.subscriptions.get({
      packageName: PACKAGE_NAME,
      subscriptionId: data.productId,
      token: data.purchaseToken,
    });
    const expiryMs = Number(res.data.expiryTimeMillis || 0);
    const active = expiryMs > Date.now();
    if (!active) {
      await docSnap.ref.set({
        premium: false,
        expiryTimeMillis: expiryMs,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
      logger.info("Entitlement lapsed", { uid: docSnap.id });
    } else if (expiryMs !== data.expiryTimeMillis) {
      await docSnap.ref.set({ expiryTimeMillis: expiryMs }, { merge: true });
    }
  }));

  results.forEach((r, i) => {
    if (r.status === "rejected") {
      logger.error("Failed to refresh entitlement", { uid: snap.docs[i].id, err: String(r.reason) });
    }
  });
});
