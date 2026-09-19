import { MAX_CENTS } from '../db/limits';
import { CsvError, parseCsv } from './csv';
import { parseMinorUnits } from './money';
import { fold } from './text';

export const HEADER = [
  'Date', 'Transaction', 'Account', 'Currency', 'Amount', 'Amount_USD', 'Category', 'Subcategory', 'Note',
] as const;

export type SourceType = 'income' | 'expense' | 'transfer';

/** One validated data row of a TrackWallet export. Amounts are signed minor units. */
export interface SourceRow {
  /** 1-based line in the source file. */
  line: number;
  /** The record's original text, for reports. */
  raw: string;
  /** Local time, always with seconds: `YYYY-MM-DDTHH:MM:SS`. */
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

/** A record that could not be turned into a SourceRow. Any issue blocks a commit. */
export interface RowIssue {
  line: number;
  raw: string;
  message: string;
}

/** The file as a whole is unusable (wrong header, malformed CSV). */
export class ImportFatalError extends Error {}

const TIMESTAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Accepts `YYYY-MM-DDTHH:MM` and `YYYY-MM-DDTHH:MM:SS`; returns the latter. Throws otherwise. */
export function normalizeTimestamp(value: string): string {
  const m = TIMESTAMP.exec(value);
  if (!m) throw new Error(`unrecognised timestamp ${JSON.stringify(value)} (expected YYYY-MM-DDTHH:MM[:SS])`);
  const [year, month, day, hour, minute, second] = [m[1], m[2], m[3], m[4], m[5], m[6] ?? '00'].map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23 || minute > 59 || second > 59) {
    throw new Error(`impossible date/time ${JSON.stringify(value)}`);
  }
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? '00'}`;
}

// A Map, not an object: a Transaction value of 'constructor' or '__proto__' must not resolve.
const TYPES = new Map<string, SourceType>([['income', 'income'], ['expense', 'expense'], ['transfer', 'transfer']]);

/**
 * Parses and validates a whole export. Every data record ends up in exactly one of `rows` or
 * `issues`; nothing is dropped. Amounts already carry their sign: it is asserted against the
 * transaction type, never re-applied.
 */
export function parseTrackWallet(text: string): { rows: SourceRow[]; issues: RowIssue[] } {
  let records;
  try {
    records = parseCsv(text);
  } catch (e) {
    if (e instanceof CsvError) throw new ImportFatalError(`malformed CSV, ${e.message}`);
    throw e;
  }
  if (records.length === 0) throw new ImportFatalError('the file is empty');
  const header = records[0].fields;
  if (header.length !== HEADER.length || header.some((h, i) => h !== HEADER[i])) {
    throw new ImportFatalError(
      `unexpected header.\n  expected: ${HEADER.join(',')}\n  found:    ${header.join(',')}`,
    );
  }

  const rows: SourceRow[] = [];
  const issues: RowIssue[] = [];
  for (const rec of records.slice(1)) {
    const problems: string[] = [];
    const f = rec.fields;
    if (f.length !== HEADER.length) {
      issues.push({ line: rec.line, raw: rec.raw, message: `expected ${HEADER.length} fields, found ${f.length}` });
      continue;
    }
    const [date, txn, accountRaw, currency, amount, amountUsd, categoryRaw, subcategoryRaw, note] = f;
    // Structural names are trimmed so 'Leisure ' cannot become a second category. The Note is kept
    // verbatim (a merchant is a merchant); only a person name taken from it is trimmed later.
    const account = accountRaw.trim();
    const category = categoryRaw.trim();
    const subcategory = subcategoryRaw.trim();

    let occurredAt = '';
    try { occurredAt = normalizeTimestamp(date); } catch (e) { problems.push((e as Error).message); }

    const type = TYPES.get(txn.toLowerCase());
    if (!type) problems.push(`unknown transaction type ${JSON.stringify(txn)}`);

    let native = 0;
    let usd = 0;
    try { native = parseMinorUnits(amount); } catch (e) { problems.push(`Amount: ${(e as Error).message}`); }
    try { usd = parseMinorUnits(amountUsd); } catch (e) { problems.push(`Amount_USD: ${(e as Error).message}`); }

    if (Math.abs(native) > MAX_CENTS || Math.abs(usd) > MAX_CENTS) {
      problems.push(`amount is larger than the limit of ${MAX_CENTS / 100} dollars`);
    }
    if (account === '') problems.push('Account is empty');
    if (currency !== 'USD') {
      problems.push(`currency ${JSON.stringify(currency)} is not supported yet (USD only)`);
    } else if (native !== usd) {
      problems.push(`USD row has Amount ${amount} but Amount_USD ${amountUsd}`);
    }

    if (problems.length === 0 && type) {
      if (native === 0) problems.push('amount is zero');
      else if (type === 'expense' && native > 0) problems.push(`Expense must be negative, got ${amount}`);
      else if (type === 'income' && native < 0) problems.push(`Income must be positive, got ${amount}`);
      if (type !== 'transfer' && category === '') problems.push(`${txn} row has no Category`);
      if (type === 'transfer' && (category !== '' || subcategory !== '')) {
        problems.push('Transfer row has a Category/Subcategory');
      }
    }

    if (problems.length > 0 || !type) {
      issues.push({ line: rec.line, raw: rec.raw, message: problems.join('; ') });
    } else {
      rows.push({
        line: rec.line, raw: rec.raw, occurredAt, type, account, currency,
        amountNative: native, amountUsd: usd, category, subcategory, note,
      });
    }
  }
  return { rows, issues };
}

export interface TransferPair {
  /** The leg that loses money (negative amount). */
  negative: SourceRow;
  /** The leg that gains it. */
  positive: SourceRow;
}

export interface UnpairedTransfer {
  row: SourceRow;
  reason: string;
}

type AccountMatching =
  | { kind: 'none' }
  | { kind: 'ambiguous' }
  | { kind: 'unique'; cells: { neg: string; pos: string; count: number }[] };

/**
 * Given how many outgoing and incoming legs each account has (all of one amount, one minute),
 * finds every way to match them so that no leg is matched with a leg on its own account.
 * Two matchings are the same if they pair the same accounts the same number of times: which
 * particular row of an account is used does not matter. Returns the matching only if it is the
 * ONLY one; otherwise 'none' (impossible) or 'ambiguous' (several different account pairings).
 * The answer depends only on the account counts, never on the order rows appear in the file.
 */
function matchAccounts(negCounts: Map<string, number>, posCounts: Map<string, number>): AccountMatching {
  const negAccts = [...negCounts.keys()].sort();
  const posAccts = [...posCounts.keys()].sort();
  const remaining = new Map(posCounts);
  const cells: { neg: string; pos: string; count: number }[] = [];
  const found: { neg: string; pos: string; count: number }[][] = [];

  const distribute = (ni: number, pj: number, left: number): void => {
    if (found.length > 1) return;
    if (ni === negAccts.length) {
      if ([...remaining.values()].every((v) => v === 0)) found.push(cells.filter((c) => c.count > 0).map((c) => ({ ...c })));
      return;
    }
    if (pj === posAccts.length) {
      if (left === 0) distribute(ni + 1, 0, negCounts.get(negAccts[ni + 1]) ?? 0);
      return;
    }
    const neg = negAccts[ni];
    const pos = posAccts[pj];
    const cap = pos === neg ? 0 : Math.min(left, remaining.get(pos)!);
    for (let count = cap; count >= 0; count--) {
      remaining.set(pos, remaining.get(pos)! - count);
      cells.push({ neg, pos, count });
      distribute(ni, pj + 1, left - count);
      cells.pop();
      remaining.set(pos, remaining.get(pos)! + count);
      if (found.length > 1) return;
    }
  };

  distribute(0, 0, negCounts.get(negAccts[0]) ?? 0);
  if (found.length === 0) return { kind: 'none' };
  if (found.length > 1) return { kind: 'ambiguous' };
  return { kind: 'unique', cells: found[0] };
}

/**
 * Pairs the two exported rows of each transfer (Section 6.3): group by exact timestamp; within
 * a group, match outgoing and incoming rows of equal |Amount_USD| so that no leg is matched with
 * a leg on its own account. If anything in a timestamp group is odd, impossible or ambiguous, the
 * WHOLE group is left unpaired. A counter-leg is never invented and a pairing is never guessed:
 * a pairing is used only when it is the only one the accounts allow.
 *
 * The outcome (paired or not, and which accounts pair) does not depend on the order of rows in
 * the file. Accounts are compared case-insensitively, like the database resolves them. Among
 * rows of the same account, `isKnown` (is this row already in the database?) decides which
 * incoming row goes with which outgoing row, so already-imported legs stay together; without
 * it two identical same-minute transfers could pair crosswise against what is stored, look
 * half-imported, and be skipped forever.
 */
export function pairTransfers(
  transfers: SourceRow[],
  isKnown?: (row: SourceRow) => boolean,
): { pairs: TransferPair[]; unpaired: UnpairedTransfer[] } {
  const groups = new Map<string, SourceRow[]>();
  for (const r of transfers) {
    const g = groups.get(r.occurredAt);
    if (g) g.push(r); else groups.set(r.occurredAt, [r]);
  }

  const pairs: TransferPair[] = [];
  const unpaired: UnpairedTransfer[] = [];

  for (const [ts, rows] of groups) {
    const fail = (reason: string) => {
      for (const row of rows) unpaired.push({ row, reason: `${reason} (timestamp ${ts}, ${rows.length} transfer row(s))` });
    };
    if (rows.length % 2 !== 0) { fail('odd number of transfer rows'); continue; }

    const negatives = rows.filter((r) => r.amountUsd < 0);
    const positives = rows.filter((r) => r.amountUsd > 0);
    if (negatives.length !== positives.length) {
      fail(`${negatives.length} outgoing vs ${positives.length} incoming rows`);
      continue;
    }

    // One independent matching problem per amount.
    const byAmount = new Map<number, { neg: SourceRow[]; pos: SourceRow[] }>();
    for (const r of rows) {
      const key = Math.abs(r.amountUsd);
      const cls = byAmount.get(key) ?? { neg: [], pos: [] };
      (r.amountUsd < 0 ? cls.neg : cls.pos).push(r);
      byAmount.set(key, cls);
    }

    const groupPairs: TransferPair[] = [];
    let failure = '';
    for (const cls of byAmount.values()) {
      const firstLine = (cls.neg[0] ?? cls.pos[0]).line;
      if (cls.neg.length !== cls.pos.length) { failure = `no counter-leg for line ${firstLine}`; break; }

      const count = (list: SourceRow[]) => {
        const m = new Map<string, number>();
        for (const r of list) m.set(fold(r.account), (m.get(fold(r.account)) ?? 0) + 1);
        return m;
      };
      const matching = matchAccounts(count(cls.neg), count(cls.pos));
      if (matching.kind === 'none') { failure = `no counter-leg for line ${firstLine}`; break; }
      if (matching.kind === 'ambiguous') {
        failure = `ambiguous counter-leg for line ${firstLine} (candidates on different accounts)`;
        break;
      }

      const freeNeg = [...cls.neg];
      const freePos = [...cls.pos];
      for (const cell of matching.cells) {
        for (let i = 0; i < cell.count; i++) {
          const ni = freeNeg.findIndex((r) => fold(r.account) === cell.neg);
          const neg = freeNeg.splice(ni, 1)[0];
          const candidates = freePos.filter((r) => fold(r.account) === cell.pos);
          const pos = (isKnown && candidates.find((c) => isKnown(c) === isKnown(neg))) || candidates[0];
          freePos.splice(freePos.indexOf(pos), 1);
          groupPairs.push({ negative: neg, positive: pos });
        }
      }
    }
    if (failure) fail(failure); else pairs.push(...groupPairs);
  }
  return { pairs, unpaired };
}
