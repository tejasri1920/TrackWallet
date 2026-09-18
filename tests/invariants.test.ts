import { describe, expect, it } from 'vitest';
import { INVARIANTS, runInvariants, type Row } from '../src/db/invariants';
import { createTransfer, softDeleteTransfer } from '../src/db/transfers';
import {
  ACC,
  CAT,
  NOW,
  insertCategory,
  insertPerson,
  insertTx,
  makeEnforcingDb,
  makeUnconstrainedDb,
  rowsOf,
} from './helpers';

const inv = (n: number) => INVARIANTS.find((i) => i.id === n)!;
const flagged = (sqlite: Parameters<typeof rowsOf>[0], n: number) => rowsOf(sqlite, inv(n).sql);
const keys = (rows: Row[], key = 'id') => rows.map((r) => String(r[key])).sort();
const sorted = (a: string[]) => [...a].sort();

const transferLeg = (group: string, amount: number, extra: Row = {}): Row => ({
  type: 'transfer',
  category_id: null,
  transfer_group_id: group,
  amount_native: amount,
  amount_usd: amount,
  ...extra,
});

// An INR expense on the loan account: 8350 paise = 100 cents at 83.5.
const inr = (extra: Row = {}): Row => ({
  account_id: ACC.loan,
  currency: 'INR',
  amount_native: -8350,
  amount_usd: -100,
  fx_rate: 83.5,
  ...extra,
});

function counter() {
  let n = 0;
  return () => `id-${++n}`;
}

// ---------------------------------------------------------------------------------------
// Layer 1: enforcement. A violating row is REJECTED by the real schema.
// ---------------------------------------------------------------------------------------
describe('enforcement: violating rows are rejected', () => {
  it('invariant 1: expense must be negative, have a category, of kind expense', () => {
    const { sqlite } = makeEnforcingDb();
    expect(() => insertTx(sqlite, { amount_native: 1000, amount_usd: 1000 })).toThrow(/tx_expense_shape/);
    expect(() => insertTx(sqlite, { category_id: null })).toThrow(/tx_expense_shape/);
    expect(() => insertTx(sqlite, { category_id: CAT.salary })).toThrow(/category kind does not match/);
    expect(insertTx(sqlite)).toBeTruthy(); // control: a valid expense goes in
  });

  it('invariant 2: income must be positive, have a category, of kind income', () => {
    const { sqlite } = makeEnforcingDb();
    const income = { type: 'income', amount_native: 5000, amount_usd: 5000, category_id: CAT.salary };
    expect(() => insertTx(sqlite, { ...income, amount_native: -5000, amount_usd: -5000 })).toThrow(/tx_income_shape/);
    expect(() => insertTx(sqlite, { ...income, category_id: null })).toThrow(/tx_income_shape/);
    expect(() => insertTx(sqlite, { ...income, category_id: CAT.food })).toThrow(/category kind does not match/);
    expect(insertTx(sqlite, income)).toBeTruthy();
  });

  it('invariant 3: transfer has no category and has a group id', () => {
    const { sqlite } = makeEnforcingDb();
    expect(() => insertTx(sqlite, transferLeg('g', -1000, { category_id: CAT.food }))).toThrow(/tx_transfer_shape/);
    expect(() => insertTx(sqlite, transferLeg('g', -1000, { transfer_group_id: null }))).toThrow(/tx_transfer_shape/);
  });

  it('invariant 4: a third live leg is rejected; soft-deleted legs do not count', () => {
    const { sqlite } = makeEnforcingDb();
    insertTx(sqlite, transferLeg('g', -1000, { account_id: ACC.chase }));
    insertTx(sqlite, transferLeg('g', 1000, { account_id: ACC.credit }));
    expect(() => insertTx(sqlite, transferLeg('g', 500, { account_id: ACC.cash }))).toThrow(
      /already has 2 live legs/,
    );

    insertTx(sqlite, transferLeg('h', -1000, { account_id: ACC.chase }));
    insertTx(sqlite, transferLeg('h', 1000, { account_id: ACC.credit, deleted_at: NOW }));
    expect(insertTx(sqlite, transferLeg('h', 1000, { account_id: ACC.cash }))).toBeTruthy();
  });

  it('invariant 4: a lone first leg cannot be rejected at insert (createTransfer + audit are the guard)', () => {
    const { sqlite } = makeEnforcingDb();
    insertTx(sqlite, transferLeg('lone', -1000, { account_id: ACC.chase }));
    expect(keys(flagged(sqlite, 4), 'transfer_group_id')).toEqual(['lone']);
  });

  it('invariant 5: a second leg that does not offset the first is rejected', () => {
    const { sqlite } = makeEnforcingDb();
    insertTx(sqlite, transferLeg('g', -1000, { account_id: ACC.chase }));
    expect(() => insertTx(sqlite, transferLeg('g', 900, { account_id: ACC.credit }))).toThrow(
      /must sum to zero/,
    );
    expect(insertTx(sqlite, transferLeg('g', 1000, { account_id: ACC.credit }))).toBeTruthy();
  });

  it('invariant 6: a USD row needs native = usd and fx_rate = 1.0', () => {
    const { sqlite } = makeEnforcingDb();
    expect(() => insertTx(sqlite, { amount_usd: -1050 })).toThrow(/tx_usd_rate/);
    expect(() => insertTx(sqlite, { fx_rate: 1.5 })).toThrow(/tx_usd_rate/);
  });

  it('invariant 7: a foreign row needs fx_rate > 0 and native/fx within 1 minor unit of usd', () => {
    const { sqlite } = makeEnforcingDb();
    expect(() => insertTx(sqlite, inr({ fx_rate: 0 }))).toThrow(/tx_foreign_rate/);
    expect(() => insertTx(sqlite, inr({ fx_rate: -83.5 }))).toThrow(/tx_foreign_rate/);
    expect(() => insertTx(sqlite, inr({ fx_rate: 90 }))).toThrow(/tx_foreign_rate/); // 8350/90 = 92.8 vs 100
    expect(() => insertTx(sqlite, inr({ amount_usd: -102 }))).toThrow(/tx_foreign_rate/); // off by 2
    expect(insertTx(sqlite, inr())).toBeTruthy(); // exact
    expect(insertTx(sqlite, inr({ amount_usd: -101 }))).toBeTruthy(); // off by exactly 1: tolerated
  });

  it('invariant 8: native and usd share a sign', () => {
    const { sqlite } = makeEnforcingDb();
    expect(() => insertTx(sqlite, inr({ amount_usd: 100 }))).toThrow(/tx_sign_match/);
  });

  it('invariant 9: category depth is at most 2', () => {
    const { sqlite } = makeEnforcingDb();
    // A child of a subcategory.
    expect(() => insertCategory(sqlite, { id: 'deep', name: 'Deep', parent_id: CAT.groceries })).toThrow(
      /depth must be <= 2/,
    );
    // Re-parenting a top-level category that already has children under another category.
    expect(() =>
      sqlite.prepare(`UPDATE categories SET parent_id = ? WHERE id = ?`).run(CAT.lend, CAT.food),
    ).toThrow(/already has children/);
    // Re-parenting under a subcategory.
    expect(() =>
      sqlite.prepare(`UPDATE categories SET parent_id = ? WHERE id = ?`).run(CAT.groceries, CAT.lend),
    ).toThrow(/depth must be <= 2/);
    // Own parent.
    expect(() => insertCategory(sqlite, { id: 'loop', name: 'Loop', parent_id: 'loop' })).toThrow(
      /depth must be <= 2/,
    );
    // Control: a legitimate subcategory.
    insertCategory(sqlite, { id: 'ok', name: 'Restaurants', parent_id: CAT.food });
  });

  it('invariant 10: person_id requires a people_backed category', () => {
    const { sqlite } = makeEnforcingDb();
    insertPerson(sqlite, 'p-1', 'Pramod');
    expect(() => insertTx(sqlite, { person_id: 'p-1', category_id: CAT.food })).toThrow(/people_backed/);
    expect(() =>
      insertTx(sqlite, transferLeg('g', -1000, { person_id: 'p-1' })),
    ).toThrow(/people_backed/);
    expect(insertTx(sqlite, { person_id: 'p-1', category_id: CAT.lend })).toBeTruthy();
    // The category cannot lose people_backed, or change kind, while rows rely on it.
    expect(() => sqlite.prepare(`UPDATE categories SET people_backed = 0 WHERE id = ?`).run(CAT.lend)).toThrow(
      /people_backed cannot be cleared/,
    );
    expect(() => sqlite.prepare(`UPDATE categories SET kind = 'income' WHERE id = ?`).run(CAT.lend)).toThrow(
      /kind cannot change/,
    );
  });

  it('invariant 11: references must exist (foreign keys are ON)', () => {
    const { sqlite } = makeEnforcingDb();
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => insertTx(sqlite, { account_id: 'ghost' })).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => insertTx(sqlite, { category_id: 'ghost' })).toThrow(/FOREIGN KEY constraint failed/);
    expect(() => insertTx(sqlite, { person_id: 'ghost', category_id: CAT.lend })).toThrow(
      /FOREIGN KEY constraint failed/,
    );
  });

  it('extra 12: money is stored as integers and fx_rate as a number', () => {
    const { sqlite } = makeEnforcingDb();
    expect(() => insertTx(sqlite, { amount_native: -12.5, amount_usd: -12.5 })).toThrow(/tx_money_integer/);
    expect(() => sqlite.prepare(`UPDATE accounts SET opening_balance_native = 10.5 WHERE id = ?`).run(ACC.cash)).toThrow(
      /accounts_opening_integer/,
    );
    // Review finding 3: a text fx_rate made tx_foreign_rate evaluate to NULL, which passes a CHECK.
    expect(() => insertTx(sqlite, inr({ fx_rate: 'abc' }))).toThrow(/tx_fx_numeric/);
  });

  it('extra 13: transfer_group_id only on transfer rows; transfer legs are non-zero', () => {
    const { sqlite, db } = makeEnforcingDb();
    // Review finding 1, scenario A: an income row joining a transfer group.
    insertTx(sqlite, transferLeg('g', -1000, { account_id: ACC.chase }));
    expect(() =>
      insertTx(sqlite, { type: 'income', category_id: CAT.salary, amount_native: 1000, amount_usd: 1000, transfer_group_id: 'g' }),
    ).toThrow(/tx_group_only_on_transfer/);
    // (a fresh group, so the insert-side transfer trigger has nothing to say and the CHECK decides)
    expect(() => insertTx(sqlite, { transfer_group_id: 'fresh' })).toThrow(/tx_group_only_on_transfer/);
    // Review finding 1, scenario B: retyping one leg of a valid transfer as income.
    const { legIds } = createTransfer(db, {
      occurredAt: NOW,
      from: { accountId: ACC.chase, currency: 'USD', amountNative: 500 },
      to: { accountId: ACC.credit, currency: 'USD', amountNative: 500 },
      amountUsd: 500,
      now: NOW,
      newId: counter(),
    });
    expect(() =>
      sqlite.prepare(`UPDATE transactions SET type = 'income', category_id = ? WHERE id = ?`).run(CAT.salary, legIds[1]),
    ).toThrow(/tx_group_only_on_transfer/);
    // Review finding 6: zero-amount transfer legs.
    expect(() => insertTx(sqlite, transferLeg('z', 0))).toThrow(/tx_transfer_nonzero/);
  });

  it('extra 14: transfer legs must be on different accounts; same-currency legs offset in native', () => {
    const { sqlite } = makeEnforcingDb();
    // Review finding 6: both legs on one account.
    insertTx(sqlite, transferLeg('same-acct', -1000, { account_id: ACC.chase }));
    expect(() => insertTx(sqlite, transferLeg('same-acct', 1000, { account_id: ACC.chase }))).toThrow(
      /different accounts/,
    );
    // Review finding 5: INR -> INR moving 10000 out and 20000 in, USD netting to zero.
    insertTx(sqlite, transferLeg('inr-inr', -10000, { account_id: ACC.loan, currency: 'INR', amount_usd: -120, fx_rate: 10000 / 120 }));
    expect(() =>
      insertTx(sqlite, transferLeg('inr-inr', 20000, { account_id: ACC.loan2, currency: 'INR', amount_usd: 120, fx_rate: 20000 / 120 })),
    ).toThrow(/offset in amount_native/);
    // Control: a cross-currency pair (USD out, INR in) is fine, and so is an equal INR pair.
    insertTx(sqlite, transferLeg('usd-inr', -10000, { account_id: ACC.chase }));
    expect(
      insertTx(sqlite, transferLeg('usd-inr', 835000, { account_id: ACC.loan, currency: 'INR', amount_usd: 10000, fx_rate: 83.5 })),
    ).toBeTruthy();
    insertTx(sqlite, transferLeg('inr-ok', -8350, { account_id: ACC.loan, currency: 'INR', amount_usd: -100, fx_rate: 83.5 }));
    expect(
      insertTx(sqlite, transferLeg('inr-ok', 8350, { account_id: ACC.loan2, currency: 'INR', amount_usd: 100, fx_rate: 83.5 })),
    ).toBeTruthy();
  });

  it('extra 16: a subcategory has the same kind as its parent', () => {
    const { sqlite } = makeEnforcingDb();
    expect(() => insertCategory(sqlite, { id: 'bad', name: 'Bad', kind: 'income', parent_id: CAT.food })).toThrow(
      /subcategory kind must equal its parent kind/,
    );
    expect(() => insertCategory(sqlite, { id: 'bad', name: 'Bad', kind: 'expense', parent_id: CAT.salary })).toThrow(
      /subcategory kind must equal its parent kind/,
    );
    // changing a parent's kind while its subcategories keep the old one
    expect(() => sqlite.prepare(`UPDATE categories SET kind = 'income' WHERE id = ?`).run(CAT.food)).toThrow(
      /subcategories of the other kind/,
    );
    // re-parenting a subcategory under a parent of the other kind
    expect(() => sqlite.prepare(`UPDATE categories SET parent_id = ? WHERE id = ?`).run(CAT.salary, CAT.groceries)).toThrow(
      /subcategory kind must equal its parent kind/,
    );
    insertCategory(sqlite, { id: 'ok', name: 'Bonus', kind: 'income', parent_id: CAT.salary }); // control
  });

  it('extra 15: currency codes are three uppercase letters', () => {
    const { sqlite } = makeEnforcingDb();
    // Review finding 4: lowercase 'usd' was treated as foreign and bypassed invariant 6.
    expect(() => insertTx(sqlite, { currency: 'usd', amount_native: -1000, amount_usd: -500, fx_rate: 2 })).toThrow(
      /tx_currency_format/,
    );
    expect(() => insertTx(sqlite, { currency: '' })).toThrow(/tx_currency_format/);
    expect(() => insertTx(sqlite, { currency: 'USDT' })).toThrow(/tx_currency_format/);
    expect(() =>
      sqlite
        .prepare(`INSERT INTO accounts (id,name,type,currency,created_at,updated_at) VALUES ('a-x','X','cash','inr',?,?)`)
        .run(NOW, NOW),
    ).toThrow(/accounts_currency_format/);
  });
});

// ---------------------------------------------------------------------------------------
// createTransfer: the write path for invariants 4 and 5.
// ---------------------------------------------------------------------------------------
describe('createTransfer', () => {
  it('writes two balanced USD legs in one group', () => {
    const { sqlite, db } = makeEnforcingDb();
    const { groupId, legIds } = createTransfer(db, {
      occurredAt: '2026-08-25T15:51:06',
      from: { accountId: ACC.chase, currency: 'USD', amountNative: 100000 },
      to: { accountId: ACC.credit, currency: 'USD', amountNative: 100000 },
      amountUsd: 100000,
      now: NOW,
      newId: counter(),
    });
    const legs = rowsOf(sqlite, `SELECT * FROM transactions WHERE transfer_group_id = '${groupId}' ORDER BY amount_native`);
    expect(legs.map((l) => l.id)).toEqual(legIds);
    expect(legs.map((l) => [l.account_id, l.amount_native, l.amount_usd, l.fx_rate, l.category_id])).toEqual([
      [ACC.chase, -100000, -100000, 1.0, null],
      [ACC.credit, 100000, 100000, 1.0, null],
    ]);
    expect(runInvariants((s) => rowsOf(sqlite, s)).filter((r) => !r.passed)).toEqual([]);
  });

  it('derives fx_rate from the two amounts for a USD -> INR transfer', () => {
    const { sqlite, db } = makeEnforcingDb();
    createTransfer(db, {
      occurredAt: '2026-08-25T15:51:06',
      from: { accountId: ACC.chase, currency: 'USD', amountNative: 10000 }, // $100.00
      to: { accountId: ACC.loan, currency: 'INR', amountNative: 835000 }, // Rs 8,350.00
      amountUsd: 10000,
      now: NOW,
      newId: counter(),
    });
    const legs = rowsOf(sqlite, `SELECT account_id, currency, amount_native, amount_usd, fx_rate FROM transactions ORDER BY amount_native`);
    expect(legs).toEqual([
      { account_id: ACC.chase, currency: 'USD', amount_native: -10000, amount_usd: -10000, fx_rate: 1 },
      { account_id: ACC.loan, currency: 'INR', amount_native: 835000, amount_usd: 10000, fx_rate: 83.5 },
    ]);
    expect(runInvariants((s) => rowsOf(sqlite, s)).filter((r) => !r.passed)).toEqual([]);
  });

  it('rejects invalid input and writes nothing', () => {
    const { sqlite, db } = makeEnforcingDb();
    const base = {
      occurredAt: NOW,
      from: { accountId: ACC.chase, currency: 'USD', amountNative: 1000 },
      to: { accountId: ACC.credit, currency: 'USD', amountNative: 1000 },
      amountUsd: 1000,
      now: NOW,
      newId: counter(),
    };
    expect(() => createTransfer(db, { ...base, to: { ...base.to, accountId: ACC.chase } })).toThrow(/must differ/);
    expect(() => createTransfer(db, { ...base, amountUsd: 0 })).toThrow(/positive integer/);
    expect(() => createTransfer(db, { ...base, amountUsd: -1000 })).toThrow(/positive integer/);
    expect(() => createTransfer(db, { ...base, amountUsd: 10.5 })).toThrow(/positive integer/);
    expect(() => createTransfer(db, { ...base, to: { ...base.to, amountNative: 999 } })).toThrow(/USD leg/);
    expect(() => createTransfer(db, { ...base, from: { ...base.from, amountNative: 0 } })).toThrow(/positive integer/);
    expect(rowsOf(sqlite, `SELECT COUNT(*) AS n FROM transactions`)).toEqual([{ n: 0 }]);
  });

  it('is atomic: a failing second leg rolls back the first', () => {
    const { sqlite, db } = makeEnforcingDb();
    expect(() =>
      createTransfer(db, {
        occurredAt: NOW,
        from: { accountId: ACC.chase, currency: 'USD', amountNative: 1000 },
        to: { accountId: 'no-such-account', currency: 'USD', amountNative: 1000 },
        amountUsd: 1000,
        now: NOW,
        newId: counter(),
      }),
    ).toThrow(/FOREIGN KEY constraint failed/);
    expect(rowsOf(sqlite, `SELECT COUNT(*) AS n FROM transactions`)).toEqual([{ n: 0 }]);
  });

  it('rejects a same-currency transfer with unequal native amounts (review finding 5)', () => {
    const { sqlite, db } = makeEnforcingDb();
    // 10000 paise out, 20000 paise in, USD netting to zero: would create 10000 paise from nothing.
    expect(() =>
      createTransfer(db, {
        occurredAt: NOW,
        from: { accountId: ACC.loan, currency: 'INR', amountNative: 10000 },
        to: { accountId: ACC.loan2, currency: 'INR', amountNative: 20000 },
        amountUsd: 120,
        now: NOW,
        newId: counter(),
      }),
    ).toThrow(/same-currency transfer must move equal native amounts/);
    expect(rowsOf(sqlite, `SELECT COUNT(*) AS n FROM transactions`)).toEqual([{ n: 0 }]);
  });

  it('rejects a lowercase currency code (review finding 4)', () => {
    const { sqlite, db } = makeEnforcingDb();
    expect(() =>
      createTransfer(db, {
        occurredAt: NOW,
        from: { accountId: ACC.chase, currency: 'usd', amountNative: 1000 },
        to: { accountId: ACC.credit, currency: 'USD', amountNative: 500 },
        amountUsd: 500,
        now: NOW,
        newId: counter(),
      }),
    ).toThrow(/tx_currency_format/);
    expect(rowsOf(sqlite, `SELECT COUNT(*) AS n FROM transactions`)).toEqual([{ n: 0 }]);
  });
});

describe('softDeleteTransfer', () => {
  const make = (db: ReturnType<typeof makeEnforcingDb>['db']) =>
    createTransfer(db, {
      occurredAt: NOW,
      from: { accountId: ACC.chase, currency: 'USD', amountNative: 1000 },
      to: { accountId: ACC.credit, currency: 'USD', amountNative: 1000 },
      amountUsd: 1000,
      now: NOW,
      newId: counter(),
    });

  it('soft-deletes both legs together and leaves every invariant passing', () => {
    const { sqlite, db } = makeEnforcingDb();
    const { groupId } = make(db);
    softDeleteTransfer(db, groupId, '2026-09-01T00:00:00');
    expect(rowsOf(sqlite, `SELECT deleted_at, updated_at FROM transactions WHERE transfer_group_id = '${groupId}'`)).toEqual([
      { deleted_at: '2026-09-01T00:00:00', updated_at: '2026-09-01T00:00:00' },
      { deleted_at: '2026-09-01T00:00:00', updated_at: '2026-09-01T00:00:00' },
    ]);
    expect(runInvariants((s) => rowsOf(sqlite, s)).filter((r) => !r.passed)).toEqual([]);
  });

  it('refuses an unknown group, an already-deleted group, and a group with one live leg', () => {
    const { sqlite, db } = makeEnforcingDb();
    const { groupId, legIds } = make(db);
    expect(() => softDeleteTransfer(db, 'no-such-group', NOW)).toThrow(/0 live legs/);
    // one leg already gone (only possible by a raw UPDATE) => refuse rather than half-delete
    sqlite.prepare(`UPDATE transactions SET deleted_at = ? WHERE id = ?`).run(NOW, legIds[0]);
    expect(() => softDeleteTransfer(db, groupId, NOW)).toThrow(/1 live legs/);
    expect(rowsOf(sqlite, `SELECT COUNT(*) AS n FROM transactions WHERE transfer_group_id = '${groupId}' AND deleted_at IS NULL`)).toEqual([{ n: 1 }]);
  });

  it('refuses to delete the same transfer twice', () => {
    const { db } = makeEnforcingDb();
    const { groupId } = make(db);
    softDeleteTransfer(db, groupId, NOW);
    expect(() => softDeleteTransfer(db, groupId, NOW)).toThrow(/0 live legs/);
  });
});

describe('known limitation: raw UPDATEs on transfer legs are not blocked, only audited', () => {
  // The insert-side trigger cannot police edits without blocking legitimate two-leg edits, so
  // the domain layer (Phase 3 updateTransfer) is the only sanctioned edit path. These tests pin
  // down exactly what the DB does NOT prevent, and that the audit catches each case.
  it('editing one leg, or soft-deleting one leg, succeeds at the DB but audits 4/5 flag it', () => {
    const { sqlite, db } = makeEnforcingDb();
    const a = createTransfer(db, {
      occurredAt: NOW,
      from: { accountId: ACC.chase, currency: 'USD', amountNative: 1000 },
      to: { accountId: ACC.credit, currency: 'USD', amountNative: 1000 },
      amountUsd: 1000,
      now: NOW,
      newId: counter(),
    });
    sqlite.prepare(`UPDATE transactions SET amount_native = 900, amount_usd = 900 WHERE id = ?`).run(a.legIds[1]);
    expect(keys(flagged(sqlite, 5), 'transfer_group_id')).toEqual([a.groupId]);

    sqlite.prepare(`UPDATE transactions SET amount_native = 1000, amount_usd = 1000 WHERE id = ?`).run(a.legIds[1]);
    expect(flagged(sqlite, 5)).toEqual([]);
    sqlite.prepare(`UPDATE transactions SET deleted_at = ? WHERE id = ?`).run(NOW, a.legIds[0]);
    expect(keys(flagged(sqlite, 4), 'transfer_group_id')).toEqual([a.groupId]);
  });
});

// ---------------------------------------------------------------------------------------
// Layer 2: audit. With every constraint stripped, each invariant query still catches bad data
// and leaves good data alone. This proves the queries themselves, and the schema-check skill.
// ---------------------------------------------------------------------------------------
describe('audit queries catch corrupt data on an unconstrained database', () => {
  it('a clean, varied fixture passes every invariant', () => {
    const { sqlite, db } = makeUnconstrainedDb();
    insertPerson(sqlite, 'p-1', 'Pramod');
    insertTx(sqlite); // expense
    insertTx(sqlite, { type: 'income', amount_native: 5000, amount_usd: 5000, category_id: CAT.salary });
    insertTx(sqlite, { category_id: CAT.lend, person_id: 'p-1' });
    insertTx(sqlite, inr());
    createTransfer(db, {
      occurredAt: NOW,
      from: { accountId: ACC.chase, currency: 'USD', amountNative: 10000 },
      to: { accountId: ACC.loan, currency: 'INR', amountNative: 835000 },
      amountUsd: 10000,
      now: NOW,
      newId: counter(),
    });
    const results = runInvariants((s) => rowsOf(sqlite, s));
    expect(results).toHaveLength(INVARIANTS.length);
    expect(results.filter((r) => !r.passed)).toEqual([]);
  });

  it('invariant 1', () => {
    const { sqlite } = makeUnconstrainedDb();
    const bad = [
      insertTx(sqlite, { amount_native: 1000, amount_usd: 1000 }),
      insertTx(sqlite, { category_id: null }),
      insertTx(sqlite, { category_id: CAT.salary }),
    ];
    insertTx(sqlite); // good
    expect(keys(flagged(sqlite, 1))).toEqual(sorted(bad));
  });

  it('invariant 2', () => {
    const { sqlite } = makeUnconstrainedDb();
    const income = { type: 'income', amount_native: 5000, amount_usd: 5000, category_id: CAT.salary };
    const bad = [
      insertTx(sqlite, { ...income, amount_native: -5000, amount_usd: -5000 }),
      insertTx(sqlite, { ...income, category_id: null }),
      insertTx(sqlite, { ...income, category_id: CAT.food }),
    ];
    insertTx(sqlite, income); // good
    expect(keys(flagged(sqlite, 2))).toEqual(sorted(bad));
  });

  it('invariant 3', () => {
    const { sqlite } = makeUnconstrainedDb();
    const bad = [
      insertTx(sqlite, transferLeg('g', -1000, { category_id: CAT.food })),
      insertTx(sqlite, transferLeg('g', 1000, { transfer_group_id: null })),
    ];
    insertTx(sqlite, transferLeg('ok', -1000));
    expect(keys(flagged(sqlite, 3))).toEqual(sorted(bad));
  });

  it('invariant 4: lone leg, three legs, and a group with one leg soft-deleted', () => {
    const { sqlite } = makeUnconstrainedDb();
    insertTx(sqlite, transferLeg('g-lone', -1000));
    insertTx(sqlite, transferLeg('g-three', -1000));
    insertTx(sqlite, transferLeg('g-three', 500));
    insertTx(sqlite, transferLeg('g-three', 500));
    insertTx(sqlite, transferLeg('g-half-deleted', -1000));
    insertTx(sqlite, transferLeg('g-half-deleted', 1000, { deleted_at: NOW }));
    insertTx(sqlite, transferLeg('g-ok', -1000));
    insertTx(sqlite, transferLeg('g-ok', 1000));
    expect(keys(flagged(sqlite, 4), 'transfer_group_id')).toEqual(['g-half-deleted', 'g-lone', 'g-three']);
  });

  it('invariant 5: unbalanced groups are flagged, soft-deleted legs are ignored', () => {
    const { sqlite } = makeUnconstrainedDb();
    insertTx(sqlite, transferLeg('g-unbalanced', -1000));
    insertTx(sqlite, transferLeg('g-unbalanced', 900));
    insertTx(sqlite, transferLeg('g-ok', -1000));
    insertTx(sqlite, transferLeg('g-ok', 1000));
    insertTx(sqlite, transferLeg('g-ignores-deleted', -1000));
    insertTx(sqlite, transferLeg('g-ignores-deleted', 1000));
    insertTx(sqlite, transferLeg('g-ignores-deleted', 50, { deleted_at: NOW }));
    expect(flagged(sqlite, 5)).toEqual([{ transfer_group_id: 'g-unbalanced', usd_sum: -100 }]);
  });

  it('invariant 6', () => {
    const { sqlite } = makeUnconstrainedDb();
    const bad = [insertTx(sqlite, { amount_usd: -1050 }), insertTx(sqlite, { fx_rate: 1.5 })];
    insertTx(sqlite);
    expect(keys(flagged(sqlite, 6))).toEqual(sorted(bad));
  });

  it('invariant 7: flags bad rates, tolerates exactly 1 minor unit of drift', () => {
    const { sqlite } = makeUnconstrainedDb();
    const bad = [
      insertTx(sqlite, inr({ fx_rate: 0 })),
      insertTx(sqlite, inr({ fx_rate: -83.5 })),
      insertTx(sqlite, inr({ fx_rate: 90 })),
      insertTx(sqlite, inr({ amount_usd: -102 })),
    ];
    insertTx(sqlite, inr()); // exact
    insertTx(sqlite, inr({ amount_usd: -101 })); // off by exactly 1
    expect(keys(flagged(sqlite, 7))).toEqual(sorted(bad));
  });

  it('invariant 8', () => {
    const { sqlite } = makeUnconstrainedDb();
    const bad = [
      insertTx(sqlite, inr({ amount_usd: 100 })),
      insertTx(sqlite, { amount_native: -1000, amount_usd: 0 }),
    ];
    insertTx(sqlite);
    expect(keys(flagged(sqlite, 8))).toEqual(sorted(bad));
  });

  it('invariant 9', () => {
    const { sqlite } = makeUnconstrainedDb();
    insertCategory(sqlite, { id: 'c-deep', name: 'Deep', parent_id: CAT.groceries });
    insertCategory(sqlite, { id: 'c-ok', name: 'Restaurants', parent_id: CAT.food });
    expect(keys(flagged(sqlite, 9))).toEqual(['c-deep']);
  });

  it('invariant 10', () => {
    const { sqlite } = makeUnconstrainedDb();
    insertPerson(sqlite, 'p-1', 'Pramod');
    const bad = [
      insertTx(sqlite, { person_id: 'p-1', category_id: CAT.food }),
      insertTx(sqlite, transferLeg('g', -1000, { person_id: 'p-1' })),
    ];
    insertTx(sqlite, { person_id: 'p-1', category_id: CAT.lend });
    expect(keys(flagged(sqlite, 10))).toEqual(sorted(bad));
  });

  it('invariant 11', () => {
    const { sqlite } = makeUnconstrainedDb();
    const a = insertTx(sqlite, { account_id: 'ghost' });
    const c = insertTx(sqlite, { category_id: 'ghost' });
    const p = insertTx(sqlite, { person_id: 'ghost', category_id: CAT.lend });
    insertTx(sqlite);
    expect(flagged(sqlite, 11).sort((x, y) => String(x.id).localeCompare(String(y.id)))).toEqual(
      [
        { id: a, missing: 'account', ref: 'ghost' },
        { id: c, missing: 'category', ref: 'ghost' },
        { id: p, missing: 'person', ref: 'ghost' },
      ].sort((x, y) => x.id.localeCompare(y.id)),
    );
  });

  it('extra 12: floats/text in money columns and a non-numeric fx_rate are flagged', () => {
    const { sqlite } = makeUnconstrainedDb();
    const f = insertTx(sqlite, { amount_native: -12.5, amount_usd: -12.5 });
    const t = insertTx(sqlite, { amount_native: 'abc' });
    // Review finding 3: this row slips through audit 7 (NULL), so audit 12 must catch it.
    const fx = insertTx(sqlite, inr({ fx_rate: 'abc' }));
    sqlite.prepare(`UPDATE accounts SET opening_balance_native = 10.5 WHERE id = ?`).run(ACC.cash);
    insertTx(sqlite);
    insertTx(sqlite, inr());
    const rows = flagged(sqlite, 12);
    const cell = (r: Row) => `${r.tbl}:${r.id}:${r.col}:${r.stored}`;
    expect(rows.map(cell).sort()).toEqual(
      [
        `transactions:${f}:amount_native:real`,
        `transactions:${f}:amount_usd:real`,
        `transactions:${t}:amount_native:text`,
        `transactions:${fx}:fx_rate:text`,
        `accounts:${ACC.cash}:opening_balance_native:real`,
      ].sort(),
    );
    // and confirm the premise: audit 7 alone does NOT see the text fx_rate row
    expect(keys(flagged(sqlite, 7))).not.toContain(fx);
  });

  it('extra 13: group id on a non-transfer row, and zero-amount transfer legs', () => {
    const { sqlite } = makeUnconstrainedDb();
    const bad = [
      insertTx(sqlite, { transfer_group_id: 'g' }), // expense carrying a group id
      insertTx(sqlite, { type: 'income', category_id: CAT.salary, amount_native: 1000, amount_usd: 1000, transfer_group_id: 'g' }),
      insertTx(sqlite, transferLeg('z', 0)),
    ];
    insertTx(sqlite, transferLeg('ok', -1000));
    expect(keys(flagged(sqlite, 13))).toEqual(sorted(bad));
    // Review finding 1: the mixed group passes audits 3, 4 and 5 by themselves.
    insertTx(sqlite, transferLeg('mixed', -1000));
    insertTx(sqlite, { type: 'income', category_id: CAT.salary, amount_native: 1000, amount_usd: 1000, transfer_group_id: 'mixed' });
    expect(keys(flagged(sqlite, 4), 'transfer_group_id')).not.toContain('mixed');
    expect(keys(flagged(sqlite, 5), 'transfer_group_id')).not.toContain('mixed');
    expect(flagged(sqlite, 13).some((r) => r.transfer_group_id === 'mixed')).toBe(true);
  });

  it('extra 14: same-account legs and same-currency native mismatches', () => {
    const { sqlite } = makeUnconstrainedDb();
    insertTx(sqlite, transferLeg('same-acct', -1000, { account_id: ACC.chase }));
    insertTx(sqlite, transferLeg('same-acct', 1000, { account_id: ACC.chase }));
    insertTx(sqlite, transferLeg('inr-inr', -10000, { account_id: ACC.loan, currency: 'INR', amount_usd: -120, fx_rate: 10000 / 120 }));
    insertTx(sqlite, transferLeg('inr-inr', 20000, { account_id: ACC.loan2, currency: 'INR', amount_usd: 120, fx_rate: 20000 / 120 }));
    // controls: cross-currency, an equal INR pair, and a pair whose mismatching leg is soft-deleted
    insertTx(sqlite, transferLeg('usd-inr', -10000, { account_id: ACC.chase }));
    insertTx(sqlite, transferLeg('usd-inr', 835000, { account_id: ACC.loan, currency: 'INR', amount_usd: 10000, fx_rate: 83.5 }));
    insertTx(sqlite, transferLeg('inr-ok', -8350, { account_id: ACC.loan, currency: 'INR', amount_usd: -100, fx_rate: 83.5 }));
    insertTx(sqlite, transferLeg('inr-ok', 8350, { account_id: ACC.loan2, currency: 'INR', amount_usd: 100, fx_rate: 83.5 }));
    insertTx(sqlite, transferLeg('deleted-mismatch', -1000, { account_id: ACC.chase }));
    insertTx(sqlite, transferLeg('deleted-mismatch', 1000, { account_id: ACC.chase, deleted_at: NOW }));
    expect(keys(flagged(sqlite, 14), 'transfer_group_id')).toEqual(['inr-inr', 'same-acct']);
  });

  it('extra 16: subcategory of a different kind than its parent', () => {
    const { sqlite } = makeUnconstrainedDb();
    insertCategory(sqlite, { id: 'c-bad', name: 'Bad', kind: 'income', parent_id: CAT.food });
    insertCategory(sqlite, { id: 'c-ok', name: 'Bonus', kind: 'income', parent_id: CAT.salary });
    expect(keys(flagged(sqlite, 16))).toEqual(['c-bad']);
  });

  it('extra 15: currency codes', () => {
    const { sqlite } = makeUnconstrainedDb();
    const bad = [
      insertTx(sqlite, { currency: 'usd', amount_native: -1000, amount_usd: -500, fx_rate: 2 }),
      insertTx(sqlite, { currency: '' }),
      insertTx(sqlite, { currency: 'USDT' }),
    ];
    sqlite.prepare(`UPDATE accounts SET currency = 'inr' WHERE id = ?`).run(ACC.loan2);
    insertTx(sqlite);
    const rows = flagged(sqlite, 15);
    expect(keys(rows.filter((r) => r.tbl === 'transactions'))).toEqual(sorted(bad));
    expect(keys(rows.filter((r) => r.tbl === 'accounts'))).toEqual([ACC.loan2]);
  });
});
