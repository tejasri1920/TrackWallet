import { invalid } from './errors';

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

/**
 * Calendar dates are plain `YYYY-MM-DD` strings compared lexicographically against the local-time
 * `occurred_at` strings. No timezone is ever involved, so a transaction can never move to another
 * day. Date arithmetic below uses UTC only as a calendar calculator on the date parts.
 */
export function assertDate(value: string, label = 'date'): void {
  const m = DATE.exec(value);
  if (!m) throw invalid(`${label} must look like YYYY-MM-DD`);
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) {
    throw invalid(`${label} is not a real calendar date: ${value}`);
  }
}

export function addDays(date: string, days: number): string {
  assertDate(date);
  const [y, mo, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, mo - 1, d) + days * DAY_MS);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${p(t.getUTCFullYear(), 4)}-${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())}`;
}

/** Days from `from` to `to` (both dates), positive if `to` is later. */
export function daysBetween(from: string, to: string): number {
  assertDate(from);
  assertDate(to);
  const ms = (s: string) => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
  return Math.round((ms(to) - ms(from)) / DAY_MS);
}

/** A half-open range of days: `from` inclusive, `toExclusive` exclusive. */
export interface DateRange {
  from: string;
  toExclusive: string;
}

export function assertRange(range: DateRange): void {
  assertDate(range.from, 'range start');
  assertDate(range.toExclusive, 'range end');
  if (range.toExclusive <= range.from) throw invalid('range end must be after range start');
}

export const dayRange = (date: string): DateRange => ({ from: date, toExclusive: addDays(date, 1) });

/** The whole calendar month, `month` being 1-12. */
export function monthRange(year: number, month: number): DateRange {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw invalid('month must be 1-12');
  }
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const from = `${p(year, 4)}-${p(month)}-01`;
  const toExclusive = month === 12 ? `${p(year + 1, 4)}-01-01` : `${p(year, 4)}-${p(month + 1)}-01`;
  return { from, toExclusive };
}
