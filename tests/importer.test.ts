import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInvariants } from '../src/db/invariants';
import { commitImport, ImportBlockedError, ImportInvariantError } from '../src/import/commit';
import { renderTrackWalletCsv } from '../src/import/export';
import { planImport, type ImportPlan } from '../src/import/plan';
import { formatPlan } from '../src/import/report';
import { HEADER } from '../src/import/trackwallet';
import { verifyImport } from '../src/import/verify';
import { NOW, makeEnforcingDb, makeUnconstrainedDb, rowsOf } from './helpers';

const FIXTURE = fs.readFileSync(path.resolve(__dirname, 'fixtures/trackwallet_2026-08-01_2026-08-31.csv'), 'utf8');
const DATA_LINES = FIXTURE.split('\n').filter(Boolean).slice(1);
const file = (...lines: string[]) => [HEADER.join(','), ...lines].join('\n') + '\n';

let n = 0;
const newId = () => `id-${++n}`; // unique across every plan in this file

type Handle = ReturnType<typeof makeEnforcingDb>;
const plan = (h: Handle, text: string, filename = 'test.csv') => planImport(h.db, text, { filename, newId });
const importText = (h: Handle, text: string, filename?: string) => {
  const p = plan(h, text, filename);
  commitImport(h.db, p, NOW);
  return p;
};
const count = (h: Handle, table = 'transactions') => (rowsOf(h.sqlite, `SELECT COUNT(*) AS n FROM ${table}`)[0].n as number);
const invariantFailures = (h: Handle) => runInvariants((s) => rowsOf(h.sqlite, s)).filter((r) => !r.passed);
const check = (report: ReturnType<typeof verifyImport>, prefix: string) => report.checks.find((c) => c.name.startsWith(prefix))!;

// ---------------------------------------------------------------------------------------------
describe('the real August export', () => {
  it('has the shape the spec describes: 65 rows, 12 with seconds, 20 transfer rows', () => {
    expect(DATA_LINES).toHaveLength(65);
    expect(DATA_LINES.filter((l) => /^"\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d"/.test(l))).toHaveLength(12);
    expect(DATA_LINES.filter((l) => l.includes('"Transfer"'))).toHaveLength(20);
    expect(DATA_LINES.filter((l) => l.includes(',,,'))).toHaveLength(20); // bare-empty category fields
  });

  describe('plan (dry run)', () => {
    const h = makeEnforcingDb();
    const p = plan(h, FIXTURE, 'trackwallet_2026-08-01_2026-08-31.csv');

    it('reads 65 rows and accounts for every one', () => {
      expect(p.rowsRead).toBe(65);
      expect(p.legs).toHaveLength(65);
      expect(p.legs.filter((l) => l.type !== 'transfer')).toHaveLength(45);
      expect(p.transferPairs).toBe(10);
      expect([p.alreadyImported.length, p.skipped.length, p.issues.length]).toEqual([0, 0, 0]);
    });

    it('creates no accounts or categories, and exactly the 7 people in lending/borrowing notes', () => {
      expect(p.newCategories).toEqual([]);
      expect(p.newPeople.map((x) => x.name).sort()).toEqual(['Aakanksha', 'India', 'Pramod', 'Rishitha', 'Sahithi', 'Teja', 'UPS']);
    });

    it('remaps the one expense-side "Returned" to "Repaid" (decision C)', () => {
      expect(p.categoryMappings).toEqual([{ from: 'Returned', to: 'Repaid', kind: 'expense', rows: 1 }]);
    });

    it('writes nothing', () => {
      expect(count(h)).toBe(0);
      expect(count(h, 'people')).toBe(0);
    });

    it('renders a readable report', () => {
      const text = formatPlan(p);
      expect(text).toContain('rows read:                       65');
      expect(text).toContain('accounted for:                   65 of 65');
      expect(text).toContain('10 pair(s) matched');
      expect(text).toContain('Aakanksha');
      expect(text).toContain('expense "Returned" -> "Repaid"');
    });
  });

  describe('after commit', () => {
    const h = makeEnforcingDb();
    importText(h, FIXTURE, 'trackwallet_2026-08-01_2026-08-31.csv');

    it('holds 65 rows, and every database invariant passes', () => {
      expect(count(h)).toBe(65);
      expect(invariantFailures(h)).toEqual([]);
    });

    it('per-account sums equal hand-calculated values (cents)', () => {
      const sums = rowsOf(h.sqlite, `SELECT a.name AS name, SUM(t.amount_native) AS native, SUM(t.amount_usd) AS usd, COUNT(*) AS rows
        FROM transactions t JOIN accounts a ON a.id = t.account_id GROUP BY a.name ORDER BY a.name`);
      expect(sums).toEqual([
        { name: 'Cash', native: 48200, usd: 48200, rows: 18 },
        { name: 'Chase Bank Account', native: 2988, usd: 2988, rows: 20 },
        { name: 'Credit', native: 317721, usd: 317721, rows: 27 },
      ]);
    });

    it("matches TrackWallet's own August totals (6,196$ income, 2,506.91$ expenses, +3,689.09$) and transfers net to 0", () => {
      const byType = Object.fromEntries(
        rowsOf(h.sqlite, `SELECT type, SUM(amount_usd) AS s, COUNT(*) AS n FROM transactions GROUP BY type`).map((r) => [r.type, r]),
      );
      expect(byType.income).toMatchObject({ s: 619600, n: 12 });
      expect(byType.expense).toMatchObject({ s: -250691, n: 33 });
      expect(byType.transfer).toMatchObject({ s: 0, n: 20 });
    });

    it("matches every day cell I read off TrackWallet's calendar screenshot", () => {
      const day = (d: string) =>
        rowsOf(h.sqlite, `SELECT
            COALESCE(SUM(CASE WHEN type = 'income'  THEN amount_usd END), 0) AS income,
            COALESCE(SUM(CASE WHEN type = 'expense' THEN -amount_usd END), 0) AS expense
          FROM transactions WHERE substr(occurred_at, 1, 10) = '2026-08-${d}'`)[0];
      const expected: Record<string, [number, number]> = {
        '01': [42500, 0], '02': [2300, 3596], '03': [150000, 51788], '04': [23500, 50500], '09': [0, 4555],
        '15': [64200, 500], '22': [86400, 700], '25': [100000, 1500], '26': [0, 76382], '29': [65000, 579],
      };
      for (const [d, [income, expense]] of Object.entries(expected)) {
        expect(day(d), `Aug ${d}`).toEqual({ income, expense });
      }
    });

    it('reconstructs the lending ledger from notes (Section 6.4), 9 rows with a person', () => {
      const got = rowsOf(h.sqlite, `SELECT c.name || '|' || p.name || '|' || t.amount_native AS k FROM transactions t
          JOIN categories c ON c.id = t.category_id JOIN people p ON p.id = t.person_id`).map((r) => r.k);
      expect(got.sort()).toEqual(
        [
          'Lend|Sahithi|-20000', 'Lend|Teja|-4500', 'Lend|Pramod|-35000', 'Lend|UPS|-3780',
          'Returned|Pramod|19400', 'Returned|Pramod|24000', 'Returned|Rishitha|3500',
          'Taken|India|100000', 'Repaid|Aakanksha|-6800',
        ].sort(),
      );
      expect(rowsOf(h.sqlite, `SELECT COUNT(*) AS n FROM transactions WHERE person_id IS NOT NULL AND merchant IS NOT NULL`)).toEqual([{ n: 0 }]);
    });

    it('maps the expense-side Returned row to Repaid with its person, and no expense Returned exists', () => {
      expect(
        rowsOf(h.sqlite, `SELECT c.kind AS kind, c.name AS cat, p.name AS person, t.amount_native AS amt FROM transactions t
          JOIN categories c ON c.id = t.category_id JOIN people p ON p.id = t.person_id WHERE t.occurred_at = '2026-08-03T13:20:00' AND t.type = 'expense'`),
      ).toEqual([{ kind: 'expense', cat: 'Repaid', person: 'Aakanksha', amt: -6800 }]);
      expect(rowsOf(h.sqlite, `SELECT id FROM categories WHERE kind = 'expense' AND name = 'Returned'`)).toEqual([]);
    });

    it('treats other notes as merchants, not people', () => {
      const merchants = rowsOf(h.sqlite, `SELECT merchant FROM transactions WHERE merchant IS NOT NULL`).map((r) => r.merchant);
      for (const m of ['Costco', 'Dunkin', 'AMC', 'USPS', 'Verizon', "Vantil's", 'Education Fees Payment', 'Sahithi']) {
        expect(merchants, m).toContain(m);
      }
      // "Sahithi" on Salary > Ride is a merchant, while "Sahithi" on Lend is a person
      expect(rowsOf(h.sqlite, `SELECT person_id FROM transactions WHERE merchant = 'Sahithi'`)).toEqual([{ person_id: null }]);
    });

    it('keeps transfer notes verbatim and creates no person from them', () => {
      const notes = rowsOf(h.sqlite, `SELECT note, COUNT(*) AS n FROM transactions WHERE type = 'transfer' GROUP BY note ORDER BY note`);
      expect(notes).toEqual([
        { note: null, n: 4 }, { note: 'Aakanksha', n: 2 }, { note: 'Pramod', n: 2 }, { note: 'Rishitha', n: 2 },
        { note: 'Sahithi', n: 2 }, { note: 'Sai ram', n: 4 }, { note: 'Vamsi', n: 2 }, { note: 'Walmart', n: 2 },
      ]);
      const people = rowsOf(h.sqlite, `SELECT name FROM people`).map((r) => r.name);
      for (const notAPerson of ['Vamsi', 'Walmart', 'Sai ram']) expect(people).not.toContain(notAPerson);
    });

    it('stores local timestamps with seconds, no zone', () => {
      expect(rowsOf(h.sqlite, `SELECT COUNT(*) AS n FROM transactions WHERE occurred_at NOT GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]T[0-9][0-9]:[0-9][0-9]:[0-9][0-9]'`)).toEqual([{ n: 0 }]);
      expect(rowsOf(h.sqlite, `SELECT occurred_at FROM transactions WHERE occurred_at LIKE '2026-08-26T20:23%'`)).toEqual([{ occurred_at: '2026-08-26T20:23:00' }]);
      expect(rowsOf(h.sqlite, `SELECT occurred_at FROM transactions WHERE occurred_at LIKE '2026-08-29T19:14%'`)).toEqual([{ occurred_at: '2026-08-29T19:14:13' }]);
    });

    it('stores integers and rate 1.0 for every USD row', () => {
      expect(rowsOf(h.sqlite, `SELECT COUNT(*) AS n FROM transactions WHERE typeof(amount_native) <> 'integer' OR typeof(amount_usd) <> 'integer' OR fx_rate <> 1.0 OR currency <> 'USD'`)).toEqual([{ n: 0 }]);
    });

    it('verifies losslessly: every check passes', () => {
      const report = verifyImport(h.db, FIXTURE);
      expect(report.checks.filter((c) => !c.passed)).toEqual([]);
      expect(report.checks).toHaveLength(7);
      expect(check(report, '5a').lines[1]).toContain('timestamp seconds added on 53 row(s)');
      expect(check(report, '5b').lines[0]).toContain('identical: 65');
    });
  });
});

// ---------------------------------------------------------------------------------------------
describe('idempotency and overlapping files', () => {
  it('re-importing the same file, even under another filename, changes nothing', () => {
    const h = makeEnforcingDb();
    importText(h, FIXTURE, 'a.csv');
    const again = plan(h, FIXTURE, 'renamed.csv');
    expect([again.legs.length, again.alreadyImported.length, again.newPeople.length]).toEqual([0, 65, 0]);
    commitImport(h.db, again, NOW);
    expect(count(h)).toBe(65);
    expect(count(h, 'people')).toBe(7);
  });

  it('an overlapping file imports only the rows it adds', () => {
    const h = makeEnforcingDb();
    importText(h, file(...DATA_LINES.slice(20)), 'later.csv'); // the earlier part of the month is missing
    const before = count(h);
    const p = plan(h, FIXTURE, 'whole-month.csv');
    expect(p.alreadyImported).toHaveLength(before);
    expect(p.legs.length + before).toBe(65);
    commitImport(h.db, p, NOW);
    expect(count(h)).toBe(65);
    expect(verifyImport(h.db, FIXTURE).passed).toBe(true);
  });

  it('a transfer cut in half by a file boundary is skipped, then imported by the file that has both legs', () => {
    const h = makeEnforcingDb();
    const first = importText(h, file(...DATA_LINES.slice(0, 7)), 'cut.csv'); // line 7 is only the outgoing leg
    expect(first.skipped).toHaveLength(1);
    expect(first.skipped[0].reason).toMatch(/odd number of transfer rows/);
    expect(count(h)).toBe(6);
    importText(h, FIXTURE, 'full.csv');
    expect(count(h)).toBe(65);
    expect(invariantFailures(h)).toEqual([]);
  });

  it('flags a pair with exactly one leg already in the database instead of importing a lone leg', () => {
    const h = makeEnforcingDb();
    importText(h, FIXTURE);
    h.sqlite.prepare(`DELETE FROM transactions WHERE occurred_at = '2026-08-25T15:51:06' AND amount_native = 100000`).run();
    const p = plan(h, FIXTURE);
    expect(p.legs).toEqual([]);
    expect(p.skipped).toHaveLength(2);
    expect(p.skipped[0].reason).toMatch(/exactly one leg .* already in the database/);
  });

  it('imports identical rows within one file separately (occurrence index), and re-import is a no-op', () => {
    const h = makeEnforcingDb();
    const row = '"2026-08-01T10:00","Expense","Cash","USD","-5","-5","Leisure","","Arcade"';
    const p = importText(h, file(row, row), 'dup.csv');
    expect(p.legs).toHaveLength(2);
    expect(new Set(p.legs.map((l) => l.hash)).size).toBe(2);
    expect(count(h)).toBe(2);
    const again = plan(h, file(row, row));
    expect([again.legs.length, again.alreadyImported.length]).toEqual([0, 2]);
    // a later file containing only one of the two recognises exactly one
    const overlap = plan(h, file(row));
    expect([overlap.legs.length, overlap.alreadyImported.length]).toEqual([0, 1]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('unpaired transfers are reported, never guessed', () => {
  const lone = '"2026-08-01T10:00","Transfer","Cash","USD","-50","-50",,,"Vamsi"';
  const good = '"2026-08-02T10:00","Expense","Cash","USD","-5","-5","Leisure","","Arcade"';

  it('skips a lone leg with a reason, imports the rest, and verification accounts for it', () => {
    const h = makeEnforcingDb();
    const p = importText(h, file(lone, good), 'lone.csv');
    expect(p.skipped).toHaveLength(1);
    expect(p.skipped[0]).toMatchObject({ reason: expect.stringContaining('unpaired transfer') });
    expect(p.skipped[0].row.raw).toBe(lone);
    expect(count(h)).toBe(1);
    expect(formatPlan(p)).toContain(`SKIPPED line 2`);
    const report = verifyImport(h.db, file(lone, good));
    expect(report.passed).toBe(true);
    expect(check(report, '1.').lines.join('\n')).toContain('explicitly skipped (unpaired transfer): 1');
  });

  it('skips mismatched amounts on both rows', () => {
    const h = makeEnforcingDb();
    const p = plan(h, file(lone, '"2026-08-01T10:00","Transfer","Chase Bank Account","USD","49","49",,,""'));
    expect(p.legs).toEqual([]);
    expect(p.skipped).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------------------------
describe('a bad file never half-imports', () => {
  const goodNewPerson = '"2026-08-01T10:00","Expense","Cash","USD","-5","-5","Lend","","Zed"';

  it('blocks the commit on any validation issue and writes nothing, not even the new person', () => {
    const h = makeEnforcingDb();
    const p = plan(h, file(goodNewPerson, '"2026-08-01T10:01","Expense","Cash","USD","5","5","Leisure","",""'));
    expect(p.issues).toHaveLength(1);
    expect(p.rowsRead).toBe(2);
    expect(() => commitImport(h.db, p, NOW)).toThrow(ImportBlockedError);
    expect([count(h), count(h, 'people'), count(h, 'categories')]).toEqual([0, 0, 28]);
  });

  it('turns an unknown account into an error rather than inventing one', () => {
    const h = makeEnforcingDb();
    const p = plan(h, file('"2026-08-01T10:00","Expense","Wallet","USD","-5","-5","Leisure","",""'));
    expect(p.issues[0].message).toMatch(/unknown account "Wallet"/);
    expect(count(h, 'accounts')).toBe(5);
  });

  it('rejects a USD row aimed at a non-USD account', () => {
    const h = makeEnforcingDb();
    const p = plan(h, file('"2026-08-01T10:00","Expense","Education Loan","USD","-5","-5","Leisure","",""'));
    expect(p.issues[0].message).toMatch(/is INR but the row is USD/);
  });

  it('rolls back everything when a database constraint fails part-way', () => {
    const h = makeEnforcingDb();
    const p = plan(h, FIXTURE);
    const lastExpense = [...p.legs].reverse().find((l) => l.type === 'expense')!;
    lastExpense.row = { ...lastExpense.row, amountNative: 500, amountUsd: 500 }; // corrupt: positive expense
    expect(() => commitImport(h.db, p, NOW)).toThrow(/tx_expense_shape/);
    expect([count(h), count(h, 'people')]).toEqual([0, 0]);
  });

  it('rolls back everything when the post-insert invariant check fails', () => {
    const h = makeUnconstrainedDb(); // constraints off, so the inserts succeed and only the audit can object
    const p = plan(h, FIXTURE);
    const lastExpense = [...p.legs].reverse().find((l) => l.type === 'expense')!;
    lastExpense.row = { ...lastExpense.row, amountNative: 500, amountUsd: 500 };
    let error: unknown;
    try { commitImport(h.db, p, NOW); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(ImportInvariantError);
    expect((error as ImportInvariantError).failures.map((f) => f.invariant.id)).toContain(1);
    expect([count(h), count(h, 'people')]).toEqual([0, 0]);
  });
});

// ---------------------------------------------------------------------------------------------
describe('category and people mapping', () => {
  const exp = (cat: string, sub: string, note: string, when = '2026-08-01T10:00') =>
    `"${when}","Expense","Cash","USD","-5","-5","${cat}","${sub}","${note}"`;

  it('creates unknown categories and subcategories under the right kind and reports them', () => {
    const h = makeEnforcingDb();
    const p = plan(h, file(exp('Health', 'Gym', 'Pool'), exp('Food & Drinks', 'Restaurants', 'Sushi', '2026-08-01T11:00')));
    expect(p.newCategories.map((c) => [c.kind, c.parentName, c.name])).toEqual([
      ['expense', null, 'Health'],
      ['expense', 'Health', 'Gym'],
      ['expense', 'Food & Drinks', 'Restaurants'],
    ]);
    commitImport(h.db, p, NOW);
    expect(rowsOf(h.sqlite, `SELECT c.name AS name, p.name AS parent, c.kind AS kind FROM categories c LEFT JOIN categories p ON p.id = c.parent_id WHERE c.name IN ('Health','Gym','Restaurants') ORDER BY c.name`)).toEqual([
      { name: 'Gym', parent: 'Health', kind: 'expense' },
      { name: 'Health', parent: null, kind: 'expense' },
      { name: 'Restaurants', parent: 'Food & Drinks', kind: 'expense' },
    ]);
    expect(invariantFailures(h)).toEqual([]);
    expect(formatPlan(p)).toContain('expense: Health > Gym');
  });

  it('matches category names case-insensitively and creates nothing', () => {
    const h = makeEnforcingDb();
    const p = plan(h, file(exp('food & drinks', 'GROCERIES', 'Aldi')));
    expect(p.newCategories).toEqual([]);
    commitImport(h.db, p, NOW);
    expect(rowsOf(h.sqlite, `SELECT category_id FROM transactions`)).toEqual([{ category_id: 'cat-exp-food-and-drinks-groceries' }]);
  });

  it('never routes an unknown category into a catch-all bucket', () => {
    const h = makeEnforcingDb();
    const p = plan(h, file(exp('Mystery', '', '')));
    expect(p.newCategories.map((c) => c.name)).toEqual(['Mystery']);
    expect(p.issues).toEqual([]);
  });

  it('unifies people case-insensitively and trims notes', () => {
    const h = makeEnforcingDb();
    const p = importText(h, file(exp('Lend', '', 'Pramod'), exp('Lend', '', 'pramod', '2026-08-01T11:00'), exp('Lend', '', ' PRAMOD ', '2026-08-01T12:00')));
    expect(p.newPeople.map((x) => x.name)).toEqual(['Pramod']);
    expect(p.warnings.some((w) => w.includes('case-insensitive'))).toBe(true);
    expect(rowsOf(h.sqlite, `SELECT COUNT(DISTINCT person_id) AS n FROM transactions`)).toEqual([{ n: 1 }]);
    // and a later file reuses the stored person rather than creating another
    const later = plan(h, file(exp('Lend', '', 'pRaMoD', '2026-08-02T10:00')));
    expect(later.newPeople).toEqual([]);
  });

  it('imports a people-backed row with an empty note but warns about it', () => {
    const h = makeEnforcingDb();
    const p = importText(h, file(exp('Lend', '', '')));
    expect(p.warnings[0]).toMatch(/nothing in Note to say who or what/);
    expect(rowsOf(h.sqlite, `SELECT person_id FROM transactions`)).toEqual([{ person_id: null }]);
    expect(invariantFailures(h)).toEqual([]);
  });

  it('rejects a Subcategory on a people-backed category rather than guessing', () => {
    const h = makeEnforcingDb();
    const p = plan(h, file(exp('Lend', 'Cash loan', 'Pramod')));
    expect(p.issues[0].message).toMatch(/people-backed but the row has a Subcategory/);
  });

  it('income Returned is a person paying the user back, and is not remapped', () => {
    const h = makeEnforcingDb();
    const p = plan(h, file('"2026-08-01T10:00","Income","Cash","USD","20","20","Returned","","Pramod"'));
    expect(p.categoryMappings).toEqual([]);
    expect(p.newPeople.map((x) => x.name)).toEqual(['Pramod']);
  });

  it('reports a clear error if the Repaid category the remap needs is missing', () => {
    const h = makeEnforcingDb();
    h.sqlite.prepare(`DELETE FROM categories WHERE id = 'cat-exp-repaid'`).run();
    const p = plan(h, file(exp('Returned', '', 'Aakanksha')));
    expect(p.issues[0].message).toMatch(/maps to "Repaid", which does not exist/);
  });
});

// ---------------------------------------------------------------------------------------------
describe('verification catches damage', () => {
  const damaged = (mutate: (h: Handle) => void) => {
    const h = makeEnforcingDb();
    importText(h, FIXTURE);
    mutate(h);
    return verifyImport(h.db, FIXTURE);
  };

  it('a soft-deleted imported row is reported as missing', () => {
    const r = damaged((h) => h.sqlite.prepare(`UPDATE transactions SET deleted_at = ? WHERE occurred_at = '2026-08-29T19:14:13'`).run(NOW));
    expect(r.passed).toBe(false);
    expect(check(r, '1.').passed).toBe(false);
    expect(check(r, '1.').lines.join('\n')).toMatch(/MISSING line 2/);
  });

  it('an altered amount breaks the per-account totals and the round trip', () => {
    const r = damaged((h) => h.sqlite.prepare(`UPDATE transactions SET amount_native = -580, amount_usd = -580 WHERE occurred_at = '2026-08-29T19:14:13'`).run());
    expect(check(r, '2.').passed).toBe(false);
    expect(check(r, '5a').passed).toBe(false);
    expect(check(r, '5b').passed).toBe(false);
  });

  it('a deleted transfer leg is reported as missing and leaves an orphan', () => {
    const r = damaged((h) => h.sqlite.prepare(`DELETE FROM transactions WHERE occurred_at = '2026-08-25T15:51:06' AND amount_native = -100000`).run());
    expect(check(r, '1.').passed).toBe(false);
    expect(check(r, '3.').passed).toBe(false);
    expect(check(r, '4.').passed).toBe(false);
    expect(check(r, '4.').lines[0]).toBe('transfer legs without a partner: 1');
  });

  it('a changed category is caught by the field-level round trip', () => {
    const r = damaged((h) => h.sqlite.prepare(`UPDATE transactions SET category_id = 'cat-exp-shopping' WHERE occurred_at = '2026-08-29T19:14:13'`).run());
    expect(check(r, '5a').passed).toBe(false);
    expect(check(r, '5a').lines.join('\n')).toMatch(/Category: source="Food & Drinks" exported="Shopping"/);
  });

  it('a lost person link is caught by the round trip', () => {
    const r = damaged((h) => h.sqlite.prepare(`UPDATE transactions SET person_id = NULL, merchant = 'Xavier' WHERE occurred_at = '2026-08-23T18:34:00'`).run());
    expect(check(r, '5a').passed).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe('CSV rendering', () => {
  const base = { currency: 'USD', amountNative: -100, amountUsd: -100, category: '', subcategory: '', note: '' } as const;

  it("reproduces TrackWallet's quoting: bare empties on transfers, quoted empties elsewhere", () => {
    const csv = renderTrackWalletCsv([
      { ...base, occurredAt: '2026-08-25T15:51:06', type: 'transfer', account: 'Chase Bank Account', amountNative: -100000, amountUsd: -100000 },
      { ...base, occurredAt: '2026-08-22T15:34:00', type: 'income', account: 'Cash', amountNative: 62400, amountUsd: 62400, category: 'Salary', subcategory: 'Denim' },
    ]);
    expect(csv.split('\n')).toEqual([
      'Date,Transaction,Account,Currency,Amount,Amount_USD,Category,Subcategory,Note',
      '"2026-08-25T15:51:06","Transfer","Chase Bank Account","USD","-1000","-1000",,,""',
      '"2026-08-22T15:34:00","Income","Cash","USD","624","624","Salary","Denim",""',
      '',
    ]);
  });

  it('escapes embedded quotes and supports CRLF', () => {
    const csv = renderTrackWalletCsv([{ ...base, occurredAt: '2026-08-01T10:00:00', type: 'expense', account: 'Cash', category: 'Leisure', note: 'the "big" one, again' }], '\r\n');
    expect(csv).toContain('"the ""big"" one, again"');
    expect(csv.endsWith('\r\n')).toBe(true);
  });
});
