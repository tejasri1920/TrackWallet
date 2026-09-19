// On-device database connection (expo-sqlite). NOT run by the Node tests: expo-sqlite needs a phone
// or emulator. It is type-checked, which proves the Expo driver satisfies `AppDb`, the driver-neutral
// type the whole data layer and importer are written against. Never import this from Node code.
import { drizzle } from 'drizzle-orm/expo-sqlite';
import { openDatabaseSync } from 'expo-sqlite';
import * as schema from './schema';
import type { AppDb } from './types';

/**
 * Opens (creating if needed) the app database with foreign keys ON, as the project rules require at
 * every connection open. Throws if the pragma did not take, rather than running unprotected.
 *
 * Migrations are applied separately (`drizzle/migrations.js`, via drizzle-orm's expo migrator) once
 * the app wiring exists; see docs/PROGRESS.md.
 */
export function openExpoDb(name = 'expenses.db'): AppDb {
  const sqlite = openDatabaseSync(name);
  sqlite.execSync('PRAGMA foreign_keys = ON;');
  const row = sqlite.getFirstSync<{ foreign_keys: number }>('PRAGMA foreign_keys;');
  if (row?.foreign_keys !== 1) {
    sqlite.closeSync();
    throw new Error('PRAGMA foreign_keys could not be enabled');
  }
  return drizzle(sqlite, { schema });
}
