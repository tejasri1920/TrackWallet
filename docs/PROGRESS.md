# Progress log

Honest running log. After each phase: what was built, what was verified, actual
output, and what's left open.

## Phase 0 — Bootstrap (2026-09-18)

**Built**
- Expo SDK 57 blank-TypeScript scaffold (TS 6, RN 0.86), TS `strict`, app code
  under `src/`, tests under `tests/`.
- Dependencies: `expo-sqlite`, `drizzle-orm`, `zustand`; dev: `drizzle-kit`,
  `vitest`, `better-sqlite3`, `@types/better-sqlite3`.
- Scripts: `test`, `typecheck`, `db:generate`, `import` (stub, exits 1).
- Every file from Section 2: `CLAUDE.md` (verbatim), `.claude/{settings.json,
  rules/, skills/, agents/}`, `docs/{DECISIONS,PROGRESS}.md`.
- Agreed additions: `docs/MASTER_PROMPT.md`, `docs/INVARIANTS.md`, `paths:`
  scoping on the two rules files, minimal `.claude/settings.json`.

**Verified (actual output)**
- `npm run typecheck` → `tsc --noEmit`, exit 0. `tsc --listFilesOnly` confirms it
  checks `src/App.tsx`, `index.ts`, `vitest.config.mts`.
- `npm run test` → `No test files found, exiting with code 0` (expected; no tests
  exist yet). `passWithNoTests` is set so this is not a false failure.
- `better-sqlite3` native module loads: SQLite 3.53.4 on Node 22.19.0.

**Not verified / open**
- The app has not been launched on a device or emulator. Nothing in Phase 0
  needs it; the first real check is Phase 4.
- `drizzle.config.ts` does not exist yet, so `npm run db:generate` will fail
  until Phase 1.
- `npm audit` reports vulnerabilities in the freshly installed tree; not
  investigated. Dev-tooling only at this point.
- Deferred to Phase 2 by the user: decisions C, G, H, I. Needs the August CSV
  and real opening balances.
- `docs/MASTER_PROMPT.md` abbreviates Sections 2.1–2.6, 5.4, 12 to pointers.
- In-app file-picker import (decision J) is not yet slotted into Phase 3 or 4.

**Small deviations from spec**
- `vitest.config.mts` instead of `.ts` to avoid a Vite CJS/ESM warning without
  changing the package module type.
- App name/slug set to `Expenses`/`expenses-app`; `userInterfaceStyle: dark`;
  iOS/web config removed from `app.json` (web is out of scope).

## Phase 1 — Schema + migrations (2026-09-18)

**Built**
- `src/db/schema.ts`: Drizzle schema for `accounts`, `people`, `categories`,
  `transactions`, with named CHECK constraints for the single-row invariants.
- `drizzle/0000_*.sql` (generated) and `drizzle/0001_constraints_and_triggers.sql`
  (hand-written: `categories_unique` expression index + 9 triggers). See
  `DECISIONS.md` for why two files.
- `src/db/invariants.ts`: the 11 spec invariants as "offending rows" queries, plus
  extras 12-15 added after review.
- `src/db/seed.ts` (idempotent; 3 accounts, 28 categories), `src/db/transfers.ts`
  (`createTransfer`, `softDeleteTransfer`), `src/db/node.ts` (better-sqlite3 helper
  that turns FKs on and verifies it), `src/cli/schema-check.ts`, `src/cli/db-init.ts`.
- `tests/invariants.test.ts`, `tests/schema.test.ts`, `tests/helpers.ts`.

**Verified (actual output)**
- `npm run typecheck` → exit 0.
- `npm run test` → `Test Files 2 passed (2)`, `Tests 58 passed (58)`.
- Every invariant has an *enforcement* test (violating row rejected, error names the
  constraint) and an *audit* test (query catches the corrupt row on a database with
  constraints stripped; good rows are not flagged). This includes both edges of the
  invariant-7 tolerance (off by exactly 1 passes, by 2 fails).
- Mutation check, run twice: breaking an audit query or neutering a trigger/CHECK
  makes exactly the expected test(s) fail; files restored, hashes verified.
- `npm run db:init -- data/x.db` then `npm run schema-check -- data/x.db` →
  `15/15 passed`, exit 0. This is a freshly seeded database with 0 transactions, so
  it shows the CLI works, not that data is clean. On a copy with one lone transfer
  leg inserted, schema-check reported invariants 4 and 5 as `FAIL`, printed the
  offending group, and exited 1. Scratch database files were deleted.
- `data-integrity-reviewer` review: 9 findings (finding 4 split in two). 5 fixed with regression tests (1, 3, 4a, 5, 6), 1 comment-only fix (7), 1 mitigated by a test (9), 1
  partly fixed (2), 1 deferred (8), 1 needs your decision (4b). Details in `DECISIONS.md`.

**Not verified / open**
- **The reviewer was not re-run after the fixes.** They rest on the regression tests
  and mutation checks above.
- **The reviewer agent ran as a stand-in.** `data-integrity-reviewer` is not
  registered until a new session; I ran a general-purpose agent with its exact
  instructions and a no-edit rule. Worth re-running it by name next session.
- `expo-sqlite` is untested: nothing here runs on a device. The `AppDb` type is
  satisfied by `better-sqlite3`; whether `expo-sqlite`'s Drizzle driver satisfies it
  is unchecked until Phase 3. The app-side connection code (which must run
  `PRAGMA foreign_keys = ON` on open) and the Expo migration bundling do not exist.
- `crypto.randomUUID` is unavailable in React Native by default; `newId()` throws
  there until an id generator (e.g. `expo-crypto`) is injected in Phase 3.
- Balance query (Section 5.2) is not implemented or tested; it waits on open
  question 1 in `DECISIONS.md`.
- The "amount_usd is never recomputed on read" test (Section 9) belongs to the data
  layer and is not written yet.
- `updateTransfer` does not exist; a raw UPDATE of one transfer leg is not blocked.
- Seeded categories have no icon or color (the spec gives none).
- Still deferred to Phase 2 by the user: decisions C, G, H, I.
- `npm audit` findings from Phase 0 remain uninvestigated.

## Phase 2 — TrackWallet importer (2026-09-18)

**Amendments to Phase 1 made first** (agreed with the user): a subcategory must have its
parent's kind (triggers `trg_cat_kind_parent_*`, extra invariant 16), and account names are
unique case-insensitively (`accounts_name_ci`). Migrations were regenerated, not patched,
because nothing has shipped.

**Built**
- `src/import/`: `csv` (RFC-4180 reader), `money` (integer-only parse/format), `hash`
  (pure-TS SHA-256), `text` (ASCII fold), `decode` (strict UTF-8), `trackwallet` (row
  validation, transfer pairing), `plan` (dry-run planner), `commit` (one transaction,
  invariants and verification re-checked inside it), `export` (TrackWallet-format CSV),
  `verify` (the seven `import-verify` checks), `report` (dry-run text).
- `src/cli/import.ts` and `src/cli/import-verify.ts`; `npm run import` and
  `npm run import-verify`.
- `tests/fixtures/trackwallet_2026-08-01_2026-08-31.csv`, `tests/import-units.test.ts`,
  `tests/importer.test.ts`, `tests/importer-hardening.test.ts`.
- Decisions C, G, H resolved; I still open (see `DECISIONS.md`, "Phase 2 decisions").

**Exit criteria, with the actual numbers** (real CLI run on the August file against a
scratch database, deleted afterwards)
- 65 rows read; 65 accounted for; 0 skipped, 0 failed validation, 0 silently missing.
  45 income/expense legs + 10 transfer pairs (20 legs). No accounts or categories to
  create; 7 people (Aakanksha, India, Pramod, Rishitha, Sahithi, Teja, UPS).
- Every transfer paired: 10 of 10 groups, each 2 live legs summing to 0 in native and USD;
  0 orphans.
- Per-account sums, CSV vs database, equal exactly (Amount and Amount_USD):
  Cash +482.00, Chase Bank Account +29.88, Credit +3177.21.
- `npm run schema-check` on the populated database: 16/16 invariants pass.
- Round trip: 65 source rows vs 65 exported rows, 0 differing fields; all 65 exported lines
  identical to the source after the counted normalizations (timestamp seconds added on 53
  rows; expense Returned->Repaid on 1 row).
- Independent cross-checks that do not use the importer: TrackWallet's own August header
  from the screenshot (6,196$ income, 2,506.91$ expenses, +3,689.09$) and ten calendar day
  cells all equal the database (asserted in `tests/importer.test.ts`); a separate scratch
  script gave the same totals and per-account sums.
- Idempotency: re-running `--commit` on the same file reported 65 already imported and
  wrote nothing. The pre-import backup file held 0 transactions; the database 65.
- `npm run typecheck` exit 0. `npm run test`: 5 files, **167 tests passed** (187 after the second-pass fixes, see the addendum)
  (import-units 32, invariants 44, schema 16, importer 44, importer-hardening 31).
- Mutation checks (deliberately breaking a protection): 6 in the first round and 10 in the
  second; every break turned tests red except two that I investigated. One slipped because a
  test could not tell read-only from read-write opens (fixed by making the CLI report how it
  opened the database and asserting on it); one is an equivalent mutant (redundant clause).
  One "caught" result was invalid because my new test failed on the unmodified code; I
  noticed, fixed the test and re-ran with a green baseline.

**Review**: `data-integrity-reviewer` (as a stand-in agent) found 11 gaps, all fixed or
consciously left, listed in `DECISIONS.md`. The reviewer was later re-run on those fixes and found three of them incomplete: see the second-pass addendum below.

**Not verified / open**
- **The fixture is a transcription of pasted text, not the original file.** It matches the
  spec's stated shape (65 rows, 12 with seconds) and TrackWallet's own totals, which makes a
  transcription error very unlikely, but byte-level details (CRLF vs LF, a trailing
  newline, a BOM) are unknown. The parser handles all of them; re-running
  `npm run import -- <original file>` on the real file would confirm.
- **Only one month exists.** A real multi-month import, including boundaries where a
  transfer's two legs fall in different files, has been tested only with synthetic files.
- **Opening balances (decision I) are not set**, so no balance chip can match TrackWallet
  yet. Needs all months up to 2026-09-14 imported.
- **Please confirm decision C** (expense `Returned` -> `Repaid`) and the 7 people, notably
  `India` (a `Taken` row) and `UPS` (a `Lend` row), which look like they may not be people.
- **Editing an already-imported transaction in TrackWallet and re-exporting** creates a
  second row (content hash changes). Import each month once, when it is final.
- The in-app file-picker import does not exist yet (Phase 3/4). `TextDecoder` (fatal mode)
  and `crypto.randomUUID` may need polyfills on React Native; `expo-sqlite` is still
  untested with any of this code.
- The importer is USD-only by decision; INR rows are rejected with an error.
- One end-to-end CLI run stalled past its 300 s timeout before finishing cleanly with
  correct output, where identical runs earlier took seconds. Not diagnosed.
- `npm audit` findings from Phase 0 remain uninvestigated.

### Phase 2, second-pass review addendum (2026-09-18)

The reviewer was re-run on the Phase 2 fixes. **Result: my first "complete" claim was
premature in three places.** Findings 3 (extra copies), 6 (failed verification) and 11
(backup) from the first review were only partly fixed, and nine new findings (N1-N9) were
reported. All were fixed or consciously left (`DECISIONS.md`, "Phase 2 second-pass review").
The two that mattered most: verification inside the commit wrongly blocked any overlapping
re-import once a row had been deleted or edited in the app (N1), and the backup could be
empty for a WAL-mode database while the CLI said it was written (N3).

**Verified (actual output)**
- `npm run typecheck`: exit 0. `npm run test`: 6 files, **187 tests passed**
  (import-units 32, invariants 44, schema 16, importer 44, importer-hardening 31,
  importer-second-pass 20).
- Mutation checks on this round: 11 protections broken one at a time, green baseline each
  time; every one turned tests red. One (hash separator) first survived because my test was
  too weak; I strengthened the test and re-ran it green/red.
- Pairing: 8,000 random groups compared with brute force, order-independent and valid; all
  24 orderings of the reviewer's case give the same pairing.
- Real CLI run on the August file (scratch database, deleted afterwards): dry run opened
  read-only; `--commit` without `--confirm-new` refused; `--commit --confirm-new` took a
  checked backup, committed 65 rows, all seven verification checks passed; a second commit
  reported 65 already imported and wrote nothing; `schema-check` 16/16.

**Not verified / open** (in addition to the Phase 2 list above)
- The reviewer was **not** run a third time on this round's fixes.
- `--allow-skips` and `--confirm-new` are enforced only by the CLI; the in-app import must
  gate them too (the lookalike gate is already in the library).
- `commitImport`'s in-transaction verification uses `tx as unknown as AppDb`; it works on
  better-sqlite3 but has not been run on expo-sqlite.
- Hash scheme is now `tw2`. Nothing real was imported under `tw1`, so no migration is needed.
