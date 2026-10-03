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

// ---------------------------------------------------------------------------
// Bill-due and budget-threshold reminders — both need the same billing-
// period math app.js's periodBounds()/monthStartDayFor() do, so that's
// mirrored here too (a "month" in Trakka is a payday-to-payday period, not
// a calendar month, and can be overridden per-month — see
// state.monthStartOverrides). A user with no monthLabels/yearTags saved yet
// (very first save hasn't landed) just gets no bill/budget reminders that
// run — there's nothing to compute a period from.
// ---------------------------------------------------------------------------
const MONTH_NUM_MAP = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
const MONTH_ORDER = Object.keys(MONTH_NUM_MAP);
function fullYear(yt) { return 2000 + Number(String(yt).replace("'", "")); }
function monthOverrideKey(label, yearTag) { return label + yearTag; }
function monthStartDayFor(state, label, yearTag, payStart) {
  const override = (state.monthStartOverrides || {})[monthOverrideKey(label, yearTag)];
  return override >= 1 && override <= 28 ? override : payStart;
}
function nextMonthLabelYear(label, yearTag) {
  const num = MONTH_NUM_MAP[label];
  const yr = fullYear(yearTag);
  const nextNum = (num + 1) % 12;
  const nextYr = num === 11 ? yr + 1 : yr;
  return [MONTH_ORDER[nextNum], "'" + String(nextYr).slice(-2)];
}
function periodBounds(state, monthLabels, yearTags, mi, payStart) {
  const y = fullYear(yearTags[mi]);
  const mNum = MONTH_NUM_MAP[monthLabels[mi]];
  const startDay = monthStartDayFor(state, monthLabels[mi], yearTags[mi], payStart);
  const [nextLabel, nextYearTag] = nextMonthLabelYear(monthLabels[mi], yearTags[mi]);
  const endDay = monthStartDayFor(state, nextLabel, nextYearTag, payStart) - 1;
  return { start: new Date(y, mNum, startDay), end: new Date(y, mNum + 1, endDay) };
}
function msPerDay() { return 24 * 60 * 60 * 1000; }

// Every unchecked, non-extra-payment debt instalment whose billing period
// ends within `daysAhead` days of `now` (overdue ones included — a missed
// bill is more worth surfacing than a merely upcoming one, not less). Mirrors
// the due-date math behind app.js's debtFreeDate()/lastDueMonthIndex(), just
// per-instalment instead of aggregated into one countdown.
export function upcomingDebtInstalments(state, monthLabels, yearTags, payStart, now, daysAhead) {
  const N = monthLabels.length;
  const out = [];
  for (let i = 0; i < N; i++) {
    const m = state.months && state.months[i];
    if (!m || !m.debts) continue;
    const { end } = periodBounds(state, monthLabels, yearTags, i, payStart);
    const daysLeft = Math.ceil((end.getTime() - now.getTime()) / msPerDay());
    if (daysLeft > daysAhead) continue;
    m.debts.forEach((it) => {
      if (it.checked || it.extraPayment || !(Number(it.amount) > 0)) return;
      out.push({
        key: seriesKeyOf(it) + "_" + monthLabels[i] + yearTags[i],
        label: it.label, amount: Number(it.amount), daysLeft,
        monthLabel: monthLabels[i], yearTag: yearTags[i]
      });
    });
  }
  return out;
}

// Mirrors getLivingBudget()/sumLivingForMonth() in app.js, split per
// category — the whole-month total isn't enough here since each category
// crosses its own threshold independently.
function livingBudgetFor(state, mi, catId) {
  const key = mi + "_" + catId;
  if (Object.prototype.hasOwnProperty.call(state.livingBudgetOverrides || {}, key)) {
    return Number(state.livingBudgetOverrides[key]) || 0;
  }
  const cat = (state.livingCategories || []).find((c) => c.id === catId);
  return cat ? Number(cat.budget) || 0 : 0;
}
function livingSpendFor(state, mi, catId) {
  return (state.livingEntries || [])
    .filter((e) => e.monthIndex === mi && e.categoryId === catId)
    .reduce((s, e) => s + (Number(e.amount) || 0), 0);
}

// Which billing period "now" actually falls in — mirrors app.js's
// dateToMonthIndex(), clamped to the tracked range the same way.
export function monthIndexForDate(state, monthLabels, yearTags, payStart, now) {
  const N = monthLabels.length;
  for (let i = 0; i < N; i++) {
    const { start, end } = periodBounds(state, monthLabels, yearTags, i, payStart);
    if (now >= start && now <= end) return i;
  }
  const first = periodBounds(state, monthLabels, yearTags, 0, payStart);
  return now < first.start ? 0 : N - 1;
}

// Every living-expense category in the CURRENT billing period that has
// crossed 90% or 100% of its budget — only the highest threshold crossed is
// returned per category (crossing 100% implies 90% already happened), so a
// category doesn't double-notify in the same check.
export function budgetThresholdAlerts(state, monthLabels, yearTags, payStart, now) {
  const mi = monthIndexForDate(state, monthLabels, yearTags, payStart, now);
  const out = [];
  (state.livingCategories || []).forEach((cat) => {
    const budget = livingBudgetFor(state, mi, cat.id);
    if (budget <= 0) return;
    const spent = livingSpendFor(state, mi, cat.id);
    const pct = spent / budget;
    const threshold = pct >= 1 ? 100 : pct >= 0.9 ? 90 : null;
    if (threshold === null) return;
    out.push({ key: cat.id + "_" + monthLabels[mi] + yearTags[mi] + "_" + threshold, catName: cat.name, spent, budget, threshold });
  });
  return out;
}
