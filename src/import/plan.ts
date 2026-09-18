import { inArray, isNull } from 'drizzle-orm';
import { newId as defaultNewId } from '../db/id';
import { accounts, categories, people, transactions } from '../db/schema';
import type { AppDb } from '../db/types';
import { sha256Hex } from './hash';
import { fold, foldTrim } from './text';
import {
  pairTransfers,
  parseTrackWallet,
  type RowIssue,
  type SourceRow,
  type SourceType,
} from './trackwallet';

/**
 * Decision C (docs/DECISIONS.md): in the user's data the expense-side `Returned` is the user
 * repaying someone (the note holds who, e.g. "Aakanksha"), not a store refund; confirmed by the
 * user ("returned and repaid are same"). It maps to the people-backed `Repaid` category. Keys are
 * ASCII-folded source names. Note that the name on these categories is a counterparty: a person,
 * a company, a place, anything (see docs/DECISIONS.md), so nothing here assumes a human.
 */
export const EXPENSE_CATEGORY_ALIASES: ReadonlyMap<string, string> = new Map([['returned', 'Repaid']]);

/**
 * Stable per-row hash for idempotent re-import (decision G): normalised row content plus an
 * occurrence index for identical rows within one file. The filename is deliberately NOT part
 * of it, so the same row in two overlapping monthly files is recognised as one. Names are
 * case-folded and trimmed first, so a re-export that only changes capitalisation or padding does
 * not re-import every row as a duplicate.
 */
export function hashRows(rows: readonly SourceRow[]): string[] {
  const seen = new Map<string, number>();
  return rows.map((r) => {
    // JSON keeps the fields unambiguous whatever characters they contain. The version tag must
    // change whenever this normalisation changes, so hashes from two schemes can never be confused.
    const tuple = JSON.stringify([
      r.occurredAt, r.type, fold(r.account), r.currency, r.amountNative, r.amountUsd,
      fold(r.category), fold(r.subcategory), foldTrim(r.note),
    ]);
    const occurrence = seen.get(tuple) ?? 0;
    seen.set(tuple, occurrence + 1);
    return sha256Hex(`tw2\n${tuple}\n${occurrence}`);
  });
}

export interface PlannedCategory {
  id: string;
  name: string;
  kind: 'income' | 'expense';
  parentId: string | null;
  parentName: string | null;
}

export interface PlannedPerson {
  id: string;
  name: string;
}

export interface PlannedLeg {
  id: string;
  row: SourceRow;
  hash: string;
  type: SourceType;
  accountId: string;
  categoryId: string | null;
  personId: string | null;
  merchant: string | null;
  note: string | null;
  transferGroupId: string | null;
}

export interface SkippedRow {
  row: SourceRow;
  reason: string;
}

export interface ImportPlan {
  filename: string;
  /** Data records in the file (header excluded). Equals legs + alreadyImported + skipped + issues. */
  rowsRead: number;
  legs: PlannedLeg[];
  transferPairs: number;
  alreadyImported: SourceRow[];
  skipped: SkippedRow[];
  /** Records that failed validation. Any issue blocks a commit: nothing is partially imported. */
  issues: RowIssue[];
  newCategories: PlannedCategory[];
  newPeople: PlannedPerson[];
  /** Source category names remapped on import, with how many rows they affected. */
  categoryMappings: { from: string; to: string; kind: SourceType; rows: number }[];
  warnings: string[];
  /**
   * Rows that would be inserted although the database already holds a live row with the same
   * content (minute, type, account, amount, category, person, merchant) that this file does not
   * account for by hash. Typical causes: the same transaction entered by hand, or imported under
   * an older hash scheme. Importing them would silently double the transaction, so a commit
   * needs an explicit acknowledgement.
   */
  lookalikes: { row: SourceRow; existingIds: string[] }[];
  /** All validated source rows and their hashes (index-aligned), for verification and reports. */
  sourceRows: SourceRow[];
  hashes: string[];
}

export interface PlanOptions {
  filename?: string;
  /** Id generator; defaults to crypto.randomUUID. Injected in tests and on React Native. */
  newId?: () => string;
}

const CHUNK = 500;

/** Builds the full import plan without writing anything. Throws ImportFatalError for unusable files. */
export function planImport(db: AppDb, csvText: string, options: PlanOptions = {}): ImportPlan {
  const genId = options.newId ?? defaultNewId;
  const { rows, issues: parseIssues } = parseTrackWallet(csvText);
  const issues: RowIssue[] = [...parseIssues];
  const rowsRead = rows.length + parseIssues.length;

  // ---- current database state -------------------------------------------------------------
  // Two accounts whose names fold together cannot be told apart by a CSV row: refuse to guess.
  const allAccounts = db.select().from(accounts).all();
  const accountByName = new Map<string, (typeof allAccounts)[number]>();
  const ambiguousAccounts = new Set<string>();
  for (const a of allAccounts) {
    const key = fold(a.name);
    if (accountByName.has(key)) ambiguousAccounts.add(key); else accountByName.set(key, a);
  }
  const cats = db.select().from(categories).all().map((c) => ({ ...c }));
  const persons = new Map(db.select().from(people).all().map((p) => [fold(p.name), { id: p.id, name: p.name }]));

  const newCategories: PlannedCategory[] = [];
  const newPeople: PlannedPerson[] = [];
  const warnings: string[] = [];
  const mappingCounts = new Map<string, { from: string; to: string; kind: SourceType; rows: number }>();

  // ---- hashes and already-imported rows ---------------------------------------------------
  const hashes = hashRows(rows);
  const existing = new Set<string>();
  for (let i = 0; i < hashes.length; i += CHUNK) {
    const chunk = hashes.slice(i, i + CHUNK);
    for (const r of db.select({ h: transactions.importHash }).from(transactions).where(inArray(transactions.importHash, chunk)).all()) {
      if (r.h) existing.add(r.h);
    }
  }
  const hashOf = new Map<SourceRow, string>(rows.map((r, i) => [r, hashes[i]]));

  // ---- accounts: unknown or non-USD accounts are errors, never silently created -------------
  const usable: SourceRow[] = [];
  for (const r of rows) {
    const acc = accountByName.get(fold(r.account));
    if (ambiguousAccounts.has(fold(r.account))) {
      issues.push({ line: r.line, raw: r.raw, message: `account name ${JSON.stringify(r.account)} is ambiguous: several accounts share it (case-insensitively)` });
    } else if (!acc) {
      issues.push({ line: r.line, raw: r.raw, message: `unknown account ${JSON.stringify(r.account)} (create it first)` });
    } else if (acc.currency !== r.currency) {
      issues.push({
        line: r.line, raw: r.raw,
        message: `account ${JSON.stringify(acc.name)} is ${acc.currency} but the row is ${r.currency}`,
      });
    } else {
      usable.push(r);
    }
  }
  const accountId = (r: SourceRow) => accountByName.get(fold(r.account))!.id;

  // ---- helpers to resolve categories and people (creating what is missing) ------------------
  const findTop = (kind: 'income' | 'expense', name: string) =>
    cats.find((c) => c.parentId === null && c.kind === kind && fold(c.name) === fold(name));
  const findChild = (parentId: string, name: string) =>
    cats.find((c) => c.parentId === parentId && fold(c.name) === fold(name));
  const addCategory = (kind: 'income' | 'expense', name: string, parent: { id: string; name: string } | null) => {
    const id = genId();
    cats.push({
      id, name, kind, parentId: parent?.id ?? null, icon: null, color: null, peopleBacked: 0,
      sortOrder: 0, archivedAt: null, createdAt: '', updatedAt: '',
    });
    newCategories.push({ id, name, kind, parentId: parent?.id ?? null, parentName: parent?.name ?? null });
    return cats[cats.length - 1];
  };
  const personFor = (name: string): string => {
    const key = fold(name);
    const found = persons.get(key);
    if (found) {
      if (found.name !== name) warnings.push(`name ${JSON.stringify(name)} matched existing/first-seen ${JSON.stringify(found.name)} (case-insensitive)`);
      return found.id;
    }
    const p = { id: genId(), name };
    persons.set(key, p);
    newPeople.push(p);
    return p.id;
  };

  // ---- transfers: pair first, then decide per pair -----------------------------------------
  const skipped: SkippedRow[] = [];
  const alreadyImported: SourceRow[] = [];
  const { pairs, unpaired } = pairTransfers(
    usable.filter((r) => r.type === 'transfer'),
    (row) => existing.has(hashOf.get(row)!),
  );
  for (const u of unpaired) skipped.push({ row: u.row, reason: `unpaired transfer: ${u.reason}` });

  const legFor = (row: SourceRow, extra: Partial<PlannedLeg>): PlannedLeg => ({
    id: genId(), row, hash: hashOf.get(row)!, type: row.type, accountId: accountId(row),
    categoryId: null, personId: null, merchant: null, note: null, transferGroupId: null, ...extra,
  });

  const legs: PlannedLeg[] = [];
  const pairOf = new Map<SourceRow, { negative: SourceRow; positive: SourceRow }>();
  for (const p of pairs) { pairOf.set(p.negative, p); pairOf.set(p.positive, p); }
  const emitted = new Set<SourceRow>();

  for (const r of usable) {
    if (emitted.has(r)) continue;

    if (r.type === 'transfer') {
      const pair = pairOf.get(r);
      if (!pair) continue; // unpaired: already on the skipped list
      emitted.add(pair.negative); emitted.add(pair.positive);
      const inDb = [pair.negative, pair.positive].filter((x) => existing.has(hashOf.get(x)!));
      if (inDb.length === 2) { alreadyImported.push(pair.negative, pair.positive); continue; }
      if (inDb.length === 1) {
        const reason = 'inconsistent transfer: exactly one leg of this pair is already in the database';
        skipped.push({ row: pair.negative, reason }, { row: pair.positive, reason });
        continue;
      }
      const groupId = genId();
      for (const leg of [pair.negative, pair.positive]) {
        legs.push(legFor(leg, { transferGroupId: groupId, note: leg.note === '' ? null : leg.note }));
      }
      continue;
    }

    emitted.add(r);
    if (existing.has(hashOf.get(r)!)) { alreadyImported.push(r); continue; }

    // income / expense
    const kind = r.type as 'income' | 'expense';
    let categoryName = r.category;
    const alias = kind === 'expense' ? EXPENSE_CATEGORY_ALIASES.get(fold(r.category)) : undefined;
    if (alias) {
      categoryName = alias;
      const key = `${kind}|${r.category}|${categoryName}`;
      const m = mappingCounts.get(key) ?? { from: r.category, to: categoryName, kind: r.type, rows: 0 };
      m.rows++;
      mappingCounts.set(key, m);
      if (!findTop(kind, categoryName)) {
        issues.push({ line: r.line, raw: r.raw, message: `${JSON.stringify(r.category)} maps to ${JSON.stringify(categoryName)}, which does not exist (seed the database first)` });
        continue;
      }
    }
    const top = findTop(kind, categoryName) ?? addCategory(kind, categoryName, null);

    if (top.peopleBacked === 1) {
      if (r.subcategory !== '') {
        issues.push({ line: r.line, raw: r.raw, message: `${top.name} is people-backed but the row has a Subcategory ${JSON.stringify(r.subcategory)}` });
        continue;
      }
      let personId: string | null = null;
      if (r.note !== r.note.trim() && r.note.trim() !== '') {
        warnings.push(`line ${r.line}: name ${JSON.stringify(r.note)} had surrounding whitespace, trimmed to ${JSON.stringify(r.note.trim())}`);
      }
      if (r.note.trim() === '') warnings.push(`line ${r.line}: ${top.name} row has nothing in Note to say who or what it was with (person, company, place); imported without one`);
      else personId = personFor(r.note.trim());
      legs.push(legFor(r, { categoryId: top.id, personId }));
    } else {
      const sub = r.subcategory === '' ? top : (findChild(top.id, r.subcategory) ?? addCategory(kind, r.subcategory, top));
      legs.push(legFor(r, { categoryId: sub.id, merchant: r.note === '' ? null : r.note }));
    }
  }

  // Would any new row duplicate something already stored under a different (or no) import hash?
  const fileHashes = new Set(hashes);
  const contentKey = (t: {
    occurredAt: string; type: string; accountId: string; amountNative: number;
    categoryId: string | null; personId: string | null; merchant: string | null; note: string | null;
  }) => JSON.stringify([
    t.occurredAt, t.type, t.accountId, t.amountNative, t.categoryId ?? '', t.personId ?? '',
    foldTrim(t.merchant ?? t.note ?? ''),
  ]);
  const storedByContent = new Map<string, string[]>();
  for (const t of db.select().from(transactions).where(isNull(transactions.deletedAt)).all()) {
    if (t.importHash && fileHashes.has(t.importHash)) continue; // already accounted for by hash
    const key = contentKey(t);
    storedByContent.set(key, [...(storedByContent.get(key) ?? []), t.id]);
  }
  const lookalikes = legs.flatMap((l) => {
    const existingIds = storedByContent.get(contentKey({
      occurredAt: l.row.occurredAt, type: l.type, accountId: l.accountId, amountNative: l.row.amountNative,
      categoryId: l.categoryId, personId: l.personId, merchant: l.merchant, note: l.note,
    }));
    return existingIds ? [{ row: l.row, existingIds }] : [];
  });

  const plan: ImportPlan = {
    filename: options.filename ?? '(unnamed)',
    rowsRead,
    legs,
    transferPairs: legs.filter((l) => l.type === 'transfer').length / 2,
    alreadyImported,
    skipped,
    issues: issues.sort((a, b) => a.line - b.line),
    newCategories,
    newPeople,
    categoryMappings: [...mappingCounts.values()],
    warnings,
    lookalikes,
    sourceRows: rows,
    hashes,
  };

  // Row accounting: every record lands in exactly one bucket. Never relax this.
  const accounted = legs.length + alreadyImported.length + skipped.length + plan.issues.length;
  if (accounted !== rowsRead) {
    throw new Error(`internal error: row accounting broken (${rowsRead} read, ${accounted} accounted for)`);
  }
  return plan;
}
