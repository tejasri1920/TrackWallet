// Usage: npm run import -- <csv> [--db <sqlite file>] [--commit [--confirm-new] [--allow-skips] [--allow-lookalikes]]
//   default:        dry run. Reads the CSV, prints the full plan, writes NOTHING.
//                   Without --db it plans against a throwaway in-memory seeded database;
//                   with --db the database is opened READ-ONLY.
//   --commit:       writes for real. Requires --db pointing at an EXISTING database (npm run db:init).
//                   Takes a backup copy first. One transaction: any invariant or verification failure
//                   rolls the whole import back.
//   --confirm-new:  required when the import would create new names (people, companies, places) or categories. Review the list in
//                   the dry run first; this is the "confirm before committing" step.
//   --allow-skips:  required when some rows are skipped (e.g. unpaired transfers). Skipped rows are
//                   NOT imported, so the database will not match the file until they are resolved.
//   --allow-lookalikes: required when a new row duplicates one the database already holds under a
//                   different (or no) import hash, e.g. entered by hand. Importing it doubles it.
import fs from 'node:fs';
import path from 'node:path';
import { commitImport, ImportBlockedError, ImportInvariantError, ImportLookalikeError, ImportVerificationError } from '../import/commit';
import { decodeCsvBytes } from '../import/decode';
import { planImport } from '../import/plan';
import { formatPlan } from '../import/report';
import { ImportFatalError } from '../import/trackwallet';
import { formatVerifyReport, verifyImport } from '../import/verify';
import { migrateNodeDb, openNodeDb } from '../db/node';
import { seed } from '../db/seed';
import { localIso } from '../db/time';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const dbIdx = args.indexOf('--db');
const dbPath = dbIdx >= 0 ? args[dbIdx + 1] : undefined;
const dbValueIdx = dbIdx >= 0 ? dbIdx + 1 : -1;
const csvPath = args.find((a, i) => !a.startsWith('--') && i !== dbValueIdx);
const commit = flag('--commit');

const fail = (msg: string, code = 2): never => {
  console.error(msg);
  process.exit(code);
};

if (!csvPath) fail('usage: npm run import -- <csv> [--db <sqlite file>] [--commit [--confirm-new] [--allow-skips] [--allow-lookalikes]]');
if (!fs.existsSync(csvPath!)) fail(`no such file: ${csvPath}`);
if (commit && !dbPath) fail('--commit needs --db <file> (an existing database created with npm run db:init)');
if (dbPath && !fs.existsSync(dbPath)) fail(`no such database: ${dbPath} (create it first: npm run db:init -- ${dbPath})`);

let csvText: string;
try {
  csvText = decodeCsvBytes(fs.readFileSync(csvPath!));
} catch (e) {
  if (e instanceof ImportFatalError) fail(`CANNOT IMPORT: ${e.message}`, 1);
  throw e;
}

// A dry run never needs to write, so it never gets the ability to.
const { sqlite, db } = dbPath ? openNodeDb(dbPath, { readonly: !commit }) : openNodeDb(':memory:');
if (dbPath) {
  // Report the mode of the ACTUAL handle, so this line cannot claim more safety than there is.
  console.log(`Database: ${dbPath} (opened ${sqlite.readonly ? 'read-only' : 'read-write'})`);
} else {
  migrateNodeDb(db);
  seed(db, localIso());
  console.log('(dry run against a throwaway in-memory database seeded with the default accounts and categories)\n');
}

let exitCode = 0;
try {
  const plan = planImport(db, csvText, { filename: path.basename(csvPath!) });
  console.log(formatPlan(plan));

  const refuse = (why: string) => {
    console.error(`\nNOT COMMITTED: ${why} Nothing was written.`);
    exitCode = 1;
  };

  if (!commit) {
    console.log(`\nDRY RUN: nothing was written.${plan.issues.length ? ' Fix the errors above first.' : ' Re-run with --commit --db <file> to import.'}`);
    exitCode = plan.issues.length ? 1 : 0;
  } else if (plan.issues.length > 0) {
    refuse(`${plan.issues.length} row(s) failed validation.`);
  } else if ((plan.newPeople.length > 0 || plan.newCategories.length > 0) && !flag('--confirm-new')) {
    refuse(
      `this import would create ${plan.newPeople.length} new names (people, companies, places) and ${plan.newCategories.length} categories (listed above). ` +
        'Check the names, then re-run with --confirm-new.',
    );
  } else if (plan.skipped.length > 0 && !flag('--allow-skips')) {
    refuse(
      `${plan.skipped.length} row(s) would be skipped (listed above) and would NOT be in the database. ` +
        'Resolve them, or re-run with --allow-skips to import everything else.',
    );
  } else if (plan.lookalikes.length > 0 && !flag('--allow-lookalikes')) {
    refuse(
      `${plan.lookalikes.length} new row(s) look like rows the database already holds under a different or no import hash (listed above); importing them would double those transactions. ` +
        'Check them, then re-run with --allow-lookalikes only if they really are new.',
    );
  } else if (plan.legs.length === 0) {
    console.log('\nNothing to import: every row is already in the database.');
  } else {
    const stamp = localIso().replace(/[-:]/g, '').replace('T', '-');
    const backup = `${dbPath}.before-import-${stamp}`;
    // VACUUM INTO writes a consistent snapshot even for a database in WAL mode with frames not yet
    // checkpointed, where copying the main file alone would give a stale or unusable backup.
    sqlite.prepare('VACUUM INTO ?').run(backup);
    const tables = ['accounts', 'categories', 'people', 'transactions'];
    const counts = (h: typeof sqlite) => tables.map((t) => (h.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n);
    const backupHandle = openNodeDb(backup, { readonly: true });
    const backedUp = counts(backupHandle.sqlite);
    backupHandle.sqlite.close();
    const live = counts(sqlite);
    if (backedUp.join() !== live.join()) {
      throw new Error(`the backup does not match the database (${tables.join('/')}: backup ${backedUp.join('/')} vs live ${live.join('/')}); not importing`);
    }
    console.log(`\nBackup written and checked: ${backup} (${tables.map((t, i) => `${backedUp[i]} ${t}`).join(', ')})`);

    const result = commitImport(db, plan, localIso(), { verifyCsv: csvText, allowLookalikes: flag('--allow-lookalikes') });
    console.log(
      `COMMITTED: ${result.transactionsInserted} transaction(s), ${result.peopleInserted} names, ${result.categoriesInserted} categories.\n`,
    );
    console.log(formatVerifyReport(verifyImport(db, csvText, { only: new Set(plan.legs.map((l) => l.hash)), acknowledgedLookalikes: flag('--allow-lookalikes') })));
  }
} catch (e) {
  if (e instanceof ImportFatalError) {
    console.error(`\nCANNOT IMPORT: ${e.message}`);
  } else if (e instanceof ImportBlockedError || e instanceof ImportLookalikeError) {
    console.error(`\nNOT COMMITTED: ${e.message}`);
  } else if (e instanceof ImportInvariantError) {
    console.error(`\nROLLED BACK: ${e.message}`);
    for (const f of e.failures) console.error(`  invariant ${f.invariant.id}: ${JSON.stringify(f.rows.slice(0, 5))}`);
  } else if (e instanceof ImportVerificationError) {
    console.error(`\nROLLED BACK: ${e.message}`);
  } else {
    // Anything unexpected: report it plainly. If it happened mid-commit the transaction has rolled back.
    console.error(`\nFAILED: ${e instanceof Error ? e.message : String(e)}\nNothing was written (any open transaction was rolled back).`);
  }
  exitCode = 1;
} finally {
  sqlite.close();
}
process.exit(exitCode);
