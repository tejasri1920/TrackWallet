# Master Prompt — Personal Finance Tracker (Expo / React Native)

> Copy of the original project spec. Sections 2.1–2.6, 5.4 and 12 are replaced
> by pointers to the files that now hold their content (`CLAUDE.md`, `.claude/`,
> `INVARIANTS.md`); everything else is verbatim, apart from the inline
> "(Amended by …)" notes. Later decisions are recorded in `DECISIONS.md`
> (A–J, resolved 2026-09-18); where they conflict with this file, `DECISIONS.md` wins.

---

## 0. Ground rules — read before writing any code

You are building a production-quality personal finance app for a single user. The
user is an Indian graduate student in the USA. He has **one year of real financial
history** in an existing Android app called TrackWallet. Losing or corrupting that
data is the single worst outcome of this project. Treat it as sacred.

**Rules you must follow for the entire project:**

1. **Do not write UI before the data model is settled and tested.** The frontend
   will be generated separately. Your job is to make the schema, the domain
   rules, and the importer correct first.
2. **Work in the phases in Section 8, in order.** At the end of each phase, stop,
   run the phase's exit criteria, and report results before starting the next.
3. **Never mark a phase complete because the code looks right.** Run it. Show the
   actual output. If a test cannot run, say so explicitly rather than assuming.
4. **All money is stored as signed integers in minor units** (cents, paise).
   Never use floats for money anywhere in the codebase. Floats appear only in
   `fx_rate`.
5. **When a requirement here is ambiguous, stop and ask.** Do not invent a
   product decision. The spec below is deliberately detailed; if something is
   genuinely missing, that is a question, not a blank to fill.
6. **Do not add features not listed in Section 10.** Explicitly out of scope
   items are listed in Section 11.

---

## 1. What you are building

A replacement for TrackWallet. It must match what TrackWallet already does well,
and add what it cannot do.

**Keep from TrackWallet:**

- Accounts with live balances shown as chips
- Three transaction types: Income, Expense, Transfer
- Two-level categories (category › subcategory) with icon and color
- Month calendar view with per-day income/expense stacked in each cell
- Cash flow summary and category breakdown
- Calculator keypad inside the amount field
- Dark theme

**Add:**

- Account types beyond cash/bank/credit: a Splitwise mirror account and an
  INR-denominated education loan account
- Dual currency (USD working currency, INR secondary) with **manually entered**
  exchange rates, no API
- Per-person lending ledger derived from category subcategories
- CSV import of TrackWallet history, and CSV export

**User's stated priority order** (use this to resolve tradeoffs):

1. A clean, complete record of spending
2. Splitting costs with roommates
3. Tracking money sent to India
4. Staying under a monthly budget ← lowest, build last or not at all

---

## 2. Phase 0 — Bootstrap the repository

Create this structure before anything else.

```
.
├── CLAUDE.md
├── .claude/
│   ├── settings.json
│   ├── rules/
│   │   ├── money.md
│   │   └── database.md
│   ├── skills/
│   │   ├── schema-check/SKILL.md
│   │   └── import-verify/SKILL.md
│   └── agents/
│       └── data-integrity-reviewer.md
├── docs/
│   ├── DECISIONS.md
│   └── PROGRESS.md
├── src/
└── tests/
```

### 2.1 `CLAUDE.md` — write exactly this content

See `/CLAUDE.md` (written verbatim).

### 2.2 `.claude/rules/money.md`, 2.3 `.claude/rules/database.md`, 2.4 `schema-check`, 2.5 `import-verify`, 2.6 `data-integrity-reviewer`

See the files themselves under `.claude/`. Their content is as in the original
spec, with the deviations listed in `DECISIONS.md` ("Phase 0 choices").

### 2.7 `docs/DECISIONS.md` and `docs/PROGRESS.md`

Seed `DECISIONS.md` with the locked decisions from Section 3. Append to it
whenever you make a design choice, with the reasoning.

`PROGRESS.md` is your running log: after each phase, append what was built, what
was verified, the actual test output, and anything left open. This is how the
user checks your work — keep it honest, including failures.

### Phase 0 exit criteria

All files above exist. `npm run typecheck` passes on an empty project. Report the
tree.

---

## 3. Locked technical decisions — do not relitigate

| Decision | Choice | Why |
|---|---|---|
| Framework | Expo managed, TypeScript strict | User's choice; frontend generated separately |
| Storage | expo-sqlite, local-first | ~800 rows/year; must work offline |
| ORM | Drizzle | Typed schema, real migrations |
| Cloud | None in v1; optional Supabase in Phase 7 | Free tier pauses after 7 days idle — app must never depend on it |
| Money | Signed integer minor units | Float rounding corrupts a year of data |
| Transfers | Two signed legs sharing a group id | Matches TrackWallet's export; makes balance a simple SUM |
| Budgets | Last priority, Phase 8, optional | User ranked it lowest of four |

---

## 4. Domain rules

### 4.1 Transaction types

- **Expense** — one leg, `amount_native < 0`, requires a category of kind `expense`.
- **Income** — one leg, `amount_native > 0`, requires a category of kind `income`.
- **Transfer** — two legs sharing `transfer_group_id`, no category on either leg.
  One leg negative (source), one positive (destination). The two `amount_usd`
  values must sum to exactly zero.

Transfers are **never** counted as income or expense in any analytics view. This
is what makes credit card payments, money sent to India, and lending settlements
not pollute the spending totals.

### 4.2 Currency

Working currency is USD. Every leg stores three things:

- `amount_native` + `currency` — what was actually charged
- `amount_usd` — the USD equivalent
- `fx_rate` — units of native currency per 1 USD

For a USD transaction: `currency = 'USD'`, `amount_native == amount_usd`,
`fx_rate = 1.0`.

For a foreign transaction, the user enters **both** the USD amount and the native
amount. The app derives the rate:

```
fx_rate = abs(amount_native) / abs(amount_usd)
```

The user never types a rate. There is no exchange-rate API in v1. The INR amount
the user actually transferred is the truth, not a market rate.

Any total spanning accounts of different currencies sums `amount_usd` only.

### 4.3 Lending

Lending is modeled as **categories with people as subcategories**, not as
accounts.

- Expense category `Lend` — subcategories are people
- Income category `Returned` — subcategories are the same people
- Income category `Taken` — money the user borrowed
- Expense category `Repaid` — the user paying someone back

Subcategories under these four categories are **not free text**. They are drawn
from the `people` table, so `Pramod` and `pramod` cannot diverge. Enforce this
with `people_backed = 1` on the category and a `COLLATE NOCASE` unique index on
`people.name`.

Per-person net balance:

```
net_owed_to_user =
    SUM(amount_usd where category = 'Lend'   and person = X)   -- negative
  + SUM(amount_usd where category = 'Returned' and person = X) -- positive
```

A negative net means that person still owes the user.

> **Note for the builder:** the user's current TrackWallet data already contains
> this information as free-text notes (`Pramod`, `Vamsi`). The importer must
> reconstruct it — see Section 6.4.

(Amended by decisions B, D, E: people are virtual subcategories, `Repaid` is
seeded, and the net is over all four categories.)

### 4.4 Splitwise

Splitwise is an **account**, type `splitwise`, not a replacement for the real
Splitwise app. The user's roommates are not users of this app and never will be.

Its balance is the user's single net position: positive when the house owes him,
negative when he owes. Adjusting it is a Transfer. Settling up is a Transfer
between the Splitwise account and a bank or cash account.

Do not build group management, n-way split math, or invitations.

(Amended by decision F: the user's share of a shared cost is an Expense leg on
the Splitwise account; only settle-ups are Transfers.)

### 4.5 Credit accounts

Accounts of type `credit` and `loan` carry negative balances normally. The
"total balance" figure sums all accounts including negatives, so the headline
number can legitimately be negative. Do not clamp it, do not hide it, and do not
display it as an error state.

---

## 5. Schema

Write this as a Drizzle schema, then generate the initial migration. SQL is given
for precision about constraints.

### 5.1 Tables

```sql
CREATE TABLE accounts (
  id                     TEXT PRIMARY KEY,
  name                   TEXT NOT NULL,
  type                   TEXT NOT NULL
                           CHECK (type IN ('cash','bank','credit','splitwise','loan')),
  currency               TEXT NOT NULL DEFAULT 'USD',
  opening_balance_native INTEGER NOT NULL DEFAULT 0,
  icon                   TEXT,
  color                  TEXT,
  sort_order             INTEGER NOT NULL DEFAULT 0,
  archived_at            TEXT,
  created_at             TEXT NOT NULL,
  updated_at             TEXT NOT NULL
);

CREATE TABLE people (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  note        TEXT,
  archived_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX people_name_ci ON people (name COLLATE NOCASE);

CREATE TABLE categories (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('income','expense')),
  parent_id     TEXT REFERENCES categories(id),
  icon          TEXT,
  color         TEXT,
  people_backed INTEGER NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  archived_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE UNIQUE INDEX categories_unique ON categories (kind, IFNULL(parent_id,''), name COLLATE NOCASE);

CREATE TABLE transactions (
  id                TEXT PRIMARY KEY,
  occurred_at       TEXT NOT NULL,
  type              TEXT NOT NULL CHECK (type IN ('income','expense','transfer')),
  account_id        TEXT NOT NULL REFERENCES accounts(id),
  currency          TEXT NOT NULL,
  amount_native     INTEGER NOT NULL,
  amount_usd        INTEGER NOT NULL,
  fx_rate           REAL NOT NULL DEFAULT 1.0,
  category_id       TEXT REFERENCES categories(id),
  person_id         TEXT REFERENCES people(id),
  merchant          TEXT,
  note              TEXT,
  transfer_group_id TEXT,
  import_hash       TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  deleted_at        TEXT
);
CREATE UNIQUE INDEX transactions_import_hash ON transactions (import_hash)
  WHERE import_hash IS NOT NULL;
CREATE INDEX transactions_occurred ON transactions (occurred_at);
CREATE INDEX transactions_account  ON transactions (account_id, occurred_at);
CREATE INDEX transactions_group    ON transactions (transfer_group_id);
```

`occurred_at` is a local-time ISO-8601 string with no timezone suffix. The user
has one timezone. Do not convert to UTC — it will shift transactions across day
boundaries and break the calendar view.

### 5.2 Balance query

```sql
SELECT a.id,
       a.opening_balance_native + COALESCE(SUM(t.amount_native), 0) AS balance_native
FROM accounts a
LEFT JOIN transactions t
  ON t.account_id = a.id AND t.deleted_at IS NULL
GROUP BY a.id;
```

### 5.3 Seed data

Seed exactly the categories visible in TrackWallet today, preserving names so the
import maps cleanly.

- **Expense:** Food & Drinks, Shopping, Housing, Bills, Transport, Vehicle,
  Leisure, Education, Lend, Returned, Investment, Subscriptions
- **Income:** Salary, Gifts, Taken, Returned, Loan

Subcategories present in the user's data — create these under their parents:
Food & Drinks › Groceries, Snacks · Vehicle › Fuel, Maintenance ·
Subscriptions › Education, Entertainment · Shopping › Gifts · Bills › Phone ·
Housing › Rent · Salary › Denim, Ride

> **Naming problem to fix during seeding:** `Returned` exists in *both* the income
> and expense trees and means two different things — returning a purchase to a
> store, versus a friend paying the user back. Seed the income one as `Returned`
> (person paying user back, `people_backed = 1`) and rename the expense one to
> `Refund`. Record this in `DECISIONS.md` and map it in the importer.

Seed accounts: Credit (`credit`), Chase Bank Account (`bank`), Cash (`cash`).
The Splitwise and education loan accounts are created by the user in-app.

(Amended by decisions C and D: `Refund` handling is finalized in Phase 2 after
inspecting the real CSV; `Repaid` is added to the seed.)

### 5.4 Invariants — these must always hold

See `INVARIANTS.md`. Each is implemented as a SQL query returning offending
rows, wired into `tests/invariants.test.ts` and into the `schema-check` skill.

---

## 6. TrackWallet CSV importer

This is the highest-risk component in the project. Build it before any UI.

### 6.1 Source format

Header, verified against the user's real August export:

```
Date,Transaction,Account,Currency,Amount,Amount_USD,Category,Subcategory,Note
```

Real rows, including the awkward ones:

```
"2026-08-26T20:23","Expense","Credit","USD","-105.88","-105.88","Food & Drinks","Groceries","Costco"
"2026-08-29T19:14:13","Expense","Credit","USD","-5.79","-5.79","Food & Drinks","Snacks",""
"2026-08-25T15:51:06","Transfer","Chase Bank Account","USD","-1000","-1000",,,""
"2026-08-25T15:51:06","Transfer","Credit","USD","1000","1000",,,""
"2026-08-23T18:34","Income","Cash","USD","194","194","Returned","","Pramod"
```

### 6.2 Parsing quirks you must handle

- **Two timestamp formats.** `YYYY-MM-DDTHH:MM:SS` and `YYYY-MM-DDTHH:MM`. In the
  reference file, 12 of 65 rows have seconds. Accept both; normalize to seconds
  with `:00`.
- **Transfer rows have bare empty fields** (`,,`) for Category and Subcategory,
  not quoted empties (`"",""`). Your CSV reader must treat both as empty.
- **Amounts are unpadded decimal strings** — `-5.79`, `650`, `-547.60`. Parse to
  minor units without float: split on `.`, pad the fractional part to 2 digits,
  combine as integers. Reject anything with more than 2 fractional digits.
- **Amount already carries the sign.** Do not re-apply a sign based on type.
  Instead, assert that the sign matches the type and fail loudly if not.

### 6.3 Transfer pairing

Transfers export as two rows. Pair them:

1. Group all `Transfer` rows by exact `occurred_at`.
2. Within a timestamp group, match each negative row to a positive row with the
   same absolute `Amount_USD` on a *different* account.
3. Assign both a shared generated `transfer_group_id`.
4. If a timestamp group has an odd number of rows, or a row cannot be matched,
   **do not import that group**. Add it to the unpaired report and continue.

Never invent a counter-leg. An unpaired transfer is a data question for the user,
not something to guess at.

### 6.4 Note field disambiguation

The `Note` column does double duty — merchant on some rows, person on others.

- If `Category` is one of `Lend`, `Returned`, `Taken`, `Repaid`: the note is a
  **person**. Look up or create in `people`, set `person_id`, leave `merchant`
  null. Also set the leg's subcategory to that person's category entry.
  (Amended by decision B: no per-person category row; `category_id` is the
  top-level category.)
- Otherwise the note is a **merchant** (`Costco`, `Dunkin`, `AMC`, `USPS`). Set
  `merchant`, leave `person_id` null.
- Empty note: both null.
- Transfer legs may carry a note too (e.g. `Vamsi` on a cash transfer). Keep it
  in `note` verbatim; do not create a person from a transfer leg.

Print every person created during import so the user can confirm the list before
committing.

### 6.5 Category mapping

Match `Category` + `Subcategory` against the seeded tree by name,
case-insensitively. Apply the `Returned` → `Refund` rule from Section 5.3 for
expense rows only. If a category is unknown, create it under the correct kind and
report it — never silently drop the row or dump it into an "Other" bucket.

### 6.6 Idempotency

Compute `import_hash` as a stable hash of the raw source line plus the source
filename. The unique index makes re-importing the same file a no-op. The user
will import twelve monthly files; some may overlap.

(Decision G, to be finalized in Phase 2: no filename in the hash; add an
occurrence index for identical lines within a file.)

### 6.7 Dry run first

Default behavior is dry run. Print, without writing anything:

- Rows read, rows that would be committed, rows skipped with reason
- Transfer groups paired, and any unpaired rows in full
- New accounts, categories, subcategories, and people that would be created
- Per-account totals the import would produce
- A sample of 10 parsed rows rendered back as readable lines

Only `--commit` writes, and it writes inside a single transaction that rolls back
entirely on any invariant failure.

### Phase 2 exit criteria

Run the importer against the real August CSV. All of:

- 65 rows read, 0 silently dropped
- Every transfer paired
- Per-account CSV sums equal database sums exactly
- All Section 5.4 invariants pass
- Round-trip export diffs clean against the source

Print the actual numbers. If any of these fail, report and stop.

---

## 7. Screens

Build only after Phases 1–2 pass. Four tabs, mirroring TrackWallet's structure.

**Home** — total balance with Week/Month/Year/All toggle, balance-over-time
chart, account chips with live balances, cash flow card (income / expenses /
net), category donut.

**Categories** — the two-level tree, editable, income and expense tabs, icon and
color per category. People-backed categories show the people list as their
subcategories.

**Analytics** — spend by category over time, per-person lending balances,
INR-sent-home summary with the effective rates the user actually got.

**Transactions** — month calendar, each day cell stacking income above expense,
a marker on days containing a transfer. Toggle to flat list. Search and filter.

**Add sheet** (from FAB) — Income / Expense / Transfer segmented control, date
and time defaulting to now, account chips showing balances, amount field with a
working calculator keypad, note, inline category chips. When the selected
account's currency is not USD, or the user toggles "foreign charge," show a
second amount field and display the derived rate live.

---

## 8. Phases

| # | Phase | Exit criteria |
|---|---|---|
| 0 | Bootstrap | Files from Section 2 exist, typecheck passes |
| 1 | Schema + migrations | All 11 invariants implemented and passing on fixtures |
| 2 | Importer | Real CSV imports losslessly, round-trip diffs clean |
| 3 | Data layer | CRUD for all entities, balance queries tested against hand-calculated fixtures |
| 4 | Core screens | Four tabs + add sheet, wired to real data |
| 5 | Currency entry | Foreign-charge flow, derived rate, invariants 6–8 hold on new entries |
| 6 | Lending + Splitwise | Per-person balances correct, settle-up flow works |
| 7 | Export + optional sync | CSV export, local backup; Supabase sync only if user confirms |
| 8 | Budgets | Only if the user asks. Lowest priority. |

Run `data-integrity-reviewer` before declaring Phases 1, 2, 3, 5, and 6 complete.
Append to `docs/PROGRESS.md` at the end of every phase.

(Decision J: an in-app file-picker import is added to Phase 3 or 4.)

---

## 9. Testing

- Every invariant in 5.4 has a test that constructs a violating row and asserts
  it is rejected.
- The importer has a test using the real August CSV as a fixture.
- Balance math has tests with hand-calculated expected values, including: an
  account with only transfers, a credit account with a negative balance, and a
  mixed-currency total.
- Currency conversion has a test asserting that `amount_usd` is never recomputed
  on read.

---

## 10. In scope for v1

Accounts and balances · three transaction types · two-level categories · people
and lending ledger · Splitwise mirror account · dual currency with manual rates ·
TrackWallet CSV import · CSV export · calendar and list views · cash flow and
category analytics · local backup.

## 11. Explicitly out of scope

Bank or card auto-sync · exchange-rate API · receipt OCR · multi-user accounts ·
Splitwise group math or invitations · notifications · widgets · web version ·
anything requiring a paid service.

---

## 12. First message back to the user

Before writing any code, reply with: (1) your understanding of the riskiest part
of this build and why, (2) any genuine ambiguity in the spec, (3) your plan for
Phase 0. Then wait for confirmation. *(Done 2026-09-18.)*
