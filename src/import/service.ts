import { localIso } from '../db/time';
import type { AppDb } from '../db/types';
import { commitImport, type CommitResult } from './commit';
import { planImport, type ImportPlan } from './plan';

/**
 * The in-app import, in two steps so the UI can show the user what will happen before anything is
 * written. Both work on any driver and never touch the network.
 */
export interface ImportRequest {
  /** The CSV text, decoded with `decodeCsvBytes` (strict UTF-8). */
  csvText: string;
  filename?: string;
  /** Injectable id generator (React Native has no crypto.randomUUID by default). */
  newId?: () => string;
}

/**
 * Step 1: read the file and say what would happen (rows, new names and categories, skipped rows,
 * duplicates, errors). Writes nothing. Show `plan.newPeople` / `plan.newCategories` to the user.
 */
export function previewImport(db: AppDb, request: ImportRequest): ImportPlan {
  return planImport(db, request.csvText, { filename: request.filename, newId: request.newId });
}

export interface ApplyOptions extends ImportRequest {
  /** Local time stamped on the new rows. Default: now. */
  now?: string;
  /** The user reviewed the names and categories to be created. */
  confirmNew?: boolean;
  /** The user reviewed the rows that will be skipped. */
  allowSkips?: boolean;
  /** The user reviewed rows that duplicate existing ones. */
  allowLookalikes?: boolean;
}

/**
 * Step 2: write it. One transaction; verified inside it; rolled back completely on any failure.
 * Throws (with nothing written) if the file has errors or if a confirmation the plan needs was not
 * given. Importing the same file again is a no-op.
 */
export function applyImport(db: AppDb, options: ApplyOptions): { plan: ImportPlan; result: CommitResult } {
  const plan = previewImport(db, options);
  // Only skip the commit when there is truly nothing to say: skipped rows (and errors) must still reach the gates.
  if (plan.legs.length === 0 && plan.issues.length === 0 && plan.skipped.length === 0) {
    return { plan, result: { transactionsInserted: 0, peopleInserted: 0, categoriesInserted: 0 } };
  }
  const result = commitImport(db, plan, options.now ?? localIso(), {
    verifyCsv: options.csvText,
    confirmNew: options.confirmNew,
    allowSkips: options.allowSkips,
    allowLookalikes: options.allowLookalikes,
  });
  return { plan, result };
}
