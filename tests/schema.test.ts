import { describe, expect, it } from 'vitest';
import { runInvariants } from '../src/db/invariants';
import { SEED_CATEGORIES, seed } from '../src/db/seed';
import { NOW, insertCategory, insertPerson, insertTx, makeEnforcingDb, rowsOf } from './helpers';

const names = (sqlite: Parameters<typeof rowsOf>[0], sql: string) =>
  rowsOf(sqlite, sql).map((r) => r.name);

describe('seed', () => {
  it('creates exactly the agreed accounts and categories', () => {
    const { sqlite } = makeEnforcingDb();
    expect(rowsOf(sqlite, `SELECT name, type, currency, opening_balance_native FROM accounts WHERE id IN ('acc-credit','acc-chase','acc-cash') ORDER BY sort_order`)).toEqual([
      { name: 'Credit', type: 'credit', currency: 'USD', opening_balance_native: 0 },
      { name: 'Chase Bank Account', type: 'bank', currency: 'USD', opening_balance_native: 0 },
      { name: 'Cash', type: 'cash', currency: 'USD', opening_balance_native: 0 },
    ]);

    expect(names(sqlite, `SELECT name FROM categories WHERE kind='expense' AND parent_id IS NULL ORDER BY sort_order`)).toEqual([
      'Food & Drinks', 'Shopping', 'Housing', 'Bills', 'Transport', 'Vehicle',
      'Leisure', 'Education', 'Lend', 'Repaid', 'Investment', 'Subscriptions',
    ]);
    expect(names(sqlite, `SELECT name FROM categories WHERE kind='income' AND parent_id IS NULL ORDER BY sort_order`)).toEqual([
      'Salary', 'Gifts', 'Taken', 'Returned', 'Loan',
    ]);

    const subs = rowsOf(
      sqlite,
      `SELECT p.name AS parent, c.name AS child FROM categories c JOIN categories p ON p.id = c.parent_id ORDER BY p.name, c.sort_order`,
    ).map((r) => `${r.parent} > ${r.child}`);
    expect(subs).toEqual([
      'Bills > Phone',
      'Food & Drinks > Groceries',
      'Food & Drinks > Snacks',
      'Housing > Rent',
      'Salary > Denim',
      'Salary > Ride',
      'Shopping > Gifts',
      'Subscriptions > Education',
      'Subscriptions > Entertainment',
      'Vehicle > Fuel',
      'Vehicle > Maintenance',
    ]);
    expect(rowsOf(sqlite, `SELECT COUNT(*) AS n FROM categories`)).toEqual([{ n: 28 }]);
  });

  it('marks only Lend, Repaid, Taken and income Returned as people_backed', () => {
    const { sqlite } = makeEnforcingDb();
    expect(
      rowsOf(sqlite, `SELECT kind, name FROM categories WHERE people_backed = 1 ORDER BY kind, name`),
    ).toEqual([
      { kind: 'expense', name: 'Lend' },
      { kind: 'expense', name: 'Repaid' },
      { kind: 'income', name: 'Returned' },
      { kind: 'income', name: 'Taken' },
    ]);
  });

  it('does not seed an expense-side Returned/Refund (decision C is deferred to Phase 2)', () => {
    const { sqlite } = makeEnforcingDb();
    expect(rowsOf(sqlite, `SELECT id FROM categories WHERE kind='expense' AND name IN ('Returned','Refund') COLLATE NOCASE`)).toEqual([]);
  });

  it('is idempotent', () => {
    const { sqlite, db } = makeEnforcingDb();
    const before = rowsOf(sqlite, `SELECT (SELECT COUNT(*) FROM accounts) AS a, (SELECT COUNT(*) FROM categories) AS c`);
    seed(db, '2027-01-01T00:00:00');
    expect(rowsOf(sqlite, `SELECT (SELECT COUNT(*) FROM accounts) AS a, (SELECT COUNT(*) FROM categories) AS c`)).toEqual(before);
    // and it did not overwrite the original timestamps
    expect(rowsOf(sqlite, `SELECT DISTINCT created_at FROM categories`)).toEqual([{ created_at: NOW }]);
  });

  it('seeds exactly the three agreed accounts (the INR ones are added by the test helper)', () => {
    const { sqlite } = makeEnforcingDb();
    expect(rowsOf(sqlite, `SELECT COUNT(*) AS n FROM accounts WHERE id LIKE 'acc-%' AND id NOT LIKE 'acc-loan%'`)).toEqual([{ n: 3 }]);
  });

  it('every seeded category has a matching row in SEED_CATEGORIES (no drift)', () => {
    const expected = SEED_CATEGORIES.reduce((n, c) => n + 1 + (c.children?.length ?? 0), 0);
    expect(expected).toBe(28);
  });

  it('leaves the database passing every invariant', () => {
    const { sqlite } = makeEnforcingDb();
    expect(runInvariants((s) => rowsOf(sqlite, s)).filter((r) => !r.passed)).toEqual([]);
  });
});

describe('uniqueness', () => {
  it('people names are unique case-insensitively (Pramod vs pramod)', () => {
    const { sqlite } = makeEnforcingDb();
    insertPerson(sqlite, 'p-1', 'Pramod');
    expect(() => insertPerson(sqlite, 'p-2', 'pramod')).toThrow(/UNIQUE constraint failed/);
    expect(() => insertPerson(sqlite, 'p-3', 'PRAMOD')).toThrow(/UNIQUE constraint failed/);
    insertPerson(sqlite, 'p-4', 'Vamsi');
  });

  it('top-level category names are unique per kind, case-insensitively (NULL parent is not exempt)', () => {
    const { sqlite } = makeEnforcingDb();
    expect(() => insertCategory(sqlite, { id: 'dup', name: 'food & drinks', kind: 'expense' })).toThrow(
      /UNIQUE constraint failed/,
    );
    // the same name in the other kind is a different category
    insertCategory(sqlite, { id: 'inc-food', name: 'Food & Drinks', kind: 'income' });
  });

  it('subcategory names are unique per parent, but may repeat under different parents', () => {
    const { sqlite } = makeEnforcingDb();
    expect(() =>
      insertCategory(sqlite, { id: 'dup', name: 'groceries', kind: 'expense', parent_id: 'cat-exp-food-and-drinks' }),
    ).toThrow(/UNIQUE constraint failed/);
    // 'Education' already exists as a top-level category and under Subscriptions
    insertCategory(sqlite, { id: 'ok', name: 'Education', kind: 'expense', parent_id: 'cat-exp-shopping' });
  });

  it('import_hash is unique when set, and many rows may have none', () => {
    const { sqlite } = makeEnforcingDb();
    insertTx(sqlite, { import_hash: 'h1' });
    expect(() => insertTx(sqlite, { import_hash: 'h1' })).toThrow(/UNIQUE constraint failed/);
    insertTx(sqlite, { import_hash: 'h2' });
    insertTx(sqlite, { import_hash: null });
    insertTx(sqlite, { import_hash: null });
  });
});

describe('hand-written migration objects survive', () => {
  // drizzle-kit does not know about these. If a future generated migration recreates a table
  // (SQLite does that when a constraint changes) they would vanish silently: this test is the alarm.
  it('all triggers and the expression index exist', () => {
    const { sqlite } = makeEnforcingDb();
    const objects = rowsOf(sqlite, `SELECT name FROM sqlite_master WHERE type IN ('trigger','index')`).map((r) => r.name);
    expect(objects).toEqual(
      expect.arrayContaining([
        'categories_unique',
        'people_name_ci',
        'transactions_import_hash',
        'trg_cat_depth_ins',
        'trg_cat_depth_upd',
        'trg_cat_kind_upd',
        'trg_cat_people_backed_upd',
        'trg_cat_kind_parent_ins',
        'trg_cat_kind_parent_upd',
        'trg_tx_category_kind_ins',
        'trg_tx_category_kind_upd',
        'trg_tx_person_ins',
        'trg_tx_person_upd',
        'trg_tx_transfer_group_ins',
      ]),
    );
  });

  it('every named CHECK is present in the transactions table definition', () => {
    const { sqlite } = makeEnforcingDb();
    const ddl = String(rowsOf(sqlite, `SELECT sql FROM sqlite_master WHERE name = 'transactions'`)[0].sql);
    for (const c of [
      'tx_type_valid', 'tx_expense_shape', 'tx_income_shape', 'tx_transfer_shape', 'tx_usd_rate',
      'tx_foreign_rate', 'tx_sign_match', 'tx_money_integer', 'tx_fx_numeric', 'tx_currency_format',
      'tx_group_only_on_transfer', 'tx_transfer_nonzero',
    ]) {
      expect(ddl, c).toContain(c);
    }
  });
});

describe('table conventions', () => {
  it('every table has created_at and updated_at', () => {
    const { sqlite } = makeEnforcingDb();
    for (const table of ['accounts', 'people', 'categories', 'transactions']) {
      const cols = rowsOf(sqlite, `SELECT name FROM pragma_table_info('${table}')`).map((r) => r.name);
      expect(cols, table).toEqual(expect.arrayContaining(['created_at', 'updated_at']));
    }
  });

  it('fx_rate is the only REAL column in the schema', () => {
    const { sqlite } = makeEnforcingDb();
    const real = rowsOf(
      sqlite,
      `SELECT m.name AS tbl, p.name AS col FROM sqlite_master m, pragma_table_info(m.name) p
       WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite_%' AND m.name NOT LIKE '\\_\\_drizzle%' ESCAPE '\\'
         AND upper(p.type) IN ('REAL','FLOAT','DOUBLE','NUMERIC')`,
    );
    expect(real).toEqual([{ tbl: 'transactions', col: 'fx_rate' }]);
  });

  it('a transaction can be soft-deleted (deleted_at exists and is nullable)', () => {
    const { sqlite } = makeEnforcingDb();
    const id = insertTx(sqlite);
    sqlite.prepare(`UPDATE transactions SET deleted_at = ? WHERE id = ?`).run(NOW, id);
    expect(rowsOf(sqlite, `SELECT deleted_at FROM transactions WHERE id = '${id}'`)).toEqual([{ deleted_at: NOW }]);
  });
});
