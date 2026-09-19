import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { migrateNodeDb, openNodeDb } from '../src/db/node';
import { seed } from '../src/db/seed';
import { commitImport } from '../src/import/commit';
import { parseCsv } from '../src/import/csv';
import { hashRows, planImport } from '../src/import/plan';
import { HEADER, pairTransfers, parseTrackWallet, type SourceRow } from '../src/import/trackwallet';
import { verifyImport } from '../src/import/verify';
import { NOW, makeEnforcingDb, rowsOf } from './helpers';

/** The user reviewed and accepted the new names / skipped rows (the library refuses otherwise). */
const ACK = { confirmNew: true, allowSkips: true };
const REPO = path.resolve(__dirname, '..');
const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/trackwallet_2026-08-01_2026-08-31.csv');
const FIXTURE = fs.readFileSync(FIXTURE_PATH, 'utf8');
const file = (...lines: string[]) => [HEADER.join(','), ...lines].join('\n') + '\n';

let n = 0;
const newId = () => `s-${++n}`;
type Handle = ReturnType<typeof makeEnforcingDb>;
const plan = (h: Handle, text: string) => planImport(h.db, text, { filename: 'second-pass.csv', newId });
const importText = (h: Handle, text: string) => {
  const p = plan(h, text);
  commitImport(h.db, p, NOW, { ...ACK, verifyCsv: text });
  return p;
};
const count = (h: Handle, where = '') => rowsOf(h.sqlite, `SELECT COUNT(*) AS n FROM transactions ${where}`)[0].n as number;
const check = (r: ReturnType<typeof verifyImport>, prefix: string) => r.checks.find((c) => c.name.startsWith(prefix))!;

const expense = (cents: number, note = '', when = '2026-08-01T10:00', cat = 'Leisure', account = 'Cash') =>
  `"${when}","Expense","${account}","USD","${-cents / 100}","${-cents / 100}","${cat}","","${note}"`;
const transfer = (when: string, account: string, cents: number) =>
  `"${when}","Transfer","${account}","USD","${cents / 100}","${cents / 100}",,,""`;

// -------------------------------------------------------------------------------------------
describe('N1: an earlier import that was since edited or deleted does not veto a new one', () => {
  const A = expense(500, 'A', '2026-08-01T10:00');
  const B = expense(700, 'B', '2026-08-02T10:00');
  const C = expense(900, 'C', '2026-08-03T10:00');

  it('re-importing a wider file after the user deleted one row still imports the new row', () => {
    const h = makeEnforcingDb();
    importText(h, file(A, B));
    h.sqlite.prepare(`UPDATE transactions SET deleted_at = ? WHERE merchant = 'A'`).run(NOW);

    const wider = file(A, B, C);
    const p = plan(h, wider);
    expect([p.legs.length, p.alreadyImported.length]).toEqual([1, 2]); // the deleted row is NOT resurrected
    expect(() => commitImport(h.db, p, NOW, { ...ACK, verifyCsv: wider })).not.toThrow();
    expect(count(h, 'WHERE deleted_at IS NULL')).toBe(2); // B and C
    expect(rowsOf(h.sqlite, `SELECT merchant FROM transactions WHERE deleted_at IS NULL ORDER BY merchant`)).toEqual([{ merchant: 'B' }, { merchant: 'C' }]);

    // the standalone whole-file verification still tells the truth about the deleted row
    const whole = verifyImport(h.db, wider);
    expect(whole.passed).toBe(false);
    expect(check(whole, '1.').lines.join('\n')).toMatch(/MISSING line 2/);
    // ...and scoped to what the last commit wrote it is clean
    expect(verifyImport(h.db, wider, { only: new Set(p.legs.map((l) => l.hash)) }).passed).toBe(true);
  });

  it('an amount edited in the app does not block a later overlapping import either', () => {
    const h = makeEnforcingDb();
    importText(h, file(A, B));
    h.sqlite.prepare(`UPDATE transactions SET amount_native = -111, amount_usd = -111 WHERE merchant = 'B'`).run();
    const wider = file(A, B, C);
    expect(() => importText(h, wider)).not.toThrow();
    expect(count(h)).toBe(3);
  });

  it('scoped verification only looks at the requested rows, but hashes the whole file', () => {
    const h = makeEnforcingDb();
    const text = file(A, A, B); // two identical rows: the occurrence index is per FILE
    importText(h, text);
    const all = parseTrackWallet(text).rows;
    const hashes = hashRows(all);
    const only = verifyImport(h.db, text, { only: new Set([hashes[1], hashes[2]]) });
    expect(only.passed).toBe(true);
    expect(check(only, '1.').lines[0]).toContain('rows read from CSV:                    2');
  });
});

// -------------------------------------------------------------------------------------------
describe('N2: a Note with a line break inside quotes imports and verifies', () => {
  for (const [label, nl] of [['LF', '\n'], ['CRLF', '\r\n']] as const) {
    it(`${label} inside the quoted field`, () => {
      const h = makeEnforcingDb();
      const text = file(`"2026-08-01T10:00","Expense","Cash","USD","-5","-5","Leisure","","line1${nl}line2"`);
      expect(parseCsv(text)).toHaveLength(2);
      const p = importText(h, text);
      expect(p.issues).toEqual([]);
      expect(rowsOf(h.sqlite, `SELECT merchant FROM transactions`)).toEqual([{ merchant: `line1${nl}line2` }]);
      const r = verifyImport(h.db, text);
      expect(r.passed).toBe(true);
      expect(check(r, '5b').lines[0]).toContain('identical: 1');
    });
  }
});

// -------------------------------------------------------------------------------------------
describe('N4/N8: lookalike rows and an unambiguous hash', () => {
  it('flags every new row that duplicates a stored one under an older hash scheme', () => {
    const h = makeEnforcingDb();
    importText(h, FIXTURE);
    h.sqlite.prepare(`UPDATE transactions SET import_hash = 'old-scheme-' || import_hash`).run(); // simulate a scheme change
    const p = plan(h, FIXTURE);
    expect(p.alreadyImported).toHaveLength(0);
    expect(p.legs).toHaveLength(65);
    expect(p.lookalikes).toHaveLength(65); // the whole file is flagged, not silently doubled
  });

  it('flags a new row that duplicates one entered by hand', () => {
    const h = makeEnforcingDb();
    h.sqlite
      .prepare(
        `INSERT INTO transactions (id, occurred_at, type, account_id, currency, amount_native, amount_usd, fx_rate, category_id, created_at, updated_at)
         VALUES ('manual', '2026-08-01T10:00:00', 'expense', 'acc-cash', 'USD', -500, -500, 1.0, 'cat-exp-leisure', ?, ?)`,
      )
      .run(NOW, NOW);
    const p = plan(h, file(expense(500)));
    expect(p.lookalikes.map((l) => [l.row.line, l.existingIds])).toEqual([[2, ['manual']]]);
  });

  it('does not cry wolf: different amount, other seconds, other account, or the same file again', () => {
    const h = makeEnforcingDb();
    importText(h, file(expense(500, 'A')));
    for (const csv of [
      file(expense(501, 'A')), // other amount
      file(expense(500, 'A', '2026-08-01T10:01')), // other minute
      file(expense(500, 'A', '2026-08-01T10:00', 'Leisure', 'Credit')), // other account
      file(expense(500, 'B')), // other merchant
    ]) {
      expect(plan(h, csv).lookalikes, csv).toEqual([]);
    }
    const same = plan(h, file(expense(500, 'A')));
    expect([same.legs.length, same.alreadyImported.length, same.lookalikes.length]).toEqual([0, 1, 0]);
  });

  it('a wider overlapping file is not a lookalike of its own earlier import', () => {
    const h = makeEnforcingDb();
    importText(h, file(...FIXTURE.split('\n').filter(Boolean).slice(1, 30)));
    const p = plan(h, FIXTURE);
    expect(p.lookalikes).toEqual([]);
    expect(p.legs.length + p.alreadyImported.length + p.skipped.length).toBe(65);
  });

  it('two identical same-minute rows split across two files are not flagged', () => {
    const h = makeEnforcingDb();
    importText(h, file(expense(500, 'Coffee')));
    const p = plan(h, file(expense(500, 'Coffee'), expense(500, 'Coffee'))); // second export shows both
    expect([p.legs.length, p.alreadyImported.length, p.lookalikes.length]).toEqual([1, 1, 0]);
  });

  it('control characters in a name cannot make two different rows share a hash', () => {
    // Hashed in SEPARATE files: within one file the occurrence index would hide a collision.
    const rowA = '"2026-08-01T10:00","Expense","Cash","USD","-5","-5","Leisure\u001fX","",""';
    const rowB = '"2026-08-01T10:00","Expense","Cash","USD","-5","-5","Leisure","X\u001f",""';
    const [ra] = parseTrackWallet(file(rowA)).rows;
    const [rb] = parseTrackWallet(file(rowB)).rows;
    expect(ra.category).toBe('Leisure\u001fX');
    expect(rb.subcategory).toBe('X\u001f');
    expect(hashRows([ra])[0]).not.toBe(hashRows([rb])[0]);
  });
});

// -------------------------------------------------------------------------------------------
describe('N5: transfer pairing does not depend on the order of rows', () => {
  const T = '2026-08-01T10:00:00';
  let line = 1;
  const row = (account: string, cents: number, when = T): SourceRow => ({
    line: ++line, raw: `r${line}`, occurredAt: when, type: 'transfer', account, currency: 'USD',
    amountNative: cents, amountUsd: cents, category: '', subcategory: '', note: '',
  });
  const permutations = <X,>(xs: X[]): X[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]));
  const signature = (pairs: { negative: SourceRow; positive: SourceRow }[]) =>
    pairs.map((p) => `${p.negative.account}>${p.positive.account}:${p.positive.amountUsd}`).sort().join('|');

  it('the reviewer case (A-10, C-10, B+10, A+10) pairs the same way in all 24 orders', () => {
    const rows = [row('A', -1000), row('C', -1000), row('B', 1000), row('A', 1000)];
    const seen = new Set<string>();
    for (const perm of permutations(rows)) {
      const { pairs, unpaired } = pairTransfers(perm);
      expect(unpaired).toEqual([]);
      expect(pairs).toHaveLength(2);
      seen.add(signature(pairs));
    }
    expect([...seen]).toEqual(['A>B:1000|C>A:1000']);
  });

  it('a re-export with the tied rows reordered does not turn imported transfers into skipped ones', () => {
    const h = makeEnforcingDb();
    // accounts A/B/C stand in for Cash / Chase Bank Account / Credit
    const first = file(
      transfer(T, 'Cash', -1000), transfer(T, 'Credit', -1000), transfer(T, 'Chase Bank Account', 1000), transfer(T, 'Cash', 1000),
    );
    const reordered = file(
      transfer(T, 'Credit', -1000), transfer(T, 'Cash', -1000), transfer(T, 'Chase Bank Account', 1000), transfer(T, 'Cash', 1000),
    );
    importText(h, first);
    expect(count(h)).toBe(4);
    const p = plan(h, reordered);
    expect([p.legs.length, p.alreadyImported.length, p.skipped.length]).toEqual([0, 4, 0]);
    expect(verifyImport(h.db, reordered).passed).toBe(true);
  });

  it('random groups: valid, order-independent, and equal to brute force on whether the pairing is forced', () => {
    let seed = 20260918;
    const rnd = (k: number) => Math.floor((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 65536) % k; // high bits: the low bits of an LCG barely vary
    const accounts = ['A', 'B', 'C', 'D'];
    let paired = 0, ambiguous = 0;

    for (let iter = 0; iter < 8000; iter++) {
      const size = 2 * (1 + rnd(3)); // 2, 4 or 6 rows
      const rows: SourceRow[] = [];
      for (let i = 0; i < size; i++) rows.push(row(accounts[rnd(4)], (rnd(2) ? 1 : -1) * (rnd(2) ? 100 : 200)));

      // brute force: distinct account-pair multisets over every perfect matching, per amount
      const bruteSignatures = new Set<string>();
      const solveAmount = (amt: number): Set<string> | null => {
        const neg = rows.filter((r) => r.amountUsd === -amt);
        const pos = rows.filter((r) => r.amountUsd === amt);
        if (neg.length !== pos.length) return null;
        const sigs = new Set<string>();
        for (const perm of permutations(pos)) {
          if (neg.every((x, i) => x.account !== perm[i].account)) {
            sigs.add(neg.map((x, i) => `${x.account}>${perm[i].account}`).sort().join(','));
          }
        }
        return sigs;
      };
      let feasible = rows.filter((r) => r.amountUsd < 0).length === rows.filter((r) => r.amountUsd > 0).length;
      let unique = feasible;
      for (const amt of [100, 200]) {
        const sigs = solveAmount(amt);
        if (sigs === null || sigs.size === 0) { feasible = unique = false; break; }
        if (sigs.size > 1) unique = false;
        sigs.forEach((s) => bruteSignatures.add(`${amt}:${s}`));
      }
      // rows may all be one sign or one amount class may be empty: solveAmount handles 0 == 0 as one empty matching
      const expectedPaired = feasible && unique;

      const results = [0, 1, 2, 3, 4, 5].map(() => {
        const shuffled = [...rows].sort(() => rnd(3) - 1);
        return pairTransfers(shuffled);
      });
      for (const r of results) {
        expect(r.pairs.length > 0, `iter ${iter}`).toBe(expectedPaired);
        expect(r.unpaired.length === 0, `iter ${iter}`).toBe(expectedPaired);
        for (const p of r.pairs) {
          expect(p.negative.amountUsd).toBe(-p.positive.amountUsd);
          expect(p.negative.account).not.toBe(p.positive.account);
          expect(p.negative.occurredAt).toBe(p.positive.occurredAt);
        }
      }
      if (expectedPaired) {
        paired++;
        expect(new Set(results.map((r) => signature(r.pairs))).size, `iter ${iter}`).toBe(1);
      } else if (feasible) {
        ambiguous++;
      }
    }
    // the generator must actually exercise both outcomes, or this test proves nothing
    expect(paired).toBeGreaterThan(200);
    expect(ambiguous).toBeGreaterThan(20);
  });
});

// -------------------------------------------------------------------------------------------
describe('N7: formatting differences are counted, not failed', () => {
  it('accepts -5.0, unquoted fields and an upper-case type, and says so', () => {
    const h = makeEnforcingDb();
    const text = file('2026-08-01T10:00,EXPENSE,Cash,USD,-5.0,-5.0,Leisure,,Arcade');
    importText(h, text); // verification runs inside the commit and must not veto this
    const r = verifyImport(h.db, text);
    expect(r.passed).toBe(true);
    expect(check(r, '5b').lines[0]).toMatch(/identical apart from formatting: 1/);
    expect(rowsOf(h.sqlite, `SELECT amount_native AS a FROM transactions`)).toEqual([{ a: -500 }]);
  });
});

// -------------------------------------------------------------------------------------------
describe('N9: a lone carriage return ends a line', () => {
  it('reports the right line numbers', () => {
    const recs = parseCsv('a,b\rc,d\re,f');
    expect(recs.map((r) => r.line)).toEqual([1, 2, 3]);
    expect(recs.map((r) => r.fields)).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f']]);
    expect(parseCsv('a,b\r\nc,d\r\n').map((r) => r.line)).toEqual([1, 2]);
  });
});

// -------------------------------------------------------------------------------------------
describe('the library refuses lookalikes unless they were reviewed', () => {
  it('commitImport throws without allowLookalikes, writes nothing, and proceeds with it', () => {
    const h = makeEnforcingDb();
    h.sqlite
      .prepare(
        `INSERT INTO transactions (id, occurred_at, type, account_id, currency, amount_native, amount_usd, fx_rate, category_id, created_at, updated_at)
         VALUES ('manual', '2026-08-01T10:00:00', 'expense', 'acc-cash', 'USD', -500, -500, 1.0, 'cat-exp-leisure', ?, ?)`,
      )
      .run(NOW, NOW);
    const csv = file(expense(500));
    const p = plan(h, csv);
    expect(() => commitImport(h.db, p, NOW, { ...ACK, verifyCsv: csv })).toThrow(/look like rows already in the database/);
    expect(count(h)).toBe(1);
    expect(() => commitImport(h.db, p, NOW, { ...ACK, verifyCsv: csv, allowLookalikes: true })).not.toThrow();
    expect(count(h)).toBe(2);
  });
});

describe('CLI: arguments, backups, lookalikes', { timeout: 90_000 }, () => {
  const tsx = path.join(REPO, 'node_modules/tsx/dist/cli.mjs');
  const run = (script: string, args: string[]) => {
    const r = spawnSync(process.execPath, [tsx, path.join('src/cli', script), ...args], { cwd: REPO, encoding: 'utf8' });
    return { status: r.status, out: r.stdout, err: r.stderr };
  };
  const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'expenses-cli2-'));
  const seedDb = (h: ReturnType<typeof openNodeDb>) => { migrateNodeDb(h.db); seed(h.db, NOW); };
  const tableCount = (dbFile: string, table: string): number | null => {
    try {
      const { sqlite } = openNodeDb(dbFile, { readonly: true });
      const c = (sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
      sqlite.close();
      return c;
    } catch {
      return null;
    }
  };

  it('N6: the CSV may be the first argument with no --db (in-memory dry run)', () => {
    const r = run('import.ts', [FIXTURE_PATH]);
    expect(r.status).toBe(0);
    expect(r.out).toContain('throwaway in-memory database');
    expect(r.out).toContain('accounted for:                   65 of 65');
    const v = run('import-verify.ts', [FIXTURE_PATH]);
    expect(v.status).toBe(2); // needs --db, with a usage message rather than a crash
    expect(v.err).toContain('usage');
  });

  it('N3: the backup of a WAL-mode database with un-checkpointed changes is complete and checked', () => {
    const dir = tmp();
    const dbFile = path.join(dir, 'wal.db');
    const held = openNodeDb(dbFile);
    held.sqlite.pragma('journal_mode = WAL');
    seedDb(held); // another connection stays open, so these changes remain in the -wal file
    try {
      // premise: copying only the main file loses them (this is the failure a naive backup has)
      const naive = path.join(dir, 'naive-copy.db');
      fs.copyFileSync(dbFile, naive);
      expect(tableCount(naive, 'accounts')).toBeNull();

      const r = run('import.ts', [FIXTURE_PATH, '--db', dbFile, '--commit', '--confirm-new']);
      expect(r.status).toBe(0);
      expect(r.out).toContain('Backup written and checked:');
      const backup = fs.readdirSync(dir).find((f) => f.includes('.before-import-'))!;
      const backupPath = path.join(dir, backup);
      expect(tableCount(backupPath, 'accounts')).toBe(3);
      expect(tableCount(backupPath, 'categories')).toBe(28);
      expect(tableCount(backupPath, 'transactions')).toBe(0);
    } finally {
      held.sqlite.close();
    }
  });

  it('N4: --commit refuses lookalike rows without --allow-lookalikes, and touches nothing', () => {
    const dir = tmp();
    const dbFile = path.join(dir, 'app.db');
    const h = openNodeDb(dbFile);
    seedDb(h);
    h.sqlite.prepare(
      `INSERT INTO transactions (id, occurred_at, type, account_id, currency, amount_native, amount_usd, fx_rate, category_id, created_at, updated_at)
       VALUES ('manual', '2026-08-01T10:00:00', 'expense', 'acc-cash', 'USD', -500, -500, 1.0, 'cat-exp-leisure', ?, ?)`,
    ).run(NOW, NOW);
    h.sqlite.close();
    const csv = path.join(dir, 'x.csv');
    fs.writeFileSync(csv, file(expense(500)));

    const dry = run('import.ts', [csv, '--db', dbFile]);
    expect(dry.out).toContain('LOOKALIKES: 1 new row(s)');

    const blocked = run('import.ts', [csv, '--db', dbFile, '--commit']);
    expect(blocked.status).toBe(1);
    expect(blocked.err).toMatch(/look like rows the database already holds/);
    expect(tableCount(dbFile, 'transactions')).toBe(1);
    expect(fs.readdirSync(dir).filter((f) => f.includes('.before-import-'))).toEqual([]);

    const allowed = run('import.ts', [csv, '--db', dbFile, '--commit', '--allow-lookalikes']);
    expect(allowed.status).toBe(0);
    expect(tableCount(dbFile, 'transactions')).toBe(2);
  });
});
