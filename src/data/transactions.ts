import { and, desc, eq, gte, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import {
  accounts, categories, people, transactions,
  type Transaction, type TransactionType,
} from '../db/schema';
import { createTransfer, softDeleteTransfer } from '../db/transfers';
import type { AppDb } from '../db/types';
import { normalizeTimestamp } from '../import/trackwallet';
import { requireUsableAccount } from './accounts';
import { resolve, type DataContext } from './context';
import { assertDate } from './dates';
import { conflict, invalid, notFound } from './errors';
import { assertPositiveCents, cleanText, notNull } from './validate';

// ---------------------------------------------------------------------------------------------
// Income and expense entries
// ---------------------------------------------------------------------------------------------

/**
 * One income or expense. `amountCents` is a positive magnitude: the sign follows the kind of
 * entry (an expense is stored negative). Everything is USD.
 */
export interface EntryInput {
  /** Local time, `YYYY-MM-DDTHH:MM` or `...:SS`. Never converted to UTC. */
  occurredAt: string;
  accountId: string;
  amountCents: number;
  categoryId: string;
  /** A name from the people list. Only for people-backed categories (Lend, Returned, Taken, Repaid). */
  personId?: string | null;
  merchant?: string | null;
  note?: string | null;
}

type EntryType = 'income' | 'expense';

interface CleanEntry {
  occurredAt: string;
  accountId: string;
  amountCents: number;
  categoryId: string;
  personId: string | null;
  merchant: string | null;
  note: string | null;
}

/** Which references changed and must therefore still be live (not archived). */
interface Recheck {
  account: boolean;
  category: boolean;
  person: boolean;
}

function timestamp(value: string): string {
  try {
    return normalizeTimestamp(value);
  } catch (e) {
    throw invalid((e as Error).message);
  }
}

function validateEntry(db: AppDb, type: EntryType, input: EntryInput, recheck: Recheck): CleanEntry {
  const occurredAt = timestamp(input.occurredAt);
  const amountCents = assertPositiveCents(input.amountCents, 'amount');

  if (recheck.account) requireUsableAccount(db, input.accountId);
  else if (!db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, input.accountId)).get()) {
    throw notFound(`account ${input.accountId} does not exist`);
  }

  const category = db.select().from(categories).where(eq(categories.id, input.categoryId)).get();
  if (!category) throw notFound(`category ${input.categoryId} does not exist`);
  if (category.kind !== type) {
    throw invalid(`"${category.name}" is an ${category.kind} category, so it cannot be used for an ${type}`);
  }
  if (recheck.category && category.archivedAt !== null) throw invalid(`category "${category.name}" is archived`);
  if (recheck.category && category.parentId) {
    const parent = db.select().from(categories).where(eq(categories.id, category.parentId)).get();
    if (parent && parent.archivedAt !== null) throw invalid(`category "${parent.name}" (the parent of "${category.name}") is archived`);
  }

  const personId = input.personId ?? null;
  const merchant = cleanText(input.merchant, 'merchant');
  const note = cleanText(input.note, 'note');

  if (personId !== null) {
    if (category.peopleBacked !== 1) {
      throw invalid(`a name can only be attached to Lend, Returned, Taken or Repaid, not "${category.name}"`);
    }
    const person = db.select().from(people).where(eq(people.id, personId)).get();
    if (!person) throw notFound(`person ${personId} does not exist`);
    if (recheck.person && person.archivedAt !== null) throw invalid(`"${person.name}" is archived`);
  }
  if (category.peopleBacked === 1 && merchant !== null) {
    throw invalid(`"${category.name}" rows take a name from the people list, not a merchant`);
  }

  return { occurredAt, accountId: input.accountId, amountCents, categoryId: input.categoryId, personId, merchant, note };
}

function insertEntry(ctx: DataContext, type: EntryType, input: EntryInput): Transaction {
  const { db, now, newId } = resolve(ctx);
  const v = validateEntry(db, type, input, { account: true, category: true, person: true });
  const sign = type === 'expense' ? -1 : 1;
  const ts = now();
  const id = newId();
  db.insert(transactions)
    .values({
      id, occurredAt: v.occurredAt, type, accountId: v.accountId, currency: 'USD',
      amountNative: sign * v.amountCents, amountUsd: sign * v.amountCents, fxRate: 1.0,
      categoryId: v.categoryId, personId: v.personId, merchant: v.merchant, note: v.note,
      createdAt: ts, updatedAt: ts,
    })
    .run();
  return getTransaction(ctx, id);
}

export const createExpense = (ctx: DataContext, input: EntryInput): Transaction => insertEntry(ctx, 'expense', input);
export const createIncome = (ctx: DataContext, input: EntryInput): Transaction => insertEntry(ctx, 'income', input);

export function getTransaction(ctx: DataContext, id: string): Transaction {
  const row = ctx.db.select().from(transactions).where(eq(transactions.id, id)).get();
  if (!row) throw notFound(`transaction ${id} does not exist`);
  return row;
}

function liveEntry(ctx: DataContext, id: string): Transaction {
  const t = getTransaction(ctx, id);
  if (t.deletedAt !== null) throw notFound(`transaction ${id} was deleted`);
  if (t.type === 'transfer') throw invalid('this is one side of a transfer: use the transfer functions to change or delete it');
  return t;
}

/**
 * Edits an income or expense. Pass only what changes; `null` clears merchant, note or person. The
 * kind (income/expense) cannot change: delete and re-create instead. References that are unchanged
 * may point at something archived since; references you change may not.
 */
export function updateEntry(ctx: DataContext, id: string, patch: Partial<EntryInput>): Transaction {
  const { db, now } = resolve(ctx);
  const cur = liveEntry(ctx, id);
  if (cur.currency !== 'USD') throw invalid('only USD entries can be edited for now');
  const type = cur.type as EntryType;

  const merged: EntryInput = {
    occurredAt: notNull(patch.occurredAt, 'time') ?? cur.occurredAt,
    accountId: notNull(patch.accountId, 'account') ?? cur.accountId,
    amountCents: notNull(patch.amountCents, 'amount') ?? Math.abs(cur.amountUsd),
    categoryId: notNull(patch.categoryId, 'category') ?? (cur.categoryId as string),
    personId: patch.personId !== undefined ? patch.personId : cur.personId,
    merchant: patch.merchant !== undefined ? patch.merchant : cur.merchant,
    note: patch.note !== undefined ? patch.note : cur.note,
  };
  const v = validateEntry(db, type, merged, {
    account: merged.accountId !== cur.accountId,
    category: merged.categoryId !== cur.categoryId,
    person: merged.personId !== cur.personId,
  });
  const sign = type === 'expense' ? -1 : 1;
  db.update(transactions)
    .set({
      occurredAt: v.occurredAt, accountId: v.accountId,
      amountNative: sign * v.amountCents, amountUsd: sign * v.amountCents,
      categoryId: v.categoryId, personId: v.personId, merchant: v.merchant, note: v.note,
      updatedAt: now(),
    })
    .where(eq(transactions.id, id))
    .run();
  return getTransaction(ctx, id);
}

/** Soft delete: the row stays for history but no longer counts anywhere. */
export function deleteEntry(ctx: DataContext, id: string): void {
  const { db, now } = resolve(ctx);
  liveEntry(ctx, id);
  const ts = now();
  db.update(transactions).set({ deletedAt: ts, updatedAt: ts }).where(eq(transactions.id, id)).run();
}

// ---------------------------------------------------------------------------------------------
// Transfers
// ---------------------------------------------------------------------------------------------

export interface TransferEntryInput {
  occurredAt: string;
  /** Money leaves this account. */
  fromAccountId: string;
  /** Money arrives in this account. */
  toAccountId: string;
  amountCents: number;
  note?: string | null;
}

/** Moves money between two accounts as two balanced legs. It is never income or spending. */
export function createTransferBetween(ctx: DataContext, input: TransferEntryInput): { groupId: string; legIds: [string, string] } {
  const { db, now, newId } = resolve(ctx);
  const occurredAt = timestamp(input.occurredAt);
  const amount = assertPositiveCents(input.amountCents, 'amount');
  if (input.fromAccountId === input.toAccountId) throw invalid('a transfer needs two different accounts');
  requireUsableAccount(db, input.fromAccountId, 'source account');
  requireUsableAccount(db, input.toAccountId, 'destination account');
  return createTransfer(db, {
    occurredAt,
    from: { accountId: input.fromAccountId, currency: 'USD', amountNative: amount },
    to: { accountId: input.toAccountId, currency: 'USD', amountNative: amount },
    amountUsd: amount,
    note: cleanText(input.note, 'note'),
    now: now(),
    newId,
  });
}

function liveLegs(db: AppDb, groupId: string): Transaction[] {
  return db
    .select()
    .from(transactions)
    .where(and(eq(transactions.transferGroupId, groupId), isNull(transactions.deletedAt)))
    .all();
}

/**
 * Edits a transfer. BOTH legs change in one database transaction, so the pair can never be seen
 * (or left) unbalanced. Pass only what changes.
 */
export function updateTransfer(ctx: DataContext, groupId: string, patch: Partial<TransferEntryInput>): { legIds: [string, string] } {
  const { db, now } = resolve(ctx);
  return db.transaction((tx) => {
    const t = tx as unknown as AppDb;
    const legs = liveLegs(t, groupId);
    if (legs.length === 0) throw notFound(`transfer ${groupId} does not exist (or is deleted)`);
    if (legs.length !== 2) {
      throw conflict(`transfer ${groupId} is damaged: it has ${legs.length} live legs instead of 2, so it cannot be edited until it is repaired`);
    }
    const out = legs.find((l) => l.amountUsd < 0);
    const into = legs.find((l) => l.amountUsd > 0);
    if (!out || !into || out.amountUsd + into.amountUsd !== 0) {
      throw conflict(`transfer ${groupId} is damaged: its two legs do not balance, so it cannot be edited until it is repaired`);
    }
    if (out.currency !== 'USD' || into.currency !== 'USD') throw invalid('only USD transfers can be edited for now');

    const fromAccountId = notNull(patch.fromAccountId, 'source account') ?? out.accountId;
    const toAccountId = notNull(patch.toAccountId, 'destination account') ?? into.accountId;
    const amount = patch.amountCents !== undefined ? assertPositiveCents(patch.amountCents, 'amount') : -out.amountUsd;
    if (fromAccountId === toAccountId) throw invalid('a transfer needs two different accounts');
    if (fromAccountId !== out.accountId) requireUsableAccount(t, fromAccountId, 'source account');
    if (toAccountId !== into.accountId) requireUsableAccount(t, toAccountId, 'destination account');
    const occurredAt = patch.occurredAt !== undefined ? timestamp(notNull(patch.occurredAt, 'time') as string) : out.occurredAt;
    // Each leg keeps its own note (an imported pair can say "to savings" / "from cash") unless the
    // caller sets one, which then applies to both.
    const newNote = patch.note !== undefined ? cleanText(patch.note, 'note') : undefined;
    const ts = now();

    tx.update(transactions)
      .set({ occurredAt, accountId: fromAccountId, amountNative: -amount, amountUsd: -amount, note: newNote !== undefined ? newNote : out.note, updatedAt: ts })
      .where(eq(transactions.id, out.id)).run();
    tx.update(transactions)
      .set({ occurredAt, accountId: toAccountId, amountNative: amount, amountUsd: amount, note: newNote !== undefined ? newNote : into.note, updatedAt: ts })
      .where(eq(transactions.id, into.id)).run();

    // Belt and braces: the pair must still be exactly two live legs summing to zero.
    const after = liveLegs(t, groupId);
    if (after.length !== 2 || after[0].amountUsd + after[1].amountUsd !== 0) {
      throw new Error(`transfer ${groupId} would be left unbalanced; rolled back`);
    }
    return { legIds: [out.id, into.id] as [string, string] };
  });
}

/** Soft-deletes both legs together. */
export function deleteTransfer(ctx: DataContext, groupId: string): void {
  const { db, now } = resolve(ctx);
  if (liveLegs(db, groupId).length !== 2) throw notFound(`transfer ${groupId} does not exist (or is already deleted)`);
  softDeleteTransfer(db, groupId, now());
}

// ---------------------------------------------------------------------------------------------
// Reading: lists, search and filters
// ---------------------------------------------------------------------------------------------

export interface TransactionView {
  id: string;
  occurredAt: string;
  type: TransactionType;
  accountId: string;
  accountName: string;
  /** Signed cents, as stored (never recomputed): negative for money out. */
  amountCents: number;
  categoryId: string | null;
  categoryName: string | null;
  /** Set when the category is a subcategory. */
  parentCategoryName: string | null;
  personId: string | null;
  personName: string | null;
  merchant: string | null;
  note: string | null;
  transferGroupId: string | null;
  /** For a transfer leg, the account on the other side. */
  counterpartAccountId: string | null;
  counterpartAccountName: string | null;
  deletedAt: string | null;
}

export interface TransactionFilter {
  /** Inclusive `YYYY-MM-DD`. */
  from?: string;
  /** Exclusive `YYYY-MM-DD`. */
  toExclusive?: string;
  accountIds?: string[];
  types?: TransactionType[];
  /** Matches this category and, if it is a top-level one, all its subcategories. */
  categoryId?: string;
  personId?: string;
  /** Case-insensitive search over merchant, note, name, category and account. */
  text?: string;
  includeDeleted?: boolean;
  limit?: number;
  offset?: number;
}

const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Newest first. Transfers appear as their two legs, each showing the account on the other side. */
export function listTransactions(ctx: DataContext, filter: TransactionFilter = {}): TransactionView[] {
  const { db } = resolve(ctx);
  const parent = alias(categories, 'parent_category');
  const conds = [];

  if (!filter.includeDeleted) conds.push(isNull(transactions.deletedAt));
  if (filter.from !== undefined) { assertDate(filter.from, 'from'); conds.push(gte(transactions.occurredAt, filter.from)); }
  if (filter.toExclusive !== undefined) { assertDate(filter.toExclusive, 'to'); conds.push(lt(transactions.occurredAt, filter.toExclusive)); }
  if (filter.accountIds !== undefined) {
    if (filter.accountIds.length === 0) return []; // nothing selected means nothing shown
    conds.push(inArray(transactions.accountId, filter.accountIds));
  }
  if (filter.types !== undefined) {
    if (filter.types.length === 0) return [];
    conds.push(inArray(transactions.type, filter.types));
  }
  if (filter.categoryId !== undefined) conds.push(or(eq(transactions.categoryId, filter.categoryId), eq(categories.parentId, filter.categoryId)));
  if (filter.personId !== undefined) conds.push(eq(transactions.personId, filter.personId));
  if (filter.text !== undefined && filter.text.trim() !== '') {
    const pattern = `%${likeEscape(filter.text.trim())}%`;
    const like = (col: unknown) => sql`${col} LIKE ${pattern} ESCAPE '\\'`;
    conds.push(
      or(
        like(transactions.merchant), like(transactions.note), like(people.name),
        like(categories.name), like(parent.name), like(accounts.name),
      ),
    );
  }

  let query = db
    .select({
      t: transactions,
      accountName: accounts.name,
      categoryName: categories.name,
      parentName: parent.name,
      personName: people.name,
    })
    .from(transactions)
    .innerJoin(accounts, eq(accounts.id, transactions.accountId))
    .leftJoin(categories, eq(categories.id, transactions.categoryId))
    .leftJoin(parent, eq(parent.id, categories.parentId))
    .leftJoin(people, eq(people.id, transactions.personId))
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(transactions.occurredAt), desc(transactions.id))
    .$dynamic();
  const count = (n: number | undefined, label: string) => {
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 0)) throw invalid(`${label} must be a whole number, zero or more`);
  };
  count(filter.limit, 'limit');
  count(filter.offset, 'offset');
  // SQLite needs a LIMIT before an OFFSET
  const limit = filter.limit ?? (filter.offset !== undefined ? Number.MAX_SAFE_INTEGER : undefined);
  if (limit !== undefined) query = query.limit(limit);
  if (filter.offset !== undefined) query = query.offset(filter.offset);
  const rows = query.all();

  // The other side of each transfer leg shown.
  const groupIds = [...new Set(rows.map((r) => r.t.transferGroupId).filter((g): g is string => !!g))];
  const legsByGroup = new Map<string, { id: string; accountId: string; accountName: string }[]>();
  for (let i = 0; i < groupIds.length; i += 500) {
    const chunk = groupIds.slice(i, i + 500); // stay far below SQLite's variable limit
    const legRows = db
      .select({ id: transactions.id, group: transactions.transferGroupId, accountId: transactions.accountId, accountName: accounts.name })
      .from(transactions)
      .innerJoin(accounts, eq(accounts.id, transactions.accountId))
      .where(and(inArray(transactions.transferGroupId, chunk), filter.includeDeleted ? undefined : isNull(transactions.deletedAt)))
      .all();
    for (const l of legRows) {
      const list = legsByGroup.get(l.group as string) ?? [];
      list.push({ id: l.id, accountId: l.accountId, accountName: l.accountName });
      legsByGroup.set(l.group as string, list);
    }
  }

  return rows.map((r): TransactionView => {
    const other = r.t.transferGroupId
      ? (legsByGroup.get(r.t.transferGroupId) ?? []).find((l) => l.id !== r.t.id)
      : undefined;
    return {
      id: r.t.id, occurredAt: r.t.occurredAt, type: r.t.type, accountId: r.t.accountId, accountName: r.accountName,
      amountCents: r.t.amountUsd,
      categoryId: r.t.categoryId, categoryName: r.categoryName, parentCategoryName: r.parentName,
      personId: r.t.personId, personName: r.personName,
      merchant: r.t.merchant, note: r.t.note, transferGroupId: r.t.transferGroupId,
      counterpartAccountId: other?.accountId ?? null, counterpartAccountName: other?.accountName ?? null,
      deletedAt: r.t.deletedAt,
    };
  });
}

