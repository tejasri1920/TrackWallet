# Decisions

Append whenever a design choice is made, with the reasoning.

## Locked at project start (Section 3 of the master prompt)

| Decision | Choice | Why |
|---|---|---|
| Framework | Expo managed, TypeScript strict | User's choice; frontend generated separately |
| Storage | expo-sqlite, local-first | ~800 rows/year; must work offline |
| ORM | Drizzle | Typed schema, real migrations |
| Cloud | None in v1; optional Supabase in Phase 7 | Free tier pauses after 7 days idle — app must never depend on it |
| Money | Signed integer minor units | Float rounding corrupts a year of data |
| Transfers | Two signed legs sharing a group id | Matches TrackWallet's export; makes balance a simple SUM |
| Budgets | Last priority, Phase 8, optional | User ranked it lowest of four |

## Resolved on 2026-09-18 (spec ambiguities A–J)

The user approved my recommendations for all of A–J, with C, G, H, I deferred to Phase 2.

**A. Invariant enforcement — hybrid.**
`CHECK` for single-row rules, triggers for cross-table rules, one domain write
function that inserts both transfer legs in one transaction. Invariant queries
are the audit. Reason: 4, 5, 9, 10 span rows/tables and cannot be CHECKs, and
two legs of a transfer cannot be inserted atomically against a per-row rule.

**B. People are virtual subcategories.**
A lending leg has `category_id` = the top-level `Lend`/`Returned`/`Taken`/`Repaid`
category and `person_id` = the person. There are no per-person rows in
`categories`. The Categories screen renders the `people` list under these four
categories. Reason: matches invariant 10 and 4.3; avoids two sources of truth
for the same person.

**C. `Returned` → `Refund` (deferred to Phase 2, interim rule set).**
Spec contradiction: a store refund is money in, so it is an Income-type row, but
invariant 2 requires an income-kind category while 5.3 makes `Refund`
expense-kind. Interim rule: treat refunds per the invariants, i.e. a refund is
an Income-type row and needs an income-kind category. Final seeding of `Refund`
and the importer mapping are decided in Phase 2 after inspecting the real
`Expense`+`Returned` rows in the August CSV. Until then `Refund` is **not**
seeded and the importer does not exist, so nothing depends on it.

**D. Seed additions.**
Seed `Repaid` (expense, `people_backed = 1`), which 4.3 requires but 5.3 omits.
`Loan` (income) stays a plain income category with no link to the loan account.
People-backed categories: `Lend`, `Returned` (income), `Taken`, `Repaid`.

**E. Lending net.**
`net_position` = SUM(`amount_usd`) over all four people-backed categories for a
person. Negative means they owe the user. (Original spec summed only `Lend` and
`Returned` and named it `net_owed_to_user`, which had the wrong sign
connotation and ignored `Taken`/`Repaid`.)

**F. Splitwise.**
The user's share of a shared cost is an ordinary Expense leg on the Splitwise
account, with a category, so it appears in spending analytics. Only settle-ups
are Transfers (between the Splitwise account and a bank/cash account). Reason:
Transfers are excluded from spending, so booking shares as transfers would hide
real spending and violate priority #1; a transfer also needs a counter-leg the
spec never names.

**G. `import_hash` (deferred to Phase 2).**
Recommendation on record: hash = normalized line content + occurrence index for
identical lines within one file; **no filename**. Reason: filename in the hash
defeats dedupe of overlapping monthly files, and identical lines in one file
would collide on the unique index and silently drop a row.

**H. Round-trip "clean" (deferred to Phase 2).**
Recommendation on record: compare parsed field tuples, and list every
normalization the importer applies (`:00` seconds, empty-field quoting,
`Returned`→`Refund`, row order). Anything outside that list is a diff.

**I. Opening balances (deferred to Phase 2).**
Seeded accounts start with `opening_balance_native = 0`. Real values are needed
from the user before the balance chips can match TrackWallet.

**J. Importer runtime.**
Importer core is pure TypeScript behind a small DB interface. CLI and Vitest use
`better-sqlite3` with the same Drizzle schema; the app uses `expo-sqlite`.
An in-app file-picker import is added in Phase 3 or 4 so real data can get onto
the phone. `npm run import` is a stub until Phase 2.

## Phase 0 choices

- **Scaffold:** Expo blank-TypeScript template (SDK 57, TypeScript 6, React
  Native 0.86). Template's own `CLAUDE.md`, `AGENTS.md`, `.claude/`, `.git` were
  deliberately not copied; `App.tsx` moved to `src/App.tsx`.
- **`docs/MASTER_PROMPT.md` and `docs/INVARIANTS.md` added** so the
  `schema-check` skill and future sessions can find the invariants. The skill
  text was changed to reference `docs/INVARIANTS.md`.
- **`paths:` frontmatter added to the two rules files** so they scope to
  `src/db/**` etc. as the spec's prose intended.
- **`.claude/settings.json`** allows only the npm scripts and `tsc`/`vitest`.
- **`better-sqlite3` as a devDependency** for Node-side tests and the CLI
  importer, because `expo-sqlite` only runs on a device. Verified it loads on
  this machine (SQLite 3.53.4, Node 22.19).
- **`npm run import`** is a stub that exits 1 until Phase 2.

## Phase 1 choices

- **Migrations:** `drizzle/0000_*.sql` is generated from `src/db/schema.ts` (tables,
  named CHECKs, ordinary indexes). `drizzle/0001_constraints_and_triggers.sql` is
  hand-written and holds what drizzle-kit cannot express: the `categories_unique`
  expression index (`IFNULL(parent_id,'')`; drizzle-kit split it on the comma and
  emitted broken SQL) and all triggers. Nothing had shipped, so `0000` was
  regenerated (not patched) whenever the schema changed, keeping the snapshot honest.
  **Once a migration ships, never regenerate; add a new one.** Caution: when a
  generated migration recreates a table (SQLite does so when a CHECK changes) it
  will silently drop these triggers; `tests/schema.test.ts` asserts they exist.
- **Named CHECK constraints** (`tx_expense_shape`, ...) so a failure message names
  the invariant it violated, and tests assert on the name.
- **Domain write path for transfers:** `createTransfer` (both legs, one
  transaction, fx_rate derived) and `softDeleteTransfer` (both legs at once). Both
  are written against a driver-neutral `AppDb` type so they run on `expo-sqlite`
  and `better-sqlite3`. `updateTransfer` is deferred to Phase 3.
- **Seed ids are deterministic** (`acc-credit`, `cat-exp-food-and-drinks`,
  `cat-exp-subscriptions-education`) so seeding is idempotent and tests can name rows.
  Seed timestamps are local time without a zone, like `occurred_at`. Icons and
  colors are left NULL: the spec does not name any.
- **Timestamps:** `created_at`/`updated_at` are local-time ISO-8601 with seconds and
  no zone suffix (`localIso()`), consistent with `occurred_at`. No DB defaults; the
  app supplies them.
- **Tooling added:** `tsx` (TypeScript CLI runner); `npm run db:init -- <file>`
  (creates + migrates + seeds a new file, refuses to overwrite an existing one) and
  `npm run schema-check -- <file>` (runs every invariant, exits 1 on any failure).
  `CLAUDE.md` was left verbatim, so these two commands are documented here and in
  the `schema-check` skill only. `data/` is git-ignored for local database files.
- **Tests run against real migrations,** on `better-sqlite3` in memory. Each
  invariant is tested twice: *enforcement* (violating row rejected, error names the
  constraint) and *audit* (on a copy with CHECKs ignored, triggers dropped and FKs
  off, corrupt rows are caught by the invariant query).

## Phase 1 review fixes (2026-09-18)

The `data-integrity-reviewer` pass (run as a general-purpose agent with that
agent's instructions and a no-edit rule, because project agents load at session
start and it was not registered) returned nine findings. I checked each against the
code. Disposition:

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | High | A non-transfer row could join a transfer group and pass audits 3/4/5 | **Fixed.** CHECK `tx_group_only_on_transfer`, extra invariant 13 |
| 2 | High | No domain function to edit/soft-delete a transfer, though decision A promised one | **Partly fixed.** `softDeleteTransfer` added; `updateTransfer` due in Phase 3 with the rest of CRUD. Raw UPDATEs stay audit-only (pinned by a test) |
| 3 | Medium | A text `fx_rate` makes `tx_foreign_rate` NULL, and NULL passes a CHECK; audit 7 also missed it | **Fixed.** CHECK `tx_fx_numeric`; audit 12 now covers `fx_rate` |
| 4a | Medium | Lowercase/empty `currency` (`'usd'`) bypasses invariant 6 | **Fixed.** CHECK `tx_currency_format` + `accounts_currency_format`, extra invariant 15 |
| 4b | Medium | `transactions.currency` never tied to `accounts.currency` | **Open, needs a decision** (below) |
| 5 | Medium | INR→INR transfer with unequal native amounts creates money while USD nets to 0 | **Fixed.** Insert trigger + `createTransfer` guard + extra invariant 14 |
| 6 | Low | Zero-amount and same-account transfer legs pass via raw insert | **Fixed.** `tx_transfer_nonzero`; same-account rule in trigger and audit 14 |
| 7 | Low | `fx_rate` documented as "native per 1 USD", implemented as minor-native per USD cent | **Comment fixed.** Equivalent only for 100-minor-unit currencies (USD, INR). JPY/KWD would break invariant 7; out of scope |
| 8 | Low | A subcategory's `kind` need not equal its parent's | **Deferred, not invented.** Not in the spec. Recommend enforcing; needs your OK |
| 9 | Low | Triggers/index live only in a hand-written migration | **Mitigated** by a test asserting they exist |

Each fixed finding has a regression test that reproduces the reviewer's scenario.
The reviewer was **not** re-run on the fixes; they were verified by those tests plus
a mutation check (neutering each new protection makes exactly one test fail).

## Open questions for the user (both RESOLVED on 2026-09-18: see "Phase 2 decisions")

1. **Currency vs account currency (finding 4b).** The balance query in Section 5.2
   sums `amount_native`, which is only right when a transaction's currency equals
   its account's currency. But Section 7 describes a "foreign charge" flow: e.g. a
   USD credit card charged in INR. There the card balance must move by `amount_usd`
   while the INR amount is the record of what the merchant charged. Options:
   (a) require `transactions.currency = accounts.currency` always, and store a
   foreign charge on a USD card as USD with the INR amount in the note (loses the
   native amount); (b) allow a transaction currency different from the account's
   only when the account is USD, and define a USD account's balance contribution as
   `amount_usd`. **Recommendation: (b).** It keeps the INR amount and rate, and only
   changes the balance query for that one case. Nothing in Phases 1-2 depends on
   this; it must be settled before Phase 3's balance queries and Phase 5.
2. **Subcategory kind (finding 8).** Enforce that a subcategory's `kind` equals its
   parent's? Recommendation: yes (a trigger).

## Phase 2 decisions (2026-09-18)

### Answers from the user that settle earlier questions

- **Currency (was open question 1): USD only for now.** The user: leave the USD/INR
  question alone; money sent to India will be entered manually in USD with a note saying
  it was sent for India. Consequences: no foreign-charge flow, no derived rates, and
  **Phase 5 (Currency entry) is shelved**. The INR-capable schema (`fx_rate`, invariants
  6-8) stays in place, unused and untouched. The importer rejects any non-USD row or
  non-USD account with a clear error. The question of whether a transaction's currency
  may differ from its account's is therefore moot until INR returns.
  *Consequence to be aware of:* Section 7's "INR-sent-home summary with the effective
  rates the user actually got" cannot be built from USD-only records. India transfers are
  tracked by USD amount and note only, unless the user reopens this.
- **Subcategory kind (was open question 2): enforced.** A subcategory's kind must equal its
  parent's (triggers `trg_cat_kind_parent_ins/_upd`, extra invariant 16).
- **The CSV is a template and test fixture only.** It is never committed to a real
  database. It lives at `tests/fixtures/` and was imported only into scratch databases that
  were deleted afterwards. The fixture is a transcription of the pasted text (see
  `PROGRESS.md` for what that does and does not prove).
- **UI screenshots are Phase 4 reference material.** No UI work was done. They also
  cross-check the data: TrackWallet's own August header (6,196$ income, 2,506.91$
  expenses, +3,689.09$) and ten calendar day cells match the fixture exactly; the
  Categories screens match the seed (plus `Repaid`); total balance -2,010.87$ equals
  -2,724.15 + 115.28 + 598 (headline sums accounts including negatives, section 4.5).

### Decisions deferred from Phase 1, now resolved

- **C. `Returned` on the expense side is `Repaid`, not `Refund`.** The one such row in
  August is `Expense, Chase, -68, Returned, note "Aakanksha"`: the user repaying a person,
  and it is counted as an expense in TrackWallet's own 517.88 total for Aug 3. The Sept
  screenshot shows "Returned 614$" as an expense, the same pattern. So expense `Returned`
  maps to the people-backed `Repaid` (person from the note) and no `Refund` category is
  seeded. If a genuine store refund ever appears (positive amount), it will be an Income
  row and needs an income-kind category. **Made on evidence, not confirmed by the user:
  please confirm.** It is one line (`EXPENSE_CATEGORY_ALIASES` in `src/import/plan.ts`).
- **G. Import hash:** SHA-256 over (timestamp with seconds, type, account, currency,
  amount, amount_usd, category, subcategory, note) plus an occurrence index for identical
  rows within a file. Names are case-folded and trimmed first. **No filename.** Pure-TS
  SHA-256 (`src/import/hash.ts`, checked against `node:crypto`) so Node and React Native
  agree.
  *Inherent limit of content hashing:* if a transaction is EDITED in TrackWallet after it
  was imported (renamed category or merchant, changed amount) and the month is exported
  again, the edited row has a new hash and imports as a second row next to the old one.
  Import each month once, after it is final; fix edits in this app, not by re-importing.
- **H. Round-trip comparison:** parsed-field comparison plus a per-row text comparison,
  with exactly these counted normalizations: timestamp seconds added; expense
  `Returned`->`Repaid`; case/whitespace of Account, Category, Subcategory and person
  names. Anything else is a difference.
- **I. Opening balances: still open, deliberately.** Not provided. The screenshot balances
  (Credit -2,724.15, Chase 115.28, Cash 598 on 2026-09-14) include September and earlier
  months that are not in the August file, so they must NOT be used as opening balances.
  Plan: after all months up to that date are imported, set each account's opening balance
  to (TrackWallet balance on that date) minus (sum of imported amounts), and confirm the
  computed balance chips reproduce the three numbers.
- **J. In-app import:** the importer core is driver-neutral (`src/import/*` use `AppDb`);
  only `src/cli/*` is Node-only. The in-app file picker is still to be added in Phase 3/4.
  Two things to check on device then: `TextDecoder` with `fatal: true` (used by
  `decodeCsvBytes`) and `crypto.randomUUID` (`newId`) may need polyfills.

### Importer behaviour

- A row is exactly one of: **committed**, **already imported**, **skipped with a reason**,
  or **failed validation**. The planner throws if these do not sum to the rows read.
- **Errors block everything.** Unknown account, non-USD row or account, wrong sign for the
  type, zero amount, unparseable date/amount, a Subcategory on a people-backed category:
  the whole import is refused, all errors listed, nothing written. Accounts are never
  auto-created (their type is unknowable), which refines the spec's "new accounts" line.
- **Unpaired transfers are skipped, never guessed** (per spec), and a counter-leg is never
  invented. Ambiguity (same amount, different source accounts, same minute) skips the
  whole minute. Pairing prefers already-imported legs so that identical same-minute
  transfers cannot pair crosswise against what is already stored.
- **A soft-deleted imported row still counts as already imported**, so re-importing never
  resurrects something the user deleted on purpose.
- **Person names** are the trimmed note; merchants keep the note verbatim. Structural names
  (account, category, subcategory) are trimmed. Matching is ASCII case-insensitive, exactly
  like SQLite `COLLATE NOCASE`.
- **Encoding:** strict UTF-8 (BOM dropped); UTF-16 and invalid UTF-8 are refused, because a
  lossy read would corrupt names and verification would share the blind spot.
- **Safety in the CLI:** dry run is the default and opens the database read-only (the CLI
  prints how it opened it); `--commit` needs an existing `--db`, never creates one, takes a
  backup copy `<db>.before-import-<time>` first, refuses to create people/categories without
  `--confirm-new`, and refuses to proceed around skipped rows without `--allow-skips`.
  Verification runs INSIDE the commit transaction, so a failed verification rolls the
  import back instead of leaving it written. (`--confirm-new` and `--allow-skips` are
  stricter than the spec, which said to "print people so the user can confirm" and to
  "continue" past unpaired groups; both are one-flag changes.)
- **Accounts are unique case-insensitively** (`accounts_name_ci`), because CSV rows find
  their account by name.
- Commands are documented here and in the skills only; `CLAUDE.md` stays verbatim.
  `npm run import -- <csv> [--db f] [--commit [--confirm-new] [--allow-skips]]`,
  `npm run import-verify -- <csv> --db <f>`.

### Phase 2 review outcome

The `data-integrity-reviewer` pass (again run as a general-purpose agent with that agent's
instructions and no edit rights, because project agents are not registered mid-session)
found no path where the importer itself loses, duplicates, sign-flips or alters an amount;
a 200,000-case fuzz of the transfer pairing against brute force found no wrong or invented
pairing. Its 11 findings were all gaps around it:

| # | Finding | Disposition |
|---|---|---|
| 1 | Duplicate account names silently route rows to one account | **Fixed** (unique index + plan error) |
| 2 | Skipped rows never block commit; identical same-minute transfers could be skipped forever | **Fixed** (known-aware pairing; `--allow-skips`) |
| 3 | Verify blind to extra live copies | **Fixed** (check 6). Limit: a copy carrying another import hash is reported, not failed |
| 4 | Verify blind to wrongly grouped transfer legs | **Fixed** (check 3 reads the database's grouping back onto the CSV) |
| 5 | Padded/case-variant person names lost silently, then verify failed after commit | **Fixed** (warning + counted normalization) |
| 6 | A failed verification left the import committed; case variants always failed verify | **Fixed** (verify inside the transaction; folded hash and comparison) |
| 7 | Non-UTF-8 files corrupted silently | **Fixed** (strict decode) |
| 8 | Transfer legs differing only in account case: plan said OK, commit threw | **Fixed** |
| 9 | `constructor`/`__proto__` accepted as a type or crashed the plan | **Fixed** (Maps) |
| 10 | Padded category names created duplicates; no confirmation gate | **Fixed** (trim; `--confirm-new`) |
| 11 | Dry run opened the DB read-write; no backup; other minor items | **Fixed** (read-only, backup). **Not fixed:** wrong line numbers in lone-CR files (cosmetic); a dry run without `--db` cannot see already-imported rows (by design) |

Making verification run inside the commit immediately exposed a real flaw in my own first
fix for #4 (the verifier re-derived pairs with a hint that is meaningless after the insert),
which is why check 3 now reads the database's grouping instead. Every fix has a regression
test, and a mutation check (breaking each protection) was run: all but one break turned
tests red. The exception, dropping the "amounts are opposite" clause from check 3, is an
equivalent mutant: the separate "group sums to zero" check already implies it.
The reviewer was re-run on these fixes: see "Phase 2 second-pass review" below, which found that findings 3, 6 and 11 were only partly fixed.

### Phase 2 second-pass review (2026-09-18)

The reviewer was re-run on the fixes above (again as a general-purpose stand-in with the
agent's instructions and no edit rights). It confirmed that no path silently drops,
duplicates, sign-flips or re-rounds a row and that nothing is written when verification
fails, and it fuzzed the pairing hint over 400,000 cases (no invalid pair, no change to the
unpaired set). It also showed that three of my earlier "fixed" claims were **incomplete**
(findings 3, 6 and 11 above) and found new problems. Disposition:

| # | Finding | Disposition |
|---|---|---|
| N1 | In-commit verification checked the whole file, so a row deleted or edited in the app after an earlier import made every overlapping re-import fail and roll back | **Fixed.** Verification inside the commit is scoped to the rows that commit wrote (`verifyImport(..., { only })`); `import-verify` stays whole-file and still reports a deleted row as missing |
| N2 | A Note containing a line break crashed verification, so the file could never be committed | **Fixed** (regression tests for LF and CRLF inside quotes) |
| N3 | The backup was a plain file copy: stale or unusable for a WAL-mode database, yet reported as written | **Fixed.** `VACUUM INTO` snapshot, then reopened read-only and its table counts compared with the live database before anything is written |
| N4 | Check 6 could not see a duplicate carrying an import hash; a change of hash scheme would double every row with all checks green | **Fixed at the right place: plan time.** A new row that duplicates a stored row (same minute, type, account, amount, category, person, merchant) not accounted for by hash is a **lookalike**; a commit is refused without `--allow-lookalikes` (CLI) or `allowLookalikes` (library). Hash version tag bumped `tw1`->`tw2`. Check 6 itself still fails only on un-attributed rows |
| N5 | Pairing depended on row order, so reordered tied rows in a re-export turned imported transfers into skipped ones | **Fixed.** Pairing is decided from the account counts of each minute-and-amount class, never from row order, and is used only when it is the ONLY valid matching. Verified against brute force over 8,000 random groups, and all 24 orders of the reviewer's case |
| N6 | `npm run import -- <csv>` without `--db` printed usage instead of running the in-memory dry run | **Fixed** |
| N7 | Verification's text round trip failed legitimate but non-canonical files (`-5.0`, unquoted fields, `EXPENSE`) and blamed the round trip | **Fixed.** Counted as "identical apart from formatting" |
| N8 | Hash fields were joined with an unescaped separator | **Fixed** (JSON encoding). Test hashes the two colliding rows in separate files, because within one file the occurrence index masks the collision |
| N9 | Lone-CR files reported wrong line numbers; sort used `localeCompare` | **Fixed** |
| info | `--allow-skips` / `--confirm-new` live only in the CLI, so an in-app caller must gate them itself | **Open.** The lookalike gate is in the library (`commitImport`); the other two are not yet. Do this when the in-app import is built |
| info | An old database file lacks `accounts_name_ci` and the triggers (migration `0000` was regenerated in place) | **Open, dev-only.** No real database has been created yet. The plan-level ambiguity error still protects the account case |

Two fixes exposed problems in my own tests, which is why they are recorded: the first
"read-only dry run" test could not tell read-only from read-write (SQLite falls back
silently), so the CLI now reports how it actually opened the database; and the first
hash-separator test passed even with the bug, because both colliding rows were in one file.
The reviewer was **not** run a third time on these second-round fixes.
