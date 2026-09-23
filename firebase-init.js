// firebase-init.js
//
// Sets up Firebase (Auth + Firestore) and exposes a small async API on
// `window.Trakka` that app.js — a classic (non-module) script — calls into.
// app.js can't use `import`, so this is the bridge between the two.
//
// Data model:
//   Firestore doc  users/{uid}
//     displayName   — the username the person signed up with
//     trackerState  — the whole tracker state object (was localStorage's
//                      "financialTrackerPublicV1" key)
//     badges        — earned-badge memory (was "financialTrackerPublicBadgesV1")
//     currency      — chosen currency symbol (was "financialTrackerPublicCurrencyV1")
//     payStart      — chosen "month starts on day N" (was "financialTrackerPublicPeriodStartV1")
//     themePreset   — chosen color/pattern theme (was "financialTrackerThemePresetV1")
//     themeMode     — chosen "light" or "dark" mode, independent of themePreset
//                      (also mirrored to localStorage under
//                      "financialTrackerPublicThemeV1" — see app.js's
//                      loadThemeMode()/saveThemeMode() — so it still applies
//                      before the Firestore round trip lands, or at all if
//                      that write fails or the device is offline)
//     petSpecies    — chosen cat-companion species (cat/dog/fox/owl/rabbit/
//                      plant), defaults to 'cat' if unset
//     streakCount   — consecutive calendar days the tracker has been opened
//     streakLastDate — the last "YYYY-MM-DD" day streakCount was updated for
//                      (see app.js's daily-visit-streak IIFE — this is what
//                      makes opening the app twice in a day, or from two
//                      devices, not double-count)
//     pinAuth       — { username, salt, iv, ciphertext, algo, iterations,
//                       updatedAt }: the account password, AES-GCM encrypted
//                       under a key derived from a short quick-unlock PIN via
//                       PBKDF2. Also mirrored (minus updatedAt, which is a
//                       Firestore-only Timestamp) to this device's
//                       localStorage under "trakkaPinAuth" — see the
//                       "Quick-unlock PIN" section below for the full
//                       design and its security trade-off; auto-logout.js
//                       and app.js's auth IIFE are the other two pieces.
//
// One document per signed-in user, and Firestore security rules (see
// firestore.rules) only let a user read/write the document whose ID matches
// their own auth uid — so this is also what makes "everyone only sees their
// own data" actually enforced, not just a client-side convention. pinAuth
// needs no rule changes beyond that: it's just another field on the same
// per-owner document, not a new collection or a field with different access
// needs.

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  sendPasswordResetEmail,
  onAuthStateChanged,
  signOut,
  setPersistence,
  browserLocalPersistence,
  browserSessionPersistence,
  updateProfile,
  EmailAuthProvider,
  reauthenticateWithCredential
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
  deleteField,
  serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyCTwklrfnEsMat8WhkwWPHLHV-YfFl_ono",
  authDomain: "tracka-app-f97e1.firebaseapp.com",
  projectId: "tracka-app-f97e1",
  storageBucket: "tracka-app-f97e1.firebasestorage.app",
  messagingSenderId: "30214999850",
  appId: "1:30214999850:web:b870293743245110a41853"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Firebase Auth accounts are identified by email, but the tracker's sign-in
// form only ever asked for a "username". Rather than redesign that UI, each
// username is turned into a private, never-displayed address under a fixed
// fake domain, so the existing username/password form keeps working as-is.
//
// The real trade-off: unless someone happens to type an actual email address
// they own into the "username" field, "Forgot password?" (which uses
// Firebase's real password-reset email) has nowhere real to deliver to. If
// you want working password recovery, ask people to sign up with a real
// email address in that field — it's stored as their password-reset address
// but shown back to them as their "username" everywhere else.
const EMAIL_DOMAIN = "tracka-users.app";
function usernameToEmail(username) {
  const trimmed = String(username || "").trim();
  // If it already looks like a real email, use it untouched (this is what
  // makes password-reset actually deliver somewhere).
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) return trimmed.toLowerCase();
  const key = trimmed.toLowerCase().replace(/[^a-z0-9._-]/g, "_");
  return key + "@" + EMAIL_DOMAIN;
}

function userDocRef(uid) {
  return doc(db, "users", uid);
}

// ============================================================
// Quick-unlock PIN
//
// auto-logout.js signs out with a REAL Firebase signOut(auth) — after that,
// there is no live session left to "just unlock". So the PIN can't gate
// access to an existing session; it has to re-derive the real account
// password and silently replay signIn() with it on correct entry. That
// means the password itself (not just a hash of it) has to be recoverable
// from what's stored — encrypted, but reversible by design.
//
// SECURITY TRADE-OFF — read this before changing PIN_KDF_ITERATIONS:
// The account's real password sits, AES-GCM encrypted, in both this user's
// Firestore doc and this device's localStorage. A short numeric PIN has
// very little entropy — a 6-digit PIN is only 1,000,000 possibilities. If
// an attacker ever obtains the encrypted blob itself (a compromised
// device's localStorage, or a Firestore export/leak), the "5 wrong
// attempts" lockout in app.js's PIN-unlock UI does NOT apply to them —
// they're not going through that UI, so they can brute-force every PIN
// offline, as fast as their hardware allows, with no rate limit at all.
// The PBKDF2 iteration count below is the ONLY real defense against that
// scenario, since it makes each guess computationally expensive. 600,000
// iterations of PBKDF2-SHA256 is OWASP's current (2023+) minimum
// recommendation for password storage generally; it's used here for the
// same reason, not because this is literally password storage. Don't lower
// it for a snappier unlock feel without understanding you're trading away
// real security margin — see the PR description for the actual unlock
// latency measured with this value.
//
// In short: this is a convenience feature for a trusted device, not a
// second authentication factor. Anyone who can extract the ciphertext can
// eventually recover the password; the iteration count only controls how
// long "eventually" takes.
const PIN_KDF_ITERATIONS = 600000;
const PIN_LOCAL_KEY = "trakkaPinAuth"; // single device-level slot — see loadUserDoc() below

function bufToBase64(buf) {
  return btoa(String.fromCharCode.apply(null, new Uint8Array(buf)));
}
function base64ToBuf(b64) {
  return Uint8Array.from(atob(b64), function (c) { return c.charCodeAt(0); });
}

async function deriveAesKeyFromPin(pin, saltBuf, iterations) {
  const baseKey = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: saltBuf, iterations: iterations, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

// Strips the Firestore-only `updatedAt` Timestamp (not JSON-serializable)
// before mirroring a pinAuth blob into localStorage.
function stripForLocal(blob) {
  const copy = {};
  for (const k in blob) { if (k !== "updatedAt") copy[k] = blob[k]; }
  return copy;
}

window.Trakka = {
  // ----- auth -----
  async signUp(username, password, remember) {
    await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
    const email = usernameToEmail(username);
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const displayName = String(username).trim();
    await updateProfile(cred.user, { displayName });
    await setDoc(userDocRef(cred.user.uid), { displayName, createdAt: serverTimestamp() }, { merge: true });
    return cred.user;
  },
  async signIn(username, password, remember) {
    await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
    const email = usernameToEmail(username);
    const cred = await signInWithEmailAndPassword(auth, email, password);
    return cred.user;
  },
  async signOutUser() {
    await signOut(auth);
  },
  async resetPassword(username) {
    await sendPasswordResetEmail(auth, usernameToEmail(username));
  },
  onAuthChange(cb) {
    return onAuthStateChanged(auth, cb);
  },

  // ----- per-user data document (this is what the security rules protect) -----
  async loadUserDoc(uid) {
    const snap = await getDoc(userDocRef(uid));
    const data = snap.exists() ? snap.data() : null;
    // A device that hasn't cached a PIN locally yet (new device, or the
    // cache was cleared) picks one up here the moment its owner signs in
    // with their password normally — so PIN unlock also works on this
    // device after its own next auto-logout, without needing its own setup.
    if (data && data.pinAuth) {
      try { localStorage.setItem(PIN_LOCAL_KEY, JSON.stringify(stripForLocal(data.pinAuth))); } catch (e) {}
    }
    return data;
  },
  async saveUserDoc(uid, patch) {
    await setDoc(userDocRef(uid), patch, { merge: true });
  },
  async eraseUserDoc(uid) {
    await deleteDoc(userDocRef(uid));
  },

  // ----- quick-unlock PIN (see the design/trade-off comment above) -----
  // Takes only the password + new PIN, not a username: the signed-in user's
  // own displayName (set at signUp() time, see the Data model note above)
  // is the username, so app.js never needs a second place to track it.
  async setupPin(password, pin) {
    if (!/^\d{6,}$/.test(pin)) throw new Error("PIN must be at least 6 digits.");
    const user = auth.currentUser;
    if (!user) throw new Error("You need to be signed in to set up a PIN.");
    const username = user.displayName;
    if (!username) throw new Error("Could not determine your username — try signing in again.");
    // Require the CURRENT password again, verified against Firebase itself,
    // so a stale/cached session alone can never be enough to set up (or
    // silently overwrite) quick-unlock — and so we have a password we know
    // is actually correct to encrypt.
    const email = user.email || usernameToEmail(username);
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(email, password));

    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12)); // 96-bit IV, the size AES-GCM is designed for
    const key = await deriveAesKeyFromPin(pin, salt, PIN_KDF_ITERATIONS);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(password)
    );

    const blob = {
      username: username,
      salt: bufToBase64(salt),
      iv: bufToBase64(iv),
      ciphertext: bufToBase64(ciphertext),
      algo: "PBKDF2-SHA256+AES-GCM",
      iterations: PIN_KDF_ITERATIONS
    };
    await setDoc(userDocRef(user.uid), { pinAuth: Object.assign({}, blob, { updatedAt: serverTimestamp() }) }, { merge: true });
    try { localStorage.setItem(PIN_LOCAL_KEY, JSON.stringify(blob)); } catch (e) {}
  },

  // Device-level check: is there a cached PIN on THIS device to even offer
  // unlocking with? (Not "does this account have one anywhere" — that's
  // what determines whether auto-logout.js can route to the PIN screen at
  // all, and what the settings UI uses to show "Set up" vs "Change/Remove".)
  hasPinConfigured() {
    try { return !!localStorage.getItem(PIN_LOCAL_KEY); } catch (e) { return false; }
  },

  async unlockWithPin(pin) {
    let blob;
    try { blob = JSON.parse(localStorage.getItem(PIN_LOCAL_KEY) || "null"); } catch (e) { blob = null; }
    if (!blob) return { ok: false, reason: "no-pin" };
    try {
      const salt = base64ToBuf(blob.salt);
      const iv = base64ToBuf(blob.iv);
      const key = await deriveAesKeyFromPin(pin, salt, blob.iterations || PIN_KDF_ITERATIONS);
      const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, base64ToBuf(blob.ciphertext));
      const password = new TextDecoder().decode(plainBuf);
      // Same persistence signIn() gives when "keep me signed in" is
      // checked — a PIN unlock implies wanting exactly that convenience.
      await window.Trakka.signIn(blob.username, password, true);
      return { ok: true };
    } catch (e) {
      // AES-GCM's built-in authentication check fails as a generic
      // OperationError — indistinguishable from any other decrypt failure
      // by design, which is fine: "wrong PIN" is the only wrong answer this
      // function needs to give.
      return { ok: false, reason: "wrong-pin" };
    }
  },

  async clearPin() {
    const user = auth.currentUser;
    if (user) {
      await setDoc(userDocRef(user.uid), { pinAuth: deleteField() }, { merge: true }).catch(function (e) { console.error("Save failed:", e); });
    }
    try { localStorage.removeItem(PIN_LOCAL_KEY); } catch (e) {}
  }
};

window.dispatchEvent(new CustomEvent("trakka:ready"));
