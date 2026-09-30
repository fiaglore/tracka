// scripts/lib/notify-logic.mjs
//
// Pure functions only — no Firebase Admin SDK, no web-push, no env vars.
// Split out from send-notifications.mjs so the actual decision logic (what
// counts as "leveled up", "debt cleared", "logged today") can be unit
// tested without live Firestore/VAPID credentials. See that file's own
// header comment for the broader design/scope notes.
//
// Every function here is a deliberately close port of the matching one in
// app.js (named in each comment) — if that one changes, this one probably
// needs the same change.

// Mirrors seriesKeyOf() in app.js.
export function seriesKeyOf(item) {
  return item.seriesId || item.id;
}

// Mirrors debtSeriesList() in app.js — only the fields this script actually
// needs (paid/remaining/total/label), not the payoff-plan display extras.
export function debtSeriesList(state, N) {
  const map = new Map();
  for (let i = 0; i < N; i++) {
    const m = state.months && state.months[i];
    if (!m || !m.debts) continue;
    m.debts.forEach((it) => {
      const key = seriesKeyOf(it);
      if (!map.has(key)) map.set(key, { key, label: it.label, paid: 0, remaining: 0 });
      const s = map.get(key);
      const amt = Number(it.amount) || 0;
      if (!it.extraPayment) s.label = it.label;
      if (it.checked) s.paid += amt;
      else if (!it.extraPayment && amt > 0) s.remaining += amt;
    });
  }
  return [...map.values()].map((s) => ({ ...s, total: s.paid + s.remaining }));
}

// Mirrors giftItemsForMonth() in app.js, trimmed to just `checked` — that's
// all allItemsForMonth()/the XP count below needs it for.
export function giftItemsForMonth(state, mi) {
  return (state.giftGoals || [])
    .filter((g) => mi >= g.targetMonthIndex - g.months && mi <= g.targetMonthIndex - 1)
    .map((g) => {
      const key = g.id + "_" + mi;
      const prog = (state.giftProgress || {})[key] || {};
      return { checked: !!prog.checked };
    });
}

// Mirrors allItemsForMonth() in app.js.
export function allItemsForMonth(state, mi) {
  const m = state.months[mi];
  return [...(m.income || []), ...(m.debts || []), ...giftItemsForMonth(state, mi)];
}

// Mirrors hasLoggedAnythingToday() in app.js — "today" here is the CALLER's
// notion of today (see localDateParts() below, computed in the user's own
// timezone), not any particular server clock.
export function hasLoggedToday(state, N, todayStr) {
  for (let i = 0; i < N; i++) {
    const m = state.months && state.months[i];
    if (!m) continue;
    if ((m.income || []).some((it) => it.checked && it.lastTicked === todayStr)) return true;
    if ((m.debts || []).some((it) => it.checked && it.lastTicked === todayStr)) return true;
    if ((m.savingsApps || []).some((it) => it.checked && it.lastTicked === todayStr)) return true;
  }
  if (Object.keys(state.giftProgress || {}).some((k) => (state.giftProgress[k] || {}).lastTicked === todayStr)) return true;
  if ((state.livingEntries || []).some((e) => e.date === todayStr)) return true;
  if ((state.extra || []).some((e) => e.date === todayStr)) return true;
  return false;
}

// Mirrors levelFromXP()/xpCostForLevel() in app.js: totalXP =
// checkedItems*10 + earnedBadges*50; level L costs L*multiplier XP to clear
// (multiplier*1, multiplier*2, multiplier*3, ...), not a flat cost every
// time. The multiplier is the user's own "Leveling pace" choice from
// Settings (cloud.xpDifficulty — easy/medium/hard), defaulting to medium
// just like the client does.
const XP_DIFFICULTY_MULTIPLIERS = { easy: 90, medium: 150, hard: 250 };
function xpCostForLevel(level, xpDifficulty) {
  return (XP_DIFFICULTY_MULTIPLIERS[xpDifficulty] || 150) * level;
}

export function computeLevel(state, N, badges, xpDifficulty) {
  let checkedCount = 0;
  for (let i = 0; i < N; i++) checkedCount += allItemsForMonth(state, i).filter((x) => x.checked).length;
  const earnedBadgeCount = Object.keys(badges || {}).filter((k) => k.startsWith("badge_")).length;
  const totalXP = checkedCount * 10 + earnedBadgeCount * 50;
  let level = 1, remaining = Math.max(0, totalXP);
  while (remaining >= xpCostForLevel(level, xpDifficulty)) {
    remaining -= xpCostForLevel(level, xpDifficulty);
    level++;
  }
  return level;
}

// Compares month+day only (dob's own birth year never matters), so this is
// true every year on the right date regardless of how old dob says the
// user is. Both dates are expected as "YYYY-MM-DD" strings.
export function isBirthdayToday(dob, dateStr) {
  return typeof dob === "string" && dob.length >= 10 && dob.slice(5, 10) === dateStr.slice(5, 10);
}

// Today's date (YYYY-MM-DD, matching the "YYYY-MM-DD" keys app.js's own
// dateKey()/todayKey() use) and the current hour, both as they'd read on a
// device actually set to `timeZone` — this is the whole point of storing
// each user's timezone rather than using one fixed clock for everyone.
export function localDateParts(timeZone, now = new Date()) {
  const dateStr = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).format(now);
  const hour = Number(
    new Intl.DateTimeFormat("en-US", { timeZone, hour: "2-digit", hour12: false }).format(now)
  );
  return { dateStr, hour };
}
