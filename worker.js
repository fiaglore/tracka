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

  return payload.sub;
}

async function requireUid(request) {
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
  try { uid = await requireUid(request); }
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
  try { uid = await requireUid(request); }
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

    return env.ASSETS.fetch(request);
  }
};
