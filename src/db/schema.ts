import { sql } from 'drizzle-orm';
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const ACCOUNT_TYPES = ['cash', 'bank', 'credit', 'splitwise', 'loan'] as const;
export const CATEGORY_KINDS = ['income', 'expense'] as const;
export const TRANSACTION_TYPES = ['income', 'expense', 'transfer'] as const;

export type AccountType = (typeof ACCOUNT_TYPES)[number];
export type CategoryKind = (typeof CATEGORY_KINDS)[number];
export type TransactionType = (typeof TRANSACTION_TYPES)[number];

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    type: text('type', { enum: ACCOUNT_TYPES }).notNull(),
    currency: text('currency').notNull().default('USD'),
    openingBalanceNative: integer('opening_balance_native').notNull().default(0),
    icon: text('icon'),
    color: text('color'),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('accounts_type_valid', sql`${t.type} IN ('cash','bank','credit','splitwise','loan')`),
    check('accounts_currency_format', sql`${t.currency} GLOB '[A-Z][A-Z][A-Z]'`),
    check('accounts_opening_integer', sql`typeof(${t.openingBalanceNative}) = 'integer'`),
    // CSV rows resolve their account by name, so two accounts must never share one.
    uniqueIndex('accounts_name_ci').on(sql`${t.name} COLLATE NOCASE`),
  ],
);

export const people = sqliteTable(
  'people',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    note: text('note'),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('people_name_ci').on(sql`${t.name} COLLATE NOCASE`)],
);

export const categories = sqliteTable(
  'categories',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    kind: text('kind', { enum: CATEGORY_KINDS }).notNull(),
    parentId: text('parent_id').references((): AnySQLiteColumn => categories.id),
    icon: text('icon'),
    color: text('color'),
    peopleBacked: integer('people_backed').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
    archivedAt: text('archived_at'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    check('categories_kind_valid', sql`${t.kind} IN ('income','expense')`),
    // `categories_unique` (kind, IFNULL(parent_id,''), name COLLATE NOCASE) is created in
    // drizzle/0001_*.sql: drizzle-kit mangles multi-argument expressions in index columns.
  ],
);

export const transactions = sqliteTable(
  'transactions',
  {
    id: text('id').primaryKey(),
    /** Local-time ISO-8601, no timezone suffix. Never converted to UTC. */
    occurredAt: text('occurred_at').notNull(),
    type: text('type', { enum: TRANSACTION_TYPES }).notNull(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id),
    currency: text('currency').notNull(),
    /** Signed minor units of `currency`. */
    amountNative: integer('amount_native').notNull(),
    /** Signed USD cents. Stored, never recomputed on read. */
    amountUsd: integer('amount_usd').notNull(),
    /**
     * minor units of `currency` per USD cent (= native units per 1 USD only for currencies with
     * 100 minor units, e.g. INR). The only REAL column in the schema.
     */
    fxRate: real('fx_rate').notNull().default(1.0),
    categoryId: text('category_id').references(() => categories.id),
    personId: text('person_id').references(() => people.id),
    merchant: text('merchant'),
    note: text('note'),
    transferGroupId: text('transfer_group_id'),
    importHash: text('import_hash'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    deletedAt: text('deleted_at'),
  },
  (t) => [
    check('tx_type_valid', sql`${t.type} IN ('income','expense','transfer')`),
    // Invariant 1
    check(
      'tx_expense_shape',
      sql`${t.type} <> 'expense' OR (${t.amountNative} < 0 AND ${t.categoryId} IS NOT NULL)`,
    ),
    // Invariant 2
    check(
      'tx_income_shape',
      sql`${t.type} <> 'income' OR (${t.amountNative} > 0 AND ${t.categoryId} IS NOT NULL)`,
    ),
    // Invariant 3
    check(
      'tx_transfer_shape',
      sql`${t.type} <> 'transfer' OR (${t.categoryId} IS NULL AND ${t.transferGroupId} IS NOT NULL)`,
    ),
    // Invariant 6
    check(
      'tx_usd_rate',
      sql`${t.currency} <> 'USD' OR (${t.amountNative} = ${t.amountUsd} AND ${t.fxRate} = 1.0)`,
    ),
    // Invariant 7 (1 minor unit tolerance)
    check(
      'tx_foreign_rate',
      sql`${t.currency} = 'USD' OR (${t.fxRate} > 0 AND ABS(ABS(${t.amountNative}) / ${t.fxRate} - ABS(${t.amountUsd})) <= 1)`,
    ),
    // Invariant 8
    check(
      'tx_sign_match',
      sql`(${t.amountNative} > 0 AND ${t.amountUsd} > 0) OR (${t.amountNative} < 0 AND ${t.amountUsd} < 0) OR (${t.amountNative} = 0 AND ${t.amountUsd} = 0)`,
    ),
    // Extra guards beyond the 11 invariants (see DECISIONS.md, "Phase 1 review fixes").
    // Money is never a float, and fx_rate is always a number (a text value would make the
    // tx_foreign_rate comparison NULL, and NULL passes a CHECK).
    check(
      'tx_money_integer',
      sql`typeof(${t.amountNative}) = 'integer' AND typeof(${t.amountUsd}) = 'integer'`,
    ),
    check('tx_fx_numeric', sql`typeof(${t.fxRate}) IN ('real','integer')`),
    // 'usd' would be treated as foreign and bypass invariant 6.
    check('tx_currency_format', sql`${t.currency} GLOB '[A-Z][A-Z][A-Z]'`),
    // A transfer group id only ever appears on transfer rows, so invariants 4/5 cannot be
    // diluted by an income/expense row sharing a group; and a transfer leg moves something.
    check('tx_group_only_on_transfer', sql`${t.transferGroupId} IS NULL OR ${t.type} = 'transfer'`),
    check('tx_transfer_nonzero', sql`${t.type} <> 'transfer' OR ${t.amountNative} <> 0`),
    uniqueIndex('transactions_import_hash')
      .on(t.importHash)
      .where(sql`${t.importHash} IS NOT NULL`),
    index('transactions_occurred').on(t.occurredAt),
    index('transactions_account').on(t.accountId, t.occurredAt),
    index('transactions_group').on(t.transferGroupId),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type NewAccount = typeof accounts.$inferInsert;
export type Person = typeof people.$inferSelect;
export type NewPerson = typeof people.$inferInsert;
export type Category = typeof categories.$inferSelect;
export type NewCategory = typeof categories.$inferInsert;
export type Transaction = typeof transactions.$inferSelect;
export type NewTransaction = typeof transactions.$inferInsert;
