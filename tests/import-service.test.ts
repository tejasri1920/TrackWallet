import { describe, expect, it } from 'vitest';
import { listPeople, totalBalanceCents, cashFlow, monthRange } from '../src/data';
import { ImportBlockedError, ImportNeedsConfirmationError } from '../src/import/commit';
import { applyImport, previewImport } from '../src/import/service';
import { HEADER } from '../src/import/trackwallet';
import { FIXTURE_CSV, NOW, makeDataDb, rows, type DataHandle } from './data-helpers';

const file = (...lines: string[]) => [HEADER.join(','), ...lines].join('\n') + '\n';
const count = (h: DataHandle, table: string) => rows(h, `SELECT COUNT(*) AS n FROM ${table}`)[0].n as number;
const lend = '"2026-08-01T10:00","Expense","Cash","USD","-5","-5","Lend","","Zed"';
const plain = '"2026-08-02T10:00","Expense","Cash","USD","-5","-5","Leisure","","Arcade"';
const lone = '"2026-08-03T10:00","Transfer","Cash","USD","-50","-50",,,""';
const req = (h: DataHandle, csvText: string) => ({ csvText, filename: 'x.csv', newId: h.ctx.newId, now: NOW });

describe('previewImport (step 1: nothing is written)', () => {
  it('reports what would happen and leaves the database untouched', () => {
    const h = makeDataDb();
    const plan = previewImport(h.db, req(h, FIXTURE_CSV));
    expect(plan.rowsRead).toBe(65);
    expect(plan.legs).toHaveLength(65);
    expect(plan.newPeople.map((p) => p.name).sort()).toEqual(['Aakanksha', 'India', 'Pramod', 'Rishitha', 'Sahithi', 'Teja', 'UPS']);
    expect([count(h, 'transactions'), count(h, 'people')]).toEqual([0, 0]);
  });
});

describe('applyImport (step 2) and the confirmations it insists on', () => {
  it('refuses to create new names without confirmNew, and writes nothing', () => {
    const h = makeDataDb();
    let error: unknown;
    try { applyImport(h.db, req(h, file(lend))); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(ImportNeedsConfirmationError);
    expect((error as ImportNeedsConfirmationError).needs).toEqual(['newRecords']);
    expect((error as Error).message).toMatch(/1 new name\(s\) and 0 categories/);
    expect([count(h, 'transactions'), count(h, 'people')]).toEqual([0, 0]);
  });

  it('refuses new categories without confirmNew too', () => {
    const h = makeDataDb();
    const csv = file('"2026-08-01T10:00","Expense","Cash","USD","-5","-5","Health","Gym","Pool"');
    expect(() => applyImport(h.db, req(h, csv))).toThrow(ImportNeedsConfirmationError);
    expect(count(h, 'categories')).toBe(28);
    applyImport(h.db, { ...req(h, csv), confirmNew: true });
    expect(count(h, 'categories')).toBe(30);
  });

  it('refuses to skip rows without allowSkips, and lists everything that needs acknowledging', () => {
    const h = makeDataDb();
    let error: unknown;
    try { applyImport(h.db, req(h, file(lone, plain))); } catch (e) { error = e; }
    expect((error as ImportNeedsConfirmationError).needs).toEqual(['skippedRows']);
    expect(count(h, 'transactions')).toBe(0);

    try { applyImport(h.db, req(h, file(lend, lone))); } catch (e) { error = e; }
    expect((error as ImportNeedsConfirmationError).needs).toEqual(['newRecords', 'skippedRows']);
    expect(count(h, 'transactions')).toBe(0);
  });

  it('imports once confirmed, and a repeat of the same file is a harmless no-op that needs no confirmation', () => {
    const h = makeDataDb();
    const first = applyImport(h.db, { ...req(h, file(lend, lone, plain)), confirmNew: true, allowSkips: true });
    expect(first.result).toEqual({ transactionsInserted: 2, peopleInserted: 1, categoriesInserted: 0 });
    expect(first.plan.skipped).toHaveLength(1);

    const again = applyImport(h.db, req(h, file(lend, plain))); // nothing new: no flags needed
    expect(again.result).toEqual({ transactionsInserted: 0, peopleInserted: 0, categoriesInserted: 0 });
    expect(count(h, 'transactions')).toBe(2);
  });

  it('refuses a file with errors and writes nothing', () => {
    const h = makeDataDb();
    const bad = file(lend, '"2026-08-02T10:00","Expense","Cash","USD","5","5","Leisure","",""'); // positive expense
    expect(() => applyImport(h.db, { ...req(h, bad), confirmNew: true })).toThrow(ImportBlockedError);
    expect([count(h, 'transactions'), count(h, 'people')]).toEqual([0, 0]);
  });

  it('feeds the data layer: the imported month reads back correctly through the public API', () => {
    const h = makeDataDb();
    applyImport(h.db, { ...req(h, FIXTURE_CSV), confirmNew: true });
    expect(cashFlow(h.ctx, monthRange(2026, 8))).toEqual({ incomeCents: 619600, expenseCents: 250691, netCents: 368909 });
    expect(totalBalanceCents(h.ctx)).toBe(317721 + 2988 + 48200);
    expect(listPeople(h.ctx).map((p) => p.name)).toEqual(['Aakanksha', 'India', 'Pramod', 'Rishitha', 'Sahithi', 'Teja', 'UPS']);
  });
});
