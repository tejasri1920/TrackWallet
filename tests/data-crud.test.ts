import { describe, expect, it } from 'vitest';
import {
  archiveAccount, archiveCategory, archivePerson, createAccount, createCategory, createExpense, createIncome,
  createPerson, createTransferBetween, deleteCategory, deleteEntry, deletePerson, deleteTransfer, ensurePerson,
  getAccount, getCategory, getPerson, getTransaction, listAccounts, listCategoryTree, listPeople, listTransactions,
  unarchiveAccount, unarchiveCategory, unarchivePerson, updateAccount, updateCategory, updateEntry, updatePerson,
  updateTransfer, accountBalances,
} from '../src/data';
import { ACC, CAT, expectData, failedInvariants, makeDataDb, rows } from './data-helpers';

const T = '2026-08-10T09:30:00';
const balanceOf = (h: ReturnType<typeof makeDataDb>, id: string) => accountBalances(h.ctx).find((b) => b.accountId === id)!.balanceCents;

// ---------------------------------------------------------------------------------------------
describe('accounts', () => {
  it('creates a USD account with sensible defaults and trims the name', () => {
    const h = makeDataDb();
    const a = createAccount(h.ctx, { name: '  Savings  ', type: 'bank' });
    expect(a).toMatchObject({ name: 'Savings', type: 'bank', currency: 'USD', openingBalanceNative: 0, sortOrder: 3, archivedAt: null });
    expect(listAccounts(h.ctx).map((x) => x.name)).toEqual(['Credit', 'Chase Bank Account', 'Cash', 'Savings']);
  });

  it('accepts a negative opening balance (a card) and shows it as the starting balance', () => {
    const h = makeDataDb();
    const a = createAccount(h.ctx, { name: 'Visa', type: 'credit', openingBalanceCents: -123456 });
    expect(balanceOf(h, a.id)).toBe(-123456);
  });

  it('rejects bad input with clear errors', () => {
    const h = makeDataDb();
    expectData(() => createAccount(h.ctx, { name: '   ', type: 'cash' }), 'invalid', /cannot be empty/);
    expectData(() => createAccount(h.ctx, { name: 'X', type: 'piggy' as never }), 'invalid', /account type/);
    expectData(() => createAccount(h.ctx, { name: 'X', type: 'cash', openingBalanceCents: 12.5 }), 'invalid', /whole number of cents/);
    expectData(() => createAccount(h.ctx, { name: 'x'.repeat(101), type: 'cash' }), 'invalid', /too long/);
    expectData(() => createAccount(h.ctx, { name: 'cash', type: 'cash' }), 'conflict', /already exists/); // case-insensitive
    expectData(() => getAccount(h.ctx, 'nope'), 'not_found');
  });

  it('updates fields, keeps what is not mentioned, and bumps updated_at', () => {
    const h = makeDataDb();
    h.clock.value = '2026-09-02T08:00:00';
    const a = updateAccount(h.ctx, ACC.cash, { name: 'Wallet', openingBalanceCents: 5000, color: '#00ff00' });
    expect(a).toMatchObject({ name: 'Wallet', openingBalanceNative: 5000, color: '#00ff00', type: 'cash', updatedAt: '2026-09-02T08:00:00' });
    expect(updateAccount(h.ctx, ACC.cash, {})).toEqual(a);
    expectData(() => updateAccount(h.ctx, ACC.cash, { name: 'CREDIT' }), 'conflict');
    expect(updateAccount(h.ctx, ACC.cash, { name: 'WALLET' }).name).toBe('WALLET'); // renaming to its own name in another case is fine
  });

  it('archives without touching history, refuses new entries, and can be restored', () => {
    const h = makeDataDb();
    createExpense(h.ctx, { occurredAt: T, accountId: ACC.cash, amountCents: 1500, categoryId: CAT.leisure });
    archiveAccount(h.ctx, ACC.cash);
    expect(listAccounts(h.ctx).map((a) => a.id)).not.toContain(ACC.cash);
    expect(listAccounts(h.ctx, { includeArchived: true }).map((a) => a.id)).toContain(ACC.cash);
    expect(balanceOf(h, ACC.cash)).toBe(-1500); // its money is still counted
    expectData(() => createExpense(h.ctx, { occurredAt: T, accountId: ACC.cash, amountCents: 100, categoryId: CAT.leisure }), 'invalid', /archived/);
    unarchiveAccount(h.ctx, ACC.cash);
    expect(createExpense(h.ctx, { occurredAt: T, accountId: ACC.cash, amountCents: 100, categoryId: CAT.leisure }).amountUsd).toBe(-100);
    expect(failedInvariants(h)).toEqual([]);
  });

  it('refuses to record against an account that is not USD', () => {
    const h = makeDataDb();
    h.sqlite.prepare(`INSERT INTO accounts (id, name, type, currency, created_at, updated_at) VALUES ('inr', 'India', 'bank', 'INR', ?, ?)`).run(T, T);
    expectData(() => createExpense(h.ctx, { occurredAt: T, accountId: 'inr', amountCents: 100, categoryId: CAT.leisure }), 'invalid', /not in USD/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('people (names used on Lend / Returned / Taken / Repaid)', () => {
  it('adds a name on its own, with an optional note, and lists them case-insensitively sorted', () => {
    const h = makeDataDb();
    createPerson(h.ctx, { name: 'pramod', note: 'roommate' });
    createPerson(h.ctx, { name: 'UPS' });
    createPerson(h.ctx, { name: 'Aakanksha', note: '   ' });
    expect(listPeople(h.ctx).map((p) => p.name)).toEqual(['Aakanksha', 'pramod', 'UPS']);
    expect(listPeople(h.ctx).find((p) => p.name === 'Aakanksha')!.note).toBeNull(); // blank note becomes null
    expect(listPeople(h.ctx).find((p) => p.name === 'pramod')!.note).toBe('roommate');
  });

  it('does not allow the same name twice (ignoring case) and offers ensurePerson', () => {
    const h = makeDataDb();
    const p = createPerson(h.ctx, { name: 'Pramod' });
    expectData(() => createPerson(h.ctx, { name: 'pramod' }), 'conflict', /already in the list/);
    expect(ensurePerson(h.ctx, ' PRAMOD ').id).toBe(p.id);
    expect(ensurePerson(h.ctx, 'India').name).toBe('India');
    expect(listPeople(h.ctx)).toHaveLength(2);
  });

  it('renames, edits the note, and refuses a clash', () => {
    const h = makeDataDb();
    const a = createPerson(h.ctx, { name: 'Sahithi' });
    createPerson(h.ctx, { name: 'Teja' });
    expect(updatePerson(h.ctx, a.id, { name: 'Sahithi R', note: 'friend' })).toMatchObject({ name: 'Sahithi R', note: 'friend' });
    expect(updatePerson(h.ctx, a.id, { note: null }).note).toBeNull();
    expectData(() => updatePerson(h.ctx, a.id, { name: 'teja' }), 'conflict');
  });

  it('archives and restores; an archived name cannot be attached to a new entry', () => {
    const h = makeDataDb();
    const p = createPerson(h.ctx, { name: 'India' });
    archivePerson(h.ctx, p.id);
    expect(listPeople(h.ctx)).toEqual([]);
    expect(listPeople(h.ctx, { includeArchived: true })).toHaveLength(1);
    expectData(() => createIncome(h.ctx, { occurredAt: T, accountId: ACC.chase, amountCents: 100000, categoryId: CAT.taken, personId: p.id }), 'invalid', /archived/);
    unarchivePerson(h.ctx, p.id);
    expect(createIncome(h.ctx, { occurredAt: T, accountId: ACC.chase, amountCents: 100000, categoryId: CAT.taken, personId: p.id }).personId).toBe(p.id);
  });

  it('deletes an unused name, but only archives one that history refers to (even a deleted transaction)', () => {
    const h = makeDataDb();
    const unused = createPerson(h.ctx, { name: 'Nobody' });
    deletePerson(h.ctx, unused.id);
    expectData(() => getPerson(h.ctx, unused.id), 'not_found');

    const used = createPerson(h.ctx, { name: 'Pramod' });
    const t = createExpense(h.ctx, { occurredAt: T, accountId: ACC.chase, amountCents: 35000, categoryId: CAT.lend, personId: used.id });
    expectData(() => deletePerson(h.ctx, used.id), 'conflict', /archive it instead/);
    deleteEntry(h.ctx, t.id); // soft-deleted: the row still refers to the name
    expectData(() => deletePerson(h.ctx, used.id), 'conflict', /1 transaction/);
    expect(failedInvariants(h)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('categories (two levels)', () => {
  it('creates top-level categories and subcategories that inherit the kind', () => {
    const h = makeDataDb();
    const health = createCategory(h.ctx, { name: 'Health', kind: 'expense', icon: 'heart', color: '#f00' });
    const gym = createCategory(h.ctx, { name: 'Gym', parentId: health.id });
    expect(health).toMatchObject({ kind: 'expense', parentId: null, peopleBacked: 0, icon: 'heart' });
    expect(gym).toMatchObject({ kind: 'expense', parentId: health.id });
    expect(failedInvariants(h)).toEqual([]);
  });

  it('enforces the structure rules with clear messages', () => {
    const h = makeDataDb();
    expectData(() => createCategory(h.ctx, { name: 'X' }), 'invalid', /kind must be/);
    expectData(() => createCategory(h.ctx, { name: 'X', kind: 'income', parentId: CAT.food }), 'invalid', /same kind/);
    expectData(() => createCategory(h.ctx, { name: 'X', parentId: CAT.groceries }), 'invalid', /cannot have its own subcategories/);
    expectData(() => createCategory(h.ctx, { name: 'X', parentId: CAT.lend }), 'invalid', /lists people/);
    expectData(() => createCategory(h.ctx, { name: 'X', parentId: CAT.food, peopleBacked: true }), 'invalid', /top-level/);
    expectData(() => createCategory(h.ctx, { name: 'groceries', parentId: CAT.food }), 'conflict', /already exists here/);
    expectData(() => createCategory(h.ctx, { name: 'FOOD & DRINKS', kind: 'expense' }), 'conflict');
    // the same name is fine in another place: another kind, or under another parent
    expect(createCategory(h.ctx, { name: 'Food & Drinks', kind: 'income' }).kind).toBe('income');
    expect(createCategory(h.ctx, { name: 'Groceries', parentId: CAT.shopping }).parentId).toBe(CAT.shopping);
  });

  it('renames, restyles, reorders, and toggles people-backed with guards', () => {
    const h = makeDataDb();
    expect(updateCategory(h.ctx, CAT.leisure, { name: 'Fun', color: '#abc', sortOrder: 99 })).toMatchObject({ name: 'Fun', color: '#abc', sortOrder: 99 });
    expectData(() => updateCategory(h.ctx, CAT.leisure, { name: 'shopping' }), 'conflict');
    expectData(() => updateCategory(h.ctx, CAT.food, { peopleBacked: true }), 'invalid', /either subcategories or people/);
    expectData(() => updateCategory(h.ctx, CAT.groceries, { peopleBacked: true }), 'invalid', /top-level/);
    // clearing people-backed while a transaction names someone under it is refused with a clear message
    const p = createPerson(h.ctx, { name: 'Pramod' });
    createExpense(h.ctx, { occurredAt: T, accountId: ACC.cash, amountCents: 100, categoryId: CAT.lend, personId: p.id });
    expectData(() => updateCategory(h.ctx, CAT.lend, { peopleBacked: false }), 'conflict', /keep listing people/);
    expect(updateCategory(h.ctx, CAT.leisure, { peopleBacked: true }).peopleBacked).toBe(1); // nothing uses a name there yet
  });

  it('lists the tree in order, hides archived ones, and archiving a parent archives its subcategories', () => {
    const h = makeDataDb();
    const tree = listCategoryTree(h.ctx, { kind: 'expense' });
    expect(tree.map((n) => n.category.name)).toEqual([
      'Food & Drinks', 'Shopping', 'Housing', 'Bills', 'Transport', 'Vehicle', 'Leisure', 'Education', 'Lend', 'Repaid', 'Investment', 'Subscriptions',
    ]);
    expect(tree[0].children.map((c) => c.name)).toEqual(['Groceries', 'Snacks']);

    archiveCategory(h.ctx, CAT.food);
    expect(listCategoryTree(h.ctx, { kind: 'expense' }).map((n) => n.category.name)).not.toContain('Food & Drinks');
    expect(getCategory(h.ctx, CAT.groceries).archivedAt).not.toBeNull();
    expectData(() => unarchiveCategory(h.ctx, CAT.groceries), 'invalid', /restore "Food & Drinks" first/);
    unarchiveCategory(h.ctx, CAT.food);
    unarchiveCategory(h.ctx, CAT.groceries);
    expect(listCategoryTree(h.ctx, { kind: 'expense' })[0].children.map((c) => c.name)).toEqual(['Groceries']); // Snacks stays archived
    expect(listCategoryTree(h.ctx, { kind: 'expense', includeArchived: true })[0].children).toHaveLength(2);
  });

  it('will not put a new entry in an archived category, but leaves old entries alone', () => {
    const h = makeDataDb();
    const before = createExpense(h.ctx, { occurredAt: T, accountId: ACC.cash, amountCents: 100, categoryId: CAT.leisure });
    archiveCategory(h.ctx, CAT.leisure);
    expectData(() => createExpense(h.ctx, { occurredAt: T, accountId: ACC.cash, amountCents: 100, categoryId: CAT.leisure }), 'invalid', /archived/);
    expect(updateEntry(h.ctx, before.id, { note: 'still editable' }).note).toBe('still editable'); // unchanged reference
  });

  it('deletes only what nothing uses and that has no subcategories', () => {
    const h = makeDataDb();
    const c = createCategory(h.ctx, { name: 'Temp', kind: 'expense' });
    const sub = createCategory(h.ctx, { name: 'Sub', parentId: c.id });
    expectData(() => deleteCategory(h.ctx, c.id), 'conflict', /1 subcategory/);
    createExpense(h.ctx, { occurredAt: T, accountId: ACC.cash, amountCents: 100, categoryId: sub.id });
    expectData(() => deleteCategory(h.ctx, sub.id), 'conflict', /used by 1 transaction/);
    const empty = createCategory(h.ctx, { name: 'Empty', kind: 'income' });
    deleteCategory(h.ctx, empty.id);
    expectData(() => getCategory(h.ctx, empty.id), 'not_found');
    expect(failedInvariants(h)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('income and expense entries', () => {
  it('stores an expense negative and an income positive, in USD at rate 1, with a normalised local time', () => {
    const h = makeDataDb();
    const e = createExpense(h.ctx, { occurredAt: '2026-08-26T20:23', accountId: ACC.credit, amountCents: 10588, categoryId: CAT.groceries, merchant: '  Costco ', note: '' });
    expect(e).toMatchObject({
      type: 'expense', occurredAt: '2026-08-26T20:23:00', currency: 'USD', amountNative: -10588, amountUsd: -10588,
      fxRate: 1, categoryId: CAT.groceries, merchant: 'Costco', note: null, personId: null, transferGroupId: null, importHash: null, deletedAt: null,
    });
    const i = createIncome(h.ctx, { occurredAt: T, accountId: ACC.cash, amountCents: 65000, categoryId: CAT.salaryDenim });
    expect(i).toMatchObject({ type: 'income', amountNative: 65000, amountUsd: 65000 });
    expect(failedInvariants(h)).toEqual([]);
  });

  it('attaches a name only on people-backed categories, and never a merchant there', () => {
    const h = makeDataDb();
    const p = createPerson(h.ctx, { name: 'Pramod' });
    const ok = createExpense(h.ctx, { occurredAt: T, accountId: ACC.chase, amountCents: 35000, categoryId: CAT.lend, personId: p.id, note: 'dinner' });
    expect(ok).toMatchObject({ personId: p.id, merchant: null, note: 'dinner' });
    expect(createIncome(h.ctx, { occurredAt: T, accountId: ACC.chase, amountCents: 100, categoryId: CAT.returned }).personId).toBeNull(); // a name is optional
    expectData(() => createExpense(h.ctx, { occurredAt: T, accountId: ACC.chase, amountCents: 100, categoryId: CAT.food, personId: p.id }), 'invalid', /Lend, Returned, Taken or Repaid/);
    expectData(() => createExpense(h.ctx, { occurredAt: T, accountId: ACC.chase, amountCents: 100, categoryId: CAT.lend, merchant: 'UPS' }), 'invalid', /not a merchant/);
    expectData(() => createExpense(h.ctx, { occurredAt: T, accountId: ACC.chase, amountCents: 100, categoryId: CAT.lend, personId: 'ghost' }), 'not_found');
  });

  it('validates every field before writing anything', () => {
    const h = makeDataDb();
    const base = { occurredAt: T, accountId: ACC.cash, amountCents: 500, categoryId: CAT.leisure };
    for (const bad of [0, -5, 12.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, '5' as never]) {
      expectData(() => createExpense(h.ctx, { ...base, amountCents: bad }), 'invalid', /amount/);
    }
    expectData(() => createExpense(h.ctx, { ...base, occurredAt: '2026-13-01T10:00' }), 'invalid', /impossible date/);
    expectData(() => createExpense(h.ctx, { ...base, occurredAt: 'yesterday' }), 'invalid', /unrecognised timestamp/);
    expectData(() => createExpense(h.ctx, { ...base, accountId: 'nope' }), 'not_found', /account/);
    expectData(() => createExpense(h.ctx, { ...base, categoryId: 'nope' }), 'not_found', /category/);
    expectData(() => createExpense(h.ctx, { ...base, categoryId: CAT.salary }), 'invalid', /income category/);
    expectData(() => createIncome(h.ctx, { ...base, categoryId: CAT.leisure }), 'invalid', /expense category/);
    expect(rows(h, 'SELECT COUNT(*) AS n FROM transactions')).toEqual([{ n: 0 }]);
  });

  it('edits only what is passed, and null clears a name, merchant or note', () => {
    const h = makeDataDb();
    h.clock.value = '2026-09-03T10:00:00';
    const p = createPerson(h.ctx, { name: 'Pramod' });
    const e = createExpense(h.ctx, { occurredAt: T, accountId: ACC.chase, amountCents: 35000, categoryId: CAT.lend, personId: p.id, note: 'dinner' });
    const u = updateEntry(h.ctx, e.id, { amountCents: 40000, occurredAt: '2026-08-11T18:00', note: null });
    expect(u).toMatchObject({ amountUsd: -40000, amountNative: -40000, occurredAt: '2026-08-11T18:00:00', personId: p.id, note: null, updatedAt: '2026-09-03T10:00:00' });
    // moving to a category that takes no names while the name is still set is refused, with the fix in the message
    expectData(() => updateEntry(h.ctx, e.id, { categoryId: CAT.food }), 'invalid', /Lend, Returned, Taken or Repaid/);
    const moved = updateEntry(h.ctx, e.id, { categoryId: CAT.food, personId: null, merchant: 'Costco' });
    expect(moved).toMatchObject({ categoryId: CAT.food, personId: null, merchant: 'Costco' });
    expect(failedInvariants(h)).toEqual([]);
  });

  it('cannot change an entry into a different kind, and refuses moves onto archived things', () => {
    const h = makeDataDb();
    const e = createExpense(h.ctx, { occurredAt: T, accountId: ACC.cash, amountCents: 500, categoryId: CAT.leisure });
    expectData(() => updateEntry(h.ctx, e.id, { categoryId: CAT.salary }), 'invalid', /income category/);
    archiveAccount(h.ctx, ACC.chase);
    expectData(() => updateEntry(h.ctx, e.id, { accountId: ACC.chase }), 'invalid', /archived/);
    expectData(() => updateEntry(h.ctx, e.id, { amountCents: 0 }), 'invalid');
    expect(getTransaction(h.ctx, e.id).amountUsd).toBe(-500); // nothing changed
  });

  it('soft-deletes: the row stays but stops counting; deleting or editing it again fails', () => {
    const h = makeDataDb();
    const e = createExpense(h.ctx, { occurredAt: T, accountId: ACC.cash, amountCents: 500, categoryId: CAT.leisure });
    expect(balanceOf(h, ACC.cash)).toBe(-500);
    deleteEntry(h.ctx, e.id);
    expect(balanceOf(h, ACC.cash)).toBe(0);
    expect(getTransaction(h.ctx, e.id).deletedAt).not.toBeNull();
    expectData(() => deleteEntry(h.ctx, e.id), 'not_found', /deleted/);
    expectData(() => updateEntry(h.ctx, e.id, { note: 'x' }), 'not_found');
    expect(listTransactions(h.ctx)).toEqual([]);
    expect(listTransactions(h.ctx, { includeDeleted: true })).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------
describe('transfers', () => {
  const make = (h: ReturnType<typeof makeDataDb>, cents = 100000) =>
    createTransferBetween(h.ctx, { occurredAt: '2026-08-25T15:51:06', fromAccountId: ACC.chase, toAccountId: ACC.credit, amountCents: cents, note: 'card payment' });

  it('creates two balanced legs that move money without changing the total', () => {
    const h = makeDataDb();
    const { groupId, legIds } = make(h);
    expect(legIds).toHaveLength(2);
    expect(rows(h, `SELECT account_id AS a, amount_native AS n, amount_usd AS u, fx_rate AS r, currency AS c, category_id AS cat, note FROM transactions WHERE transfer_group_id = '${groupId}' ORDER BY amount_native`)).toEqual([
      { a: ACC.chase, n: -100000, u: -100000, r: 1, c: 'USD', cat: null, note: 'card payment' },
      { a: ACC.credit, n: 100000, u: 100000, r: 1, c: 'USD', cat: null, note: 'card payment' },
    ]);
    expect(balanceOf(h, ACC.chase) + balanceOf(h, ACC.credit)).toBe(0);
    expect(failedInvariants(h)).toEqual([]);
  });

  it('validates accounts and amounts', () => {
    const h = makeDataDb();
    const base = { occurredAt: T, fromAccountId: ACC.chase, toAccountId: ACC.credit, amountCents: 100 };
    expectData(() => createTransferBetween(h.ctx, { ...base, toAccountId: ACC.chase }), 'invalid', /two different accounts/);
    expectData(() => createTransferBetween(h.ctx, { ...base, amountCents: 0 }), 'invalid', /amount/);
    expectData(() => createTransferBetween(h.ctx, { ...base, fromAccountId: 'nope' }), 'not_found', /source account/);
    archiveAccount(h.ctx, ACC.credit);
    expectData(() => createTransferBetween(h.ctx, base), 'invalid', /destination account "Credit" is archived/);
    expect(rows(h, 'SELECT COUNT(*) AS n FROM transactions')).toEqual([{ n: 0 }]);
  });

  it('edits BOTH legs together: amount, accounts, time and note', () => {
    const h = makeDataDb();
    const { groupId, legIds } = make(h);
    h.clock.value = '2026-09-04T09:00:00';
    updateTransfer(h.ctx, groupId, { amountCents: 25050, toAccountId: ACC.cash, occurredAt: '2026-08-26T10:00', note: null });
    expect(rows(h, `SELECT id, account_id AS a, amount_usd AS u, occurred_at AS at, note, updated_at AS up FROM transactions WHERE transfer_group_id = '${groupId}' ORDER BY amount_usd`)).toEqual([
      { id: legIds[0], a: ACC.chase, u: -25050, at: '2026-08-26T10:00:00', note: null, up: '2026-09-04T09:00:00' },
      { id: legIds[1], a: ACC.cash, u: 25050, at: '2026-08-26T10:00:00', note: null, up: '2026-09-04T09:00:00' },
    ]);
    expect(balanceOf(h, ACC.credit)).toBe(0);
    expect(balanceOf(h, ACC.cash)).toBe(25050);
    expect(failedInvariants(h)).toEqual([]);
  });

  it('leaves the transfer untouched when an edit is invalid', () => {
    const h = makeDataDb();
    const { groupId } = make(h);
    const before = rows(h, `SELECT * FROM transactions WHERE transfer_group_id = '${groupId}' ORDER BY id`);
    expectData(() => updateTransfer(h.ctx, groupId, { toAccountId: ACC.chase }), 'invalid', /two different accounts/);
    expectData(() => updateTransfer(h.ctx, groupId, { amountCents: -5 }), 'invalid');
    expectData(() => updateTransfer(h.ctx, groupId, { occurredAt: 'soon' }), 'invalid');
    archiveAccount(h.ctx, ACC.cash);
    expectData(() => updateTransfer(h.ctx, groupId, { toAccountId: ACC.cash }), 'invalid', /archived/);
    expect(rows(h, `SELECT * FROM transactions WHERE transfer_group_id = '${groupId}' ORDER BY id`)).toEqual(before);
    expectData(() => updateTransfer(h.ctx, 'no-such-group', {}), 'not_found');
  });

  it('deletes both legs together and restores the balances; one leg cannot be handled alone', () => {
    const h = makeDataDb();
    const { groupId, legIds } = make(h);
    expectData(() => deleteEntry(h.ctx, legIds[0]), 'invalid', /transfer/);
    expectData(() => updateEntry(h.ctx, legIds[1], { note: 'x' }), 'invalid', /transfer/);
    deleteTransfer(h.ctx, groupId);
    expect(balanceOf(h, ACC.chase)).toBe(0);
    expect(balanceOf(h, ACC.credit)).toBe(0);
    expectData(() => deleteTransfer(h.ctx, groupId), 'not_found');
    expectData(() => updateTransfer(h.ctx, groupId, { amountCents: 5 }), 'not_found');
    expect(failedInvariants(h)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('lists, filters and search', () => {
  function fixture() {
    const h = makeDataDb();
    const pramod = createPerson(h.ctx, { name: 'Pramod' });
    createExpense(h.ctx, { occurredAt: '2026-08-03T14:17', accountId: ACC.chase, amountCents: 35000, categoryId: CAT.lend, personId: pramod.id });
    createExpense(h.ctx, { occurredAt: '2026-08-26T20:23', accountId: ACC.credit, amountCents: 10588, categoryId: CAT.groceries, merchant: 'Costco' });
    createExpense(h.ctx, { occurredAt: '2026-08-22T16:44', accountId: ACC.chase, amountCents: 134, categoryId: CAT.snacks, note: '50% off snack' });
    createExpense(h.ctx, { occurredAt: '2026-08-15T09:24', accountId: ACC.credit, amountCents: 500, categoryId: CAT.subsEntertainment, merchant: 'Railway' });
    createIncome(h.ctx, { occurredAt: '2026-08-15T14:36', accountId: ACC.cash, amountCents: 64200, categoryId: CAT.salaryDenim });
    createTransferBetween(h.ctx, { occurredAt: '2026-08-25T15:51:06', fromAccountId: ACC.chase, toAccountId: ACC.credit, amountCents: 100000 });
    return { h, pramod };
  }

  it('lists newest first, with signed stored amounts and the names joined in', () => {
    const { h } = fixture();
    const all = listTransactions(h.ctx);
    expect(all.map((t) => t.occurredAt)).toEqual([
      '2026-08-26T20:23:00', '2026-08-25T15:51:06', '2026-08-25T15:51:06', '2026-08-22T16:44:00', '2026-08-15T14:36:00', '2026-08-15T09:24:00', '2026-08-03T14:17:00',
    ]);
    const costco = all.find((t) => t.merchant === 'Costco')!;
    expect(costco).toMatchObject({ amountCents: -10588, accountName: 'Credit', categoryName: 'Groceries', parentCategoryName: 'Food & Drinks', personName: null });
    expect(all.find((t) => t.personName === 'Pramod')).toMatchObject({ categoryName: 'Lend', parentCategoryName: null, amountCents: -35000 });
  });

  it('shows the account on the other side of each transfer leg', () => {
    const { h } = fixture();
    const legs = listTransactions(h.ctx, { types: ['transfer'] });
    expect(legs.map((l) => [l.accountName, l.amountCents, l.counterpartAccountName])).toEqual(
      expect.arrayContaining([['Chase Bank Account', -100000, 'Credit'], ['Credit', 100000, 'Chase Bank Account']]),
    );
  });

  it('filters by date range, account, type and category (a parent includes its subcategories)', () => {
    const { h } = fixture();
    const ids = (f: Parameters<typeof listTransactions>[1]) => listTransactions(h.ctx, f).length;
    expect(ids({ from: '2026-08-15', toExclusive: '2026-08-16' })).toBe(2);
    expect(ids({ from: '2026-08-26' })).toBe(1);
    expect(ids({ toExclusive: '2026-08-04' })).toBe(1);
    expect(ids({ accountIds: [ACC.credit] })).toBe(3); // costco, railway, transfer leg
    expect(ids({ types: ['income'] })).toBe(1);
    expect(ids({ categoryId: CAT.food })).toBe(2); // groceries + snacks via the parent
    expect(ids({ categoryId: CAT.groceries })).toBe(1);
  });

  it('searches merchant, note, name, category and account, ignoring case, treating % and _ literally', () => {
    const { h, pramod } = fixture();
    const find = (text: string) => listTransactions(h.ctx, { text }).map((t) => t.merchant ?? t.note ?? t.personName);
    expect(find('costco')).toEqual(['Costco']);
    expect(find('RAILWAY')).toEqual(['Railway']);
    expect(find('pramod')).toEqual(['Pramod']); // a name
    expect(find('entertain')).toEqual(['Railway']); // category name
    expect(find('groceries')).toEqual(['Costco']);
    expect(find('food & drinks')).toHaveLength(2); // parent category name
    expect(listTransactions(h.ctx, { text: 'Chase' }).length).toBe(3); // account name: 2 expenses + transfer leg
    expect(find('50%')).toEqual(['50% off snack']);
    expect(listTransactions(h.ctx, { text: '%' }).map((t) => t.note)).toEqual(['50% off snack']); // a lone % is not a wildcard
    expect(listTransactions(h.ctx, { text: '_' })).toEqual([]);
    expect(listTransactions(h.ctx, { text: '   ' })).toHaveLength(7); // blank search = no filter
    expect(listTransactions(h.ctx, { personId: pramod.id })).toHaveLength(1);
  });

  it('pages results and rejects malformed dates', () => {
    const { h } = fixture();
    expect(listTransactions(h.ctx, { limit: 2 }).map((t) => t.occurredAt)).toEqual(['2026-08-26T20:23:00', '2026-08-25T15:51:06']);
    expect(listTransactions(h.ctx, { limit: 2, offset: 5 })).toHaveLength(2);
    expectData(() => listTransactions(h.ctx, { from: '2026-8-1' }), 'invalid', /YYYY-MM-DD/);
    expectData(() => listTransactions(h.ctx, { toExclusive: '2026-02-30' }), 'invalid', /real calendar date/);
  });
});
