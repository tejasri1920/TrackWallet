import { isNull } from 'drizzle-orm';
import { accounts, categories, people, transactions } from '../db/schema';
import type { AppDb } from '../db/types';
import { HEADER, type SourceType } from './trackwallet';
import { formatMinorUnits } from './money';

/** One transaction leg flattened into TrackWallet's column layout. */
export interface ExportRow {
  /** Transaction id; not rendered, lets callers line rows up with the database. */
  id?: string;
  occurredAt: string;
  type: SourceType;
  account: string;
  currency: string;
  amountNative: number;
  amountUsd: number;
  category: string;
  subcategory: string;
  note: string;
}

export interface ExportFilter {
  /** Inclusive lower bound on occurred_at (e.g. `2026-08-01T00:00:00`). */
  from?: string;
  /** Inclusive upper bound on occurred_at. */
  to?: string;
  /** Restrict to these transaction ids. */
  ids?: ReadonlySet<string>;
}

const TYPE_LABEL: Record<SourceType, string> = { income: 'Income', expense: 'Expense', transfer: 'Transfer' };

/** Live (not soft-deleted) transactions as export rows, newest first like TrackWallet. */
export function loadExportRows(db: AppDb, filter: ExportFilter = {}): ExportRow[] {
  const accountName = new Map(db.select().from(accounts).all().map((a) => [a.id, a.name]));
  const cats = new Map(db.select().from(categories).all().map((c) => [c.id, c]));
  const personName = new Map(db.select().from(people).all().map((p) => [p.id, p.name]));

  return db
    .select()
    .from(transactions)
    .where(isNull(transactions.deletedAt))
    .all()
    .filter((t) => (!filter.ids || filter.ids.has(t.id)) && (!filter.from || t.occurredAt >= filter.from) && (!filter.to || t.occurredAt <= filter.to))
    .map((t): ExportRow => {
      const cat = t.categoryId ? cats.get(t.categoryId) : undefined;
      const parent = cat?.parentId ? cats.get(cat.parentId) : undefined;
      return {
        id: t.id,
        occurredAt: t.occurredAt,
        type: t.type,
        account: accountName.get(t.accountId) ?? '',
        currency: t.currency,
        amountNative: t.amountNative,
        amountUsd: t.amountUsd,
        category: parent ? parent.name : (cat?.name ?? ''),
        subcategory: parent ? (cat?.name ?? '') : '',
        note: (t.personId ? personName.get(t.personId) : null) ?? t.merchant ?? t.note ?? '',
      };
    })
    .sort(
      (a, b) =>
        b.occurredAt.localeCompare(a.occurredAt) || a.amountNative - b.amountNative || a.account.localeCompare(b.account),
    );
}

const quote = (s: string) => `"${s.replace(/"/g, '""')}"`;

/**
 * Renders rows in TrackWallet's exact style: every field quoted, amounts unpadded
 * (`650`, `-547.60`), and transfer rows carry bare empty Category/Subcategory fields (`,,`).
 */
export function renderTrackWalletCsv(rows: readonly ExportRow[], eol = '\n'): string {
  const lines = [HEADER.join(',')];
  for (const r of rows) {
    const cat = r.type === 'transfer' ? ['', ''] : [quote(r.category), quote(r.subcategory)];
    lines.push(
      [
        quote(r.occurredAt), quote(TYPE_LABEL[r.type]), quote(r.account), quote(r.currency),
        quote(formatMinorUnits(r.amountNative)), quote(formatMinorUnits(r.amountUsd)),
        ...cat, quote(r.note),
      ].join(','),
    );
  }
  return lines.join(eol) + eol;
}

export function exportTrackWalletCsv(db: AppDb, filter: ExportFilter = {}): string {
  return renderTrackWalletCsv(loadExportRows(db, filter));
}
