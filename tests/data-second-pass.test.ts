import { describe, expect, it } from 'vitest';
import {
  archiveAccount, createExpense, createPerson, createTransferBetween, deleteEntry, listTransactions, MAX_CENTS,
  totalBalanceCents, updateEntry, updateTransfer, balanceSeries,
} from '../src/data';
import { createTransfer } from '../src/db/transfers';
import { HEADER, parseTrackWallet } from '../src/import/trackwallet';
import { applyImport, previewImport } from '../src/import/service';
import { ACC, CAT, NOW, expectData, makeDataDb, rows, type DataHandle } from './data-helpers';

const file = (...lines: string[]) => [HEADER.join(','), ...lines].join('\n') + '\n';
const big = (dollars: string) => `"2026-08-01T10:00","Expense","Cash","USD","-${dollars}","-${dollars}","Leisure","","big"`;
const req = (h: DataHandle, csvText: string) => ({ csvText, filename: 'x.csv', newId: h.ctx.newId, now: NOW });
const T = '2026-08-10T09:30:00';

describe('one amount limit for every way in (the importer used to allow far more than the data layer)', () => {
  it('the importer refuses a row above the limit, and accepts exactly the limit', () => {
    const over = parseTrackWallet(file(big('10000000000.01')));
    expect(over.rows).toEqual([]);
    expect(over.issues[0].message).toMatch(/larger than the limit of 10000000000 dollars/);
    expect(parseTrackWallet(file(big('9999999999999'))).issues).toHaveLength(1); // the 13-digit amount that used to import
    expect(parseTrackWallet(file(big('10000000000'))).rows).toHaveLength(1);
  });

  it('a row imported at the limit can still be edited and deleted (the regression the review found)', () => {
    const h = makeDataDb();
    applyImport(h.db, req(h, file(big('10000000000'))));
    const id = (rows(h, `SELECT id FROM transactions`)[0] as { id: string }).id;
    expect(rows(h, `SELECT amount_usd AS a FROM transactions`)).toEqual([{ a: -MAX_CENTS }]);
    expect(updateEntry(h.ctx, id, { note: 'fixed', merchant: null }).note).toBe('fixed');
    expect(updateEntry(h.ctx, id, { categoryId: CAT.food }).categoryId).toBe(CAT.food);
    deleteEntry(h.ctx, id);
    expect(totalBalanceCents(h.ctx)).toBe(0);
  });

  it('an over-limit row in a file blocks the whole import and writes nothing', () => {
    const h = makeDataDb();
    const plan = previewImport(h.db, req(h, file(big('20000000000'), big('5'))));
    expect(plan.issues).toHaveLength(1);
    expect(() => applyImport(h.db, { ...req(h, file(big('20000000000'))), confirmNew: true })).toThrow();
    expect(rows(h, 'SELECT COUNT(*) AS n FROM transactions')).toEqual([{ n: 0 }]);
  });

  it('edits and the raw transfer write path enforce the same limit', () => {
    const h = makeDataDb();
    const e = createExpense(h.ctx, { occurredAt: T, accountId: ACC.cash, amountCents: 100, categoryId: CAT.leisure });
    expectData(() => updateEntry(h.ctx, e.id, { amountCents: MAX_CENTS + 1 }), 'invalid', /too large/);
    const { groupId } = createTransferBetween(h.ctx, { occurredAt: T, fromAccountId: ACC.chase, toAccountId: ACC.credit, amountCents: 100 });
    expectData(() => updateTransfer(h.ctx, groupId, { amountCents: MAX_CENTS + 1 }), 'invalid', /too large/);
    expect(() =>
      createTransfer(h.db, {
        occurredAt: T, from: { accountId: ACC.chase, currency: 'USD', amountNative: MAX_CENTS + 1 },
        to: { accountId: ACC.credit, currency: 'USD', amountNative: MAX_CENTS + 1 }, amountUsd: MAX_CENTS + 1, now: NOW,
      }),
    ).toThrow(/larger than the limit/);
    // the USD amount is capped on its own: small native legs (INR) with a huge USD amount are still refused
    expect(() =>
      createTransfer(h.db, {
        occurredAt: T, from: { accountId: ACC.chase, currency: 'INR', amountNative: 100 },
        to: { accountId: ACC.credit, currency: 'INR', amountNative: 100 }, amountUsd: MAX_CENTS + 1, now: NOW,
      }),
    ).toThrow(/amountUsd is larger than the limit/);
    expect(rows(h, `SELECT COUNT(*) AS n FROM transactions WHERE type = 'transfer'`)).toEqual([{ n: 2 }]); // only the valid one above
  });
});

describe('names', () => {
  it('rejects a name made only of any of the invisible / filler characters', () => {
    const h = makeDataDb();
    const invisible = [0x3164, 0x034f, 0x180e, 0x115f, 0x1160, 0x2800, 0xffa0, 0x2062, 0xfe0f, 0x17b4];
    for (const cp of invisible) {
      const ch = String.fromCharCode(cp);
      expectData(() => createPerson(h.ctx, { name: ch }), 'invalid', /visible character/);
      expectData(() => createPerson(h.ctx, { name: `${ch}${ch}` }), 'invalid', /visible character/);
    }
    expect(createPerson(h.ctx, { name: `A${String.fromCharCode(0x3164)}` }).name).toContain('A'); // real text plus a filler is fine
  });
});

describe('the import plan', () => {
  it('lists new names as exactly {id, name}, and warns once per name spelling', () => {
    const h = makeDataDb();
    const csv = file(
      '"2026-08-01T10:00","Expense","Cash","USD","-5","-5","Lend","","Pramod"',
      '"2026-08-01T10:01","Expense","Cash","USD","-5","-5","Lend","","pramod"',
      '"2026-08-01T10:02","Expense","Cash","USD","-5","-5","Lend","","pramod"',
      '"2026-08-01T10:03","Expense","Cash","USD","-5","-5","Lend","","PRAMOD"',
    );
    const plan = previewImport(h.db, req(h, csv));
    expect(plan.newPeople).toHaveLength(1);
    expect(Object.keys(plan.newPeople[0]).sort()).toEqual(['id', 'name']);
    const caseWarnings = plan.warnings.filter((w) => w.includes('case-insensitive'));
    expect(caseWarnings).toHaveLength(2); // "pramod" once (seen twice) and "PRAMOD" once
  });
});

describe('edits and guards, edge behaviour', () => {
  it('an empty-string name is refused when editing an entry', () => {
    const h = makeDataDb();
    const e = createExpense(h.ctx, { occurredAt: T, accountId: ACC.cash, amountCents: 100, categoryId: CAT.leisure });
    expectData(() => updateEntry(h.ctx, e.id, { personId: '' }), 'invalid', /Lend, Returned, Taken or Repaid/);
  });

  it('the foreign-currency guard respects archived accounts and ignores deleted rows', () => {
    const h = makeDataDb();
    h.sqlite.pragma('ignore_check_constraints = ON');
    const insert = (id: string, account: string, deleted: string | null) =>
      h.sqlite
        .prepare(
          `INSERT INTO transactions (id, occurred_at, type, account_id, currency, amount_native, amount_usd, fx_rate, category_id, created_at, updated_at, deleted_at)
           VALUES (?, '2026-08-06T10:00:00', 'expense', ?, 'EUR', -500, -500, 1, ?, ?, ?, ?)`,
        )
        .run(id, account, CAT.leisure, NOW, NOW, deleted);
    insert('gone', ACC.chase, NOW); // a deleted foreign row: ignored
    expect(totalBalanceCents(h.ctx)).toBe(0);
    insert('live', ACC.cash, null);
    expectData(() => totalBalanceCents(h.ctx), 'invalid', /is in EUR/);
    archiveAccount(h.ctx, ACC.cash); // the foreign row now sits on an archived account
    expectData(() => totalBalanceCents(h.ctx), 'invalid', /is in EUR/); // still included by default
    expect(totalBalanceCents(h.ctx, { includeArchived: false })).toBe(0); // left out on request
    expect(balanceSeries(h.ctx, { from: '2026-08-05', to: '2026-08-06' }, { includeArchived: false }).map((p) => p.totalCents)).toEqual([0, 0]);
  });

  it('transfer counterparts stay correct across the lookup chunks', () => {
    const h = makeDataDb();
    for (let i = 0; i < 620; i++) {
      createTransferBetween(h.ctx, { occurredAt: `2026-08-01T10:${String(i % 60).padStart(2, '0')}:00`, fromAccountId: ACC.chase, toAccountId: ACC.credit, amountCents: 1 + i });
    }
    const opposite: Record<string, string> = { 'Chase Bank Account': 'Credit', Credit: 'Chase Bank Account' };
    for (const t of listTransactions(h.ctx, { types: ['transfer'] })) {
      expect(t.counterpartAccountName, t.id).toBe(opposite[t.accountName]);
    }
    // each group's two legs point at different rows, never at themselves
    const groups = new Map<string, string[]>();
    for (const t of listTransactions(h.ctx, { types: ['transfer'] })) groups.set(t.transferGroupId as string, [...(groups.get(t.transferGroupId as string) ?? []), t.accountName]);
    expect([...groups.values()].every((g) => g.length === 2 && g[0] !== g[1])).toBe(true);
  });
});
