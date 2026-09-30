// scripts/send-notifications.mjs
//
// The one piece of Trakka's notification system that has to run somewhere
// other than the browser: deciding WHEN to notify a user whose app is fully
// closed. Everything else (level-ups, achievements, "haven't logged today")
// already computes client-side in app.js while the tracker is open — this
// script re-derives the same handful of conditions from each user's synced
// Firestore data (see scripts/lib/notify-logic.mjs for the actual ported
// logic, kept separate so it's unit-testable without live credentials) and
// sends a Web Push message when one newly applies.
//
// Run on a schedule by .github/workflows/notify.yml (every 15 minutes, plus
// on-demand via workflow_dispatch). Needs three secrets, none of which are
// ever committed to this repo:
//   FIREBASE_SERVICE_ACCOUNT  — the JSON key from Firebase console →
//                               Project settings → Service accounts →
//                               Generate new private key.
//   VAPID_PRIVATE_KEY         — the private half of the VAPID key pair
//                               (the public half lives in firebase-init.js
//                               — public keys are fine to commit).
//   VAPID_CONTACT_EMAIL       — a "mailto:" contact address, required by
//                               the Web Push protocol so a push service can
//                               reach you if something's misconfigured.
//
// Scope note: this intentionally does NOT reimplement every one of the 34
// in-app achievement conditions (app.js's ACHIEVEMENTS list) — that's a lot
// of business logic to keep duplicated and in sync in two languages for
// fairly low-stakes notifications. Achievements still show live the moment
// you're in the app, same as before; only the reminder, level-up, and
// debt-cleared notifications are wired up to fire while it's closed.

import admin from "firebase-admin";
import webpush from "web-push";
import { debtSeriesList, hasLoggedToday, computeLevel, localDateParts } from "./lib/notify-logic.mjs";

const VAPID_PUBLIC_KEY = "BD1CPoNr6Xst1Igyg_0t-GZXqyjYpIHRghsN1N6D5pplhDwxk3sZI6q6PMMBa1-Bz-ERctIVXYt20s4joFMaxHs";

// Local hour (in the USER's own timezone, not the runner's) the daily
// reminder is allowed to fire from. Uses ">=" rather than "===" below so a
// delayed/skipped GitHub Actions run doesn't just silently miss the day
// entirely — cron timing on free runners isn't exact.
const REMINDER_HOUR = 19;

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

// Sends to every subscription on file for this user, dropping any the push
// service reports as gone (410/404 — the browser unsubscribed or the
// subscription expired) so they don't get retried forever. Other failures
// are logged and the subscription is kept, since those are more likely
// transient (network blip, push service hiccup).
async function sendToUser(uid, subscriptions, title, body) {
  const survivors = [];
  for (const sub of subscriptions) {
    try {
      await webpush.sendNotification(sub, JSON.stringify({ title, body }));
      survivors.push(sub);
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        console.log(`Dropping expired subscription for ${uid}`);
      } else {
        console.error(`Push to ${uid} failed (${err.statusCode || "?"}):`, err.message);
        survivors.push(sub);
      }
    }
  }
  return survivors;
}

async function processUser(doc) {
  const uid = doc.id;
  const data = doc.data();
  const subscriptions = data.pushSubscriptions || [];
  if (subscriptions.length === 0 || !data.remindersEnabled) return;

  const state = data.trackerState;
  if (!state || !Array.isArray(state.months) || state.months.length === 0) return;
  const N = state.months.length;
  const timeZone = data.timezone || "UTC";
  const notifyState = data.notifyState || {};
  const updates = {};
  let subs = subscriptions;

  // ---- 1. "Haven't logged anything today" reminder ----
  try {
    const { dateStr, hour } = localDateParts(timeZone);
    if (
      hour >= REMINDER_HOUR &&
      notifyState.lastReminderDate !== dateStr &&
      !hasLoggedToday(state, N, dateStr)
    ) {
      subs = await sendToUser(
        uid, subs, "Trakka",
        "You haven't logged anything yet today — a couple of minutes keeps your tracker honest."
      );
      updates["notifyState.lastReminderDate"] = dateStr;
    }
  } catch (e) {
    console.error(`Reminder check failed for ${uid} (timezone "${timeZone}"):`, e.message);
  }

  // ---- 2. Level up ----
  try {
    const level = computeLevel(state, N, data.badges || {});
    // First time this script has ever looked at this user, just record the
    // baseline silently — otherwise everyone gets a "you reached level 7!"
    // notification the moment they turn reminders on, however long they've
    // actually been level 7.
    if (notifyState.lastLevel !== undefined && level > notifyState.lastLevel) {
      subs = await sendToUser(uid, subs, "🌟 Level up!", `You reached Level ${level} in Trakka.`);
    }
    if (notifyState.lastLevel !== level) updates["notifyState.lastLevel"] = level;
  } catch (e) {
    console.error(`Level check failed for ${uid}:`, e.message);
  }

  // ---- 3. Debt cleared ----
  try {
    const series = debtSeriesList(state, N);
    const clearedKeys = series.filter((s) => s.total > 0 && s.remaining <= 0).map((s) => s.key);
    const knownCleared = new Set(notifyState.lastClearedDebtKeys || []);
    const newlyCleared = clearedKeys.filter((k) => !knownCleared.has(k));
    // Same first-run baseline reasoning as level-up above — don't fire for
    // every debt that happened to already be cleared before this shipped.
    if (notifyState.lastClearedDebtKeys !== undefined && newlyCleared.length > 0) {
      const labels = newlyCleared.map((k) => series.find((s) => s.key === k)?.label).filter(Boolean);
      subs = await sendToUser(
        uid, subs,
        newlyCleared.length === 1 ? "💳 Debt cleared" : `💳 ${newlyCleared.length} debts cleared!`,
        labels.join(" · ") + (newlyCleared.length === 1 ? " is fully paid off!" : " are fully paid off!")
      );
    }
    updates["notifyState.lastClearedDebtKeys"] = clearedKeys;
  } catch (e) {
    console.error(`Debt check failed for ${uid}:`, e.message);
  }

  if (subs.length !== subscriptions.length) updates.pushSubscriptions = subs;
  if (Object.keys(updates).length > 0) await doc.ref.update(updates);
}

async function run() {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(requireEnv("FIREBASE_SERVICE_ACCOUNT")))
  });
  webpush.setVapidDetails(
    "mailto:" + requireEnv("VAPID_CONTACT_EMAIL"),
    VAPID_PUBLIC_KEY,
    requireEnv("VAPID_PRIVATE_KEY")
  );

  const db = admin.firestore();
  const snapshot = await db.collection("users").get();
  console.log(`Checking ${snapshot.size} user doc(s)...`);
  for (const doc of snapshot.docs) {
    await processUser(doc).catch((e) => console.error(`Unhandled error for ${doc.id}:`, e));
  }
}

run()
  .then(() => { console.log("Done."); process.exit(0); })
  .catch((err) => { console.error(err); process.exit(1); });
