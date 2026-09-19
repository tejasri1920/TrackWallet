# Handoff: personal finance tracker

For an engineer or AI agent picking this up cold, usually to debug something. Read this first,
then `docs/DECISIONS.md` (why things are the way they are), `docs/INVARIANTS.md` (the database
rules) and `docs/PROGRESS.md` (what was verified, and what was not). `docs/MASTER_PROMPT.md` is the
original spec; `DECISIONS.md` overrides it where they differ.

## 1. What this is, and how far it got

An Expo / React Native app that replaces the Android app **TrackWallet** for one user (an Indian
graduate student in the USA). Local-first SQLite, no server. The user has a year of real financial
history in TrackWallet, so **silently losing or corrupting data is the worst possible bug**. That
drove every design choice below.

| Phase | Scope | Status |
|---|---|---|
| 0 | Repo, config, docs | done |
| 1 | Schema, migrations, the database invariants | done |
| 2 | TrackWallet CSV importer + verifier | done |
| 3 | Data layer (CRUD, balances, summaries), in-app import service | done |
| 4 | Screens (Home, Categories, Analytics, Transactions, add sheet) | **not started** |
| 5 | Foreign-currency entry | **shelved** (the app is USD-only for now) |
| 6 | Lending ledger per name, Splitwise settle-up | not started |
| 7 | CSV export, local backup, optional sync | not started |
| 8 | Budgets | not started, lowest priority |

**There is no UI.** `src/App.tsx` is the blank Expo template. **Nothing has ever run on a phone or
emulator.** Everything below was verified in Node with `better-sqlite3`. The on-device connection
(`src/db/expo.ts`) only type-checks.

## 2. Run it

Needs Node 22 and `npm install` (installs a native module, `better-sqlite3`). Run everything from
the repo root.

| Command | What it does |
|---|---|
| `npm run test` | All tests. Baseline: **12 files, 294 tests, all passing** |
| `npx vitest run tests/<file>` | One test file. Add `-t "part of a test name"` for one test |
| `npm run typecheck` | `tsc --noEmit`, strict mode. Baseline: clean |
| `npm run db:init -- <file.db>` | Create a new database file (migrated and seeded). Refuses to overwrite |
| `npm run schema-check -- <file.db>` | Run all 17 invariants against a database file, read-only. Exit 1 on any failure |
| `npm run import -- <csv> [--db f] [--commit --confirm-new --allow-skips --allow-lookalikes]` | Dry run by default. See section 6 |
| `npm run import-verify -- <csv> --db <file.db>` | Check a CSV was imported losslessly (read-only) |
| `npm run db:generate` | Generate a Drizzle migration from `src/db/schema.ts` (see section 9 first) |

The `data/` folder at the repo root is git-ignored and is where scratch databases go. Delete what
you create there.

## 3. Map of the code

```
src/db/        schema.ts       Drizzle tables + every single-row CHECK (named, e.g. tx_expense_shape)
               invariants.ts   the 17 invariants as SQL queries returning the OFFENDING rows
               transfers.ts    createTransfer / softDeleteTransfer (atomic two-leg write path)
               seed.ts         3 accounts + 28 categories (deterministic ids like cat-exp-lend)
               limits.ts       MAX_CENTS, the one amount limit shared by everything
               node.ts         better-sqlite3 opener (Node only: tests and CLIs)
               expo.ts         expo-sqlite opener (device only; type-checked, never run)
               types.ts        AppDb: the driver-neutral Drizzle type all logic is written against
src/data/      the data layer the screens will call (section 5)
src/import/    csv, money, hash, trackwallet (parse + pairing), plan, commit, verify,
               export, report, decode, service (the in-app import), text
src/cli/       db-init, schema-check, import, import-verify
drizzle/       0000_*.sql (generated) + 0001_constraints_and_triggers.sql (hand-written, section 9)
tests/         see section 8; fixtures/ holds a real-format TrackWallet export
.claude/       project rules, two skills (schema-check, import-verify), a reviewer agent definition
```

Data flow: `CSV -> src/import (parse, plan, commit, verify) -> SQLite <- src/data <- (future UI)`.
Both the importer and the data layer are written against `AppDb`, so they run on `better-sqlite3`
(tests, CLIs) and `expo-sqlite` (device) unchanged.

## 4. The model and the rules that bite

Tables: `accounts`, `people`, `categories` (two levels only), `transactions`. Full SQL is in
`src/db/schema.ts` and the spec (`MASTER_PROMPT.md` section 5).

- **Money is signed integer cents**, never a float, never a string. `fx_rate` is the only REAL
  column. **Expenses are negative, income positive.**
- **A transfer is two transactions** sharing `transfer_group_id`: one negative, one positive, summing
  to exactly 0. Transfers are never income or spending in any total.
- **Balance** = account `opening_balance_native` + sum of live (`deleted_at IS NULL`) transactions.
- **Soft delete** for transactions (`deleted_at`); **archive** (`archived_at`) for accounts, people and
  categories. Nothing is hard-deleted if history refers to it.
- **Dates are local-time strings** `YYYY-MM-DDTHH:MM:SS`, no timezone, never converted. Every date
  query compares them as text, so the shape is enforced by CHECK `tx_occurred_format`.
- **USD only for now** (decision). Non-USD rows and accounts are rejected by the importer and the
  data layer; the INR-capable columns exist but are unused.
- **`people` holds any counterparty** (person, company, place), used on the four *people-backed*
  categories: Lend, Repaid, Taken, Returned (income side). Code says "person"; read "counterparty".
- **Names compare ASCII-case-insensitively** (SQLite `COLLATE NOCASE`); accented characters do not fold.
- Amounts are capped at `MAX_CENTS` = 10^12 cents ($10 billion) everywhere they enter.

Where each rule is enforced (database CHECK, trigger, domain function, audit query) is tabulated in
`docs/INVARIANTS.md`. Multi-row rules (a transfer having exactly two balanced legs) cannot be CHECKs:
the insert trigger, `createTransfer` and the audit queries cover them.

## 5. The data layer (`src/data`)

Every function takes `ctx: { db, now?, newId? }` (inject `now`/`newId` in tests). It validates
first and throws `DataError` with `code` = `invalid | not_found | conflict` and a user-readable message.

- **accounts**: `createAccount` (no currency input) `updateAccount` `archiveAccount` `unarchiveAccount` `listAccounts` `getAccount`
- **people**: `createPerson` `ensurePerson` (restores an archived match) `updatePerson` `archivePerson` `unarchivePerson` `deletePerson` (only if never referenced) `listPeople`
- **categories**: `createCategory` `updateCategory` `archiveCategory` (cascades) `unarchiveCategory` `deleteCategory` (only if unused and childless) `listCategoryTree`
- **entries**: `createExpense` `createIncome` `updateEntry` `deleteEntry`. Amount is a positive magnitude; the sign follows the kind
- **transfers**: `createTransferBetween` `updateTransfer` (both legs, one transaction) `deleteTransfer`
- **reads**: `listTransactions` (filters, search, paging), `accountBalances`, `totalBalanceCents`, `balanceSeries`, `cashFlow`, `categoryBreakdown`, `dailySummary`, date helpers `monthRange` `dayRange` `addDays`
- **import**: `previewImport` (writes nothing) then `applyImport` (`src/import/service.ts`)

## 6. The importer

Pipeline: strict CSV read -> row validation -> transfer pairing -> `plan` (writes nothing) ->
`commit` (one transaction) -> verify (inside that transaction) -> rollback on any failure.

Deliberate behaviours that can look like bugs:

- **Errors block everything** (bad sign, zero amount, unknown account, non-USD, over the limit). Nothing is
  partially imported.
- **Unpaired transfers are skipped, never guessed.** Pairing groups rows by exact minute and pairs by
  amount and account; if a group is odd or ambiguous the whole minute is left unpaired. It depends only
  on account counts, never on row order. Skipped rows need `--allow-skips` (`allowSkips`).
- **Expense-side "Returned" is mapped to "Repaid"** (the user repaying someone). Income-side Returned is
  someone paying the user back and is untouched.
- **New names or categories need `--confirm-new`** (`confirmNew`), so the user reviews them first.
- **Idempotent:** each row gets a SHA-256 of its normalised content plus an occurrence index for
  identical rows in one file (scheme tag `tw2`, see `plan.ts` `hashRows`). The filename is NOT part of it.
  Re-importing a file, or an overlapping one, adds nothing. Consequence: a transaction edited in
  TrackWallet after import imports again as a second row.
- **Lookalikes:** a new row identical in content to a stored row that this file does not account for by
  hash (a hand entry, or a row from an older hash scheme) is refused unless `--allow-lookalikes`.
- **A soft-deleted imported row still counts as imported**, so re-importing never resurrects it.
- **Importing into an archived account/category/name is allowed** (history belongs there); the plan warns.
- The CLI takes a backup copy (`VACUUM INTO`, checked) before any commit, opens the database read-only for a
  dry run, refuses `--commit` without an existing `--db`, and never creates a database implicitly.

`verify.ts` runs six checks: row accounting, per-account totals (CSV vs database), transfer pairing
(the database's grouping must be a real pair from the CSV), orphans, round trip (export and compare every
field, then every line), and no un-attributed duplicate rows. The only tolerated differences are the counted
normalisations: seconds added to timestamps, Returned->Repaid, and case/whitespace of names.

## 7. What was verified, and how confident to be

- **Hand-calculated fixtures** for balances, series, cash flow and category rollups
  (`tests/data-balances.test.ts`; the arithmetic is written in comments).
- **Real-data cross-check:** the fixture month imports to totals equal to numbers read off TrackWallet's
  own screens (income 6,196.00, expenses 2,506.91, net +3,689.09 and all 22 calendar days).
- **Model-based test** (`tests/data-model.test.ts`): 3,000 random operations, balances compared with an
  independent model after every one.
- **Two layers per invariant** (`tests/invariants.test.ts`): the schema rejects the bad row; and with the
  constraints stripped, the audit query still catches it.
- **Mutation checks** (breaking a protection on purpose and confirming a test fails) were run after every
  phase. They are done with throwaway scripts, not committed.
- **Independent review passes** by a separate agent after each phase found real bugs each time
  (details in `DECISIONS.md`). Two of those bugs were caused by my own earlier fixes, so re-review fixes.

**Not verified:** anything on a device; `expo-sqlite` behaviour (binding integers against the
`typeof(...) = 'integer'` CHECKs is the one to watch); drizzle's Expo migrator; a multi-month import of
real data (only the one fixture month exists, plus synthetic files).

## 8. Tests

`tests/` files and what they protect: `invariants` and `schema` (the database), `data-*` (the data layer:
`-crud`, `-balances`, `-model`, `-hardening`, `-second-pass`), `importer*` and `import-*` (the importer).
Helpers: `tests/helpers.ts` (raw-SQL builders, a database with constraints on, or with them stripped) and
`tests/data-helpers.ts` (`makeDataDb()` = seeded database + `ctx` with a controllable clock, `expectData`,
`importCsv`). Seeded ids are deterministic (`ACC.cash`, `CAT.food`, ...).

To reproduce a bug: write the smallest failing test first with `makeDataDb()`, watch it fail for the reason
you expect, then fix, then run the whole suite.

## 9. Migrations (read before touching the schema)

Nothing has shipped, so the migrations are **regenerated, not stacked**:

1. Edit `src/db/schema.ts`.
2. Copy `drizzle/0001_constraints_and_triggers.sql` somewhere safe (it is hand-written: triggers and the
   `categories_unique` expression index, which Drizzle cannot express).
3. Delete `drizzle/`, run `npm run db:generate`, then
   `npx drizzle-kit generate --custom --name=constraints_and_triggers`, then copy your `0001` file back.
4. `tests/schema.test.ts` asserts the triggers still exist; it is the alarm if you skip step 2.

**Once a real database exists this procedure is forbidden**: add a new migration instead, and note that
SQLite recreates a table when a CHECK changes, which silently drops the triggers.

## 10. Symptom -> where to look

| Symptom | Start here |
|---|---|
| A balance is off | `src/data/balances.ts`; then run `schema-check`; compare with a manual sum of live rows. Deleted rows and the `asOfDate` day boundary are the usual suspects |
| A transfer does not balance | audits 4, 5, 14; `src/db/transfers.ts`; a raw UPDATE of one leg bypasses the guards |
| Spending total includes something odd | `src/data/summaries.ts` (transfers are excluded; Lend/Repaid count as spending on purpose) |
| Import refuses or skips rows | run the dry run (`npm run import -- file.csv`); the plan prints every error and skipped row with a reason |
| Import made duplicates | hash scheme (`plan.ts hashRows`), lookalike check, or a row edited in TrackWallet after import |
| `import-verify` fails | its output prints the numbers on both sides of each check; check 2 (totals) and check 3 (pairing) are the most informative |
| A transaction landed on the wrong day | it never should: dates are text, never converted; look for a writer that bypassed `normalizeTimestamp` |
| Foreign-key error | `PRAGMA foreign_keys` must be ON at every open (`src/db/node.ts`, `src/db/expo.ts` check it) |
| A name will not save | ASCII-case-insensitive uniqueness (`people_name_ci`, `accounts_name_ci`, `categories_unique`) |
| Test fails after a schema change | section 9; `tests/schema.test.ts` lists the expected CHECK and trigger names |
| Numbers wrong only on the phone | not covered by anything here; suspect number binding in expo-sqlite first |

## 11. Environment gotchas

- Developed on **Windows with PowerShell 5.1**: no `&&`, and native-command stderr shows as red text even on
  success. Trust the exit code (`$LASTEXITCODE`), not the colour.
- Some editors/tools decode `\uXXXX` inside text they write; a hash separator once ended up as a raw
  control character in source. `plan.ts` now uses visible escapes; keep it that way.
- `.gitignore` uses `/data/` (root only). A bare `data/` also hides `src/data/`; that once nearly excluded the
  whole data layer from a commit.
- `tests/fixtures/*.csv` has real-format personal data (names, amounts). The GitHub repo is private; replace it
  with fake data before ever making the repo public.
- The project agent `.claude/agents/data-integrity-reviewer.md` is only picked up at session start.

## 12. Open decisions and known limits

- Opening balances are unset; set them with `updateAccount` after the real history is imported.
- Export (Phase 7): an entry can have both a merchant and a note but TrackWallet's export has one Note column.
- Search is ASCII-case-insensitive only. Names differing only by accents/normalisation are not duplicates.
- The import confirmations are booleans; `applyImport` re-plans, so show `previewImport` and apply right away.
- Device wiring (Phase 4) still needs: `expo-crypto` for ids, Metro/Babel config for the `.sql` migrations,
  strict-mode `TextDecoder`, and finalising drizzle's prepared statements.

## 13. Prompt to give another AI agent

> Read `docs/HANDOFF.md`, then `docs/DECISIONS.md` and `docs/INVARIANTS.md`. Run `npm run test` and
> `npm run typecheck` and confirm the baseline (12 files, 294 tests, clean) before changing anything.
> Symptom: **<describe it, with exact inputs and the numbers you expected vs got>**.
> Rules: money is integer cents (expenses negative); never weaken an invariant or a CHECK to make a test
> pass; do not touch the sign, transfer or soft-delete semantics without asking; write a failing test that
> reproduces the bug first; do not regenerate migrations without reading section 9; report what you ran and
> its real output, and say plainly what you could not verify.

For a code review, add: "Act as a data-integrity reviewer (`.claude/agents/data-integrity-reviewer.md`): look for
float arithmetic in money paths, sums mixing currencies, balance queries missing the deleted filter, transfers
counted as spending, sign errors, importer paths that can drop or duplicate a row, and rounding applied twice.
Report only; do not fix."
