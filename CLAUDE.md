# Personal Finance Tracker

Expo / React Native expense tracker replacing TrackWallet for a single user
(Indian grad student in the USA). Local-first SQLite. One year of real
financial history is being migrated in — data loss is the worst possible bug.

## Stack
- Expo (managed workflow), TypeScript strict mode
- expo-sqlite as the only source of truth
- Drizzle ORM for schema and migrations
- Zustand for UI state (never for persisted data)
- Vitest for unit tests

## Non-negotiable rules
- Money is stored as signed INTEGER minor units. Never float. Never store a
  formatted string. `fx_rate` is the only REAL column in the schema.
- Expenses are negative. Income is positive. Transfers are two signed legs.
- Every schema change ships as a Drizzle migration. Never edit a shipped
  migration; add a new one.
- No network calls in v1 except the optional sync layer in Phase 7.
- Category depth is exactly 2. A subcategory cannot have children.

## Commands
- `npm run test` — unit tests
- `npm run typecheck` — tsc --noEmit
- `npm run db:generate` — generate migration from schema
- `npm run import -- <csv>` — run the TrackWallet importer in dry-run mode
- `npm run import -- <csv> --commit` — actually import

## Definition of done for any task
Typecheck passes, tests pass, and the invariant suite in
`tests/invariants.test.ts` passes. Report actual command output, not a summary.
