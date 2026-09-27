// billing.js
//
// The actual Google Play purchase flow. Kept separate from firebase-init.js
// (which only knows how to watch/report entitlement state and relay a
// purchase token to the server) because everything in here is browser
// platform API glue — Digital Goods API + Payment Request API — that only
// works at all inside the installed Android TWA, never in a normal
// desktop/mobile browser tab. See PR description for the PWABuilder
// packaging step ("Enable Google Play Billing") this depends on.
//
// IMPORTANT: this proves a purchase FLOW completed, nothing more. The
// purchaseToken it gets back is untrusted until firebase-init.js's
// verifyPurchase() sends it to the verifyPlayPurchase Cloud Function, which
// checks it against Google's own servers before entitlements/{uid} (the
// thing that actually gates premium features) ever changes — see that
// function's comments for why this can't be skipped.
const PREMIUM_SUBSCRIPTION_ID = "trakka_premium_monthly";
const PLAY_BILLING_METHOD = "https://play.google.com/billing";

function digitalGoodsAvailable() {
  return "getDigitalGoodsService" in window;
}

async function getPlayBillingService() {
  return window.getDigitalGoodsService(PLAY_BILLING_METHOD);
}

// Returns { id, title, description, price: {value, currency} } or null if
// Play doesn't recognize the SKU (product not set up yet in Play Console,
// or a typo in PREMIUM_SUBSCRIPTION_ID above vs. the Play Console listing).
async function getPremiumProductDetails() {
  if (!digitalGoodsAvailable()) return null;
  const service = await getPlayBillingService();
  const [details] = await service.getDetails([PREMIUM_SUBSCRIPTION_ID]);
  return details || null;
}

// Runs the actual purchase sheet. Resolves { ok:true, premium:true } on a
// verified purchase, { ok:false, reason } otherwise — reason is one of
// "unsupported" (not running inside the TWA), "cancelled" (user backed out
// of the payment sheet — not an error), or "failed" (payment or server
// verification genuinely failed).
async function purchasePremium() {
  if (!digitalGoodsAvailable()) {
    return { ok: false, reason: "unsupported" };
  }
  if (!window.__ftUid) {
    return { ok: false, reason: "failed", message: "Sign in first." };
  }

  const request = new PaymentRequest(
    [{ supportedMethods: PLAY_BILLING_METHOD, data: { sku: PREMIUM_SUBSCRIPTION_ID } }],
    { total: { label: "Trakka Premium", amount: { currency: "USD", value: "0" } } }
  );

  let response;
  try {
    response = await request.show();
  } catch (err) {
    // AbortError: the user closed the payment sheet — normal, not a failure.
    if (err && err.name === "AbortError") return { ok: false, reason: "cancelled" };
    console.error("Trakka: payment request failed", err);
    return { ok: false, reason: "failed", message: String(err && err.message || err) };
  }

  const purchaseToken = response.details && response.details.purchaseToken;
  if (!purchaseToken) {
    await response.complete("fail");
    return { ok: false, reason: "failed", message: "No purchase token returned." };
  }

  try {
    const result = await window.Trakka.verifyPurchase(purchaseToken, PREMIUM_SUBSCRIPTION_ID);
    await response.complete("success");
    return { ok: true, premium: !!result.premium };
  } catch (err) {
    await response.complete("fail");
    console.error("Trakka: purchase verification failed", err);
    return { ok: false, reason: "failed", message: "Purchase completed but couldn't be verified. It will retry automatically — contact support if this keeps happening." };
  }
}

// Covers the case where a purchase went through (Play has it, money moved)
// but verifyPurchase never got called or failed — a crashed tab mid-flow, a
// flaky connection right after request.show() resolved. Play still has the
// purchase on record even though entitlements/{uid} was never updated, so
// this re-sends every currently-owned token through the same verification
// path rather than making the user pay twice or file a support ticket.
async function restorePurchases() {
  if (!digitalGoodsAvailable() || !window.__ftUid) {
    return { ok: false, reason: "unsupported" };
  }
  const service = await getPlayBillingService();
  const purchases = await service.listPurchases();
  const premiumPurchase = purchases.find((p) => p.itemId === PREMIUM_SUBSCRIPTION_ID);
  if (!premiumPurchase) return { ok: false, reason: "none-found" };
  try {
    const result = await window.Trakka.verifyPurchase(premiumPurchase.purchaseToken || premiumPurchase.token, PREMIUM_SUBSCRIPTION_ID);
    return { ok: true, premium: !!result.premium };
  } catch (err) {
    console.error("Trakka: restore verification failed", err);
    return { ok: false, reason: "failed" };
  }
}

window.TrakkaBilling = {
  isSupported: digitalGoodsAvailable,
  getPremiumProductDetails,
  purchasePremium,
  restorePurchases,
};
