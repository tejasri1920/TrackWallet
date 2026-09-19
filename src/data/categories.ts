import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { CATEGORY_KINDS, categories, transactions, type Category, type CategoryKind } from '../db/schema';
import type { AppDb } from '../db/types';
import { resolve, type DataContext } from './context';
import { conflict, invalid, notFound } from './errors';
import { assertCents, cleanName, cleanText } from './validate';

export interface CategoryInput {
  name: string;
  /** Required for a top-level category; a subcategory takes its parent's kind. */
  kind?: CategoryKind;
  /** Makes this a subcategory. The parent must be a top-level category. */
  parentId?: string | null;
  icon?: string | null;
  color?: string | null;
  /** Top-level only. Rows in such a category name a counterparty from the people list instead of a subcategory. */
  peopleBacked?: boolean;
}

export interface CategoryNode {
  category: Category;
  children: Category[];
}

export function getCategory(ctx: DataContext, id: string): Category {
  const row = ctx.db.select().from(categories).where(eq(categories.id, id)).get();
  if (!row) throw notFound(`category ${id} does not exist`);
  return row;
}

/** The two-level tree, top-level categories with their subcategories, each in display order. */
export function listCategoryTree(
  ctx: DataContext,
  options: { kind?: CategoryKind; includeArchived?: boolean } = {},
): CategoryNode[] {
  const all = ctx.db.select().from(categories).orderBy(asc(categories.sortOrder), asc(sql`${categories.name} COLLATE NOCASE`)).all();
  const visible = (c: Category) => options.includeArchived || c.archivedAt === null;
  return all
    .filter((c) => c.parentId === null && (!options.kind || c.kind === options.kind) && visible(c))
    .map((category) => ({ category, children: all.filter((c) => c.parentId === category.id && visible(c)) }));
}

function siblings(db: AppDb, kind: CategoryKind, parentId: string | null): Category[] {
  return db
    .select()
    .from(categories)
    .where(and(eq(categories.kind, kind), parentId === null ? isNull(categories.parentId) : eq(categories.parentId, parentId)))
    .all();
}

const sameName = (a: string, b: string) => a.replace(/[A-Z]/g, (c) => c.toLowerCase()) === b.replace(/[A-Z]/g, (c) => c.toLowerCase());

export function createCategory(ctx: DataContext, input: CategoryInput): Category {
  const { db, now, newId } = resolve(ctx);
  const name = cleanName(input.name, 'category name');
  let kind: CategoryKind;
  let parentId: string | null = null;

  if (input.peopleBacked !== undefined && typeof input.peopleBacked !== 'boolean') throw invalid('peopleBacked must be true or false');
  if (input.parentId !== undefined && input.parentId !== null) {
    const parent = getCategory(ctx, input.parentId);
    if (parent.parentId !== null) throw invalid('a subcategory cannot have its own subcategories');
    if (parent.peopleBacked === 1) {
      throw invalid(`"${parent.name}" lists people instead of subcategories: add a name to the people list`);
    }
    if (parent.archivedAt !== null) throw invalid(`"${parent.name}" is archived: restore it before adding to it`);
    if (input.kind !== undefined && input.kind !== parent.kind) {
      throw invalid(`a subcategory must have the same kind as "${parent.name}" (${parent.kind})`);
    }
    if (input.peopleBacked) throw invalid('only a top-level category can list people');
    kind = parent.kind;
    parentId = parent.id;
  } else {
    if (!(CATEGORY_KINDS as readonly unknown[]).includes(input.kind)) throw invalid('kind must be income or expense');
    kind = input.kind as CategoryKind;
  }

  const sibs = siblings(db, kind, parentId);
  const clash = sibs.find((c) => sameName(c.name, name));
  if (clash) throw conflict(`"${clash.name}" already exists here${clash.archivedAt ? ' (archived)' : ''}`);

  const ts = now();
  const id = newId();
  db.insert(categories)
    .values({
      id, name, kind, parentId, icon: cleanText(input.icon, 'icon'), color: cleanText(input.color, 'color'),
      peopleBacked: input.peopleBacked ? 1 : 0,
      sortOrder: sibs.length === 0 ? 0 : Math.max(...sibs.map((c) => c.sortOrder)) + 1,
      createdAt: ts, updatedAt: ts,
    })
    .run();
  return getCategory(ctx, id);
}

/** Rename, restyle, reorder, or toggle people-backed. Kind and parent are fixed once created. */
export function updateCategory(
  ctx: DataContext,
  id: string,
  patch: { name?: string; icon?: string | null; color?: string | null; sortOrder?: number; peopleBacked?: boolean },
): Category {
  const { db, now } = resolve(ctx);
  const current = getCategory(ctx, id);
  const set: Partial<typeof categories.$inferInsert> = {};

  if (patch.name !== undefined) {
    const name = cleanName(patch.name, 'category name');
    const clash = siblings(db, current.kind, current.parentId).find((c) => c.id !== id && sameName(c.name, name));
    if (clash) throw conflict(`"${clash.name}" already exists here${clash.archivedAt ? ' (archived)' : ''}`);
    set.name = name;
  }
  if (patch.icon !== undefined) set.icon = cleanText(patch.icon, 'icon');
  if (patch.color !== undefined) set.color = cleanText(patch.color, 'color');
  if (patch.sortOrder !== undefined) set.sortOrder = assertCents(patch.sortOrder, 'sort order');
  if (patch.peopleBacked !== undefined) {
    if (typeof patch.peopleBacked !== 'boolean') throw invalid('peopleBacked must be true or false');
    if (patch.peopleBacked && current.parentId !== null) throw invalid('only a top-level category can list people');
    if (patch.peopleBacked && db.select().from(categories).where(eq(categories.parentId, id)).all().length > 0) {
      throw invalid(`"${current.name}" has subcategories; a category lists either subcategories or people`);
    }
    if (patch.peopleBacked && current.peopleBacked !== 1) {
      const withMerchant = db
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.categoryId, id), sql`${transactions.merchant} IS NOT NULL`))
        .all().length;
      if (withMerchant > 0) throw conflict(`${withMerchant} transaction(s) in "${current.name}" have a merchant, which a people-backed category does not take; clear those first`);
    }
    if (!patch.peopleBacked && current.peopleBacked === 1) {
      const withNames = db
        .select({ id: transactions.id })
        .from(transactions)
        .where(and(eq(transactions.categoryId, id), sql`${transactions.personId} IS NOT NULL`))
        .all().length;
      if (withNames > 0) throw conflict(`${withNames} transaction(s) in "${current.name}" name someone from the people list, so it must keep listing people`);
    }
    set.peopleBacked = patch.peopleBacked ? 1 : 0;
  }
  if (Object.keys(set).length === 0) return current;

  db.update(categories).set({ ...set, updatedAt: now() }).where(eq(categories.id, id)).run();
  return getCategory(ctx, id);
}

/** Hides the category (and its subcategories) from pickers. Existing transactions keep it. */
export function archiveCategory(ctx: DataContext, id: string): Category {
  const { db, now } = resolve(ctx);
  const c = getCategory(ctx, id);
  const ts = now();
  db.transaction((tx) => {
    tx.update(categories).set({ archivedAt: ts, updatedAt: ts }).where(and(eq(categories.id, id), isNull(categories.archivedAt))).run();
    tx.update(categories).set({ archivedAt: ts, updatedAt: ts }).where(and(eq(categories.parentId, c.id), isNull(categories.archivedAt))).run();
  });
  return getCategory(ctx, id);
}

export function unarchiveCategory(ctx: DataContext, id: string): Category {
  const { db, now } = resolve(ctx);
  const c = getCategory(ctx, id);
  if (c.parentId) {
    const parent = getCategory(ctx, c.parentId);
    if (parent.archivedAt !== null) throw invalid(`restore "${parent.name}" first`);
  }
  db.update(categories).set({ archivedAt: null, updatedAt: now() }).where(eq(categories.id, id)).run();
  return getCategory(ctx, id);
}

/** Removes a category nothing has ever used and that has no subcategories; otherwise archive it. */
export function deleteCategory(ctx: DataContext, id: string): void {
  const { db } = resolve(ctx);
  const c = getCategory(ctx, id);
  const kids = db.select({ id: categories.id }).from(categories).where(eq(categories.parentId, id)).all().length;
  if (kids > 0) throw conflict(`"${c.name}" has ${kids} subcategor${kids === 1 ? 'y' : 'ies'}; remove or archive those first`);
  const used = db.select({ id: transactions.id }).from(transactions).where(eq(transactions.categoryId, id)).all().length;
  if (used > 0) throw conflict(`"${c.name}" is used by ${used} transaction(s); archive it instead of deleting`);
  db.delete(categories).where(eq(categories.id, id)).run();
}
