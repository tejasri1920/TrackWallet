import { describe, expect, it } from 'vitest';
import {
  accountBalances, archiveAccount, balanceSeries, cashFlow, categoryBreakdown, createExpense, createIncome,
  createTransferBetween, dailySummary, deleteEntry, deleteTransfer, listAccounts, monthRange, totalBalanceCents,
  updateAccount, updateEntry, addDays, dayRange,
} from '../src/data';
import { ACC, CAT, FIXTURE_CSV, expectData, importCsv, makeDataDb, type DataHandle } from './data-helpers';

const balances = (h: DataHandle, opts: Parameters<typeof accountBalances>[1] = {}) =>
  Object.fromEntries(accountBalances(h.ctx, opts).map((b) => [b.accountId, b.balanceCents]));

// ---------------------------------------------------------------------------------------------
// Fixture A: an account that only ever sees transfers.
//   Cash -> Chase 250.00, Credit -> Cash 40.00, all openings 0.
//   Cash   = -250.00 + 40.00 = -210.00
//   Chase  = +250.00
//   Credit = - 40.00
//   Total  = 0 exactly: transfers move money, they never create or destroy it.
// ---------------------------------------------------------------------------------------------
describe('balance math: an account with only transfers', () => {
  it('matches the hand calculation and the total is exactly zero', () => {
    const h = makeDataDb();
    createTransferBetween(h.ctx, { occurredAt: '2026-08-01T10:00', fromAccountId: ACC.cash, toAccountId: ACC.chase, amountCents: 25000 });
    createTransferBetween(h.ctx, { occurredAt: '2026-08-02T10:00', fromAccountId: ACC.credit, toAccountId: ACC.cash, amountCents: 4000 });
    expect(balances(h)).toEqual({ [ACC.credit]: -4000, [ACC.chase]: 25000, [ACC.cash]: -21000 });
    expect(totalBalanceCents(h.ctx)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Fixture B: openings, a credit card that goes negative, income, and a transfer.
//   Openings:  Chase 1000.00   Cash 50.00   Credit 0.00                         (total 1050.00)
//   08-02 10:00  Credit  expense  105.88  Groceries
//   08-03 10:00  Credit  expense  110.34  Shopping > Gifts
//   08-03 15:00  Chase -> Credit  200.00  (card payment)
//   08-05 09:00  Chase   income  1500.00  Loan
//   08-05 12:00  Cash    expense   15.00  Leisure
//   08-06 08:00  Credit  expense   29.73  Subscriptions > Entertainment
//   End balances:
//     Chase  = 1000.00 - 200.00 + 1500.00                       = 2300.00
//     Cash   =   50.00 -  15.00                                 =   35.00
//     Credit =    0.00 - 105.88 - 110.34 + 200.00 - 29.73       =  -45.95   (negative, shown as is)
//     Total  = 2300.00 + 35.00 - 45.95                          = 2289.05
// ---------------------------------------------------------------------------------------------
function fixtureB() {
  const h = makeDataDb();
  updateAccount(h.ctx, ACC.chase, { openingBalanceCents: 100000 });
  updateAccount(h.ctx, ACC.cash, { openingBalanceCents: 5000 });
  const e1 = createExpense(h.ctx, { occurredAt: '2026-08-02T10:00', accountId: ACC.credit, amountCents: 10588, categoryId: CAT.groceries });
  const e2 = createExpense(h.ctx, { occurredAt: '2026-08-03T10:00', accountId: ACC.credit, amountCents: 11034, categoryId: CAT.shoppingGifts });
  const pay = createTransferBetween(h.ctx, { occurredAt: '2026-08-03T15:00', fromAccountId: ACC.chase, toAccountId: ACC.credit, amountCents: 20000 });
  createIncome(h.ctx, { occurredAt: '2026-08-05T09:00', accountId: ACC.chase, amountCents: 150000, categoryId: CAT.loan });
  createExpense(h.ctx, { occurredAt: '2026-08-05T12:00', accountId: ACC.cash, amountCents: 1500, categoryId: CAT.leisure });
  const e6 = createExpense(h.ctx, { occurredAt: '2026-08-06T08:00', accountId: ACC.credit, amountCents: 2973, categoryId: CAT.subsEntertainment });
  return { h, e1, e2, e6, pay };
}

describe('balance math: openings, a negative credit account, and a mixed total', () => {
  it('per-account balances and the headline total match the hand calculation', () => {
    const { h } = fixtureB();
    expect(balances(h)).toEqual({ [ACC.chase]: 230000, [ACC.cash]: 3500, [ACC.credit]: -4595 });
    expect(totalBalanceCents(h.ctx)).toBe(228905);
    // the credit account's negative balance is reported as it is, never clamped
    expect(accountBalances(h.ctx).find((b) => b.accountId === ACC.credit)).toMatchObject({ openingCents: 0, balanceCents: -4595, type: 'credit' });
  });

  it('the total can legitimately be negative and is not clamped', () => {
    const h = makeDataDb();
    createExpense(h.ctx, { occurredAt: '2026-08-01T10:00', accountId: ACC.credit, amountCents: 274415, categoryId: CAT.shopping });
    expect(totalBalanceCents(h.ctx)).toBe(-274415);
  });

  it('balances as of a date count everything up to the END of that day', () => {
    const { h } = fixtureB();
    // 08-03: Chase 1000-200 = 800.00; Cash 50.00; Credit -105.88 -110.34 +200 = -16.22; total 833.78
    expect(balances(h, { asOfDate: '2026-08-03' })).toEqual({ [ACC.chase]: 80000, [ACC.cash]: 5000, [ACC.credit]: -1622 });
    expect(totalBalanceCents(h.ctx, { asOfDate: '2026-08-03' })).toBe(83378);
    // 08-02: only the first card purchase has happened
    expect(totalBalanceCents(h.ctx, { asOfDate: '2026-08-02' })).toBe(94412);
    // before anything: just the opening balances
    expect(totalBalanceCents(h.ctx, { asOfDate: '2026-07-31' })).toBe(105000);
    // a transaction late on the last day is included, one just after midnight is not
    expect(totalBalanceCents(h.ctx, { asOfDate: '2026-08-06' })).toBe(228905);
    createExpense(h.ctx, { occurredAt: '2026-08-06T23:59:59', accountId: ACC.cash, amountCents: 100, categoryId: CAT.leisure });
    createExpense(h.ctx, { occurredAt: '2026-08-07T00:00:00', accountId: ACC.cash, amountCents: 1000, categoryId: CAT.leisure });
    expect(totalBalanceCents(h.ctx, { asOfDate: '2026-08-06' })).toBe(228805);
  });

  it('deleted transactions never count: deleting restores the money', () => {
    const { h, e2 } = fixtureB();
    deleteEntry(h.ctx, e2.id); // the 110.34 card purchase
    // Credit = -45.95 + 110.34 = +64.39 ; total = 2300.00 + 35.00 + 64.39 = 2399.39
    expect(balances(h)[ACC.credit]).toBe(6439);
    expect(totalBalanceCents(h.ctx)).toBe(239939);
  });

  it('deleting a transfer restores both accounts; total unchanged', () => {
    const { h, pay } = fixtureB();
    deleteTransfer(h.ctx, pay.groupId);
    expect(balances(h)).toEqual({ [ACC.chase]: 250000, [ACC.cash]: 3500, [ACC.credit]: -24595 });
    expect(totalBalanceCents(h.ctx)).toBe(228905);
  });

  it('editing an amount moves the balance by exactly the difference', () => {
    const { h, e6 } = fixtureB();
    updateEntry(h.ctx, e6.id, { amountCents: 3000 }); // 29.73 -> 30.00
    expect(balances(h)[ACC.credit]).toBe(-4622);
    expect(totalBalanceCents(h.ctx)).toBe(228878);
  });

  it('archived accounts still hold their money, and can be left out of a total on request', () => {
    const { h } = fixtureB();
    archiveAccount(h.ctx, ACC.cash);
    expect(listAccounts(h.ctx).map((a) => a.id)).not.toContain(ACC.cash);
    expect(totalBalanceCents(h.ctx)).toBe(228905); // default: everything counts
    expect(totalBalanceCents(h.ctx, { includeArchived: false })).toBe(225405); // 2289.05 - 35.00
    expect(accountBalances(h.ctx, { includeArchived: false }).map((b) => b.accountId)).not.toContain(ACC.cash);
  });
});

// ---------------------------------------------------------------------------------------------
describe('balance over time', () => {
  it('matches the hand calculation for every day', () => {
    const { h } = fixtureB();
    // 08-01 1050.00 | 08-02 -105.88 | 08-03 -110.34 (transfer nets 0) | 08-04 | 08-05 +1500 -15 | 08-06 -29.73
    expect(balanceSeries(h.ctx, { from: '2026-08-01', to: '2026-08-06' })).toEqual([
      { date: '2026-08-01', totalCents: 105000 },
      { date: '2026-08-02', totalCents: 94412 },
      { date: '2026-08-03', totalCents: 83378 },
      { date: '2026-08-04', totalCents: 83378 },
      { date: '2026-08-05', totalCents: 231878 },
      { date: '2026-08-06', totalCents: 228905 },
    ]);
  });

  it('starts correctly when the window begins after (or before) the activity', () => {
    const { h } = fixtureB();
    expect(balanceSeries(h.ctx, { from: '2026-08-04', to: '2026-08-06' }).map((p) => p.totalCents)).toEqual([83378, 231878, 228905]);
    expect(balanceSeries(h.ctx, { from: '2026-07-30', to: '2026-08-01' }).map((p) => p.totalCents)).toEqual([105000, 105000, 105000]);
    expect(balanceSeries(h.ctx, { from: '2026-09-01', to: '2026-09-02' }).map((p) => p.totalCents)).toEqual([228905, 228905]);
  });

  it('agrees with totalBalance for every single day (one method cannot drift from the other)', () => {
    const { h } = fixtureB();
    createExpense(h.ctx, { occurredAt: '2026-08-04T23:59:59', accountId: ACC.credit, amountCents: 777, categoryId: CAT.food });
    for (const p of balanceSeries(h.ctx, { from: '2026-07-28', to: '2026-08-10' })) {
      expect(p.totalCents, p.date).toBe(totalBalanceCents(h.ctx, { asOfDate: p.date }));
    }
  });

  it('respects deletions, archived accounts and the size limit', () => {
    const { h, e1 } = fixtureB();
    deleteEntry(h.ctx, e1.id);
    expect(balanceSeries(h.ctx, { from: '2026-08-02', to: '2026-08-02' })).toEqual([{ date: '2026-08-02', totalCents: 105000 }]);
    archiveAccount(h.ctx, ACC.cash);
    expect(balanceSeries(h.ctx, { from: '2026-08-01', to: '2026-08-01' }, { includeArchived: false })).toEqual([{ date: '2026-08-01', totalCents: 100000 }]);
    expectData(() => balanceSeries(h.ctx, { from: '2026-08-05', to: '2026-08-04' }), 'invalid', /must not be before/);
    expectData(() => balanceSeries(h.ctx, { from: '2000-01-01', to: '2026-01-01' }), 'invalid', /at most/);
    expectData(() => balanceSeries(h.ctx, { from: '2026-8-1', to: '2026-08-04' }), 'invalid', /YYYY-MM-DD/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('cash flow: transfers are never income or spending', () => {
  it('matches the hand calculation for the month and for a sub-range', () => {
    const { h } = fixtureB();
    const aug = monthRange(2026, 8);
    // income 1500.00; expenses 105.88 + 110.34 + 15.00 + 29.73 = 260.95; net 1239.05. The 200.00 payment is in neither.
    expect(cashFlow(h.ctx, aug)).toEqual({ incomeCents: 150000, expenseCents: 26095, netCents: 123905 });
    // Aug 3..5 (6th excluded): income 1500.00; expenses 110.34 + 15.00 = 125.34; net 1374.66
    expect(cashFlow(h.ctx, { from: '2026-08-03', toExclusive: '2026-08-06' })).toEqual({ incomeCents: 150000, expenseCents: 12534, netCents: 137466 });
    expect(cashFlow(h.ctx, { from: '2026-08-01', toExclusive: '2026-08-02' })).toEqual({ incomeCents: 0, expenseCents: 0, netCents: 0 });
  });

  it('can be limited to some accounts, and ignores deleted rows', () => {
    const { h, e2 } = fixtureB();
    expect(cashFlow(h.ctx, monthRange(2026, 8), { accountIds: [ACC.cash] })).toEqual({ incomeCents: 0, expenseCents: 1500, netCents: -1500 });
    expect(cashFlow(h.ctx, monthRange(2026, 8), { accountIds: [ACC.credit, ACC.chase] }).expenseCents).toBe(10588 + 11034 + 2973);
    deleteEntry(h.ctx, e2.id);
    expect(cashFlow(h.ctx, monthRange(2026, 8)).expenseCents).toBe(26095 - 11034);
  });

  it('month and day ranges are half-open and handle month/year ends', () => {
    expect(monthRange(2026, 12)).toEqual({ from: '2026-12-01', toExclusive: '2027-01-01' });
    expect(monthRange(2028, 2)).toEqual({ from: '2028-02-01', toExclusive: '2028-03-01' });
    expect(dayRange('2026-12-31')).toEqual({ from: '2026-12-31', toExclusive: '2027-01-01' });
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expectData(() => monthRange(2026, 13), 'invalid');
  });

  it('a purchase at 23:59:59 stays on its own day and month', () => {
    const h = makeDataDb();
    createExpense(h.ctx, { occurredAt: '2026-08-31T23:59:59', accountId: ACC.cash, amountCents: 100, categoryId: CAT.leisure });
    createExpense(h.ctx, { occurredAt: '2026-09-01T00:00:00', accountId: ACC.cash, amountCents: 200, categoryId: CAT.leisure });
    expect(cashFlow(h.ctx, monthRange(2026, 8)).expenseCents).toBe(100);
    expect(cashFlow(h.ctx, monthRange(2026, 9)).expenseCents).toBe(200);
  });
});

// ---------------------------------------------------------------------------------------------
// Fixture C: category breakdown.
//   Food & Drinks: direct 5.66 | Groceries 105.88 | Snacks 3.00 + 1.34 = 4.34   -> top total 115.88
//   Shopping > Gifts 110.34                                                      -> top total 110.34
//   Subscriptions > Entertainment 29.73
//   Leisure (direct) 15.00
//   plus a 500.00 transfer and a deleted 999.99 expense, which must not appear
//   Income: Salary > Denim 650.00 + 425.00, Salary > Ride 23.00, Loan (direct) 1500.00
// ---------------------------------------------------------------------------------------------
describe('category breakdown', () => {
  function fixtureC() {
    const h = makeDataDb();
    const e = (cat: string, cents: number, at = '2026-08-10T10:00') =>
      createExpense(h.ctx, { occurredAt: at, accountId: ACC.credit, amountCents: cents, categoryId: cat });
    e(CAT.food, 566); e(CAT.groceries, 10588); e(CAT.snacks, 300); e(CAT.snacks, 134);
    e(CAT.shoppingGifts, 11034); e(CAT.subsEntertainment, 2973); e(CAT.leisure, 1500);
    const gone = e(CAT.leisure, 99999); deleteEntry(h.ctx, gone.id);
    e(CAT.leisure, 700, '2026-09-02T10:00'); // outside the month
    createTransferBetween(h.ctx, { occurredAt: '2026-08-11T10:00', fromAccountId: ACC.chase, toAccountId: ACC.credit, amountCents: 50000 });
    const i = (cat: string, cents: number) => createIncome(h.ctx, { occurredAt: '2026-08-12T10:00', accountId: ACC.cash, amountCents: cents, categoryId: cat });
    i(CAT.salaryDenim, 65000); i(CAT.salaryDenim, 42500); i(CAT.salaryRide, 2300); i(CAT.loan, 150000);
    return h;
  }

  it('rolls subcategories up, orders by size, and leaves out transfers, deleted rows and other months', () => {
    const h = fixtureC();
    const out = categoryBreakdown(h.ctx, 'expense', monthRange(2026, 8));
    expect(out.map((c) => [c.name, c.totalCents, c.directCents])).toEqual([
      ['Food & Drinks', 11588, 566],
      ['Shopping', 11034, 0],
      ['Subscriptions', 2973, 0],
      ['Leisure', 1500, 1500],
    ]);
    expect(out[0].children.map((c) => [c.name, c.totalCents])).toEqual([['Groceries', 10588], ['Snacks', 434]]);
    expect(out[1].children.map((c) => [c.name, c.totalCents])).toEqual([['Gifts', 11034]]);
    // the breakdown adds up to the cash-flow expense figure
    expect(out.reduce((s, c) => s + c.totalCents, 0)).toBe(cashFlow(h.ctx, monthRange(2026, 8)).expenseCents);
  });

  it('breaks income down the same way, as positive magnitudes', () => {
    const h = fixtureC();
    const out = categoryBreakdown(h.ctx, 'income', monthRange(2026, 8));
    expect(out.map((c) => [c.name, c.totalCents])).toEqual([['Loan', 150000], ['Salary', 109800]]);
    expect(out[1].children.map((c) => [c.name, c.totalCents])).toEqual([['Denim', 107500], ['Ride', 2300]]);
    expect(out.reduce((s, c) => s + c.totalCents, 0)).toBe(cashFlow(h.ctx, monthRange(2026, 8)).incomeCents);
  });

  it('respects an account filter and an empty range', () => {
    const h = fixtureC();
    expect(categoryBreakdown(h.ctx, 'income', monthRange(2026, 8), { accountIds: [ACC.credit] })).toEqual([]);
    expect(categoryBreakdown(h.ctx, 'expense', { from: '2026-01-01', toExclusive: '2026-02-01' })).toEqual([]);
  });

  it('keeps archived categories that were used in the period', () => {
    const h = fixtureC();
    updateAccount(h.ctx, ACC.cash, {});
    expect(categoryBreakdown(h.ctx, 'expense', monthRange(2026, 8)).map((c) => c.name)).toContain('Leisure');
  });
});

// ---------------------------------------------------------------------------------------------
// The real August export, checked against numbers read off TrackWallet's own screenshots.
// ---------------------------------------------------------------------------------------------
describe('the August export, against TrackWallet screenshots', () => {
  const aug = () => {
    const h = makeDataDb();
    importCsv(h, FIXTURE_CSV);
    return h;
  };

  it("cash flow equals TrackWallet's header: 6,196$ income, 2,506.91$ expenses, +3,689.09$", () => {
    expect(cashFlow(aug().ctx, monthRange(2026, 8))).toEqual({ incomeCents: 619600, expenseCents: 250691, netCents: 368909 });
  });

  it("the daily summary equals every cell of TrackWallet's August calendar, with transfer markers on 3, 4, 9, 17 and 25", () => {
    const expected: Record<string, [number, number, boolean]> = {
      '01': [42500, 0, false], '02': [2300, 3596, false], '03': [150000, 51788, true], '04': [23500, 50500, true],
      '06': [0, 2000, false], '08': [66300, 0, false], '09': [0, 4555, true], '11': [0, 12037, false],
      '12': [0, 27000, false], '13': [0, 5273, false], '15': [64200, 500, false], '16': [0, 2949, false],
      '17': [0, 883, true], '18': [0, 2973, false], '19': [0, 213, false], '21': [0, 6239, false],
      '22': [86400, 700, false], '23': [19400, 0, false], '24': [0, 1024, false], '25': [100000, 1500, true],
      '26': [0, 76382, false], '29': [65000, 579, false],
    };
    const got = dailySummary(aug().ctx, monthRange(2026, 8));
    expect(got.map((d) => d.date)).toEqual(Object.keys(expected).sort().map((d) => `2026-08-${d}`)); // exactly these 22 days, none missing or extra
    for (const d of got) {
      const [income, expense, transfer] = expected[d.date.slice(8)];
      expect([d.incomeCents, d.expenseCents, d.hasTransfer], d.date).toEqual([income, expense, transfer]);
    }
  });

  it('per-account balances (openings 0) equal the hand-summed August totals', () => {
    expect(balances(aug())).toEqual({ [ACC.credit]: 317721, [ACC.chase]: 2988, [ACC.cash]: 48200 });
  });

  it('category totals equal sums worked out by hand from the CSV', () => {
    const h = aug();
    const exp = categoryBreakdown(h.ctx, 'expense', monthRange(2026, 8));
    const by = Object.fromEntries(exp.map((c) => [c.name, c]));
    // Food & Drinks: Groceries 203.83, Snacks 15.52, direct (Dunkin 5.66 + 8.83) 14.49
    expect(by['Food & Drinks']).toMatchObject({ totalCents: 23384, directCents: 1449 });
    expect(by['Food & Drinks'].children.map((c) => [c.name, c.totalCents])).toEqual([['Groceries', 20383], ['Snacks', 1552]]);
    // Vehicle: Fuel 54.00 + 52.73 + 10.10 + 20.03, Maintenance 100.00 + 20.37
    expect(by['Vehicle'].children.map((c) => [c.name, c.totalCents])).toEqual([['Fuel', 13686], ['Maintenance', 12037]]);
    expect(by['Vehicle'].totalCents).toBe(25723);
    expect(by['Housing'].totalCents).toBe(30500); // Rent 305.00
    expect(by['Bills'].totalCents).toBe(27000); // Phone 270.00
    expect(by['Lend'].totalCents).toBe(20000 + 4500 + 35000 + 3780); // Sahithi, Teja, Pramod, UPS
    expect(by['Repaid'].totalCents).toBe(6800); // the expense-side "Returned" -> Aakanksha
    expect(exp.reduce((s, c) => s + c.totalCents, 0)).toBe(250691);

    const inc = Object.fromEntries(categoryBreakdown(h.ctx, 'income', monthRange(2026, 8)).map((c) => [c.name, c]));
    expect(inc['Salary'].totalCents).toBe(322700); // Denim 3004.00 + Ride 223.00
    expect(inc['Salary'].children.map((c) => [c.name, c.totalCents])).toEqual([['Denim', 300400], ['Ride', 22300]]);
    expect([inc['Taken'].totalCents, inc['Returned'].totalCents, inc['Loan'].totalCents]).toEqual([100000, 46900, 150000]);
  });

  it('the balance series ends at the sum of the account balances, and reflects the daily net', () => {
    const h = aug();
    const series = balanceSeries(h.ctx, { from: '2026-08-01', to: '2026-08-31' });
    expect(series).toHaveLength(31);
    expect(series[series.length - 1].totalCents).toBe(317721 + 2988 + 48200);
    expect(series[0].totalCents).toBe(42500); // Aug 1: the 425.00 salary
    // Aug 3 net: +1500.00 - 517.88 (transfers net to zero)
    expect(series[2].totalCents - series[1].totalCents).toBe(150000 - 51788);
  });
});

// ---------------------------------------------------------------------------------------------
describe('stored USD amounts are used as stored, never recomputed', () => {
  it('changing a stored rate does not move any total, and a foreign account blocks a mixed total', () => {
    const h = makeDataDb();
    h.sqlite.prepare(`INSERT INTO accounts (id, name, type, currency, created_at, updated_at) VALUES ('inr', 'India', 'bank', 'INR', ?, ?)`).run('2026-08-01T00:00:00', '2026-08-01T00:00:00');
    // Rs 83.50 = 8350 paise, stored as $1.00 at rate 83.5
    h.sqlite.prepare(
      `INSERT INTO transactions (id, occurred_at, type, account_id, currency, amount_native, amount_usd, fx_rate, category_id, created_at, updated_at)
       VALUES ('foreign', '2026-08-10T10:00:00', 'expense', 'inr', 'INR', -8350, -100, 83.5, ?, ?, ?)`,
    ).run(CAT.leisure, '2026-08-10T10:00:00', '2026-08-10T10:00:00');
    const flow = () => cashFlow(h.ctx, monthRange(2026, 8));
    expect(flow().expenseCents).toBe(100);

    h.sqlite.pragma('ignore_check_constraints = ON'); // deliberately break the rate to prove it is not consulted
    h.sqlite.prepare(`UPDATE transactions SET fx_rate = 999 WHERE id = 'foreign'`).run();
    expect(flow().expenseCents).toBe(100);
    expect(dailySummary(h.ctx, monthRange(2026, 8))).toEqual([{ date: '2026-08-10', incomeCents: 0, expenseCents: 100, hasTransfer: false }]);
    expect(categoryBreakdown(h.ctx, 'expense', monthRange(2026, 8))[0].totalCents).toBe(100);

    // the native balance of that account is in its own currency; a total across currencies is refused, not guessed
    expect(accountBalances(h.ctx).find((b) => b.accountId === 'inr')).toMatchObject({ currency: 'INR', balanceCents: -8350 });
    expectData(() => totalBalanceCents(h.ctx), 'invalid', /in INR/);
    expectData(() => balanceSeries(h.ctx, { from: '2026-08-01', to: '2026-08-02' }), 'invalid', /in INR/);
    archiveAccount(h.ctx, 'inr');
    expect(totalBalanceCents(h.ctx, { includeArchived: false })).toBe(0);
  });
});
