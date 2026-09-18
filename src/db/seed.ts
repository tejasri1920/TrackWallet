import { accounts, categories, type AccountType, type CategoryKind } from './schema';
import type { AppDb } from './types';

interface SeedCategory {
  name: string;
  kind: CategoryKind;
  peopleBacked?: boolean;
  children?: readonly string[];
}

// Names match TrackWallet exactly so the importer maps cleanly. See docs/DECISIONS.md:
// - C: the expense-side "Returned" (-> Refund) is NOT seeded yet; decided in Phase 2.
// - D: `Repaid` is seeded because the lending model needs it.
export const SEED_CATEGORIES: readonly SeedCategory[] = [
  { name: 'Food & Drinks', kind: 'expense', children: ['Groceries', 'Snacks'] },
  { name: 'Shopping', kind: 'expense', children: ['Gifts'] },
  { name: 'Housing', kind: 'expense', children: ['Rent'] },
  { name: 'Bills', kind: 'expense', children: ['Phone'] },
  { name: 'Transport', kind: 'expense' },
  { name: 'Vehicle', kind: 'expense', children: ['Fuel', 'Maintenance'] },
  { name: 'Leisure', kind: 'expense' },
  { name: 'Education', kind: 'expense' },
  { name: 'Lend', kind: 'expense', peopleBacked: true },
  { name: 'Repaid', kind: 'expense', peopleBacked: true },
  { name: 'Investment', kind: 'expense' },
  { name: 'Subscriptions', kind: 'expense', children: ['Education', 'Entertainment'] },
  { name: 'Salary', kind: 'income', children: ['Denim', 'Ride'] },
  { name: 'Gifts', kind: 'income' },
  { name: 'Taken', kind: 'income', peopleBacked: true },
  { name: 'Returned', kind: 'income', peopleBacked: true },
  { name: 'Loan', kind: 'income' },
];

export const SEED_ACCOUNTS: readonly { id: string; name: string; type: AccountType }[] = [
  { id: 'acc-credit', name: 'Credit', type: 'credit' },
  { id: 'acc-chase', name: 'Chase Bank Account', type: 'bank' },
  { id: 'acc-cash', name: 'Cash', type: 'cash' },
];

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/&/g, 'and')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Deterministic id so seeding is idempotent and tests can refer to rows by id. */
export const categoryId = (kind: CategoryKind, name: string, parent?: string): string =>
  `cat-${kind === 'income' ? 'inc' : 'exp'}-${parent ? `${slug(parent)}-` : ''}${slug(name)}`;

/** Inserts the seed rows; a no-op for rows already present. Opening balances start at 0. */
export function seed(db: AppDb, now: string): void {
  db.transaction((tx) => {
    SEED_ACCOUNTS.forEach((a, i) => {
      tx.insert(accounts)
        .values({
          id: a.id,
          name: a.name,
          type: a.type,
          currency: 'USD',
          openingBalanceNative: 0,
          sortOrder: i,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
    });

    SEED_CATEGORIES.forEach((c, i) => {
      const parentId = categoryId(c.kind, c.name);
      tx.insert(categories)
        .values({
          id: parentId,
          name: c.name,
          kind: c.kind,
          parentId: null,
          peopleBacked: c.peopleBacked ? 1 : 0,
          sortOrder: i,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run();
      (c.children ?? []).forEach((child, j) => {
        tx.insert(categories)
          .values({
            id: categoryId(c.kind, child, c.name),
            name: child,
            kind: c.kind,
            parentId,
            sortOrder: j,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .run();
      });
    });
  });
}
