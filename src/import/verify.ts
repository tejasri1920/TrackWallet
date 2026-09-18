import { and, inArray, isNull } from 'drizzle-orm';
import { accounts, transactions, type Transaction } from '../db/schema';
import type { AppDb } from '../db/types';
import { parseCsv } from './csv';
import { loadExportRows, renderTrackWalletCsv, type ExportRow } from './export';
import { formatFixed2, parseMinorUnits } from './money';
import { hashRows } from './plan';
import { fold, foldTrim } from './text';
import { normalizeTimestamp, pairTransfers, parseTrackWallet, type SourceRow } from './trackwallet';

export interface CheckResult {
  name: string;
  passed: boolean;
  lines: string[];
}

export interface VerifyReport {
  checks: CheckResult[];
  passed: boolean;
}

const CHUNK = 500;
/** Column positions whose spelling may legitimately change on import (case / padding): Account, Category, Subcategory, Note. */
const NAME_FIELDS = new Set([2, 6, 7, 8]);
const FIELDS = ['Date', 'Transaction', 'Account', 'Currency', 'Amount', 'Amount_USD', 'Category', 'Subcategory', 'Note'];

/**
 * Verifies that a TrackWallet CSV was imported losslessly into `db` (the import-verify skill).
 * Everything is recomputed from the CSV text and read back from the database; the report prints
 * the actual numbers on both sides of each comparison.
 *
 * Counted normalizations (decision H) are the ONLY differences tolerated between the CSV and the
 * exported data: timestamp seconds, expense `Returned` -> `Repaid`, and the case/whitespace of
 * account, category, subcategory and person names. Anything else is a FAIL.
 */
export interface VerifyOptions {
  /**
   * Verify only the rows carrying these import hashes, i.e. what a commit has just written. A
   * whole-file verification also holds rows that were imported earlier and may since have been
   * edited or deleted on purpose in the app; those must not veto an unrelated new import. The
   * default is the whole file (what `npm run import-verify` reports).
   */
  only?: ReadonlySet<string>;
  /** The caller was told about lookalike rows and accepted them: check 6 reports them but does not fail. */
  acknowledgedLookalikes?: boolean;
}

export function verifyImport(db: AppDb, csvText: string, options: VerifyOptions = {}): VerifyReport {
  const parsed = parseTrackWallet(csvText);
  const allHashes = hashRows(parsed.rows); // occurrence indexes are per FILE, so hash before scoping
  const keep = parsed.rows.map((_, i) => !options.only || options.only.has(allHashes[i]));
  const rows = parsed.rows.filter((_, i) => keep[i]);
  const hashes = allHashes.filter((_, i) => keep[i]);
  const issues = options.only ? [] : parsed.issues;
  const hashOf = new Map<SourceRow, string>(rows.map((r, i) => [r, hashes[i]]));

  const byHash = new Map<string, Transaction>();
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const chunk = hashes.slice(i, i + CHUNK);
    for (const t of db
      .select()
      .from(transactions)
      .where(and(inArray(transactions.importHash, chunk), isNull(transactions.deletedAt)))
      .all()) {
      if (t.importHash) byHash.set(t.importHash, t);
    }
  }
  const inDb = (r: SourceRow) => byHash.has(hashOf.get(r)!);
  const txOf = (r: SourceRow) => byHash.get(hashOf.get(r)!)!;

  // Only the SET of unpaired rows is needed here. It does not depend on how interchangeable legs
  // are matched, so no importer-side tie-breaking (and no "already imported" hint) is involved.
  const { unpaired } = pairTransfers(rows.filter((r) => r.type === 'transfer'));
  const unpairedRows = new Set(unpaired.map((u) => u.row));
  const committed = rows.filter(inDb);
  const accountName = new Map(db.select().from(accounts).all().map((a) => [a.id, a.name]));
  const checks: CheckResult[] = [];

  // 1. Row accounting -------------------------------------------------------------------------
  {
    const skipped = rows.filter((r) => unpairedRows.has(r));
    const missing = rows.filter((r) => !inDb(r) && !unpairedRows.has(r));
    const skippedButPresent = skipped.filter(inDb);
    const rowsRead = rows.length + issues.length;
    const accounted = committed.length + skipped.length - skippedButPresent.length + issues.length;
    const lines = [
      `rows read from CSV:                    ${rowsRead}`,
      `committed (found in database by hash): ${committed.length}`,
      `explicitly skipped (unpaired transfer): ${skipped.length}`,
      `failed validation:                     ${issues.length}`,
      `silently missing:                      ${missing.length}`,
      `accounted for: ${accounted} of ${rowsRead}`,
    ];
    for (const r of missing) lines.push(`  MISSING line ${r.line}: ${r.raw}`);
    for (const r of skippedButPresent) lines.push(`  SKIPPED BUT PRESENT line ${r.line}: ${r.raw}`);
    for (const r of skipped) lines.push(`  skipped line ${r.line}: ${r.raw}`);
    for (const i of issues) lines.push(`  ISSUE line ${i.line}: ${i.message}`);
    checks.push({
      name: '1. Row accounting: every source row is a committed leg or on the skipped list',
      passed: missing.length === 0 && skippedButPresent.length === 0 && issues.length === 0 && accounted === rowsRead,
      lines,
    });
  }

  // 2. Per-account totals ---------------------------------------------------------------------
  {
    const csvNative = new Map<string, number>();
    const csvUsd = new Map<string, number>();
    const csvAllNative = new Map<string, number>();
    for (const r of rows) {
      const k = fold(r.account);
      csvAllNative.set(k, (csvAllNative.get(k) ?? 0) + r.amountNative);
      if (inDb(r)) {
        csvNative.set(k, (csvNative.get(k) ?? 0) + r.amountNative);
        csvUsd.set(k, (csvUsd.get(k) ?? 0) + r.amountUsd);
      }
    }
    const dbNative = new Map<string, number>();
    const dbUsd = new Map<string, number>();
    for (const r of committed) {
      const t = txOf(r);
      const k = fold(accountName.get(t.accountId) ?? '?');
      dbNative.set(k, (dbNative.get(k) ?? 0) + t.amountNative);
      dbUsd.set(k, (dbUsd.get(k) ?? 0) + t.amountUsd);
    }
    const names = [...new Set([...csvAllNative.keys(), ...dbNative.keys()])].sort();
    let ok = true;
    const lines: string[] = [];
    for (const k of names) {
      const cn = csvNative.get(k) ?? 0, dn = dbNative.get(k) ?? 0;
      const cu = csvUsd.get(k) ?? 0, du = dbUsd.get(k) ?? 0;
      const same = cn === dn && cu === du;
      ok = ok && same;
      const skippedDiff = (csvAllNative.get(k) ?? 0) - cn;
      lines.push(
        `${same ? 'OK  ' : 'DIFF'} ${k.padEnd(20)} CSV sum(Amount)=${formatSigned(cn)}  DB sum(amount_native)=${formatSigned(dn)}` +
          `  |  CSV sum(Amount_USD)=${formatSigned(cu)}  DB sum(amount_usd)=${formatSigned(du)}` +
          (skippedDiff !== 0 ? `  (skipped rows carry ${formatSigned(skippedDiff)})` : ''),
      );
    }
    checks.push({ name: '2. Per-account totals: CSV sums equal database sums exactly', passed: ok, lines });
  }

  // 3 + 4. Transfer pairing and orphans ------------------------------------------------------
  {
    const matched = committed.filter((r) => r.type === 'transfer').map(txOf);
    const groupIds = [...new Set(matched.map((t) => t.transferGroupId).filter((g): g is string => !!g))];
    const legsByGroup = new Map<string, Transaction[]>();
    if (groupIds.length > 0) {
      for (const t of db.select().from(transactions).where(and(isNull(transactions.deletedAt), inArray(transactions.transferGroupId, groupIds))).all()) {
        const g = t.transferGroupId!;
        legsByGroup.set(g, [...(legsByGroup.get(g) ?? []), t]);
      }
    }
    const pairingLines: string[] = [];
    let badGroups = 0;
    for (const g of groupIds) {
      const legs = legsByGroup.get(g) ?? [];
      const nat = legs.reduce((s, l) => s + l.amountNative, 0);
      const usd = legs.reduce((s, l) => s + l.amountUsd, 0);
      if (legs.length !== 2 || nat !== 0 || usd !== 0) {
        badGroups++;
        pairingLines.push(`  BAD group ${g}: ${legs.length} live legs, sum native=${nat}, sum usd=${usd}`);
      }
    }
    // Read the database's own grouping back onto the CSV rows: every group must hold exactly two
    // CSV rows that form a genuine transfer (same minute, opposite amounts, different accounts).
    // This catches legs swapped between groups even when every group still sums to zero.
    const bySourceGroup = new Map<string, SourceRow[]>();
    for (const r of committed.filter((x) => x.type === 'transfer')) {
      const g = txOf(r).transferGroupId ?? `(no group: line ${r.line})`;
      bySourceGroup.set(g, [...(bySourceGroup.get(g) ?? []), r]);
    }
    let invalidPairs = 0;
    for (const [g, rs] of bySourceGroup) {
      const valid =
        rs.length === 2 &&
        rs[0].occurredAt === rs[1].occurredAt &&
        rs[0].amountUsd === -rs[1].amountUsd &&
        fold(rs[0].account) !== fold(rs[1].account);
      if (!valid) {
        invalidPairs++;
        pairingLines.push(`  WRONGLY GROUPED: database group ${g} holds CSV line(s) ${rs.map((r) => r.line).join(', ')}, which do not form a valid transfer pair`);
      }
    }
    const expectedGroups = matched.length / 2;
    pairingLines.unshift(
      `transfer groups in DB: ${groupIds.length} (expected from CSV: ${expectedGroups}); transfer legs in DB: ${matched.length}`,
      `groups with exactly 2 live legs summing to 0 (native and usd): ${groupIds.length - badGroups} of ${groupIds.length}`,
      `database groups holding a valid CSV transfer pair: ${bySourceGroup.size - invalidPairs} of ${bySourceGroup.size}`,
    );
    checks.push({
      name: '3. Transfer pairing: every group has exactly two legs summing to zero, and they are a real CSV pair',
      passed: badGroups === 0 && invalidPairs === 0 && Number.isInteger(expectedGroups) && groupIds.length === expectedGroups,
      lines: pairingLines,
    });

    const orphans = matched.filter((t) => !t.transferGroupId || (legsByGroup.get(t.transferGroupId) ?? []).length !== 2);
    checks.push({
      name: '4. Orphans: no transfer leg without a partner',
      passed: orphans.length === 0,
      lines: [`transfer legs without a partner: ${orphans.length}`, ...orphans.map((t) => `  ORPHAN ${t.id} (${t.occurredAt}, ${t.amountNative})`)],
    });
  }

  // 5. Round trip -----------------------------------------------------------------------------
  {
    const ids = new Set(committed.map((r) => txOf(r).id));
    const exportRows = loadExportRows(db, { ids });
    const exportById = new Map<string, ExportRow>(exportRows.map((e) => [e.id!, e]));
    const exported = renderTrackWalletCsv(exportRows);
    const reparsed = parseTrackWallet(exported);

    // Counted normalizations (decision H). Anything else is a difference.
    const noSeconds = committed.filter((r) => /^"?\d{4}-\d{2}-\d{2}T\d{2}:\d{2}"?,/.test(r.raw)).length;
    const returnedToRepaid = committed.filter((r) => r.type === 'expense' && fold(r.category) === 'returned').length;

    type Cell = string | number;
    const tuple = (r: SourceRow, mapReturned: boolean): Cell[] => [
      r.occurredAt, r.type, r.account, r.currency, r.amountNative, r.amountUsd,
      mapReturned && r.type === 'expense' && fold(r.category) === 'returned' ? 'Repaid' : r.category,
      r.subcategory, r.note,
    ];
    const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0); // not localeCompare: ignorable characters must not reorder rows
    const sortKey = (t: Cell[]) => t.map((v, i) => (NAME_FIELDS.has(i) ? foldTrim(String(v)) : String(v))).join('\u001f');
    const src = committed.map((r) => tuple(r, true)).sort((a, b) => cmp(sortKey(a), sortKey(b)));
    const out = reparsed.rows.map((r) => tuple(r, false)).sort((a, b) => cmp(sortKey(a), sortKey(b)));

    const fieldLines: string[] = [];
    let diffs = 0;
    let respelled = 0;
    if (src.length !== out.length || reparsed.issues.length > 0) {
      diffs++;
      fieldLines.push(`row count differs: source ${src.length}, exported ${out.length}, exported-with-issues ${reparsed.issues.length}`);
    } else {
      src.forEach((s, i) => {
        s.forEach((v, f) => {
          if (v === out[i][f]) return;
          if (NAME_FIELDS.has(f) && foldTrim(String(v)) === foldTrim(String(out[i][f]))) { respelled++; return; }
          diffs++;
          fieldLines.push(`  row ${i + 1}: ${FIELDS[f]}: source=${JSON.stringify(v)} exported=${JSON.stringify(out[i][f])}  [${s.join(' | ')}]`);
        });
      });
    }
    checks.push({
      name: '5a. Round trip (parsed fields): export the imported rows and compare every field',
      passed: diffs === 0,
      lines: [
        `source rows compared: ${src.length}; exported rows: ${out.length}; differing fields: ${diffs}`,
        `normalizations applied (allowed, counted): timestamp seconds added on ${noSeconds} row(s); ` +
          `expense Returned -> Repaid on ${returnedToRepaid} row(s); name case/whitespace respelled in ${respelled} field(s)`,
        ...fieldLines,
      ],
    });

    // Text level, row by row: the exported line must equal the source line after the textual
    // normalizations. A row that differs only by respelled names or by formatting (`-5.0` for
    // `-5`, no quotes, `EXPENSE`) is compared field by field and counted, not failed.
    const sameField = (i: number, want: string, got: string): boolean => {
      if (want === got) return true;
      if (NAME_FIELDS.has(i) && foldTrim(want) === foldTrim(got)) return true;
      try {
        if (i === 0) return normalizeTimestamp(want) === got;
        if (i === 4 || i === 5) return parseMinorUnits(want) === parseMinorUnits(got);
      } catch {
        return false;
      }
      return i === 1 && want.toLowerCase() === got.toLowerCase();
    };
    let identical = 0;
    let respelledOnly = 0;
    let formatOnly = 0;
    const mismatches: string[] = [];
    for (const r of committed) {
      const e = exportById.get(txOf(r).id);
      const rendered = e ? renderTrackWalletCsv([e]) : '';
      // Everything after the header line, minus the final newline: a quoted Note may contain newlines itself.
      const got = rendered ? rendered.slice(rendered.indexOf('\n') + 1).replace(/\n$/, '') : '';
      const returned = r.type === 'expense' && fold(r.category) === 'returned';
      let want = r.raw.replace(/^"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})"/, '"$1:00"');
      let wantFields: string[] = [];
      let gotFields: string[] = [];
      try {
        wantFields = parseCsv(r.raw)[0].fields;
        if (returned) want = want.replace(`,"${wantFields[6]}",`, ',"Repaid",');
        if (returned) wantFields[6] = 'Repaid';
        gotFields = got ? parseCsv(got)[0].fields : [];
      } catch {
        /* an unparseable line is reported as a mismatch below */
      }
      if (got === want) { identical++; continue; }
      const equivalent =
        gotFields.length === wantFields.length && wantFields.length === 9 && wantFields.every((w, i) => sameField(i, w, gotFields[i]));
      if (equivalent) {
        if (wantFields.some((w, i) => NAME_FIELDS.has(i) && w !== gotFields[i])) respelledOnly++; else formatOnly++;
      } else {
        mismatches.push(`  line ${r.line}: expected ${want}\n${' '.repeat(6 + String(r.line).length)}got      ${got || '(no exported row)'}`);
      }
    }
    checks.push({
      name: '5b. Round trip (text): each exported line equals its source line after the counted normalizations',
      passed: mismatches.length === 0 && exportRows.length === committed.length,
      lines: [
        `source lines compared: ${committed.length}; exported lines: ${exportRows.length}; identical: ${identical}; identical apart from respelled names: ${respelledOnly}; identical apart from formatting: ${formatOnly}; different: ${mismatches.length}`,
        ...mismatches.slice(0, 10),
      ],
    });
  }

  // 6. No extra copies ------------------------------------------------------------------------
  {
    const key = (t: { occurredAt: string; type: string; accountId: string; amountNative: number }) =>
      `${t.occurredAt}|${t.type}|${t.accountId}|${t.amountNative}`;
    const matchedIds = new Set(committed.map((r) => txOf(r).id));
    const csvKeys = new Set(committed.map((r) => key(txOf(r))));

    // Live rows that look like one of this file's rows but are not the row this file imported.
    const lookalikes = db
      .select()
      .from(transactions)
      .where(isNull(transactions.deletedAt))
      .all()
      .filter((t) => !matchedIds.has(t.id) && csvKeys.has(key(t)));
    // No import hash = no provenance: a manual entry or an accidental second copy. That is a FAIL.
    // A DIFFERENT import hash means another import wrote it, and the same minute/account/amount
    // recurring in another file is legitimate, so it is reported but not failed. (A duplicate that
    // happens to carry some other hash therefore cannot be told apart here; the invariants and
    // per-account totals still apply to it.)
    const unhashed = lookalikes.filter((t) => !t.importHash);
    const otherImport = lookalikes.filter((t) => !!t.importHash);

    const lines: string[] = [
      `rows with no import hash that look like a second copy of an imported row: ${unhashed.length}`,
      `(info) rows from another import sharing minute, account and amount with a row here: ${otherImport.length}`,
    ];
    for (const t of unhashed) {
      lines.push(`  SUSPECTED DUPLICATE: ${key(t).split('|').join(' | ')} (row ${t.id}, no import hash)`);
    }
    const lo = rows.reduce((m, r) => (r.occurredAt < m ? r.occurredAt : m), rows[0]?.occurredAt ?? '');
    const hi = rows.reduce((m, r) => (r.occurredAt > m ? r.occurredAt : m), rows[0]?.occurredAt ?? '');
    if (rows.length > 0) {
      const inRange = db.select().from(transactions).where(isNull(transactions.deletedAt)).all()
        .filter((t) => !matchedIds.has(t.id) && t.occurredAt >= lo && t.occurredAt <= hi).length;
      lines.push(`(info) other live rows inside this file's time range that are not from it: ${inRange} (fine if entered by hand or from another file)`);
    }
    checks.push({
      name: '6. No extra copies: no un-attributed row duplicates an imported one',
      passed: unhashed.length === 0 || options.acknowledgedLookalikes === true,
      lines,
    });
  }

  return { checks, passed: checks.every((c) => c.passed) };
}

const formatSigned = (minor: number) => (minor >= 0 ? '+' : '') + formatFixed2(minor);

export function formatVerifyReport(report: VerifyReport): string {
  const out: string[] = [];
  for (const c of report.checks) {
    out.push(`[${c.passed ? 'PASS' : 'FAIL'}] ${c.name}`);
    out.push(...c.lines.map((l) => `    ${l}`));
    out.push('');
  }
  out.push(report.passed ? 'VERIFY: ALL CHECKS PASSED' : `VERIFY: FAILED (${report.checks.filter((c) => !c.passed).length} check(s))`);
  return out.join('\n');
}
