import { sql } from 'drizzle-orm';
import type { AccountType } from '../db/schema';
import type { AppDb } from '../db/types';
import type { DataContext } from './context';
import { addDays, assertDate, daysBetween } from './dates';
import { invalid } from './errors';

export interface AccountBalance {
  accountId: string;
  name: string;
  type: AccountType;
  currency: string;
  archived: boolean;
  /** What the account held before the first recorded transaction. */
  openingCents: number;
  /** Opening balance plus every live transaction (up to the end of `asOfDate` if given). */
  balanceCents: number;
}

export interface BalanceOptions {
  /**
   * Balance at the END of this day (`YYYY-MM-DD`). Default: counting EVERYTHING, including entries
   * dated in the future. For a headline that matches a chart ending today, pass today's date.
   */
  asOfDate?: string;
  /** Archived accounts still hold money; they are included unless you say otherwise. */
  includeArchived?: boolean;
}

interface BalanceRow {
  id: string;
  name: string;
  type: AccountType;
  currency: string;
  archived_at: string | null;
  opening: number;
  balance: number;
}

/**
 * Per-account balances: opening balance + the sum of `amount_native` of live (not deleted)
 * transactions. A transfer is two ordinary signed legs, so it moves money between accounts without
 * changing the total. Deleted rows never count. Stored amounts are summed as stored.
 */
export function accountBalances(ctx: DataContext, options: BalanceOptions = {}): AccountBalance[] {
  const upto = options.asOfDate !== undefined ? addDays(options.asOfDate, 1) : null; // exclusive bound
  const includeArchived = options.includeArchived === false ? 0 : 1;
  const rows = ctx.db.all(sql`
    SELECT a.id AS id, a.name AS name, a.type AS type, a.currency AS currency, a.archived_at AS archived_at,
           a.opening_balance_native AS opening,
           a.opening_balance_native + COALESCE(SUM(t.amount_native), 0) AS balance
    FROM accounts a
    LEFT JOIN transactions t
      ON t.account_id = a.id AND t.deleted_at IS NULL AND (${upto} IS NULL OR t.occurred_at < ${upto})
    WHERE (${includeArchived} = 1 OR a.archived_at IS NULL)
    GROUP BY a.id
    ORDER BY a.sort_order, a.name`) as BalanceRow[];
  return rows.map((r) => ({
    accountId: r.id, name: r.name, type: r.type, currency: r.currency, archived: r.archived_at !== null,
    openingCents: r.opening, balanceCents: r.balance,
  }));
}

/**
 * Every live transaction on the included accounts must be in USD. The per-account balance sums
 * native amounts while totals and the series sum USD amounts; they agree only for USD rows, so a
 * foreign-currency transaction (which nothing in the app can create today) is refused loudly
 * instead of letting the two silently drift apart.
 */
function assertNoForeignTransactions(ctx: DataContext, includeArchived: number): void {
  const row = ctx.db.all(sql`
    SELECT a.name AS name, t.currency AS currency
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.deleted_at IS NULL AND (${includeArchived} = 1 OR a.archived_at IS NULL) AND t.currency <> 'USD'
    LIMIT 1`)[0] as { name: string; currency: string } | undefined;
  if (row) throw invalid(`a transaction on "${row.name}" is in ${row.currency}: totals across currencies are not supported yet`);
}

/**
 * The headline number: the sum of all account balances, negatives included (a credit card or loan
 * legitimately makes it negative; it is never clamped or hidden). Money is only summed across
 * accounts of one currency, so this refuses a mix instead of adding native amounts of different
 * currencies.
 */
export function totalBalanceCents(ctx: DataContext, options: BalanceOptions = {}): number {
  const balances = accountBalances(ctx, options);
  const foreign = balances.find((b) => b.currency !== 'USD');
  if (foreign) {
    throw invalid(
      `account "${foreign.name}" is in ${foreign.currency}: a total across currencies needs a stored USD equivalent of its opening balance, which is not supported yet`,
    );
  }
  assertNoForeignTransactions(ctx, options.includeArchived === false ? 0 : 1);
  return balances.reduce((sum, b) => sum + b.balanceCents, 0);
}

export interface SeriesPoint {
  /** `YYYY-MM-DD`; the value is the total at the END of that day. */
  date: string;
  totalCents: number;
}

const MAX_SERIES_DAYS = 3660;

/**
 * Total balance at the end of each day from `from` to `to` inclusive, for the balance-over-time
 * chart. It uses one grouped query plus running totals, and equals `totalBalanceCents` with the
 * matching `asOfDate` for every day (tested).
 */
export function balanceSeries(
  ctx: DataContext,
  range: { from: string; to: string },
  options: { includeArchived?: boolean } = {},
): SeriesPoint[] {
  assertDate(range.from, 'from');
  assertDate(range.to, 'to');
  const days = daysBetween(range.from, range.to) + 1;
  if (days < 1) throw invalid('the end date must not be before the start date');
  if (days > MAX_SERIES_DAYS) throw invalid(`a series can cover at most ${MAX_SERIES_DAYS} days`);

  const includeArchived = options.includeArchived === false ? 0 : 1;
  const accountsIncluded = ctx.db.all(sql`
    SELECT currency AS currency, opening_balance_native AS opening, name AS name FROM accounts
    WHERE (${includeArchived} = 1 OR archived_at IS NULL)`) as { currency: string; opening: number; name: string }[];
  const foreign = accountsIncluded.find((a) => a.currency !== 'USD');
  if (foreign) throw invalid(`account "${foreign.name}" is in ${foreign.currency}: a series across currencies is not supported yet`);
  assertNoForeignTransactions(ctx, includeArchived);

  const end = addDays(range.to, 1);
  const perDay = ctx.db.all(sql`
    SELECT substr(t.occurred_at, 1, 10) AS day, SUM(t.amount_usd) AS s
    FROM transactions t JOIN accounts a ON a.id = t.account_id
    WHERE t.deleted_at IS NULL AND (${includeArchived} = 1 OR a.archived_at IS NULL) AND t.occurred_at < ${end}
    GROUP BY day`) as { day: string; s: number }[];

  let running = accountsIncluded.reduce((sum, a) => sum + a.opening, 0);
  const byDay = new Map<string, number>();
  for (const r of perDay) {
    if (r.day < range.from) running += r.s;
    else byDay.set(r.day, r.s);
  }

  const points: SeriesPoint[] = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(range.from, i);
    running += byDay.get(date) ?? 0;
    points.push({ date, totalCents: running });
  }
  return points;
}

export type { AppDb };
