import { expect } from 'vitest';
import { runInvariants, type Row } from '../src/db/invariants';
import { migrateNodeDb, openNodeDb } from '../src/db/node';
import { seed } from '../src/db/seed';
import type { DataContext } from '../src/data/context';
import { DataError, type DataErrorCode } from '../src/data/errors';

export const NOW = '2026-09-01T12:00:00';

/** Seeded ids (see src/db/seed.ts). */
export const ACC = { credit: 'acc-credit', chase: 'acc-chase', cash: 'acc-cash' };
export const CAT = {
  food: 'cat-exp-food-and-drinks',
  groceries: 'cat-exp-food-and-drinks-groceries',
  snacks: 'cat-exp-food-and-drinks-snacks',
  shopping: 'cat-exp-shopping',
  shoppingGifts: 'cat-exp-shopping-gifts',
  leisure: 'cat-exp-leisure',
  subscriptions: 'cat-exp-subscriptions',
  subsEntertainment: 'cat-exp-subscriptions-entertainment',
  lend: 'cat-exp-lend',
  repaid: 'cat-exp-repaid',
  salary: 'cat-inc-salary',
  salaryDenim: 'cat-inc-salary-denim',
  salaryRide: 'cat-inc-salary-ride',
  taken: 'cat-inc-taken',
  returned: 'cat-inc-returned',
  loan: 'cat-inc-loan',
};

/** A seeded database (3 USD accounts, 28 categories, no people, no transactions) with a controllable clock. */
export function makeDataDb() {
  const { sqlite, db } = openNodeDb(':memory:');
  migrateNodeDb(db);
  seed(db, NOW);
  let n = 0;
  const clock = { value: NOW };
  const ctx: DataContext = { db, now: () => clock.value, newId: () => `d-${++n}` };
  return { sqlite, db, ctx, clock };
}
export type DataHandle = ReturnType<typeof makeDataDb>;

export const rows = (h: DataHandle, sql: string): Row[] => h.sqlite.prepare(sql).all() as Row[];
export const failedInvariants = (h: DataHandle) => runInvariants((s) => rows(h, s)).filter((r) => !r.passed);

/** Asserts the call throws a DataError with this code (and, optionally, a message matching `message`). */
export function expectData(fn: () => unknown, code: DataErrorCode, message?: RegExp): void {
  let error: unknown;
  try { fn(); } catch (e) { error = e; }
  expect(error, 'expected a DataError').toBeInstanceOf(DataError);
  expect((error as DataError).code).toBe(code);
  if (message) expect((error as DataError).message).toMatch(message);
}

// ---- importing the August fixture into a data-layer database ----------------------------------
import fs from 'node:fs';
import path from 'node:path';
import { applyImport } from '../src/import/service';

export const FIXTURE_CSV = fs.readFileSync(path.resolve(__dirname, 'fixtures/trackwallet_2026-08-01_2026-08-31.csv'), 'utf8');

/** Imports a CSV through the in-app import service, as the app will (the user confirmed everything). */
export function importCsv(h: DataHandle, text: string): void {
  applyImport(h.db, { csvText: text, filename: 'test.csv', newId: h.ctx.newId, now: NOW, confirmNew: true, allowSkips: true });
}
