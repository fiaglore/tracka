// worker.js
//
// Cloudflare Worker handling the one piece of Trakka that needs real
// backend logic: profile photo storage in R2. Everything else is served
// straight from static assets (see wrangler.jsonc) — nothing in the assets
// directory matches /api/avatar*, so that's the only path that ever
// reaches this file; every other request is handled by Workers' own
// asset-serving logic before this script even runs.
//
// Firebase Storage now requires the paid Blaze plan just to switch on, so
// profile photos live here instead, in a plain R2 bucket. R2 has no
// per-user security-rules engine the way Firestore/Storage rules did, so
// this file IS the access control: it verifies the caller's Firebase ID
// token itself (Google's own public signing keys, RS256) before letting
// anyone touch the bucket, rather than trusting the client's claimed uid.

const FIREBASE_PROJECT_ID = "tracka-app-f97e1";
const GOOGLE_JWK_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MAX_RECEIPT_BYTES = 5 * 1024 * 1024;

// Kept in sync by hand with app.js's ADMIN_EMAIL — this account can read
// anyone's uploaded receipt (see handleReceiptGet below) to review premium
// requests, same override that unlocks every premium feature client-side.
const ADMIN_EMAIL = "lolafalobi@gmail.com";

// Cached per-isolate — Workers reuse a warm isolate across many requests,
// so this avoids refetching Google's signing keys on every single upload.
// An hour is generous but harmless: these keys rotate on the order of
// weeks, Google serves them with long cache lifetimes itself, and a cold
// isolate just fetches fresh ones anyway.
let cachedKeys = null;
let cachedKeysAt = 0;
const KEY_CACHE_MS = 60 * 60 * 1000;

async function getGoogleSigningKeys() {
  const now = Date.now();
  if (cachedKeys && now - cachedKeysAt < KEY_CACHE_MS) return cachedKeys;
  const res = await fetch(GOOGLE_JWK_URL);
  if (!res.ok) throw new Error("Could not fetch verification keys.");
  const data = await res.json();
  cachedKeys = data.keys || [];
  cachedKeysAt = now;
  return cachedKeys;
}

function base64UrlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(b64url.length / 4) * 4, "=");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function base64UrlToJson(b64url) {
  return JSON.parse(new TextDecoder().decode(base64UrlToBytes(b64url)));
}

// Verifies a Firebase ID token the way Firebase's own Admin SDK does
// (see https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library),
// using only Web Crypto so this Worker needs no npm dependency to build.
// Returns the token's subject (the Firebase uid) once every check passes.
async function verifyFirebaseIdToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed token.");
  const [headerB64, payloadB64, sigB64] = parts;
  const header = base64UrlToJson(headerB64);
  const payload = base64UrlToJson(payloadB64);

  if (header.alg !== "RS256") throw new Error("Unexpected token algorithm.");

  const keys = await getGoogleSigningKeys();
  const jwk = keys.find(function (k) { return k.kid === header.kid; });
  if (!jwk) throw new Error("Unknown signing key.");

  const cryptoKey = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );
  const signedData = new TextEncoder().encode(headerB64 + "." + payloadB64);
  const signature = base64UrlToBytes(sigB64);
  const validSignature = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", cryptoKey, signature, signedData);
  if (!validSignature) throw new Error("Invalid token signature.");

  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now) throw new Error("Token expired.");
  if (typeof payload.iat !== "number" || payload.iat > now + 60) throw new Error("Token not valid yet.");
  if (payload.aud !== FIREBASE_PROJECT_ID) throw new Error("Token issued for a different project.");
  if (payload.iss !== "https://securetoken.google.com/" + FIREBASE_PROJECT_ID) throw new Error("Unexpected token issuer.");
  if (!payload.sub) throw new Error("Token missing subject.");

  return { uid: payload.sub, email: payload.email || null };
}

async function requireAuth(request) {
  const authHeader = request.headers.get("Authorization") || "";
  const match = authHeader.match(/^Bearer (.+)$/);
  if (!match) throw new Error("Missing bearer token.");
  return verifyFirebaseIdToken(match[1]);
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" }
  });
}

async function handleUpload(request, env) {
  let uid;
  try { ({ uid } = await requireAuth(request)); }
  catch (e) { return jsonResponse({ error: e.message }, 401); }

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.startsWith("image/")) {
    return jsonResponse({ error: "Please upload an image file." }, 400);
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return jsonResponse({ error: "Empty upload." }, 400);
  if (bytes.byteLength > MAX_AVATAR_BYTES) {
    return jsonResponse({ error: "That image is too large (max 2MB)." }, 400);
  }

  await env.AVATARS.put("avatars/" + uid, bytes, {
    httpMetadata: { contentType: contentType, cacheControl: "public, max-age=31536000" }
  });

  // Cache-bust the URL stored on the user's profile so browsers that
  // already cached the previous photo at this same path pick up the new
  // one immediately, instead of waiting out the year-long cache-control.
  const url = new URL(request.url);
  return jsonResponse({ url: url.origin + "/api/avatar/" + uid + "?v=" + Date.now() });
}

async function handleDelete(request, env) {
  let uid;
  try { ({ uid } = await requireAuth(request)); }
  catch (e) { return jsonResponse({ error: e.message }, 401); }

  await env.AVATARS.delete("avatars/" + uid);
  return jsonResponse({ ok: true });
}

async function handleGet(request, env, uid) {
  if (!uid) return new Response("Not found.", { status: 404 });

  const object = await env.AVATARS.get("avatars/" + uid);
  if (!object) return new Response("Not found.", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  if (!headers.has("cache-control")) headers.set("cache-control", "public, max-age=31536000");

  return new Response(object.body, { headers });
}

// ----- receipt uploads (proof of a manual bank transfer for Premium) -----
// Unlike avatars, receipts are private financial documents — a bank
// transfer receipt can show account numbers and balances, so unlike
// handleGet above this never serves one without checking who's asking.
// One object per user (receipts/{uid}), overwritten on every re-upload,
// same as avatars — a brand-new receipt for a still-pending request simply
// replaces the old one, since only the latest submission matters.
async function handleReceiptUpload(request, env) {
  let uid;
  try { ({ uid } = await requireAuth(request)); }
  catch (e) { return jsonResponse({ error: e.message }, 401); }

  const contentType = request.headers.get("Content-Type") || "";
  if (!contentType.startsWith("image/") && contentType !== "application/pdf") {
    return jsonResponse({ error: "Please upload an image or PDF of your receipt." }, 400);
  }

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return jsonResponse({ error: "Empty upload." }, 400);
  if (bytes.byteLength > MAX_RECEIPT_BYTES) {
    return jsonResponse({ error: "That file is too large (max 5MB)." }, 400);
  }

  await env.RECEIPTS.put("receipts/" + uid, bytes, {
    httpMetadata: { contentType: contentType }
  });

  const url = new URL(request.url);
  return jsonResponse({ url: url.origin + "/api/receipt/" + uid + "?v=" + Date.now() });
}

async function handleReceiptGet(request, env, uid) {
  if (!uid) return new Response("Not found.", { status: 404 });

  let auth;
  try { auth = await requireAuth(request); }
  catch (e) { return jsonResponse({ error: e.message }, 401); }
  if (auth.uid !== uid && auth.email !== ADMIN_EMAIL) {
    return jsonResponse({ error: "Not allowed." }, 403);
  }

  const object = await env.RECEIPTS.get("receipts/" + uid);
  if (!object) return new Response("Not found.", { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "private, no-store");

  return new Response(object.body, { headers });
}

// ----- live FX rates (Premium "auto-updating FX rates" feature) -----
// No auth needed — this is the same public exchange-rate data for every
// caller, nothing account-specific, same trust level as fetching any other
// public API. Cached per-isolate for a few minutes (mirroring the Google
// signing-keys cache above) so a page with several foreign currencies
// doesn't trigger a separate upstream call per currency, and so Premium
// users opening Settings → Currency rates repeatedly within the same
// warm isolate don't re-hit the upstream API every time.
const FX_CACHE_MS = 5 * 60 * 1000;
let fxCache = {}; // { [base]: { data, cachedAt } }

async function handleFxRates(request, env) {
  const url = new URL(request.url);
  const base = (url.searchParams.get("base") || "USD").toUpperCase();
  if (!/^[A-Z]{3}$/.test(base)) {
    return jsonResponse({ error: "Invalid base currency code." }, 400);
  }

  const now = Date.now();
  const cached = fxCache[base];
  if (cached && now - cached.cachedAt < FX_CACHE_MS) {
    return jsonResponse(cached.data);
  }

  let res;
  try {
    res = await fetch("https://open.er-api.com/v6/latest/" + base);
  } catch (e) {
    return jsonResponse({ error: "Could not reach the exchange-rate service." }, 502);
  }
  if (!res.ok) return jsonResponse({ error: "Could not reach the exchange-rate service." }, 502);

  const raw = await res.json().catch(function () { return null; });
  if (!raw || raw.result !== "success" || !raw.rates || typeof raw.rates !== "object") {
    return jsonResponse({ error: "The exchange-rate service returned an unexpected response." }, 502);
  }

  const data = {
    base: base,
    rates: raw.rates,
    updatedAt: raw.time_last_update_unix ? raw.time_last_update_unix * 1000 : now
  };
  fxCache[base] = { data: data, cachedAt: now };
  return jsonResponse(data);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/avatar" && request.method === "POST") {
      return handleUpload(request, env);
    }
    if (url.pathname === "/api/avatar" && request.method === "DELETE") {
      return handleDelete(request, env);
    }
    if (url.pathname.startsWith("/api/avatar/") && request.method === "GET") {
      return handleGet(request, env, url.pathname.slice("/api/avatar/".length));
    }
    if (url.pathname === "/api/receipt" && request.method === "POST") {
      return handleReceiptUpload(request, env);
    }
    if (url.pathname.startsWith("/api/receipt/") && request.method === "GET") {
      return handleReceiptGet(request, env, url.pathname.slice("/api/receipt/".length));
    }
    if (url.pathname === "/api/fxrates" && request.method === "GET") {
      return handleFxRates(request, env);
    }

    return env.ASSETS.fetch(request);
  }
};
