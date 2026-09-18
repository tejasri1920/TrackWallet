// Usage: npm run db:init -- <path-to-new-sqlite-file>
// Creates a new database, applies all migrations and seeds it. Refuses to touch an existing file.
import fs from 'node:fs';
import path from 'node:path';
import { migrateNodeDb, openNodeDb } from '../db/node';
import { seed } from '../db/seed';
import { localIso } from '../db/time';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run db:init -- <path-to-new-sqlite-file>');
  process.exit(2);
}
if (fs.existsSync(file)) {
  console.error(`refusing to overwrite existing file: ${file}`);
  process.exit(2);
}

fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
const { sqlite, db } = openNodeDb(file);
migrateNodeDb(db);
seed(db, localIso());
const count = (t: string) => (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
console.log(
  `created ${file}: ${count('accounts')} accounts, ${count('categories')} categories, ${count('transactions')} transactions`,
);
sqlite.close();
