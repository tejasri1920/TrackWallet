import { asc, eq, sql } from 'drizzle-orm';
import { people, transactions, type Person } from '../db/schema';
import type { AppDb } from '../db/types';
import { resolve, type DataContext } from './context';
import { conflict, notFound } from './errors';
import { cleanName, cleanText } from './validate';

/**
 * "People" is the list of names used on Lend / Returned / Taken / Repaid rows. Despite the name it
 * holds any counterparty: a person, a company, a place. It stands alone: adding a name needs no
 * transaction, so it can also serve as a plain list of references.
 */
export interface PersonInput {
  name: string;
  note?: string | null;
}

export function getPerson(ctx: DataContext, id: string): Person {
  const row = ctx.db.select().from(people).where(eq(people.id, id)).get();
  if (!row) throw notFound(`person ${id} does not exist`);
  return row;
}

export function listPeople(ctx: DataContext, options: { includeArchived?: boolean } = {}): Person[] {
  const rows = ctx.db.select().from(people).orderBy(asc(sql`${people.name} COLLATE NOCASE`)).all();
  return options.includeArchived ? rows : rows.filter((p) => p.archivedAt === null);
}

function nameTaken(db: AppDb, name: string, exceptId?: string): Person | undefined {
  return db
    .select()
    .from(people)
    .where(sql`${people.name} = ${name} COLLATE NOCASE`)
    .all()
    .find((p) => p.id !== exceptId);
}

export function findPersonByName(ctx: DataContext, name: string): Person | undefined {
  return nameTaken(ctx.db, cleanName(name, 'name'));
}

export function createPerson(ctx: DataContext, input: PersonInput): Person {
  const { db, now, newId } = resolve(ctx);
  const name = cleanName(input.name, 'name');
  const existing = nameTaken(db, name);
  if (existing) throw conflict(`"${existing.name}" is already in the list${existing.archivedAt ? ' (archived)' : ''}`);
  const ts = now();
  const id = newId();
  db.insert(people).values({ id, name, note: cleanText(input.note, 'note'), createdAt: ts, updatedAt: ts }).run();
  return getPerson(ctx, id);
}

/**
 * The existing entry for this name (ignoring case), or a new one. Convenient for "type a name".
 * Typing the name of an archived entry brings it back, so it can be used straight away.
 */
export function ensurePerson(ctx: DataContext, name: string): Person {
  const found = findPersonByName(ctx, name);
  if (!found) return createPerson(ctx, { name });
  return found.archivedAt === null ? found : unarchivePerson(ctx, found.id);
}

export function updatePerson(ctx: DataContext, id: string, patch: Partial<PersonInput>): Person {
  const { db, now } = resolve(ctx);
  const current = getPerson(ctx, id);
  const set: Partial<typeof people.$inferInsert> = {};
  if (patch.name !== undefined) {
    const name = cleanName(patch.name, 'name');
    const clash = nameTaken(db, name, id);
    if (clash) throw conflict(`"${clash.name}" is already in the list${clash.archivedAt ? ' (archived)' : ''}`);
    set.name = name;
  }
  if (patch.note !== undefined) set.note = cleanText(patch.note, 'note');
  if (Object.keys(set).length === 0) return current;
  db.update(people).set({ ...set, updatedAt: now() }).where(eq(people.id, id)).run();
  return getPerson(ctx, id);
}

export function archivePerson(ctx: DataContext, id: string): Person {
  const { db, now } = resolve(ctx);
  const p = getPerson(ctx, id);
  if (p.archivedAt === null) db.update(people).set({ archivedAt: now(), updatedAt: now() }).where(eq(people.id, id)).run();
  return getPerson(ctx, id);
}

export function unarchivePerson(ctx: DataContext, id: string): Person {
  const { db, now } = resolve(ctx);
  getPerson(ctx, id);
  db.update(people).set({ archivedAt: null, updatedAt: now() }).where(eq(people.id, id)).run();
  return getPerson(ctx, id);
}

/**
 * Removes a name that no transaction has ever used. If any transaction (even a deleted one) refers
 * to it, it must be archived instead so history stays intact.
 */
export function deletePerson(ctx: DataContext, id: string): void {
  const { db } = resolve(ctx);
  const p = getPerson(ctx, id);
  const used = db.select({ id: transactions.id }).from(transactions).where(eq(transactions.personId, id)).all().length;
  if (used > 0) {
    throw conflict(`"${p.name}" is used by ${used} transaction(s); archive it instead of deleting`);
  }
  db.delete(people).where(eq(people.id, id)).run();
}
