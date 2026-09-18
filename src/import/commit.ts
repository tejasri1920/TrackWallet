import { sql } from 'drizzle-orm';
import { runInvariants, type InvariantResult, type Row } from '../db/invariants';
import { categories, people, transactions } from '../db/schema';
import type { AppDb } from '../db/types';
import type { ImportPlan } from './plan';
import { formatVerifyReport, verifyImport, type VerifyReport } from './verify';

/** Thrown before anything is written: the plan has validation issues. */
export class ImportBlockedError extends Error {
  constructor(readonly plan: ImportPlan) {
    super(`import blocked: ${plan.issues.length} row(s) failed validation; nothing was written`);
  }
}

/** Thrown before anything is written: new rows would duplicate rows the database already holds. */
export class ImportLookalikeError extends Error {
  constructor(readonly plan: ImportPlan) {
    super(
      `import blocked: ${plan.lookalikes.length} new row(s) look like rows already in the database under a different or no import hash; ` +
        'importing them would double those transactions. Review them, then pass allowLookalikes.',
    );
  }
}

/** Thrown from inside the transaction, so the whole import rolls back. */
export class ImportInvariantError extends Error {
  constructor(readonly failures: InvariantResult[]) {
    super(
      `import rolled back: invariant(s) failed: ` +
        failures.map((f) => `${f.invariant.id} (${f.rows.length} row(s))`).join(', '),
    );
  }
}

/** Thrown from inside the transaction when post-insert verification fails, so the import rolls back. */
export class ImportVerificationError extends Error {
  constructor(readonly report: VerifyReport) {
    super('import rolled back: verification failed\n' + formatVerifyReport(report));
  }
}

export interface CommitOptions {
  /**
   * The source CSV text. When given, the rows this commit wrote are verified against it INSIDE
   * the transaction (row accounting, per-account totals, transfer pairing, round trip, no extra
   * copies) and the commit is rolled back if anything fails, so a bad import is never left in
   * the database.
   */
  verifyCsv?: string;
  /**
   * The caller has reviewed `plan.lookalikes` (rows that duplicate something already stored) and
   * wants them imported anyway. Without this a plan containing lookalikes is refused.
   */
  allowLookalikes?: boolean;
}

export interface CommitResult {
  transactionsInserted: number;
  peopleInserted: number;
  categoriesInserted: number;
}

/**
 * Writes the plan in ONE transaction. After the inserts every database invariant is re-checked
 * against the whole database (and, if `verifyCsv` is given, the CSV is verified too); any failure
 * throws and SQLite rolls the entire import back.
 */
export function commitImport(db: AppDb, plan: ImportPlan, now: string, options: CommitOptions = {}): CommitResult {
  if (plan.issues.length > 0) throw new ImportBlockedError(plan);
  if (plan.lookalikes.length > 0 && !options.allowLookalikes) throw new ImportLookalikeError(plan);

  db.transaction((tx) => {
    for (const p of plan.newPeople) {
      tx.insert(people).values({ id: p.id, name: p.name, createdAt: now, updatedAt: now }).run();
    }
    // Parents are always planned before their children.
    for (const c of plan.newCategories) {
      tx.insert(categories)
        .values({ id: c.id, name: c.name, kind: c.kind, parentId: c.parentId, createdAt: now, updatedAt: now })
        .run();
    }
    // One row per statement, in plan order: the transfer-group trigger inspects the first leg
    // when the second arrives.
    for (const leg of plan.legs) {
      tx.insert(transactions)
        .values({
          id: leg.id,
          occurredAt: leg.row.occurredAt,
          type: leg.type,
          accountId: leg.accountId,
          currency: leg.row.currency,
          amountNative: leg.row.amountNative,
          amountUsd: leg.row.amountUsd,
          fxRate: 1.0,
          categoryId: leg.categoryId,
          personId: leg.personId,
          merchant: leg.merchant,
          note: leg.note,
          transferGroupId: leg.transferGroupId,
          importHash: leg.hash,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const failures = runInvariants((q) => tx.all(sql.raw(q)) as Row[]).filter((r) => !r.passed);
    if (failures.length > 0) throw new ImportInvariantError(failures);

    if (options.verifyCsv !== undefined) {
      // Only the rows written here: earlier imports may since have been edited or deleted in the app.
      const report = verifyImport(tx as unknown as AppDb, options.verifyCsv, {
        only: new Set(plan.legs.map((l) => l.hash)),
        acknowledgedLookalikes: options.allowLookalikes === true,
      });
      if (!report.passed) throw new ImportVerificationError(report);
    }
  });

  return {
    transactionsInserted: plan.legs.length,
    peopleInserted: plan.newPeople.length,
    categoriesInserted: plan.newCategories.length,
  };
}
