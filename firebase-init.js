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
//
// One document per signed-in user, and Firestore security rules (see
// firestore.rules) only let a user read/write the document whose ID matches
// their own auth uid — so this is also what makes "everyone only sees their
// own data" actually enforced, not just a client-side convention.

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
  updateProfile
} from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import {
  getFirestore,
  doc,
  getDoc,
  setDoc,
  deleteDoc,
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
    return snap.exists() ? snap.data() : null;
  },
  async saveUserDoc(uid, patch) {
    await setDoc(userDocRef(uid), patch, { merge: true });
  },
  async eraseUserDoc(uid) {
    await deleteDoc(userDocRef(uid));
  }
};

window.dispatchEvent(new CustomEvent("trakka:ready"));
