import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateNodeDb, openNodeDb } from '../src/db/node';
import { seed } from '../src/db/seed';
import { commitImport, ImportVerificationError } from '../src/import/commit';
import { decodeCsvBytes } from '../src/import/decode';
import { planImport } from '../src/import/plan';
import { HEADER, ImportFatalError, pairTransfers, parseTrackWallet } from '../src/import/trackwallet';
import { formatVerifyReport, verifyImport } from '../src/import/verify';
import { NOW, makeEnforcingDb, rowsOf } from './helpers';

const REPO = path.resolve(__dirname, '..');
const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/trackwallet_2026-08-01_2026-08-31.csv');
const FIXTURE = fs.readFileSync(FIXTURE_PATH, 'utf8');
const file = (...lines: string[]) => [HEADER.join(','), ...lines].join('\n') + '\n';

let n = 0;
const newId = () => `h-${++n}`;
type Handle = ReturnType<typeof makeEnforcingDb>;
const plan = (h: Handle, text: string) => planImport(h.db, text, { filename: 'hardening.csv', newId });
/** Plan + commit with in-transaction verification, as the CLI does. */
const importText = (h: Handle, text: string) => {
  const p = plan(h, text);
  commitImport(h.db, p, NOW, { verifyCsv: text });
  return p;
};
const count = (h: Handle, table = 'transactions') => rowsOf(h.sqlite, `SELECT COUNT(*) AS n FROM ${table}`)[0].n as number;
const check = (r: ReturnType<typeof verifyImport>, prefix: string) => r.checks.find((c) => c.name.startsWith(prefix))!;

const transfer = (when: string, account: string, cents: number) =>
  `"${when}","Transfer","${account}","USD","${cents / 100}","${cents / 100}",,,""`;
const expense = (account: string, cat: string, note = '', when = '2026-08-01T10:00', sub = '') =>
  `"${when}","Expense","${account}","USD","-5","-5","${cat}","${sub}","${note}"`;

// -------------------------------------------------------------------------------------------
describe('account names must be unambiguous', () => {
  it('the database refuses two accounts whose names differ only by case', () => {
    const h = makeEnforcingDb();
    expect(() =>
      h.sqlite
        .prepare(`INSERT INTO accounts (id, name, type, currency, created_at, updated_at) VALUES ('dup', 'CASH', 'cash', 'USD', ?, ?)`)
        .run(NOW, NOW),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it('and the plan refuses to guess if a database somehow has them anyway', () => {
    const h = makeEnforcingDb();
    h.sqlite.exec('DROP INDEX accounts_name_ci');
    h.sqlite
      .prepare(`INSERT INTO accounts (id, name, type, currency, created_at, updated_at) VALUES ('dup', 'CASH', 'cash', 'USD', ?, ?)`)
      .run(NOW, NOW);
    const p = plan(h, file(expense('Cash', 'Leisure')));
    expect(p.issues).toHaveLength(1);
    expect(p.issues[0].message).toMatch(/ambiguous/);
    expect(p.legs).toEqual([]);
  });
});

// -------------------------------------------------------------------------------------------
describe('identical same-minute transfers are paired consistently with what is already imported', () => {
  const T = '2026-08-01T10:00';
  // Already imported: Credit -> Chase. The later export adds Cash -> Chase in the same minute.
  const first = file(transfer(T, 'Credit', -1000), transfer(T, 'Chase Bank Account', 1000));
  const later = file(
    transfer(T, 'Cash', -1000),
    transfer(T, 'Credit', -1000),
    transfer(T, 'Chase Bank Account', 1000),
    transfer(T, 'Chase Bank Account', 1000),
  );

  it('without the already-imported hint, blind pairing crosses the legs (the bug being guarded)', () => {
    const rows = parseTrackWallet(later).rows;
    const { pairs } = pairTransfers(rows);
    // Cash takes the first Chase leg, which is the one already stored against Credit
    expect(pairs.map((p) => [p.negative.account, p.positive.line]).sort()).toEqual([['Cash', 4], ['Credit', 5]]);
  });

  it('with the hint, the new transfer is imported and the old one recognised', () => {
    const h = makeEnforcingDb();
    importText(h, first);
    expect(count(h)).toBe(2);
    const p = plan(h, later);
    expect([p.legs.length, p.alreadyImported.length, p.skipped.length]).toEqual([2, 2, 0]);
    commitImport(h.db, p, NOW, { verifyCsv: later });
    expect(count(h)).toBe(4);
    expect(verifyImport(h.db, later).passed).toBe(true);
    expect(verifyImport(h.db, first).passed).toBe(true);
    expect(
      rowsOf(h.sqlite, `SELECT a.name AS name, SUM(t.amount_native) AS s FROM transactions t JOIN accounts a ON a.id = t.account_id GROUP BY a.name ORDER BY a.name`),
    ).toEqual([
      { name: 'Cash', s: -1000 },
      { name: 'Chase Bank Account', s: 2000 },
      { name: 'Credit', s: -1000 },
    ]);
  });
});

// -------------------------------------------------------------------------------------------
describe('verification sees corruption that is not in the CSV', () => {
  const copyOfFirstRow = (h: Handle, hash: string | null) =>
    h.sqlite
      .prepare(
        `INSERT INTO transactions (id, occurred_at, type, account_id, currency, amount_native, amount_usd, fx_rate, category_id, import_hash, created_at, updated_at)
         SELECT 'copy', occurred_at, type, account_id, currency, amount_native, amount_usd, fx_rate, category_id, ?, created_at, updated_at
         FROM transactions WHERE occurred_at = '2026-08-29T19:14:13'`,
      )
      .run(hash);

  it('flags an un-attributed second copy of an imported row (no import hash)', () => {
    const h = makeEnforcingDb();
    importText(h, FIXTURE);
    copyOfFirstRow(h, null);
    const r = verifyImport(h.db, FIXTURE);
    expect(r.passed).toBe(false);
    expect(check(r, '6.').passed).toBe(false);
    expect(check(r, '6.').lines.join('\n')).toMatch(/SUSPECTED DUPLICATE: 2026-08-29T19:14:13/);
    // the per-account totals alone would NOT have noticed: only this check catches it
    expect(check(r, '2.').passed).toBe(true);
  });

  it('reports, but does not fail, a lookalike that carries another import hash (known limit)', () => {
    // A row written by another import may legitimately share minute, account and amount. The
    // verifier cannot tell such a row from a duplicate that happens to carry some other hash.
    const h = makeEnforcingDb();
    importText(h, FIXTURE);
    copyOfFirstRow(h, 'from-another-file');
    const r = verifyImport(h.db, FIXTURE);
    expect(check(r, '6.').passed).toBe(true);
    expect(check(r, '6.').lines[1]).toContain('rows from another import sharing minute, account and amount with a row here: 1');
  });

  it('does not cry wolf about unrelated rows entered by hand in the same period', () => {
    const h = makeEnforcingDb();
    importText(h, FIXTURE);
    h.sqlite
      .prepare(
        `INSERT INTO transactions (id, occurred_at, type, account_id, currency, amount_native, amount_usd, fx_rate, category_id, created_at, updated_at)
         VALUES ('manual', '2026-08-15T12:00:00', 'expense', 'acc-cash', 'USD', -777, -777, 1.0, 'cat-exp-leisure', ?, ?)`,
      )
      .run(NOW, NOW);
    const r = verifyImport(h.db, FIXTURE);
    expect(r.passed).toBe(true);
    expect(check(r, '6.').lines.join('\n')).toContain('(info) other live rows inside this file');
  });

  it('flags transfer legs swapped between two groups, which balance sheets alone cannot see', () => {
    const h = makeEnforcingDb();
    const csv = file(
      transfer('2026-08-01T10:00', 'Cash', -1000), transfer('2026-08-01T10:00', 'Chase Bank Account', 1000),
      transfer('2026-08-02T10:00', 'Cash', -1000), transfer('2026-08-02T10:00', 'Chase Bank Account', 1000),
    );
    importText(h, csv);
    expect(verifyImport(h.db, csv).passed).toBe(true);
    const [neg1, pos1, neg2, pos2] = rowsOf(h.sqlite, `SELECT id, transfer_group_id AS g FROM transactions ORDER BY occurred_at, amount_native`) as { id: string; g: string }[];
    expect(neg1.g).toBe(pos1.g);
    h.sqlite.prepare(`UPDATE transactions SET transfer_group_id = ? WHERE id = ?`).run(neg2.g, pos1.id);
    h.sqlite.prepare(`UPDATE transactions SET transfer_group_id = ? WHERE id = ?`).run(neg1.g, pos2.id);
    const r = verifyImport(h.db, csv);
    expect(r.passed).toBe(false);
    expect(check(r, '3.').passed).toBe(false);
    expect(check(r, '3.').lines.join('\n')).toMatch(/WRONGLY GROUPED/);
    expect(check(r, '2.').passed).toBe(true); // sums still balance: this is the blind spot being closed
  });
});

// -------------------------------------------------------------------------------------------
describe('names may be respelled on import, and verification accounts for it instead of failing', () => {
  it('trims a padded person name, warns about it, and still verifies', () => {
    const h = makeEnforcingDb();
    const csv = file(expense('Cash', 'Lend', '  aakanksha (dinner) '));
    const p = importText(h, csv);
    expect(p.warnings.join('\n')).toMatch(/had surrounding whitespace, trimmed to "aakanksha \(dinner\)"/);
    expect(rowsOf(h.sqlite, `SELECT name FROM people`)).toEqual([{ name: 'aakanksha (dinner)' }]);
    const r = verifyImport(h.db, csv);
    expect(r.passed).toBe(true);
    expect(check(r, '5a').lines[1]).toMatch(/respelled in [1-9]\d* field/);
    expect(check(r, '5b').lines[0]).toMatch(/identical apart from respelled names: 1/);
  });

  it('matches an existing person case-insensitively and verifies', () => {
    const h = makeEnforcingDb();
    h.sqlite.prepare(`INSERT INTO people (id, name, created_at, updated_at) VALUES ('p-x', 'AAKANKSHA', ?, ?)`).run(NOW, NOW);
    const csv = file(expense('Cash', 'Lend', 'aakanksha'));
    importText(h, csv);
    expect(count(h, 'people')).toBe(1);
    expect(verifyImport(h.db, csv).passed).toBe(true);
  });

  it('accepts case-variant account and category names, and verifies', () => {
    const h = makeEnforcingDb();
    const csv = file(expense('cash', 'leisure', 'Arcade'));
    const p = importText(h, csv);
    expect(p.issues).toEqual([]);
    expect(rowsOf(h.sqlite, `SELECT account_id, category_id FROM transactions`)).toEqual([{ account_id: 'acc-cash', category_id: 'cat-exp-leisure' }]);
    expect(verifyImport(h.db, csv).passed).toBe(true);
  });

  it('trims padded category and subcategory names instead of creating a second category', () => {
    const h = makeEnforcingDb();
    const p = plan(h, file(expense('Cash', 'Food & Drinks ', 'x', '2026-08-01T10:00', ' Groceries ')));
    expect(p.newCategories).toEqual([]);
    expect(p.legs[0].categoryId).toBe('cat-exp-food-and-drinks-groceries');
  });

  it('recognises the same row re-exported with different capitalisation instead of duplicating it', () => {
    const h = makeEnforcingDb();
    importText(h, file(expense('Cash', 'Leisure', 'Arcade')));
    const again = plan(h, file(expense('CASH', 'LEISURE', 'arcade ')));
    expect([again.legs.length, again.alreadyImported.length]).toEqual([0, 1]);
  });

  it('still catches a genuinely different spelling as a difference', () => {
    const h = makeEnforcingDb();
    const csv = file(expense('Cash', 'Leisure', 'Arcade'));
    importText(h, csv);
    h.sqlite.prepare(`UPDATE transactions SET merchant = 'Casino'`).run();
    const r = verifyImport(h.db, csv);
    expect(r.passed).toBe(false);
    expect(check(r, '5a').passed).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------
describe('verification runs inside the commit, so a bad import is never left behind', () => {
  it('rolls everything back when verification fails', () => {
    const h = makeEnforcingDb();
    const p = plan(h, FIXTURE);
    // the planned amount differs from the CSV by one cent: inserts fine, verification must object
    p.legs[0].row = { ...p.legs[0].row, amountNative: p.legs[0].row.amountNative - 1, amountUsd: p.legs[0].row.amountUsd - 1 };
    let error: unknown;
    try { commitImport(h.db, p, NOW, { verifyCsv: FIXTURE }); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(ImportVerificationError);
    expect((error as ImportVerificationError).report.passed).toBe(false);
    expect([count(h), count(h, 'people')]).toEqual([0, 0]);
    expect(formatVerifyReport((error as ImportVerificationError).report)).toContain('VERIFY: FAILED');
  });

  it('commits normally when verification passes', () => {
    const h = makeEnforcingDb();
    importText(h, FIXTURE);
    expect(count(h)).toBe(65);
  });
});

// -------------------------------------------------------------------------------------------
describe('file encoding', () => {
  it('refuses bytes that are not valid UTF-8 rather than corrupting names', () => {
    expect(() => decodeCsvBytes(Uint8Array.from([0x4a, 0x6f, 0x73, 0xe9]))).toThrow(ImportFatalError); // "Jos\xE9" in Latin-1
    expect(() => decodeCsvBytes(Uint8Array.from([0x4a, 0x6f, 0x73, 0xe9]))).toThrow(/not valid UTF-8/);
  });

  it('refuses UTF-16 in either byte order', () => {
    expect(() => decodeCsvBytes(Uint8Array.from([0xff, 0xfe, 0x44, 0x00]))).toThrow(/UTF-16/);
    expect(() => decodeCsvBytes(Uint8Array.from([0xfe, 0xff, 0x00, 0x44]))).toThrow(/UTF-16/);
  });

  it('reads UTF-8 (with or without a BOM) and keeps non-ASCII names intact end to end', () => {
    expect(decodeCsvBytes(Buffer.from('José'))).toBe('José');
    expect(decodeCsvBytes(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('José')]))).toBe('José');
    const h = makeEnforcingDb();
    const csv = decodeCsvBytes(Buffer.from(file(expense('Cash', 'Leisure', 'Café José 🎉'))));
    importText(h, csv);
    expect(rowsOf(h.sqlite, `SELECT merchant FROM transactions`)).toEqual([{ merchant: 'Café José 🎉' }]);
    expect(verifyImport(h.db, csv).passed).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------
describe('hostile or odd values fail safely', () => {
  it("a Transaction type of 'constructor' or '__proto__' is rejected as unknown, not accepted", () => {
    const { rows, issues } = parseTrackWallet(
      file(
        '"2026-08-01T10:00","constructor","Cash","USD","-5","-5","Leisure","",""',
        '"2026-08-01T10:00","__proto__","Cash","USD","-5","-5","Leisure","",""',
      ),
    );
    expect(rows).toEqual([]);
    expect(issues.map((i) => i.message)).toEqual([
      expect.stringContaining('unknown transaction type "constructor"'),
      expect.stringContaining('unknown transaction type "__proto__"'),
    ]);
  });

  it("an expense Category named 'constructor' or '__proto__' is just a new category, with no crash", () => {
    const h = makeEnforcingDb();
    const csv = file(expense('Cash', 'constructor'), expense('Cash', '__proto__', '', '2026-08-01T11:00'));
    const p = importText(h, csv);
    expect(p.newCategories.map((c) => c.name)).toEqual(['constructor', '__proto__']);
    expect(count(h)).toBe(2);
  });

  it('transfer legs whose account names differ only by case are one account, so they are not paired', () => {
    const h = makeEnforcingDb();
    const csv = file(transfer('2026-08-01T10:00', 'Cash', -10000), transfer('2026-08-01T10:00', 'cash', 10000));
    const p = plan(h, csv);
    expect(p.transferPairs).toBe(0);
    expect(p.skipped).toHaveLength(2);
    expect(() => commitImport(h.db, p, NOW, { verifyCsv: csv })).not.toThrow();
    expect(count(h)).toBe(0);
  });
});

// -------------------------------------------------------------------------------------------
// The command-line tool, run for real as a subprocess.
// -------------------------------------------------------------------------------------------
describe('import CLI safety rules', { timeout: 60_000 }, () => {
  const tsx = path.join(REPO, 'node_modules/tsx/dist/cli.mjs');
  const run = (script: string, args: string[]) => {
    const r = spawnSync(process.execPath, [tsx, path.join('src/cli', script), ...args], { cwd: REPO, encoding: 'utf8' });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'expenses-cli-'));
  const makeDb = (dir: string) => {
    const file = path.join(dir, 'app.db');
    const { sqlite, db } = openNodeDb(file);
    migrateNodeDb(db);
    seed(db, NOW);
    sqlite.close();
    return file;
  };
  const txCount = (dbFile: string) => {
    const { sqlite } = openNodeDb(dbFile, { readonly: true });
    const c = (sqlite.prepare('SELECT COUNT(*) AS n FROM transactions').get() as { n: number }).n;
    sqlite.close();
    return c;
  };
  const sha = (f: string) => createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const backups = (dir: string) => fs.readdirSync(dir).filter((f) => f.includes('.before-import-'));

  it('a dry run against a real database changes nothing and makes no backup', () => {
    const dir = tmp(); const db = makeDb(dir);
    const before = sha(db);
    const r = run('import.ts', [FIXTURE_PATH, '--db', db]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('DRY RUN: nothing was written');
    expect(r.out).toContain('accounted for:                   65 of 65');
    expect(sha(db)).toBe(before);
    expect(backups(dir)).toEqual([]);
  });

  it('opens the database read-only for a dry run and read-write only for --commit', () => {
    const dir = tmp(); const db = makeDb(dir);
    const dry = run('import.ts', [FIXTURE_PATH, '--db', db]);
    expect(dry.status).toBe(0);
    expect(dry.out).toContain('(opened read-only)');
    expect(dry.out).not.toContain('read-write');

    const real = run('import.ts', [FIXTURE_PATH, '--db', db, '--commit', '--confirm-new']);
    expect(real.status).toBe(0);
    expect(real.out).toContain('(opened read-write)');
  });

  it('a read-only handle really cannot write', () => {
    const dir = tmp(); const db = makeDb(dir);
    const { sqlite } = openNodeDb(db, { readonly: true });
    expect(sqlite.readonly).toBe(true);
    expect(() => sqlite.prepare(`DELETE FROM accounts`).run()).toThrow(/readonly/i);
    sqlite.close();
  });

  it('refuses --commit without --db, and never creates a database implicitly', () => {
    const dir = tmp();
    expect(run('import.ts', [FIXTURE_PATH, '--commit']).status).toBe(2);
    const missing = path.join(dir, 'nope.db');
    const r = run('import.ts', [FIXTURE_PATH, '--db', missing, '--commit', '--confirm-new']);
    expect(r.status).toBe(2);
    expect(r.err).toMatch(/no such database/);
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('will not create new people or categories until --confirm-new is given', () => {
    const dir = tmp(); const db = makeDb(dir);
    const r = run('import.ts', [FIXTURE_PATH, '--db', db, '--commit']);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/would create 7 people and 0 categories/);
    expect(r.err).toContain('--confirm-new');
    expect(txCount(db)).toBe(0);
    expect(backups(dir)).toEqual([]);
  });

  it('commits with --confirm-new: backs up first, verifies, and a second run is a no-op', () => {
    const dir = tmp(); const db = makeDb(dir);
    const r = run('import.ts', [FIXTURE_PATH, '--db', db, '--commit', '--confirm-new']);
    expect(r.status).toBe(0);
    expect(r.out).toContain('Backup written and checked:');
    expect(r.out).toContain('COMMITTED: 65 transaction(s), 7 people, 0 categories');
    expect(r.out).toContain('VERIFY: ALL CHECKS PASSED');
    expect(txCount(db)).toBe(65);
    const [backup] = backups(dir);
    expect(txCount(path.join(dir, backup))).toBe(0); // the backup is the state BEFORE the import

    const again = run('import.ts', [FIXTURE_PATH, '--db', db, '--commit', '--confirm-new']);
    expect(again.status).toBe(0);
    expect(again.out).toContain('Nothing to import');
    expect(txCount(db)).toBe(65);
    expect(backups(dir)).toHaveLength(1);
  });

  it('will not commit around skipped rows unless --allow-skips is given', () => {
    const dir = tmp(); const db = makeDb(dir);
    const csvFile = path.join(dir, 'lone.csv');
    fs.writeFileSync(csvFile, file(transfer('2026-08-01T10:00', 'Cash', -5000), expense('Cash', 'Leisure', 'Arcade', '2026-08-02T10:00')));
    const blocked = run('import.ts', [csvFile, '--db', db, '--commit']);
    expect(blocked.status).toBe(1);
    expect(blocked.err).toMatch(/1 row\(s\) would be skipped/);
    expect(txCount(db)).toBe(0);

    const allowed = run('import.ts', [csvFile, '--db', db, '--commit', '--allow-skips']);
    expect(allowed.status).toBe(0);
    expect(txCount(db)).toBe(1);
  });

  it('refuses a file that is not valid UTF-8', () => {
    const dir = tmp(); const db = makeDb(dir);
    const csvFile = path.join(dir, 'latin1.csv');
    fs.writeFileSync(csvFile, Buffer.concat([Buffer.from(HEADER.join(',') + '\n'), Buffer.from([0x22, 0x4a, 0x6f, 0x73, 0xe9, 0x22, 0x0a])]));
    const r = run('import.ts', [csvFile, '--db', db]);
    expect(r.status).toBe(1);
    expect(r.err).toMatch(/not valid UTF-8/);
  });

  it('import-verify reads the database read-only and reports pass, then fail after damage', () => {
    const dir = tmp(); const db = makeDb(dir);
    run('import.ts', [FIXTURE_PATH, '--db', db, '--commit', '--confirm-new']);
    const ok = run('import-verify.ts', [FIXTURE_PATH, '--db', db]);
    expect(ok.status).toBe(0);
    expect(ok.out).toContain('VERIFY: ALL CHECKS PASSED');

    const { sqlite } = openNodeDb(db);
    sqlite.prepare(`UPDATE transactions SET amount_native = amount_native - 1, amount_usd = amount_usd - 1 WHERE occurred_at = '2026-08-29T19:14:13'`).run();
    sqlite.close();
    const bad = run('import-verify.ts', [FIXTURE_PATH, '--db', db]);
    expect(bad.status).toBe(1);
    expect(bad.out).toContain('VERIFY: FAILED');
  });
});
