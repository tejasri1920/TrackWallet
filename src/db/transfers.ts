import { and, eq, isNull } from 'drizzle-orm';
import { newId } from './id';
import { transactions } from './schema';
import type { AppDb } from './types';

/** One side of a transfer. `amountNative` is a positive magnitude in minor units of `currency`. */
export interface TransferLegInput {
  accountId: string;
  currency: string;
  amountNative: number;
}

export interface CreateTransferInput {
  occurredAt: string;
  /** Money leaves this account. */
  from: TransferLegInput;
  /** Money arrives in this account. */
  to: TransferLegInput;
  /** Positive USD cents moved. Both legs share it, so their amount_usd sum to exactly 0. */
  amountUsd: number;
  note?: string | null;
  now: string;
  newId?: () => string;
}

const isPositiveInt = (n: number) => Number.isSafeInteger(n) && n > 0;

/**
 * The only sanctioned way to create a transfer. Writes both legs in one transaction so a
 * transfer group can never exist with a single leg (invariant 4) or an unbalanced pair
 * (invariant 5). Each leg's fx_rate is derived from the amounts, never typed by the user.
 */
export function createTransfer(
  db: AppDb,
  input: CreateTransferInput,
): { groupId: string; legIds: [string, string] } {
  const { from, to, amountUsd } = input;
  const genId = input.newId ?? newId;

  if (!isPositiveInt(amountUsd)) throw new Error('amountUsd must be a positive integer (cents)');
  for (const leg of [from, to]) {
    if (!isPositiveInt(leg.amountNative)) {
      throw new Error('amountNative must be a positive integer (minor units)');
    }
    if (leg.currency === 'USD' && leg.amountNative !== amountUsd) {
      throw new Error('a USD leg must have amountNative equal to amountUsd');
    }
  }
  if (from.accountId === to.accountId) throw new Error('transfer source and destination must differ');
  // Same currency on both sides means no conversion: the native amounts must be identical, or
  // native money would be created or destroyed while the USD legs still net to zero.
  if (from.currency === to.currency && from.amountNative !== to.amountNative) {
    throw new Error('a same-currency transfer must move equal native amounts on both legs');
  }

  const groupId = genId();
  const legIds: [string, string] = [genId(), genId()];
  const leg = (id: string, side: TransferLegInput, sign: 1 | -1) => ({
    id,
    occurredAt: input.occurredAt,
    type: 'transfer' as const,
    accountId: side.accountId,
    currency: side.currency,
    amountNative: sign * side.amountNative,
    amountUsd: sign * amountUsd,
    // fx_rate is the only float in the schema.
    fxRate: side.currency === 'USD' ? 1.0 : side.amountNative / amountUsd,
    note: input.note ?? null,
    transferGroupId: groupId,
    createdAt: input.now,
    updatedAt: input.now,
  });

  db.transaction((tx) => {
    tx.insert(transactions).values(leg(legIds[0], from, -1)).run();
    tx.insert(transactions).values(leg(legIds[1], to, 1)).run();
  });

  return { groupId, legIds };
}

/**
 * Soft-deletes both live legs of a transfer in one transaction, so a group is never left with
 * a single live leg (invariants 4 and 5). Throws unless the group has exactly two live legs.
 * A plain UPDATE of one leg bypasses this; the app layer must never do that.
 */
export function softDeleteTransfer(db: AppDb, groupId: string, now: string): void {
  db.transaction((tx) => {
    const live = and(eq(transactions.transferGroupId, groupId), isNull(transactions.deletedAt));
    const legs = tx.select({ id: transactions.id }).from(transactions).where(live).all();
    if (legs.length !== 2) {
      throw new Error(`transfer group ${groupId} has ${legs.length} live legs, expected 2`);
    }
    tx.update(transactions).set({ deletedAt: now, updatedAt: now }).where(live).run();
  });
}
