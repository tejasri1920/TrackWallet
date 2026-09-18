// Node-only helpers (Vitest, CLI tools). Never import this from app code:
// the app opens its database through expo-sqlite.
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema';

export const MIGRATIONS_FOLDER = path.resolve(__dirname, '../../drizzle');

export function openNodeDb(file: string, options: { readonly?: boolean } = {}) {
  const sqlite = new Database(file, { readonly: options.readonly ?? false, fileMustExist: options.readonly ?? false });
  sqlite.pragma('foreign_keys = ON');
  if (sqlite.pragma('foreign_keys', { simple: true }) !== 1) {
    sqlite.close();
    throw new Error('PRAGMA foreign_keys could not be enabled');
  }
  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

export function migrateNodeDb(db: ReturnType<typeof openNodeDb>['db']): void {
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
}
