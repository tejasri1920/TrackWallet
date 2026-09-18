// Usage: npm run import-verify -- <csv> --db <sqlite file>
// Checks that <csv> was imported losslessly into the database (opened read-only).
import fs from 'node:fs';
import { openNodeDb } from '../db/node';
import { decodeCsvBytes } from '../import/decode';
import { ImportFatalError } from '../import/trackwallet';
import { formatVerifyReport, verifyImport } from '../import/verify';

const args = process.argv.slice(2);
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : undefined;
const csvPath = args.find((a, i) => !a.startsWith('--') && i !== (dbIdx >= 0 ? dbIdx + 1 : -1));

if (!csvPath || !dbPath) {
  console.error('usage: npm run import-verify -- <csv> --db <sqlite file>');
  process.exit(2);
}
if (!fs.existsSync(csvPath)) { console.error(`no such file: ${csvPath}`); process.exit(2); }
if (!fs.existsSync(dbPath)) { console.error(`no such database: ${dbPath}`); process.exit(2); }

const { sqlite, db } = openNodeDb(dbPath, { readonly: true });
try {
  const report = verifyImport(db, decodeCsvBytes(fs.readFileSync(csvPath)));
  console.log(formatVerifyReport(report));
  process.exit(report.passed ? 0 : 1);
} catch (e) {
  if (e instanceof ImportFatalError) { console.error(`CANNOT VERIFY: ${e.message}`); process.exit(1); }
  throw e;
} finally {
  sqlite.close();
}
