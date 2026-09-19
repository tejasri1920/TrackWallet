/**
 * Database invariants (docs/INVARIANTS.md). Each `sql` returns the OFFENDING rows:
 * zero rows means the invariant holds. Single-row rules are also enforced by CHECK
 * constraints and cross-table rules by triggers; these queries are the audit that proves it,
 * and the only guard for edits/soft-deletes of transfers (invariants 4 and 5).
 *
 * Row-level rules (1-3, 6-8, 10-11) look at every row including soft-deleted ones, because
 * the constraints applied when those rows were written. Transfer-group rules (4-5) count
 * only non-deleted legs, per the spec.
 */
export interface Invariant {
  id: number;
  name: string;
  sql: string;
  /** Added beyond the 11 in the master prompt; see docs/DECISIONS.md. */
  extra?: boolean;
}

export const INVARIANTS: readonly Invariant[] = [
  {
    id: 1,
    name: 'expense => amount_native < 0, category present and of kind expense',
    sql: `SELECT t.id, t.type, t.amount_native, t.category_id, c.kind AS category_kind
FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
WHERE t.type = 'expense'
  AND (t.amount_native >= 0 OR t.category_id IS NULL OR c.kind IS NOT 'expense')`,
  },
  {
    id: 2,
    name: 'income => amount_native > 0, category present and of kind income',
    sql: `SELECT t.id, t.type, t.amount_native, t.category_id, c.kind AS category_kind
FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
WHERE t.type = 'income'
  AND (t.amount_native <= 0 OR t.category_id IS NULL OR c.kind IS NOT 'income')`,
  },
  {
    id: 3,
    name: 'transfer => no category and a transfer_group_id',
    sql: `SELECT id, category_id, transfer_group_id
FROM transactions
WHERE type = 'transfer' AND (category_id IS NOT NULL OR transfer_group_id IS NULL)`,
  },
  {
    id: 4,
    name: 'every transfer_group_id has exactly 2 non-deleted legs',
    sql: `SELECT transfer_group_id, COUNT(*) AS live_legs
FROM transactions
WHERE transfer_group_id IS NOT NULL AND deleted_at IS NULL
GROUP BY transfer_group_id
HAVING COUNT(*) <> 2`,
  },
  {
    id: 5,
    name: 'every transfer group sums to exactly 0 in amount_usd',
    sql: `SELECT transfer_group_id, SUM(amount_usd) AS usd_sum
FROM transactions
WHERE transfer_group_id IS NOT NULL AND deleted_at IS NULL
GROUP BY transfer_group_id
HAVING SUM(amount_usd) <> 0`,
  },
  {
    id: 6,
    name: 'USD => amount_native = amount_usd and fx_rate = 1.0',
    sql: `SELECT id, currency, amount_native, amount_usd, fx_rate
FROM transactions
WHERE currency = 'USD' AND (amount_native <> amount_usd OR fx_rate <> 1.0)`,
  },
  {
    id: 7,
    name: 'non-USD => fx_rate > 0 and |native|/fx_rate within 1 minor unit of |usd|',
    sql: `SELECT id, currency, amount_native, amount_usd, fx_rate
FROM transactions
WHERE currency <> 'USD'
  AND (fx_rate <= 0 OR ABS(ABS(amount_native) / fx_rate - ABS(amount_usd)) > 1)`,
  },
  {
    id: 8,
    name: 'amount_native and amount_usd share the same sign',
    sql: `SELECT id, amount_native, amount_usd
FROM transactions
WHERE NOT ((amount_native > 0 AND amount_usd > 0)
        OR (amount_native < 0 AND amount_usd < 0)
        OR (amount_native = 0 AND amount_usd = 0))`,
  },
  {
    id: 9,
    name: 'category depth <= 2',
    sql: `SELECT c.id, c.name, c.parent_id
FROM categories c JOIN categories p ON p.id = c.parent_id
WHERE p.parent_id IS NOT NULL`,
  },
  {
    id: 10,
    name: 'person_id => the leg category has people_backed = 1',
    sql: `SELECT t.id, t.person_id, t.category_id, c.people_backed
FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
WHERE t.person_id IS NOT NULL AND (c.id IS NULL OR c.people_backed <> 1)`,
  },
  {
    id: 11,
    name: 'no transaction references a missing account, category or person',
    sql: `SELECT t.id, 'account' AS missing, t.account_id AS ref
FROM transactions t LEFT JOIN accounts a ON a.id = t.account_id
WHERE a.id IS NULL
UNION ALL
SELECT t.id, 'category', t.category_id
FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
WHERE t.category_id IS NOT NULL AND c.id IS NULL
UNION ALL
SELECT t.id, 'person', t.person_id
FROM transactions t LEFT JOIN people p ON p.id = t.person_id
WHERE t.person_id IS NOT NULL AND p.id IS NULL`,
  },
  {
    id: 12,
    extra: true,
    name: 'money columns hold integers (never floats/text) and fx_rate holds a number',
    sql: `SELECT 'transactions' AS tbl, id, 'amount_native' AS col, typeof(amount_native) AS stored
FROM transactions WHERE typeof(amount_native) <> 'integer'
UNION ALL
SELECT 'transactions', id, 'amount_usd', typeof(amount_usd)
FROM transactions WHERE typeof(amount_usd) <> 'integer'
UNION ALL
SELECT 'transactions', id, 'fx_rate', typeof(fx_rate)
FROM transactions WHERE typeof(fx_rate) NOT IN ('real','integer')
UNION ALL
SELECT 'accounts', id, 'opening_balance_native', typeof(opening_balance_native)
FROM accounts WHERE typeof(opening_balance_native) <> 'integer'`,
  },
  {
    id: 13,
    extra: true,
    name: 'transfer_group_id appears only on transfer rows; transfer legs are non-zero',
    sql: `SELECT id, type, transfer_group_id, amount_native
FROM transactions
WHERE (transfer_group_id IS NOT NULL AND type <> 'transfer')
   OR (type = 'transfer' AND amount_native = 0)`,
  },
  {
    id: 14,
    extra: true,
    name: 'live transfer legs are on different accounts; same-currency legs offset in amount_native',
    sql: `SELECT a.transfer_group_id, a.id AS leg_a, b.id AS leg_b,
       a.account_id AS account_a, b.account_id AS account_b,
       a.currency, a.amount_native AS native_a, b.amount_native AS native_b
FROM transactions a JOIN transactions b
  ON a.transfer_group_id = b.transfer_group_id AND a.id < b.id
WHERE a.deleted_at IS NULL AND b.deleted_at IS NULL
  AND (a.account_id = b.account_id
       OR (a.currency = b.currency AND a.amount_native + b.amount_native <> 0))`,
  },
  {
    id: 15,
    extra: true,
    name: 'currency codes are three uppercase letters',
    sql: `SELECT 'transactions' AS tbl, id, currency
FROM transactions WHERE currency NOT GLOB '[A-Z][A-Z][A-Z]'
UNION ALL
SELECT 'accounts', id, currency
FROM accounts WHERE currency NOT GLOB '[A-Z][A-Z][A-Z]'`,
  },
  {
    id: 16,
    extra: true,
    name: 'a subcategory has the same kind as its parent',
    sql: `SELECT c.id, c.name, c.kind, p.id AS parent_id, p.kind AS parent_kind
FROM categories c JOIN categories p ON p.id = c.parent_id
WHERE c.kind <> p.kind`,
  },
  {
    id: 17,
    extra: true,
    name: 'occurred_at is a local timestamp shaped YYYY-MM-DDTHH:MM:SS',
    sql: `SELECT id, occurred_at
FROM transactions
WHERE occurred_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]'`,
  },
];

export type Row = Record<string, unknown>;
/** Runs a SELECT and returns all rows. Adapt better-sqlite3 / expo-sqlite to this. */
export type QueryFn = (sql: string) => Row[];

export interface InvariantResult {
  invariant: Invariant;
  rows: Row[];
  passed: boolean;
}

export function runInvariants(query: QueryFn): InvariantResult[] {
  return INVARIANTS.map((invariant) => {
    const rows = query(invariant.sql);
    return { invariant, rows, passed: rows.length === 0 };
  });
}
