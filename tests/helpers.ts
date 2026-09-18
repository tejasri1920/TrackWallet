import type Database from 'better-sqlite3';
import { migrateNodeDb, openNodeDb } from '../src/db/node';
import { categoryId, seed } from '../src/db/seed';
import type { Row } from '../src/db/invariants';

export const NOW = '2026-08-26T20:00:00';

export const CAT = {
  food: categoryId('expense', 'Food & Drinks'),
  groceries: categoryId('expense', 'Groceries', 'Food & Drinks'),
  lend: categoryId('expense', 'Lend'),
  salary: categoryId('income', 'Salary'),
  returned: categoryId('income', 'Returned'),
};

export const ACC = {
  credit: 'acc-credit',
  chase: 'acc-chase',
  cash: 'acc-cash',
  loan: 'acc-loan-inr',
  loan2: 'acc-loan-inr-2',
};
/** The three seeded accounts (the INR ones below are test-only). */
export const SEEDED_ACCOUNT_IDS = [ACC.credit, ACC.chase, ACC.cash];

/** A seeded database with every constraint and trigger in place, plus two INR accounts. */
export function makeEnforcingDb() {
  const { sqlite, db } = openNodeDb(':memory:');
  migrateNodeDb(db);
  seed(db, NOW);
  const insertAccount = sqlite.prepare(
    `INSERT INTO accounts (id, name, type, currency, opening_balance_native, sort_order, created_at, updated_at)
     VALUES (?, ?, 'loan', 'INR', 0, ?, ?, ?)`,
  );
  insertAccount.run(ACC.loan, 'Education Loan', 3, NOW, NOW);
  insertAccount.run(ACC.loan2, 'Second INR Account', 4, NOW, NOW);
  return { sqlite, db };
}

/**
 * Same schema with CHECK constraints ignored, triggers dropped and foreign keys off, so that
 * deliberately corrupt rows can be written and the audit queries proven to catch them.
 */
export function makeUnconstrainedDb() {
  const handle = makeEnforcingDb();
  const triggers = handle.sqlite
    .prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger'`)
    .all() as { name: string }[];
  for (const t of triggers) handle.sqlite.exec(`DROP TRIGGER "${t.name}"`);
  handle.sqlite.pragma('ignore_check_constraints = ON');
  handle.sqlite.pragma('foreign_keys = OFF');
  return handle;
}

let seq = 0;

const DEFAULT_TX: Row = {
  occurred_at: '2026-08-26T20:23:00',
  type: 'expense',
  account_id: ACC.credit,
  currency: 'USD',
  amount_native: -1000,
  amount_usd: -1000,
  fx_rate: 1.0,
  category_id: CAT.food,
  person_id: null,
  merchant: null,
  note: null,
  transfer_group_id: null,
  import_hash: null,
  created_at: NOW,
  updated_at: NOW,
  deleted_at: null,
};

/** Raw insert (bypasses domain code on purpose). Returns the row id. */
export function insertTx(sqlite: Database.Database, overrides: Row = {}): string {
  const row: Row = { id: `tx-${++seq}`, ...DEFAULT_TX, ...overrides };
  const cols = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO transactions (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`)
    .run(row);
  return row.id as string;
}

export function insertPerson(sqlite: Database.Database, id: string, name: string): string {
  sqlite
    .prepare(`INSERT INTO people (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run(id, name, NOW, NOW);
  return id;
}

export function insertCategory(sqlite: Database.Database, o: Row): void {
  const row: Row = {
    kind: 'expense',
    parent_id: null,
    people_backed: 0,
    sort_order: 0,
    created_at: NOW,
    updated_at: NOW,
    ...o,
  };
  const cols = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO categories (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`)
    .run(row);
}

export const rowsOf = (sqlite: Database.Database, sql: string): Row[] => sqlite.prepare(sql).all() as Row[];
