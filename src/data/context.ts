import { newId as defaultNewId } from '../db/id';
import { localIso } from '../db/time';
import type { AppDb } from '../db/types';

/**
 * What every data-layer function needs. `now` and `newId` are injectable so tests are
 * deterministic and React Native can supply its own id generator.
 */
export interface DataContext {
  db: AppDb;
  /** Local-time ISO-8601 with seconds, no zone. Defaults to the current local time. */
  now?: () => string;
  /** Random unique id. Defaults to crypto.randomUUID. */
  newId?: () => string;
}

export interface ResolvedContext {
  db: AppDb;
  now: () => string;
  newId: () => string;
}

export function resolve(ctx: DataContext): ResolvedContext {
  return { db: ctx.db, now: ctx.now ?? (() => localIso()), newId: ctx.newId ?? defaultNewId };
}
