import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';
import type * as schema from './schema';

/**
 * Synchronous Drizzle database. Both the app (expo-sqlite) and Node tooling
 * (better-sqlite3) satisfy this, so domain code is written once against it.
 */
export type AppDb = BaseSQLiteDatabase<'sync', any, typeof schema>;
