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
//     notifyPrefs   — { dailyReminder, levelUp, debtCleared, billDue,
//                       budgetThreshold, birthday, achievements } booleans,
//                       each defaulting to true when absent — the per-type
//                       breakdown of the single remindersEnabled master
//                       switch above. Read by app.js's notifyPrefEnabled()
//                       and mirrored in notifications/scripts/send-notifications.mjs's
//                       prefEnabled().
//     trustedDevices — [{ id, label, addedAt, lastSeen }], one entry per
//                       device that's ever signed in (see registerDevice()/
//                       forgetDevice() below) — Settings → Security's
//                       "Trusted devices" list. `id` is a random UUID this
//                       device generates for itself once and keeps in its
//                       own localStorage, not anything derived from
//                       hardware. Removing a device from this list signs it
//                       out the next time IT loads (app.js's begin() checks
//                       its own id is still present) — there's no live push
//                       for this, so it isn't instant.
//     securityLog   — [{ ts, event, detail }], newest first, capped to 30 —
//                       Settings → Security's "Recent activity" list. Purely
//                       informational, nothing reads it back for logic.
//
// One document per signed-in user, and Firestore security rules (see
// firestore.rules) only let a user read/write the document whose ID matches
// their own auth uid — so this is also what makes "everyone only sees their
// own data" actually enforced, not just a client-side convention. None of
// the fields above need any rule changes beyond that: they're all just more
// fields on the same per-owner document, not a new collection or a field
// with different access needs. (Biometric unlock is the one exception that
// stores nothing server-side at all — see "Biometric unlock" below for why.)

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
  updatePassword,
  verifyBeforeUpdateEmail,
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
  serverTimestamp,
  arrayUnion,
  arrayRemove,
  collection,
  query,
  where,
  getDocs
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-firestore.js";
const firebaseConfig = {
  apiKey: "AIzaSyCTwklrfnEsMat8WhkwWPHLHV-YfFl_ono",
  authDomain: "tracka-app-f97e1.firebaseapp.com",
  projectId: "tracka-app-f97e1",
  messagingSenderId: "30214999850",
  appId: "1:30214999850:web:b870293743245110a41853"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Public half of the VAPID key pair used for Web Push (see
// notifications/scripts/send-notifications.mjs, which holds the matching private half as
// a GitHub Actions secret — never put the private key anywhere in this
// repo). Public keys are safe to ship in client code, same trust level as
// the Firebase apiKey above.
const VAPID_PUBLIC_KEY = "BBu3BjNQYno6ggvoHIqDHo7mbksg7DeZa3JC6NEa3aYmfLLKbR-FBFn8tep23uDim1TonfMSzyScazK7rG3VMJw";

// This one account always has every premium feature unlocked (see
// app.js's begin()) and is the only one Firestore rules let review other
// users' premiumRequest submissions (see firestore.rules, and
// listPendingPremiumRequests()/approvePremiumRequest()/rejectPremiumRequest()
// below) — kept in sync by hand with the matching constant in worker.js,
// which can't import this file (it's a separate runtime, no bundler).
const ADMIN_EMAIL = "lolafalobi@gmail.com";

// PushManager.subscribe() wants the VAPID key as a raw Uint8Array, not the
// URL-safe base64 string Firebase/web-push tooling hands you everywhere
// else — this is the standard conversion (see the Web Push spec's examples).
function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) outputArray[i] = rawData.charCodeAt(i);
  return outputArray;
}

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
// Biometric unlock's local slot — see the "Biometric unlock" section below.
// Unlike pinAuth, this one is never written to Firestore: a WebAuthn
// platform-authenticator credential (Face ID/Touch ID/Windows Hello/Android
// fingerprint) is physically tied to the device that created it, so there's
// nothing another device could do with a synced copy anyway. Each device
// that wants biometric unlock sets it up for itself.
const BIO_LOCAL_KEY = "trakkaBioAuth";

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
  // Settings → Security's "Reset password by email" — same reset email as
  // the signed-out "Forgot password?" link, just usable from inside the app
  // without re-typing a username, since the signed-in user is already known.
  // Same delivery caveat as usernameToEmail() documents above: this only
  // actually arrives if the account's "username" is a real email address.
  async resetMyPassword() {
    const user = auth.currentUser;
    if (!user) throw new Error("You need to be signed in to reset your password.");
    const username = user.displayName;
    const email = user.email || usernameToEmail(username || "");
    await sendPasswordResetEmail(auth, email);
  },
  // Settings → Security's "Change password" — requires the CURRENT password
  // (re-verified against Firebase itself, same reauthenticateWithCredential
  // pattern setupPin()/setupBiometric() already use above) before Firebase
  // will accept a new one. Anyone with a quick-unlock PIN or biometric unlock
  // set up on this device should change THOSE too afterward — they each hold
  // an independent encrypted copy of the OLD password (see the PIN/biometric
  // design comments), which this does not touch.
  async changePassword(currentPassword, newPassword) {
    if (!newPassword || newPassword.length < 6) throw new Error("New password must be at least 6 characters.");
    const user = auth.currentUser;
    if (!user) throw new Error("You need to be signed in to change your password.");
    const username = user.displayName;
    if (!username) throw new Error("Could not determine your username — try signing in again.");
    const email = user.email || usernameToEmail(username);
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(email, currentPassword));
    await updatePassword(user, newPassword);
  },

  // Account email shown in Settings → Security's "📧 Recovery email" — the
  // address Firebase Auth actually has on file. See usernameToEmail()'s
  // comment above: this is only a REAL, reachable address if the user
  // happened to type one into the username field at signup; otherwise it's
  // the auto-generated username@tracka-users.app placeholder, which is
  // exactly why "Forgot password?" can show its generic success message
  // and still never deliver anything.
  myAccountEmail() {
    const user = auth.currentUser;
    return user ? user.email : null;
  },
  hasRealRecoveryEmail() {
    const email = auth.currentUser && auth.currentUser.email;
    return !!email && !email.toLowerCase().endsWith("@" + EMAIL_DOMAIN);
  },
  // Lets someone whose account has no real email (see above) add one, or
  // change an existing one, so "Forgot password?" and "Reset password by
  // email" actually have somewhere to deliver to. Uses
  // verifyBeforeUpdateEmail rather than the older updateEmail — Firebase
  // sends a verification link to the NEW address first, and the account's
  // email on file only actually changes once that link is clicked, so a
  // typo or someone else's address can't silently take over the account or
  // quietly break sign-in.
  async updateRecoveryEmail(currentPassword, newEmail) {
    const trimmed = String(newEmail || "").trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) throw new Error("Enter a valid email address.");
    const user = auth.currentUser;
    if (!user) throw new Error("You need to be signed in to do this.");
    const username = user.displayName;
    const currentEmail = user.email || usernameToEmail(username || "");
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(currentEmail, currentPassword));
    await verifyBeforeUpdateEmail(user, trimmed);
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
  },

  // Checks a PIN against the cached blob WITHOUT replaying signIn() —
  // unlike unlockWithPin() above, this is for the security gates (deleting
  // an entry, revealing hidden data, the post-sign-in PIN challenge) where
  // the user is already in an active session and only needs to prove they
  // still know the PIN, not get signed back in.
  async verifyPin(pin) {
    let blob;
    try { blob = JSON.parse(localStorage.getItem(PIN_LOCAL_KEY) || "null"); } catch (e) { blob = null; }
    if (!blob) return { ok: false, reason: "no-pin" };
    try {
      const salt = base64ToBuf(blob.salt);
      const iv = base64ToBuf(blob.iv);
      const key = await deriveAesKeyFromPin(pin, salt, blob.iterations || PIN_KDF_ITERATIONS);
      // Decrypting at all (AES-GCM's auth tag check passing) is proof enough
      // the PIN was right — the recovered password itself isn't needed here.
      await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, base64ToBuf(blob.ciphertext));
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: "wrong-pin" };
    }
  },

  // ============================================================
  // Biometric unlock (WebAuthn platform authenticator)
  //
  // Same shape as the PIN above — the lock screen has no live session left
  // to "just unlock" (auto-logout.js really signs out), so this also has to
  // recover the real password and replay signIn() with it. The difference
  // is what gates the decryption: instead of a PIN, it's a successful
  // `navigator.credentials.get()` against a platform authenticator (Face
  // ID/Touch ID/Windows Hello/Android fingerprint) this device registered.
  //
  // SECURITY TRADE-OFF — same honesty as the PIN comment above applies
  // here: there's no backend relying-party verifying the WebAuthn
  // attestation/assertion (this app has no auth server beyond Firebase
  // itself), so this isn't a cryptographic second factor — it's the browser
  // mediating a real OS biometric check before this code ever runs, which a
  // page can't forge, but isn't attestation-verified either. The AES key
  // that actually decrypts the stored password lives in this device's
  // localStorage either way (there's no WebAuthn PRF support to derive one
  // from the assertion widely enough yet to depend on); the biometric
  // prompt is the UX gate against casual/opportunistic access, exactly like
  // the PIN already is by its own documented trade-off.
  async setupBiometric(password) {
    if (!(window.PublicKeyCredential)) throw new Error("This browser doesn't support biometric unlock.");
    const user = auth.currentUser;
    if (!user) throw new Error("You need to be signed in to set up biometric unlock.");
    const username = user.displayName;
    if (!username) throw new Error("Could not determine your username — try signing in again.");
    const email = user.email || usernameToEmail(username);
    await reauthenticateWithCredential(user, EmailAuthProvider.credential(email, password));

    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "AnchorTrakk" },
        user: { id: new TextEncoder().encode(user.uid), name: username, displayName: username },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: "platform", userVerification: "required" },
        timeout: 60000
      }
    });
    if (!cred) throw new Error("Biometric setup was cancelled.");

    const aesKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
    const rawKey = await crypto.subtle.exportKey("raw", aesKey);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv }, aesKey, new TextEncoder().encode(password));

    const blob = {
      username: username,
      credentialId: bufToBase64(cred.rawId),
      key: bufToBase64(rawKey),
      iv: bufToBase64(iv),
      ciphertext: bufToBase64(ciphertext)
    };
    try { localStorage.setItem(BIO_LOCAL_KEY, JSON.stringify(blob)); } catch (e) { throw new Error("Could not save biometric unlock on this device."); }
  },

  hasBiometricConfigured() {
    try { return !!localStorage.getItem(BIO_LOCAL_KEY); } catch (e) { return false; }
  },

  async biometricSupported() {
    if (!(window.PublicKeyCredential && window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable)) return false;
    try { return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch (e) { return false; }
  },

  async unlockWithBiometric() {
    let blob;
    try { blob = JSON.parse(localStorage.getItem(BIO_LOCAL_KEY) || "null"); } catch (e) { blob = null; }
    if (!blob) return { ok: false, reason: "no-biometric" };
    try {
      await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ id: base64ToBuf(blob.credentialId), type: "public-key" }],
          userVerification: "required",
          timeout: 60000
        }
      });
      const key = await crypto.subtle.importKey("raw", base64ToBuf(blob.key), "AES-GCM", false, ["decrypt"]);
      const plainBuf = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64ToBuf(blob.iv) }, key, base64ToBuf(blob.ciphertext));
      const password = new TextDecoder().decode(plainBuf);
      await window.Trakka.signIn(blob.username, password, true);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: "failed" };
    }
  },

  clearBiometric() {
    try { localStorage.removeItem(BIO_LOCAL_KEY); } catch (e) {}
  },

  // Same idea as verifyPin() above: confirms the user's biometric WITHOUT
  // replaying signIn(), for the security gates on an already-active
  // session. A successful navigator.credentials.get() assertion against the
  // registered platform authenticator is proof enough on its own — there's
  // nothing to decrypt or recover here, unlike unlockWithBiometric().
  async verifyBiometricPresence() {
    let blob;
    try { blob = JSON.parse(localStorage.getItem(BIO_LOCAL_KEY) || "null"); } catch (e) { blob = null; }
    if (!blob) return { ok: false, reason: "no-biometric" };
    try {
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)),
          allowCredentials: [{ id: base64ToBuf(blob.credentialId), type: "public-key" }],
          userVerification: "required",
          timeout: 60000
        }
      });
      return assertion ? { ok: true } : { ok: false, reason: "failed" };
    } catch (e) {
      return { ok: false, reason: "failed" };
    }
  },

  // ----- trusted devices + security activity log -----
  // Both live as plain fields on the same per-user doc (not a subcollection)
  // so this needs no firestore.rules change to ship — the existing
  // "only the owner can read/write their own users/{uid} doc" rule already
  // covers them.
  //
  // A device's trust entry is written the moment it signs in successfully
  // (see registerDevice() below, called from app.js's post-sign-in flow) and
  // is only ever removed by an explicit "Forget this device" in Settings on
  // ANY device — there is no live push to a revoked device, so it keeps
  // working until its own next reload/sign-in, at which point app.js finds
  // its deviceId missing from the list and signs it out. That's the same
  // "instant-ish, not exact" trade-off the rest of the notification system
  // already makes.
  deviceId() {
    const KEY = "trakkaDeviceId";
    try {
      let id = localStorage.getItem(KEY);
      if (!id) { id = crypto.randomUUID(); localStorage.setItem(KEY, id); }
      return id;
    } catch (e) { return "unknown-device"; }
  },
  deviceLabel() {
    const ua = navigator.userAgent || "";
    const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
    const os = /iPhone|iPad/.test(ua) ? "iOS" : /Android/.test(ua) ? "Android" : /Mac OS X/.test(ua) ? "Mac" : /Windows/.test(ua) ? "Windows" : /Linux/.test(ua) ? "Linux" : "";
    return os ? browser + " on " + os : browser;
  },
  // Adds/refreshes this device's entry (idempotent — safe to call on every
  // sign-in). Returns the up-to-date list so the caller doesn't need a
  // second read.
  async registerDevice(uid) {
    const data = (await getDoc(userDocRef(uid))).data() || {};
    const id = window.Trakka.deviceId();
    const list = Array.isArray(data.trustedDevices) ? data.trustedDevices.filter(function (d) { return d.id !== id; }) : [];
    list.push({ id: id, label: window.Trakka.deviceLabel(), addedAt: Date.now(), lastSeen: Date.now() });
    await setDoc(userDocRef(uid), { trustedDevices: list }, { merge: true });
    return list;
  },
  async forgetDevice(uid, id) {
    const data = (await getDoc(userDocRef(uid))).data() || {};
    const list = (Array.isArray(data.trustedDevices) ? data.trustedDevices : []).filter(function (d) { return d.id !== id; });
    await setDoc(userDocRef(uid), { trustedDevices: list }, { merge: true });
    return list;
  },
  // Capped to the most recent 30 entries (oldest dropped), same trim-on-
  // write pattern app.js's in-app notification log already uses — this is
  // a glanceable recent-activity list, not a permanent audit trail.
  async logSecurityEvent(uid, event, detail) {
    const data = (await getDoc(userDocRef(uid))).data() || {};
    const list = Array.isArray(data.securityLog) ? data.securityLog.slice() : [];
    list.unshift({ ts: Date.now(), event: event, detail: detail || "" });
    await setDoc(userDocRef(uid), { securityLog: list.slice(0, 30) }, { merge: true }).catch(function (e) { console.error("Save failed:", e); });
  },

  // ----- push notifications (see notifications/scripts/send-notifications.mjs — the
  // GitHub Actions job that actually decides when to send, since a Web Push
  // message received while the app is fully closed has to come from
  // somewhere other than app.js) -----
  //
  // Called once notification permission is already granted (app.js's
  // existing 🔔 toggle handles that). Registers this device for push and
  // records the subscription + this device's IANA timezone (e.g.
  // "Africa/Lagos") on the user doc, so the scheduled job can send the
  // daily reminder at the right LOCAL hour for whoever's reading it rather
  // than one fixed UTC hour for everyone. `arrayUnion` means subscribing a
  // second device (or re-subscribing the same one after its token
  // rotates) never wipes out any other device already subscribed.
  async subscribeToPush(uid) {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
      throw new Error("Push notifications aren't supported in this browser.");
    }
    const registration = await navigator.serviceWorker.ready;
    let subscription = await registration.pushManager.getSubscription();
    if (!subscription) {
      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY)
      });
    }
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    await setDoc(
      userDocRef(uid),
      { pushSubscriptions: arrayUnion(subscription.toJSON()), timezone },
      { merge: true }
    );
    return subscription;
  },

  // Called when the 🔔 toggle is switched off, so a signed-out/opted-out
  // device stops receiving pushes rather than just stops showing them (the
  // scheduled job has no idea a device stopped listening otherwise).
  async unsubscribeFromPush(uid) {
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (!subscription) return;
    const json = subscription.toJSON();
    await subscription.unsubscribe();
    await setDoc(userDocRef(uid), { pushSubscriptions: arrayRemove(json) }, { merge: true }).catch(function (e) {
      console.error("Save failed:", e);
    });
  },

  // ----- profile photo (Cloudflare R2, via the /api/avatar Worker route) -----
  // Firebase Storage now requires the paid Blaze plan to enable at all, so
  // photos live in this Worker's own R2 bucket instead (see worker.js) —
  // one object per user at avatars/{uid}, overwritten on every re-upload.
  // R2 has no per-user security-rules engine like Storage did, so the
  // Worker itself verifies this ID token before touching the bucket; that's
  // also why this needs a fresh token on every call rather than reusing one.
  async uploadAvatarPhoto(uid, blob) {
    const user = auth.currentUser;
    if (!user) throw new Error("Sign in again to upload a photo.");
    const token = await user.getIdToken();
    const res = await fetch("/api/avatar", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": blob.type || "image/jpeg"
      },
      body: blob
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || "Could not upload that photo.");
    return data.url;
  },
  async deleteAvatarPhoto(uid) {
    const user = auth.currentUser;
    if (!user) throw new Error("Sign in again to remove your photo.");
    const token = await user.getIdToken();
    const res = await fetch("/api/avatar", {
      method: "DELETE",
      headers: { Authorization: "Bearer " + token }
    });
    if (!res.ok) {
      const data = await res.json().catch(function () { return {}; });
      throw new Error(data.error || "Could not remove that photo.");
    }
  },

  // ----- Premium via manual bank transfer (see worker.js's /api/receipt
  // route and firestore.rules' admin override) -----
  // No payment processor is wired up yet, so unlocking Premium works like
  // this: show the bank account, the person transfers outside the app and
  // uploads a receipt as proof, then ADMIN_EMAIL reviews it by hand and
  // approves or rejects. Unlike avatars, receipts never get a public URL —
  // the Worker only hands one back to the uploader themselves or the admin.
  ADMIN_EMAIL: ADMIN_EMAIL,
  async uploadReceipt(uid, blob) {
    const user = auth.currentUser;
    if (!user) throw new Error("Sign in again to upload a receipt.");
    const token = await user.getIdToken();
    const res = await fetch("/api/receipt", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": blob.type || "image/jpeg"
      },
      body: blob
    });
    const data = await res.json().catch(function () { return {}; });
    if (!res.ok) throw new Error(data.error || "Could not upload that receipt.");
    return data.url;
  },
  // Receipts are never public (see worker.js's handleReceiptGet) — fetching
  // one always needs this device's own fresh ID token, same as the upload
  // above, whether it's the uploader checking their own or ADMIN_EMAIL
  // reviewing someone else's.
  async fetchReceiptBlob(uid) {
    const user = auth.currentUser;
    if (!user) throw new Error("Sign in again to view that receipt.");
    const token = await user.getIdToken();
    const res = await fetch("/api/receipt/" + uid, { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) {
      const data = await res.json().catch(function () { return {}; });
      throw new Error(data.error || "Could not load that receipt.");
    }
    return res.blob();
  },
  // Keeping receiptUrl (rather than re-fetching it) means Settings can show
  // "receipt submitted" status without an extra authenticated round trip
  // to the Worker just to check it still exists.
  // `product` is always "premium" now (the ₦3,500/month subscription — see
  // PREMIUM_PRODUCT_LABELS in app.js); the param is kept, defaulting to
  // "premium", so older in-flight requests from before the now-retired
  // "unlimitedLogs" add-on still work.
  async submitPremiumRequest(uid, receiptUrl, product) {
    await setDoc(
      userDocRef(uid),
      { premiumRequest: { status: "pending", product: product || "premium", receiptUrl: receiptUrl, submittedAt: serverTimestamp() } },
      { merge: true }
    );
  },
  // Admin-only in practice: firestore.rules only lets ADMIN_EMAIL read any
  // uid besides its own, so this query comes back empty (not an error) for
  // everyone else — app.js only shows the review UI to ADMIN_EMAIL anyway.
  async listPendingPremiumRequests() {
    const snap = await getDocs(query(collection(db, "users"), where("premiumRequest.status", "==", "pending")));
    return snap.docs.map(function (d) { return Object.assign({ uid: d.id }, d.data()); });
  },
  // `product` is accepted for compatibility with older, already-in-flight
  // requests (back when "unlimitedLogs" was a separate add-on) but always
  // grants the one Premium entitlement now — Premium itself has no caps.
  async approvePremiumRequest(uid, product) {
    await setDoc(
      userDocRef(uid),
      {
        entitlements: { premium: true },
        premiumRequest: { status: "approved", reviewedAt: serverTimestamp() }
      },
      { merge: true }
    );
  },
  async rejectPremiumRequest(uid, reason) {
    await setDoc(
      userDocRef(uid),
      { premiumRequest: { status: "rejected", reviewedAt: serverTimestamp(), reason: reason || "" } },
      { merge: true }
    );
  }
};

window.dispatchEvent(new CustomEvent("trakka:ready"));
