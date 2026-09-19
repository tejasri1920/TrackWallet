import { describe, expect, it } from 'vitest';
import {
  accountBalances, archiveAccount, cashFlow, createAccount, createExpense, createIncome, createTransferBetween, DataError,
  deleteEntry, deleteTransfer, monthRange, totalBalanceCents, unarchiveAccount, updateEntry, updateTransfer,
} from '../src/data';
import { ACC, CAT, failedInvariants, makeDataDb } from './data-helpers';

/**
 * Model-based test. A long random sequence of operations is applied to the real data layer AND to a
 * tiny independent model (plain arithmetic on plain maps). After every operation each account's
 * balance, the total and the all-time cash flow must agree exactly, and every database invariant
 * must hold. Operations that should be refused must be refused, with a DataError, changing nothing.
 */
describe('random operation sequences keep the books correct', () => {
  function run(seed: number, steps: number) {
    let s = seed;
    const rnd = (k: number) => Math.floor((s = (s * 1103515245 + 12345) & 0x7fffffff) / 65536) % k;
    const pick = <T,>(xs: T[]): T => xs[rnd(xs.length)];

    const h = makeDataDb();
    const extra = createAccount(h.ctx, { name: 'Savings', type: 'bank', openingBalanceCents: 7777 });
    const opening: Record<string, number> = { [ACC.credit]: 0, [ACC.chase]: 0, [ACC.cash]: 0, [extra.id]: 7777 };
    const accountIds = Object.keys(opening);
    const archived = new Set<string>();

    const entries = new Map<string, { type: 'income' | 'expense'; account: string; cents: number }>();
    const transfers = new Map<string, { from: string; to: string; cents: number }>();

    const expenseCats = [CAT.food, CAT.groceries, CAT.snacks, CAT.shopping, CAT.leisure];
    const incomeCats = [CAT.salary, CAT.salaryDenim, CAT.loan];
    const when = () =>
      `2026-0${8 + rnd(2)}-${String(1 + rnd(28)).padStart(2, '0')}T${String(rnd(24)).padStart(2, '0')}:${String(rnd(60)).padStart(2, '0')}`;
    const cents = () => 1 + rnd(50000);
    const live = () => accountIds.filter((a) => !archived.has(a));

    const model = () => {
      const bal: Record<string, number> = { ...opening };
      let income = 0, expense = 0;
      for (const e of entries.values()) {
        bal[e.account] += e.type === 'income' ? e.cents : -e.cents;
        if (e.type === 'income') income += e.cents; else expense += e.cents;
      }
      for (const t of transfers.values()) { bal[t.from] -= t.cents; bal[t.to] += t.cents; }
      return { bal, income, expense };
    };

    const refused = (fn: () => unknown) => {
      let e: unknown;
      try { fn(); } catch (err) { e = err; }
      expect(e, 'should have been refused').toBeInstanceOf(DataError);
    };

    const log: string[] = [];
    for (let step = 0; step < steps; step++) {
      const op = rnd(12);
      const desc = `#${step} op${op}`;
      log.push(desc);

      if (op <= 2) { // create expense
        const account = pick(live());
        const c = cents();
        const t = createExpense(h.ctx, { occurredAt: when(), accountId: account, amountCents: c, categoryId: pick(expenseCats) });
        entries.set(t.id, { type: 'expense', account, cents: c });
      } else if (op === 3) { // create income
        const account = pick(live());
        const c = cents();
        const t = createIncome(h.ctx, { occurredAt: when(), accountId: account, amountCents: c, categoryId: pick(incomeCats) });
        entries.set(t.id, { type: 'income', account, cents: c });
      } else if (op === 4 || op === 5) { // create transfer
        const from = pick(live());
        const to = pick(live().filter((a) => a !== from));
        const c = cents();
        const { groupId } = createTransferBetween(h.ctx, { occurredAt: when(), fromAccountId: from, toAccountId: to, amountCents: c });
        transfers.set(groupId, { from, to, cents: c });
      } else if (op === 6 && entries.size > 0) { // edit an entry's amount / account
        const [id, e] = pick([...entries]);
        if (rnd(2) === 0) {
          const c = cents();
          updateEntry(h.ctx, id, { amountCents: c });
          e.cents = c;
        } else {
          const target = pick(accountIds);
          if (archived.has(target) && target !== e.account) refused(() => updateEntry(h.ctx, id, { accountId: target }));
          else { updateEntry(h.ctx, id, { accountId: target }); e.account = target; }
        }
      } else if (op === 7 && entries.size > 0) { // delete an entry
        const [id] = pick([...entries]);
        deleteEntry(h.ctx, id);
        entries.delete(id);
        refused(() => deleteEntry(h.ctx, id)); // a second delete is refused
      } else if (op === 8 && transfers.size > 0) { // edit a transfer
        const [g, t] = pick([...transfers]);
        const which = rnd(3);
        if (which === 0) { const c = cents(); updateTransfer(h.ctx, g, { amountCents: c }); t.cents = c; }
        else if (which === 1) {
          const to = pick(accountIds);
          if (to === t.from) refused(() => updateTransfer(h.ctx, g, { toAccountId: to }));
          else if (archived.has(to) && to !== t.to) refused(() => updateTransfer(h.ctx, g, { toAccountId: to }));
          else { updateTransfer(h.ctx, g, { toAccountId: to }); t.to = to; }
        } else {
          const from = pick(accountIds);
          if (from === t.to) refused(() => updateTransfer(h.ctx, g, { fromAccountId: from }));
          else if (archived.has(from) && from !== t.from) refused(() => updateTransfer(h.ctx, g, { fromAccountId: from }));
          else { updateTransfer(h.ctx, g, { fromAccountId: from }); t.from = from; }
        }
      } else if (op === 9 && transfers.size > 0) { // delete a transfer
        const [g] = pick([...transfers]);
        deleteTransfer(h.ctx, g);
        transfers.delete(g);
        refused(() => deleteTransfer(h.ctx, g));
      } else if (op === 10) { // archive / unarchive
        const a = pick(accountIds);
        if (archived.has(a)) { unarchiveAccount(h.ctx, a); archived.delete(a); }
        else if (live().length > 2) { archiveAccount(h.ctx, a); archived.add(a); }
      } else if (op === 11 && archived.size > 0) { // recording against an archived account must be refused, changing nothing
        const a = pick([...archived]);
        refused(() => createExpense(h.ctx, { occurredAt: when(), accountId: a, amountCents: 100, categoryId: CAT.leisure }));
        refused(() => createTransferBetween(h.ctx, { occurredAt: when(), fromAccountId: a, toAccountId: pick(live()), amountCents: 100 }));
      }

      // The real numbers must equal the model's, every single step.
      const m = model();
      const real = Object.fromEntries(accountBalances(h.ctx).map((b) => [b.accountId, b.balanceCents]));
      expect(real, `${desc}: balances`).toEqual(m.bal);
      expect(totalBalanceCents(h.ctx), `${desc}: total`).toBe(Object.values(m.bal).reduce((x, y) => x + y, 0));
      if (step % 20 === 0 || step === steps - 1) {
        const flow = cashFlow(h.ctx, { from: '2026-08-01', toExclusive: '2026-11-01' });
        expect(flow, `${desc}: cash flow`).toEqual({ incomeCents: m.income, expenseCents: m.expense, netCents: m.income - m.expense });
        expect(failedInvariants(h), `${desc}: invariants`).toEqual([]);
      }
    }
    return { entries: entries.size, transfers: transfers.size, archived: archived.size, monthly: cashFlow(h.ctx, monthRange(2026, 8)) };
  }

  for (const seed of [1, 7, 42, 2026, 918273]) {
    it(`seed ${seed}: 600 operations`, () => {
      const outcome = run(seed, 600);
      // the run must actually have exercised a mix of things, or it proves nothing
      expect(outcome.entries).toBeGreaterThan(20);
      expect(outcome.transfers).toBeGreaterThan(5);
    });
  }
});
