import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadApp } from './helpers/load-app.mjs';

const monthNumMap = { Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11 };
const monthOrder = Object.keys(monthNumMap);
const ymd = (d) => [d.getFullYear(), d.getMonth() + 1, d.getDate()].join('-');

// ---------- billing periods ----------
function periodCtx({ PSTART = 1, overrides = {}, labels, tags }) {
  return loadApp(
    ['fullYear', 'nextMonthLabelYear', 'monthOverrideKey', 'monthStartDayFor', 'periodBounds'],
    { PSTART, monthNumMap, monthOrder, monthLabels: labels, yearTags: tags, state: { monthStartOverrides: overrides } }
  );
}

test('billing period: calendar month when start day is 1', () => {
  const c = periodCtx({ PSTART: 1, labels: ['Jan'], tags: ["'26"] });
  const { start, end } = c.periodBounds(0);
  assert.equal(ymd(start), '2026-1-1');
  assert.equal(ymd(end), '2026-1-31');
});

test('billing period: 25th payday runs 25th to the 24th of next month', () => {
  const c = periodCtx({ PSTART: 25, labels: ['Jan'], tags: ["'26"] });
  const { start, end } = c.periodBounds(0);
  assert.equal(ymd(start), '2026-1-25');
  assert.equal(ymd(end), '2026-2-24');
});

test('billing period: wraps the year (Dec -> Jan)', () => {
  const c = periodCtx({ PSTART: 25, labels: ['Dec'], tags: ["'26"] });
  assert.equal(ymd(c.periodBounds(0).end), '2027-1-24');
});

test('billing period: consecutive periods are contiguous with a per-month override', () => {
  const c = periodCtx({ PSTART: 25, overrides: { "Feb'26": 28 }, labels: ['Jan', 'Feb', 'Mar'], tags: ["'26", "'26", "'26"] });
  const jan = c.periodBounds(0), feb = c.periodBounds(1), mar = c.periodBounds(2);
  assert.equal(ymd(feb.start), '2026-2-28');
  // Jan ends the day before Feb's (overridden) start; no gap, no overlap.
  assert.equal(ymd(jan.end), '2026-2-27');
  assert.equal(ymd(mar.start), '2026-3-25');
  assert.equal(ymd(feb.end), '2026-3-24');
});

test('billing period: out-of-range override (29+) is ignored', () => {
  const c = periodCtx({ PSTART: 25, overrides: { "Jan'26": 31 }, labels: ['Jan'], tags: ["'26"] });
  assert.equal(ymd(c.periodBounds(0).start), '2026-1-25');
});

// ---------- debt-free date ----------
function debtCtx(months, labels, tags, PSTART = 25) {
  const c = periodCtx({ PSTART, labels, tags });
  const d = loadApp(['lastDueMonthIndex', 'debtFreeDate'], {
    N: months.length, state: { months }, periodBounds: c.periodBounds,
  });
  return d;
}

test('debt-free date: end of the period holding the last unpaid instalment', () => {
  const labels = ['Jan', 'Feb', 'Mar'], tags = ["'26", "'26", "'26"];
  const months = [
    { debts: [{ amount: 100, checked: true }] },
    { debts: [{ amount: 100 }] },
    { debts: [{ amount: 100, checked: true }] },
  ];
  const c = debtCtx(months, labels, tags);
  assert.equal(c.lastDueMonthIndex(), 1);
  assert.equal(ymd(c.debtFreeDate()), '2026-3-24');
});

test('debt-free date: null when nothing is outstanding; extra payments and zero amounts are ignored', () => {
  const months = [{ debts: [{ amount: 100, checked: true }, { amount: 50, extraPayment: true }, { amount: 0 }] }];
  const c = debtCtx(months, ['Jan'], ["'26"]);
  assert.equal(c.debtFreeDate(), null);
});

// ---------- snowball / avalanche ----------
const series = [
  { key: 'a', remaining: 300, paymentsLeft: 3 },   // small balance, low rate
  { key: 'b', remaining: 1200, paymentsLeft: 12 }, // big balance, high rate
  { key: 'c', remaining: 600, paymentsLeft: 6 },
  { key: 'paid', remaining: 0, paymentsLeft: 0 },
];
function strategyCtx(rates = {}) {
  return loadApp(
    ['debtInterestRate', 'debtPriorityOrder', 'debtMinimumPayment', 'simulateDebtPayoffMonths', 'simulateAcceleratedPayoff'],
    { state: { debtInterestRates: rates }, debtSeriesList: () => series }
  );
}

test('snowball orders smallest balance first and skips cleared debts', () => {
  const c = strategyCtx();
  assert.deepEqual(c.debtPriorityOrder('snowball').map((s) => s.key), ['a', 'c', 'b']);
});

test('snowball ties on balance are broken by higher rate', () => {
  const c = strategyCtx({ x: 30, y: 10 });
  c.debtSeriesList = () => [{ key: 'y', remaining: 100, paymentsLeft: 1 }, { key: 'x', remaining: 100, paymentsLeft: 1 }];
  assert.deepEqual(c.debtPriorityOrder('snowball').map((s) => s.key), ['x', 'y']);
});

test('avalanche orders highest rate first, ties by smaller balance', () => {
  const c = strategyCtx({ a: 5, b: 40, c: 40 });
  assert.deepEqual(c.debtPriorityOrder('avalanche').map((s) => s.key), ['c', 'b', 'a']);
});

test('unknown strategy keeps original order', () => {
  const c = strategyCtx();
  assert.deepEqual(c.debtPriorityOrder('none').map((s) => s.key), ['a', 'b', 'c']);
});

test('minimum payment is remaining / paymentsLeft; 0 when nothing scheduled', () => {
  const c = strategyCtx();
  assert.equal(c.debtMinimumPayment({ remaining: 1200, paymentsLeft: 12 }), 100);
  assert.equal(c.debtMinimumPayment({ remaining: 50, paymentsLeft: 0 }), 0);
});

test('rolling payoff is never slower than own-pace and is faster here', () => {
  const c = strategyCtx();
  const order = c.debtPriorityOrder('snowball');
  const rolling = c.simulateDebtPayoffMonths(order, true);
  const own = c.simulateDebtPayoffMonths(order, false);
  assert.equal(own, 12);          // longest schedule decides
  assert.ok(rolling <= own);
  assert.ok(rolling < own);       // freed minimums shorten the big debt
});

test('payoff simulation: no debts = 0 months; interest slows payoff', () => {
  const none = strategyCtx();
  assert.equal(none.simulateDebtPayoffMonths([], true), 0);
  const withInterest = strategyCtx({ a: 24, b: 24, c: 24 });
  const order = withInterest.debtPriorityOrder('snowball');
  assert.ok(withInterest.simulateDebtPayoffMonths(order, false) > 12);
});

test('simulateAcceleratedPayoff: null for no strategy or fewer than 2 open debts', () => {
  const c = strategyCtx();
  assert.equal(c.simulateAcceleratedPayoff('none'), null);
  c.debtSeriesList = () => [series[0]];
  assert.equal(c.simulateAcceleratedPayoff('snowball'), null);
  c.debtSeriesList = () => series;
  const r = c.simulateAcceleratedPayoff('snowball');
  assert.ok(r.months < r.baselineMonths);
});

// ---------- savings lock ----------
test('savings deposit locks for 3 months from the month it was added', () => {
  const c = loadApp(['savingsUnlockMonth', 'isSavingsLocked']);
  const e = { monthIndex: 2 };
  assert.equal(c.savingsUnlockMonth(e), 5);
  assert.equal(c.isSavingsLocked(e, 4), true);
  assert.equal(c.isSavingsLocked(e, 5), false);
});

// ---------- currency + net worth ----------
function moneyCtx(state, extra = {}) {
  return loadApp(
    ['currencyCode', 'rateFor', 'setCurrencyRate', 'convertToPrimary', 'outstandingDebtsAsOf', 'manualAssetsTotal', 'netWorthForMonth'],
    {
      CUR: '₦',
      CURRENCIES: [{ sym: '$', code: 'USD' }, { sym: '£', code: 'GBP' }, { sym: '₦', code: 'NGN' }],
      state, N: 3,
      cumulativeBalanceUpTo: () => 0, totalAppsBalanceUpToConverted: () => 0,
      totalInvestmentsValue: () => 0, currentRealMonthIndex: () => 2,
      ...extra,
    }
  );
}

test('currency: primary currency and unknown rates convert 1:1; set/clear rates', () => {
  const c = moneyCtx({ currencyRates: {} });
  assert.equal(c.convertToPrimary(100, 'NGN'), 100);
  assert.equal(c.convertToPrimary(100, 'USD'), 100); // no rate set -> 1
  c.setCurrencyRate('USD', 1500);
  assert.equal(c.convertToPrimary(2, 'USD'), 3000);
  c.setCurrencyRate('NGN', 5);                       // primary: ignored
  assert.equal(c.state.currencyRates.NGN, undefined);
  c.setCurrencyRate('USD', 0);                       // invalid clears
  assert.equal(c.state.currencyRates.USD, undefined);
  assert.equal(c.convertToPrimary('abc', 'USD'), 0);
});

test('outstanding debts: unchecked, non-extra, converted, only up to month', () => {
  const state = {
    currencyRates: { GBP: 2000 }, assets: [],
    months: [
      { debts: [{ amount: 1000 }, { amount: 500, checked: true }] },
      { debts: [{ amount: 1, currency: 'GBP' }, { amount: 999, extraPayment: true }] },
      { debts: [{ amount: 7000 }] },
    ],
  };
  const c = moneyCtx(state);
  assert.equal(c.outstandingDebtsAsOf(1), 3000);
  assert.equal(c.outstandingDebtsAsOf(2), 10000);
});

test('net worth = balance + savings - debts + assets + investments, capped at today\'s month', () => {
  const state = {
    currencyRates: {}, assets: [{ amount: 400 }, { amount: '100' }],
    months: [{ debts: [{ amount: 200 }] }, { debts: [] }, { debts: [{ amount: 9999 }] }],
  };
  const calls = [];
  const c = moneyCtx(state, {
    cumulativeBalanceUpTo: (mi) => { calls.push(mi); return 1000; },
    totalAppsBalanceUpToConverted: () => 300,
    totalInvestmentsValue: () => 50,
    currentRealMonthIndex: () => 1,
  });
  // 1000 + 300 - 200 + 500 + 50
  assert.equal(c.netWorthForMonth(2), 1650);
  assert.deepEqual(calls, [1]); // future month capped to month 1, so month-2 debt not counted
});

// ---------- trusted-device limit ----------
test('stale device eviction: picks the least-recently-seen device only if 7+ days old', () => {
  const c = loadApp(['staleDeviceToEvict'], { STALE_DEVICE_DAYS: 7 });
  const DAY = 24 * 60 * 60 * 1000, now = 1_800_000_000_000;
  const recent = [1, 2, 3].map((i) => ({ id: 'r' + i, lastSeen: now - i * DAY }));
  assert.equal(c.staleDeviceToEvict(recent, now), null);                       // all in recent use -> ask the user
  const mixed = [...recent, { id: 'old', lastSeen: now - 8 * DAY }, { id: 'older', lastSeen: now - 40 * DAY }];
  assert.equal(c.staleDeviceToEvict(mixed, now).id, 'older');
  assert.equal(c.staleDeviceToEvict([{ id: 'edge', lastSeen: now - 7 * DAY }], now).id, 'edge'); // exactly 7 days counts
  assert.equal(c.staleDeviceToEvict([...recent, { id: 'nots' }], now).id, 'nots');              // missing lastSeen = oldest
  assert.equal(c.staleDeviceToEvict([], now), null);
  assert.equal(c.staleDeviceToEvict(undefined, now), null);
});
