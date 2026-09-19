import { sql, type SQL } from 'drizzle-orm';
import { categories, type CategoryKind } from '../db/schema';
import type { DataContext } from './context';
import { assertRange, type DateRange } from './dates';

/**
 * Analytics over a range of days. Every figure sums the STORED `amount_usd` (never recomputed from
 * a rate) of live transactions, and transfers are never counted as income or spending: that is what
 * keeps card payments, money sent home and settlements out of the spending totals.
 */
export interface SummaryOptions {
  accountIds?: string[];
}

// An empty list is an empty selection: it matches nothing (it must not fall back to "all accounts").
const accountFilter = (ids: string[] | undefined): SQL =>
  ids === undefined
    ? sql``
    : ids.length === 0
      ? sql`AND 0`
      : sql`AND t.account_id IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`;

export interface CashFlow {
  incomeCents: number;
  /** A positive magnitude. */
  expenseCents: number;
  netCents: number;
}

export function cashFlow(ctx: DataContext, range: DateRange, options: SummaryOptions = {}): CashFlow {
  assertRange(range);
  const row = ctx.db.all(sql`
    SELECT COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_usd END), 0) AS income,
           COALESCE(SUM(CASE WHEN t.type = 'expense' THEN -t.amount_usd END), 0) AS expense
    FROM transactions t
    WHERE t.deleted_at IS NULL AND t.type IN ('income', 'expense')
      AND t.occurred_at >= ${range.from} AND t.occurred_at < ${range.toExclusive}
      ${accountFilter(options.accountIds)}`)[0] as { income: number; expense: number };
  return { incomeCents: row.income, expenseCents: row.expense, netCents: row.income - row.expense };
}

export interface CategoryTotal {
  categoryId: string;
  name: string;
  /** Everything in this category: what was posted to it directly plus all its subcategories. */
  totalCents: number;
  /** Posted directly to the top-level category, with no subcategory. */
  directCents: number;
  children: { categoryId: string; name: string; totalCents: number }[];
}

/** Spending (or income) by top-level category with subcategory detail, largest first. Amounts are positive magnitudes. */
export function categoryBreakdown(
  ctx: DataContext,
  kind: CategoryKind,
  range: DateRange,
  options: SummaryOptions = {},
): CategoryTotal[] {
  assertRange(range);
  const sign = kind === 'expense' ? -1 : 1;
  const sums = ctx.db.all(sql`
    SELECT t.category_id AS id, SUM(t.amount_usd * ${sign}) AS total
    FROM transactions t
    WHERE t.deleted_at IS NULL AND t.type = ${kind} AND t.category_id IS NOT NULL
      AND t.occurred_at >= ${range.from} AND t.occurred_at < ${range.toExclusive}
      ${accountFilter(options.accountIds)}
    GROUP BY t.category_id`) as { id: string; total: number }[];

  const cats = new Map(ctx.db.select().from(categories).all().map((c) => [c.id, c]));
  const tops = new Map<string, CategoryTotal>();
  const top = (id: string): CategoryTotal => {
    let entry = tops.get(id);
    if (!entry) {
      entry = { categoryId: id, name: cats.get(id)?.name ?? '(unknown)', totalCents: 0, directCents: 0, children: [] };
      tops.set(id, entry);
    }
    return entry;
  };

  for (const s of sums) {
    const cat = cats.get(s.id);
    if (cat?.parentId) {
      const parent = top(cat.parentId);
      parent.children.push({ categoryId: cat.id, name: cat.name, totalCents: s.total });
      parent.totalCents += s.total;
    } else {
      const entry = top(s.id);
      entry.directCents += s.total;
      entry.totalCents += s.total;
    }
  }
  const byTotal = <T extends { totalCents: number; name: string }>(a: T, b: T) => b.totalCents - a.totalCents || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  const result = [...tops.values()].sort(byTotal);
  for (const r of result) r.children.sort(byTotal);
  return result;
}

export interface DaySummary {
  /** `YYYY-MM-DD` */
  date: string;
  incomeCents: number;
  expenseCents: number;
  /** The calendar marks days that contain a transfer. */
  hasTransfer: boolean;
}

/** One entry per day that has any activity (income above expense, plus a transfer marker), for the month calendar. */
export function dailySummary(ctx: DataContext, range: DateRange, options: SummaryOptions = {}): DaySummary[] {
  assertRange(range);
  const rows = ctx.db.all(sql`
    SELECT substr(t.occurred_at, 1, 10) AS day,
           COALESCE(SUM(CASE WHEN t.type = 'income' THEN t.amount_usd END), 0) AS income,
           COALESCE(SUM(CASE WHEN t.type = 'expense' THEN -t.amount_usd END), 0) AS expense,
           MAX(CASE WHEN t.type = 'transfer' THEN 1 ELSE 0 END) AS has_transfer
    FROM transactions t
    WHERE t.deleted_at IS NULL
      AND t.occurred_at >= ${range.from} AND t.occurred_at < ${range.toExclusive}
      ${accountFilter(options.accountIds)}
    GROUP BY day
    ORDER BY day`) as { day: string; income: number; expense: number; has_transfer: number }[];
  return rows.map((r) => ({ date: r.day, incomeCents: r.income, expenseCents: r.expense, hasTransfer: r.has_transfer === 1 }));
}
