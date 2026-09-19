import { asc, eq, sql } from 'drizzle-orm';
import { ACCOUNT_TYPES, accounts, type Account, type AccountType } from '../db/schema';
import type { AppDb } from '../db/types';
import { resolve, type DataContext } from './context';
import { conflict, invalid, notFound } from './errors';
import { assertCents, cleanName, cleanText } from './validate';

export interface AccountInput {
  name: string;
  type: AccountType;
  /** Signed cents the account held before the first recorded transaction. Negative is fine (a card). */
  openingBalanceCents?: number;
  icon?: string | null;
  color?: string | null;
  sortOrder?: number;
}

export type AccountPatch = Partial<AccountInput>;

export function getAccount(ctx: DataContext, id: string): Account {
  const row = ctx.db.select().from(accounts).where(eq(accounts.id, id)).get();
  if (!row) throw notFound(`account ${id} does not exist`);
  return row;
}

export function listAccounts(ctx: DataContext, options: { includeArchived?: boolean } = {}): Account[] {
  const rows = ctx.db.select().from(accounts).orderBy(asc(accounts.sortOrder), asc(accounts.name)).all();
  return options.includeArchived ? rows : rows.filter((a) => a.archivedAt === null);
}

/** Case-insensitive, exactly like the unique index. */
function nameTaken(db: AppDb, name: string, exceptId?: string): Account | undefined {
  return db
    .select()
    .from(accounts)
    .where(sql`${accounts.name} = ${name} COLLATE NOCASE`)
    .all()
    .find((a) => a.id !== exceptId);
}

function checkType(type: unknown): AccountType {
  if (!(ACCOUNT_TYPES as readonly unknown[]).includes(type)) {
    throw invalid(`account type must be one of ${ACCOUNT_TYPES.join(', ')}`);
  }
  return type as AccountType;
}

/**
 * Creates an account. Everything is in USD for now (decision: USD only), so the currency is not an
 * input. A transaction can never be recorded against an archived account.
 */
export function createAccount(ctx: DataContext, input: AccountInput): Account {
  const { db, now, newId } = resolve(ctx);
  const name = cleanName(input.name, 'account name');
  const type = checkType(input.type);
  const opening = assertCents(input.openingBalanceCents ?? 0, 'opening balance');
  const existing = nameTaken(db, name);
  if (existing) throw conflict(`an account named "${existing.name}" already exists${existing.archivedAt ? ' (archived)' : ''}`);
  if (input.sortOrder !== undefined) assertCents(input.sortOrder, 'sort order');

  const all = db.select({ s: accounts.sortOrder }).from(accounts).all();
  const sortOrder = input.sortOrder ?? (all.length === 0 ? 0 : Math.max(...all.map((a) => a.s)) + 1);
  const ts = now();
  const id = newId();
  db.insert(accounts)
    .values({
      id, name, type, currency: 'USD', openingBalanceNative: opening,
      icon: cleanText(input.icon, 'icon'), color: cleanText(input.color, 'color'),
      sortOrder, createdAt: ts, updatedAt: ts,
    })
    .run();
  return getAccount(ctx, id);
}

export function updateAccount(ctx: DataContext, id: string, patch: AccountPatch): Account {
  const { db, now } = resolve(ctx);
  const current = getAccount(ctx, id);
  const set: Partial<typeof accounts.$inferInsert> = {};

  if (patch.name !== undefined) {
    const name = cleanName(patch.name, 'account name');
    const clash = nameTaken(db, name, id);
    if (clash) throw conflict(`an account named "${clash.name}" already exists${clash.archivedAt ? ' (archived)' : ''}`);
    set.name = name;
  }
  if (patch.type !== undefined) set.type = checkType(patch.type);
  if (patch.openingBalanceCents !== undefined) set.openingBalanceNative = assertCents(patch.openingBalanceCents, 'opening balance');
  if (patch.icon !== undefined) set.icon = cleanText(patch.icon, 'icon');
  if (patch.color !== undefined) set.color = cleanText(patch.color, 'color');
  if (patch.sortOrder !== undefined) set.sortOrder = assertCents(patch.sortOrder, 'sort order');
  if (Object.keys(set).length === 0) return current;

  db.update(accounts).set({ ...set, updatedAt: now() }).where(eq(accounts.id, id)).run();
  return getAccount(ctx, id);
}

/** Hides the account from pickers. Its transactions and balance are untouched. */
export function archiveAccount(ctx: DataContext, id: string): Account {
  const { db, now } = resolve(ctx);
  const a = getAccount(ctx, id);
  if (a.archivedAt === null) {
    db.update(accounts).set({ archivedAt: now(), updatedAt: now() }).where(eq(accounts.id, id)).run();
  }
  return getAccount(ctx, id);
}

export function unarchiveAccount(ctx: DataContext, id: string): Account {
  const { db, now } = resolve(ctx);
  getAccount(ctx, id);
  db.update(accounts).set({ archivedAt: null, updatedAt: now() }).where(eq(accounts.id, id)).run();
  return getAccount(ctx, id);
}

/** For write paths: the account must exist, be live, and be USD. */
export function requireUsableAccount(db: AppDb, id: string, label = 'account'): Account {
  const a = db.select().from(accounts).where(eq(accounts.id, id)).get();
  if (!a) throw notFound(`${label} ${id} does not exist`);
  if (a.archivedAt !== null) throw invalid(`${label} "${a.name}" is archived`);
  if (a.currency !== 'USD') throw invalid(`${label} "${a.name}" is not in USD, which is all that is supported for now`);
  return a;
}

