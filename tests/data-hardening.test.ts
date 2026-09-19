import { describe, expect, it } from 'vitest';
import {
  accountBalances, archiveAccount, archiveCategory, archivePerson, balanceSeries, cashFlow, categoryBreakdown, createAccount,
  createCategory, createExpense, createIncome, createPerson, createTransferBetween, dailySummary, deleteEntry, ensurePerson,
  listPeople, listTransactions, monthRange, totalBalanceCents, unarchivePerson, updateAccount, updateCategory, updateEntry,
  updateTransfer, MAX_CENTS,
} from '../src/data';
import { HEADER } from '../src/import/trackwallet';
import { ImportNeedsConfirmationError } from '../src/import/commit';
import { applyImport, previewImport } from '../src/import/service';
import { ACC, CAT, NOW, expectData, failedInvariants, makeDataDb, rows, type DataHandle } from './data-helpers';

const T = '2026-08-10T09:30:00';
const base = { occurredAt: T, accountId: ACC.cash, amountCents: 500, categoryId: CAT.leisure };
const legs = (h: DataHandle, group: string) =>
  rows(h, `SELECT id, account_id AS a, amount_usd AS u, note, occurred_at AS at FROM transactions WHERE transfer_group_id = '${group}' ORDER BY amount_usd`);

// ---------------------------------------------------------------------------------------------
describe('transfers keep each leg\'s own note, and damaged groups are reported, not repaired', () => {
  it('editing the amount leaves per-leg notes alone; setting a note applies to both', () => {
    const h = makeDataDb();
    const { groupId, legIds } = createTransferBetween(h.ctx, { occurredAt: T, fromAccountId: ACC.chase, toAccountId: ACC.credit, amountCents: 10000 });
    // an imported pair can carry a different note on each leg
    h.sqlite.prepare(`UPDATE transactions SET note = 'from cash' WHERE id = ?`).run(legIds[0]);
    h.sqlite.prepare(`UPDATE transactions SET note = 'to savings' WHERE id = ?`).run(legIds[1]);
    updateTransfer(h.ctx, groupId, { amountCents: 6000 });
    expect(legs(h, groupId).map((l) => [l.u, l.note])).toEqual([[-6000, 'from cash'], [6000, 'to savings']]);
    updateTransfer(h.ctx, groupId, { note: 'card payment' });
    expect(legs(h, groupId).map((l) => l.note)).toEqual(['card payment', 'card payment']);
    updateTransfer(h.ctx, groupId, { note: null });
    expect(legs(h, groupId).map((l) => l.note)).toEqual([null, null]);
  });

  it('refuses a group with one live leg, or legs that do not balance, and changes nothing', () => {
    const h = makeDataDb();
    const a = createTransferBetween(h.ctx, { occurredAt: T, fromAccountId: ACC.chase, toAccountId: ACC.credit, amountCents: 10000 });
    h.sqlite.prepare(`UPDATE transactions SET deleted_at = ? WHERE id = ?`).run(NOW, a.legIds[1]); // one leg gone
    const before = legs(h, a.groupId);
    expectData(() => updateTransfer(h.ctx, a.groupId, { amountCents: 5 }), 'conflict', /damaged: it has 1 live legs/);
    expect(legs(h, a.groupId)).toEqual(before);

    const b = createTransferBetween(h.ctx, { occurredAt: T, fromAccountId: ACC.chase, toAccountId: ACC.credit, amountCents: 10000 });
    h.sqlite.prepare(`UPDATE transactions SET amount_native = 9000, amount_usd = 9000 WHERE id = ?`).run(b.legIds[1]); // -100.00 / +90.00
    const beforeB = legs(h, b.groupId);
    expectData(() => updateTransfer(h.ctx, b.groupId, { note: 'x' }), 'conflict', /do not balance/);
    expect(legs(h, b.groupId)).toEqual(beforeB); // NOT silently "repaired" to the outgoing amount
    expectData(() => updateTransfer(h.ctx, 'never-existed', {}), 'not_found');
  });

  it('refuses null for accounts and time instead of silently keeping the old value', () => {
    const h = makeDataDb();
    const { groupId } = createTransferBetween(h.ctx, { occurredAt: T, fromAccountId: ACC.chase, toAccountId: ACC.credit, amountCents: 100 });
    expectData(() => updateTransfer(h.ctx, groupId, { fromAccountId: null as never }), 'invalid', /cannot be cleared/);
    expectData(() => updateTransfer(h.ctx, groupId, { toAccountId: null as never }), 'invalid', /cannot be cleared/);
    expectData(() => updateTransfer(h.ctx, groupId, { occurredAt: null as never }), 'invalid');
  });
});

// ---------------------------------------------------------------------------------------------
describe('entry edits', () => {
  it('refuse null for required fields, and refuse to rewrite a non-USD row', () => {
    const h = makeDataDb();
    const e = createExpense(h.ctx, base);
    for (const field of ['occurredAt', 'accountId', 'amountCents', 'categoryId'] as const) {
      expectData(() => updateEntry(h.ctx, e.id, { [field]: null } as never), 'invalid', /cannot be cleared/);
    }
    expect(updateEntry(h.ctx, e.id, { merchant: null, note: null }).merchant).toBeNull(); // clearable fields still clear

    h.sqlite.prepare(`INSERT INTO accounts (id, name, type, currency, created_at, updated_at) VALUES ('inr', 'India', 'bank', 'INR', ?, ?)`).run(NOW, NOW);
    h.sqlite.prepare(
      `INSERT INTO transactions (id, occurred_at, type, account_id, currency, amount_native, amount_usd, fx_rate, category_id, created_at, updated_at)
       VALUES ('foreign', ?, 'expense', 'inr', 'INR', -150, -1, 100, ?, ?, ?)`,
    ).run(T, CAT.leisure, NOW, NOW);
    expectData(() => updateEntry(h.ctx, 'foreign', { note: 'edit' }), 'invalid', /only USD entries/);
    expect(rows(h, `SELECT amount_native AS n FROM transactions WHERE id = 'foreign'`)).toEqual([{ n: -150 }]); // untouched
  });

  it('cannot move an entry into a subcategory whose PARENT is archived', () => {
    const h = makeDataDb();
    const e = createExpense(h.ctx, base);
    h.sqlite.prepare(`UPDATE categories SET archived_at = ? WHERE id = ?`).run(NOW, CAT.food); // parent archived, child left live
    expectData(() => createExpense(h.ctx, { ...base, categoryId: CAT.groceries }), 'invalid', /parent of "Groceries"\) is archived/);
    expectData(() => updateEntry(h.ctx, e.id, { categoryId: CAT.groceries }), 'invalid', /is archived/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('amounts are bounded so sums stay exact', () => {
  it('accepts the largest amount and refuses one cent more, for entries, transfers and balances', () => {
    const h = makeDataDb();
    expect(createIncome(h.ctx, { ...base, categoryId: CAT.salary, amountCents: MAX_CENTS }).amountUsd).toBe(MAX_CENTS);
    expectData(() => createIncome(h.ctx, { ...base, categoryId: CAT.salary, amountCents: MAX_CENTS + 1 }), 'invalid', /too large/);
    expectData(() => createTransferBetween(h.ctx, { occurredAt: T, fromAccountId: ACC.chase, toAccountId: ACC.credit, amountCents: MAX_CENTS + 1 }), 'invalid', /too large/);
    expectData(() => createAccount(h.ctx, { name: 'Big', type: 'bank', openingBalanceCents: MAX_CENTS + 1 }), 'invalid', /too large/);
    expectData(() => updateAccount(h.ctx, ACC.cash, { openingBalanceCents: -MAX_CENTS - 1 }), 'invalid', /too large/);
    // two maximum incomes still add exactly (this overflowed a JS number before the cap)
    createIncome(h.ctx, { ...base, categoryId: CAT.salary, amountCents: MAX_CENTS });
    expect(totalBalanceCents(h.ctx)).toBe(2 * MAX_CENTS);
    expect(Number.isSafeInteger(totalBalanceCents(h.ctx))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('input hygiene', () => {
  it('validates sortOrder on create, and rejects a non-boolean peopleBacked and an empty parentId', () => {
    const h = makeDataDb();
    for (const bad of [Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      expectData(() => createAccount(h.ctx, { name: `A${String(bad)}`, type: 'cash', sortOrder: bad }), 'invalid', /sort order/);
    }
    expectData(() => createCategory(h.ctx, { name: 'X', kind: 'expense', peopleBacked: 'false' as never }), 'invalid', /true or false/);
    expectData(() => updateCategory(h.ctx, CAT.leisure, { peopleBacked: 'no' as never }), 'invalid', /true or false/);
    expectData(() => createCategory(h.ctx, { name: 'X', kind: 'expense', parentId: '' }), 'not_found'); // no longer silently top-level
  });

  it('rejects a name made only of invisible characters, but accepts real names', () => {
    const h = makeDataDb();
    const invisible = [0x200b, 0x200d, 0x2060, 0xfeff].map((c) => String.fromCharCode(c)).join('');
    expectData(() => createPerson(h.ctx, { name: invisible }), 'invalid', /visible character/);
    expectData(() => createAccount(h.ctx, { name: ` ${invisible} `, type: 'cash' }), 'invalid', /visible character/);
    expect(createPerson(h.ctx, { name: `${invisible}UPS` }).name).toContain('UPS');
    expect(createPerson(h.ctx, { name: '🏠 Rent' }).name).toBe('🏠 Rent');
  });

  it('a clash with an archived name says it is archived; typing an archived name brings it back', () => {
    const h = makeDataDb();
    const p = createPerson(h.ctx, { name: 'India' });
    archivePerson(h.ctx, p.id);
    expectData(() => createPerson(h.ctx, { name: 'india' }), 'conflict', /already in the list \(archived\)/);
    const back = ensurePerson(h.ctx, 'INDIA');
    expect(back.id).toBe(p.id);
    expect(back.archivedAt).toBeNull();
    expect(listPeople(h.ctx).map((x) => x.name)).toEqual(['India']);
    // and it can be used immediately
    expect(createIncome(h.ctx, { ...base, categoryId: CAT.taken, personId: back.id }).personId).toBe(p.id);

    archiveAccount(h.ctx, ACC.cash);
    expectData(() => createAccount(h.ctx, { name: 'cash', type: 'cash' }), 'conflict', /\(archived\)/);
    archiveCategory(h.ctx, CAT.leisure);
    expectData(() => createCategory(h.ctx, { name: 'LEISURE', kind: 'expense' }), 'conflict', /\(archived\)/);
    unarchivePerson(h.ctx, p.id);
  });

  it('will not switch on people-backed while transactions in the category carry a merchant', () => {
    const h = makeDataDb();
    createExpense(h.ctx, { ...base, merchant: 'Amazon' });
    expectData(() => updateCategory(h.ctx, CAT.leisure, { peopleBacked: true }), 'conflict', /have a merchant/);
    expect(updateCategory(h.ctx, 'cat-exp-transport', { peopleBacked: true }).peopleBacked).toBe(1); // untouched category: fine
  });

  it('will not add a subcategory under an archived parent', () => {
    const h = makeDataDb();
    archiveCategory(h.ctx, CAT.food);
    expectData(() => createCategory(h.ctx, { name: 'zzz', parentId: CAT.food }), 'invalid', /archived: restore it/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('lists: empty selections, paging and filters', () => {
  function fixture() {
    const h = makeDataDb();
    for (let i = 1; i <= 7; i++) {
      // several rows share a timestamp: paging must still be stable
      createExpense(h.ctx, { ...base, occurredAt: `2026-08-1${i % 3}T10:00:00`, amountCents: 100 * i, merchant: `m${i}` });
    }
    return h;
  }

  it('an empty account or type selection shows nothing, not everything', () => {
    const h = fixture();
    expect(listTransactions(h.ctx)).toHaveLength(7);
    expect(listTransactions(h.ctx, { accountIds: [] })).toEqual([]);
    expect(listTransactions(h.ctx, { types: [] })).toEqual([]);
    expect(listTransactions(h.ctx, { accountIds: [ACC.cash] })).toHaveLength(7);
    expect(listTransactions(h.ctx, { categoryId: '' })).toEqual([]);
    expect(listTransactions(h.ctx, { personId: '' })).toEqual([]);
  });

  it('paging works with or without a limit, is stable across equal timestamps, and validates its inputs', () => {
    const h = fixture();
    const all = listTransactions(h.ctx).map((t) => t.id);
    const paged = [
      ...listTransactions(h.ctx, { limit: 3, offset: 0 }),
      ...listTransactions(h.ctx, { limit: 3, offset: 3 }),
      ...listTransactions(h.ctx, { limit: 3, offset: 6 }),
    ].map((t) => t.id);
    expect(paged).toEqual(all); // identical order, nothing skipped or repeated
    expect(listTransactions(h.ctx, { offset: 2 }).map((t) => t.id)).toEqual(all.slice(2)); // offset alone used to crash
    expect(listTransactions(h.ctx, { limit: 0 })).toEqual([]);
    for (const bad of [1.5, -1, Number.NaN]) {
      expectData(() => listTransactions(h.ctx, { limit: bad }), 'invalid', /limit/);
      expectData(() => listTransactions(h.ctx, { offset: bad }), 'invalid', /offset/);
    }
  });

  it('shows the counterpart of deleted transfers when deleted rows are included', () => {
    const h = makeDataDb();
    const { groupId } = createTransferBetween(h.ctx, { occurredAt: T, fromAccountId: ACC.chase, toAccountId: ACC.credit, amountCents: 5000 });
    h.sqlite.prepare(`UPDATE transactions SET deleted_at = ? WHERE transfer_group_id = ?`).run(NOW, groupId);
    expect(listTransactions(h.ctx)).toEqual([]);
    const shown = listTransactions(h.ctx, { includeDeleted: true });
    expect(shown.map((t) => [t.accountName, t.counterpartAccountName])).toEqual(
      expect.arrayContaining([['Chase Bank Account', 'Credit'], ['Credit', 'Chase Bank Account']]),
    );
  });

  it('handles more transfers than a single database query could look up', () => {
    const h = makeDataDb();
    for (let i = 0; i < 620; i++) {
      createTransferBetween(h.ctx, { occurredAt: `2026-08-01T10:${String(i % 60).padStart(2, '0')}:00`, fromAccountId: ACC.chase, toAccountId: ACC.credit, amountCents: 1 + i });
    }
    const all = listTransactions(h.ctx, { types: ['transfer'] });
    expect(all).toHaveLength(1240);
    expect(all.every((t) => t.counterpartAccountName !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe('summaries and balances: edge behaviour', () => {
  function fixture() {
    const h = makeDataDb();
    updateAccount(h.ctx, ACC.cash, { openingBalanceCents: 5000 });
    createExpense(h.ctx, { ...base, occurredAt: '2026-08-02T10:00', accountId: ACC.credit, amountCents: 1000, categoryId: CAT.groceries });
    createExpense(h.ctx, { ...base, occurredAt: '2026-08-03T10:00', accountId: ACC.cash, amountCents: 300, categoryId: CAT.leisure });
    createIncome(h.ctx, { ...base, occurredAt: '2026-08-04T10:00', accountId: ACC.chase, amountCents: 20000, categoryId: CAT.salaryDenim });
    createTransferBetween(h.ctx, { occurredAt: '2026-08-04T12:00', fromAccountId: ACC.chase, toAccountId: ACC.cash, amountCents: 700 });
    return h;
  }

  it('an empty account selection means nothing, for every summary', () => {
    const h = fixture();
    const aug = monthRange(2026, 8);
    expect(cashFlow(h.ctx, aug, { accountIds: [] })).toEqual({ incomeCents: 0, expenseCents: 0, netCents: 0 });
    expect(categoryBreakdown(h.ctx, 'expense', aug, { accountIds: [] })).toEqual([]);
    expect(dailySummary(h.ctx, aug, { accountIds: [] })).toEqual([]);
    expect(cashFlow(h.ctx, aug)).toMatchObject({ incomeCents: 20000, expenseCents: 1300 }); // unfiltered still sees everything
  });

  it('a non-empty account filter returns the right non-empty figures', () => {
    const h = fixture();
    const aug = monthRange(2026, 8);
    expect(cashFlow(h.ctx, aug, { accountIds: [ACC.cash] })).toEqual({ incomeCents: 0, expenseCents: 300, netCents: -300 });
    expect(categoryBreakdown(h.ctx, 'expense', aug, { accountIds: [ACC.credit] }).map((c) => [c.name, c.totalCents])).toEqual([['Food & Drinks', 1000]]);
    expect(categoryBreakdown(h.ctx, 'income', aug, { accountIds: [ACC.chase] }).map((c) => [c.name, c.totalCents])).toEqual([['Salary', 20000]]);
    expect(dailySummary(h.ctx, aug, { accountIds: [ACC.chase] })).toEqual([{ date: '2026-08-04', incomeCents: 20000, expenseCents: 0, hasTransfer: true }]);
  });

  it('archived categories, and archived parents, still appear in a breakdown of the period they were used in', () => {
    const h = fixture();
    archiveCategory(h.ctx, CAT.leisure);
    archiveCategory(h.ctx, CAT.food);
    const out = categoryBreakdown(h.ctx, 'expense', monthRange(2026, 8));
    expect(out.map((c) => [c.name, c.totalCents])).toEqual([['Food & Drinks', 1000], ['Leisure', 300]]);
    expect(out[0].children.map((c) => c.name)).toEqual(['Groceries']);
  });

  it('a deleted transfer neither counts nor marks the calendar day', () => {
    const h = fixture();
    h.sqlite.prepare(`UPDATE transactions SET deleted_at = ? WHERE type = 'transfer'`).run(NOW);
    expect(dailySummary(h.ctx, monthRange(2026, 8)).find((d) => d.date === '2026-08-04')).toEqual({ date: '2026-08-04', incomeCents: 20000, expenseCents: 0, hasTransfer: false });
  });

  it('an account with no transactions, or only deleted ones, shows exactly its opening balance', () => {
    const h = fixture();
    const idle = createAccount(h.ctx, { name: 'Idle', type: 'bank', openingBalanceCents: 4242 });
    const gone = createAccount(h.ctx, { name: 'Gone', type: 'bank', openingBalanceCents: -900 });
    const e = createExpense(h.ctx, { ...base, accountId: gone.id, amountCents: 77 });
    deleteEntry(h.ctx, e.id);
    const b = Object.fromEntries(accountBalances(h.ctx).map((x) => [x.accountId, x.balanceCents]));
    expect(b[idle.id]).toBe(4242);
    expect(b[gone.id]).toBe(-900);
  });

  it('the series without archived accounts agrees with the total for every day, including after the account had activity', () => {
    const h = fixture();
    createExpense(h.ctx, { ...base, occurredAt: '2026-08-05T10:00', accountId: ACC.cash, amountCents: 111, categoryId: CAT.leisure });
    archiveAccount(h.ctx, ACC.cash);
    const series = balanceSeries(h.ctx, { from: '2026-08-01', to: '2026-08-08' }, { includeArchived: false });
    for (const p of series) {
      expect(p.totalCents, p.date).toBe(totalBalanceCents(h.ctx, { asOfDate: p.date, includeArchived: false }));
    }
    // and it really is different from the version that keeps the archived account
    const withAll = balanceSeries(h.ctx, { from: '2026-08-05', to: '2026-08-05' });
    expect(withAll[0].totalCents).not.toBe(series[4].totalCents);
  });

  it('refuses a total or series when a foreign-currency transaction sits on a USD account', () => {
    const h = fixture();
    h.sqlite.pragma('ignore_check_constraints = ON');
    h.sqlite.prepare(
      `INSERT INTO transactions (id, occurred_at, type, account_id, currency, amount_native, amount_usd, fx_rate, category_id, created_at, updated_at)
       VALUES ('odd', '2026-08-06T10:00:00', 'expense', ?, 'INR', -8350, -100, 83.5, ?, ?, ?)`,
    ).run(ACC.cash, CAT.leisure, NOW, NOW);
    expectData(() => totalBalanceCents(h.ctx), 'invalid', /is in INR/);
    expectData(() => balanceSeries(h.ctx, { from: '2026-08-01', to: '2026-08-07' }), 'invalid', /is in INR/);
  });

  it('a random mix of days and times keeps the series and the total in agreement', () => {
    const h = makeDataDb();
    let s = 99;
    const rnd = (k: number) => Math.floor((s = (s * 1103515245 + 12345) & 0x7fffffff) / 65536) % k;
    for (let i = 0; i < 150; i++) {
      const at = `2028-0${2 + rnd(2)}-${String(1 + rnd(28)).padStart(2, '0')}T${String(rnd(24)).padStart(2, '0')}:${String(rnd(60)).padStart(2, '0')}:${String(rnd(60)).padStart(2, '0')}`;
      const acc = [ACC.cash, ACC.chase, ACC.credit][rnd(3)];
      const c = 1 + rnd(9000);
      if (rnd(3) === 0) createIncome(h.ctx, { ...base, occurredAt: at, accountId: acc, amountCents: c, categoryId: CAT.salary });
      else createExpense(h.ctx, { ...base, occurredAt: at, accountId: acc, amountCents: c });
    }
    for (const p of balanceSeries(h.ctx, { from: '2028-02-01', to: '2028-04-05' })) {
      expect(p.totalCents, p.date).toBe(totalBalanceCents(h.ctx, { asOfDate: p.date }));
    }
    expect(failedInvariants(h)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('the import: skipped rows and archived items', () => {
  const header = HEADER.join(',');
  const file = (...lines: string[]) => [header, ...lines].join('\n') + '\n';
  const lone = '"2026-08-03T10:00","Transfer","Cash","USD","-50","-50",,,""';
  const req = (h: DataHandle, csvText: string) => ({ csvText, filename: 'x.csv', newId: h.ctx.newId, now: NOW });

  it('a file whose only content is a skipped row still reaches the gate (it used to return "nothing to import")', () => {
    const h = makeDataDb();
    let error: unknown;
    try { applyImport(h.db, req(h, file(lone))); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(ImportNeedsConfirmationError);
    expect((error as ImportNeedsConfirmationError).needs).toEqual(['skippedRows']);
    // acknowledged, it succeeds and imports nothing, and the plan still lists what was skipped
    const ok = applyImport(h.db, { ...req(h, file(lone)), allowSkips: true });
    expect(ok.result.transactionsInserted).toBe(0);
    expect(ok.plan.skipped).toHaveLength(1);
  });

  it('still imports history into an archived account, category or name, and says so in the plan', () => {
    const h = makeDataDb();
    const p = createPerson(h.ctx, { name: 'Zed' });
    archiveAccount(h.ctx, ACC.cash);
    archiveCategory(h.ctx, CAT.leisure);
    archivePerson(h.ctx, p.id);
    const csv = file(
      '"2026-08-01T10:00","Expense","Cash","USD","-5","-5","Leisure","","Arcade"',
      '"2026-08-02T10:00","Expense","Cash","USD","-7","-7","Lend","","Zed"',
    );
    const plan = previewImport(h.db, req(h, csv));
    expect(plan.issues).toEqual([]);
    expect(plan.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining('account "Cash" is archived'),
        expect.stringContaining('category "Leisure" is archived'),
        expect.stringContaining('name "Zed" is archived'),
      ]),
    );
    expect(plan.warnings.filter((w) => w.includes('account "Cash"'))).toHaveLength(1); // once, not per row
    applyImport(h.db, req(h, csv));
    expect(rows(h, 'SELECT COUNT(*) AS n FROM transactions')).toEqual([{ n: 2 }]);
  });
});
