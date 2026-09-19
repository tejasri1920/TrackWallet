# Database invariants

Source: Section 5.4 of `MASTER_PROMPT.md`. These must always hold. Each is a SQL
query returning offending rows in `src/db/invariants.ts`, exercised by
`tests/invariants.test.ts`, and run against a real file by the `schema-check`
skill (`npm run schema-check -- <db file>`).

1. `type='expense'` ⟹ `amount_native < 0` and `category_id IS NOT NULL`
2. `type='income'` ⟹ `amount_native > 0` and `category_id IS NOT NULL`
3. `type='transfer'` ⟹ `category_id IS NULL` and `transfer_group_id IS NOT NULL`
4. Every `transfer_group_id` has exactly 2 non-deleted legs
5. Every transfer group's legs sum to exactly 0 in `amount_usd`
6. `currency='USD'` ⟹ `amount_native = amount_usd` and `fx_rate = 1.0`
7. `currency != 'USD'` ⟹ `fx_rate > 0` and
   `abs(abs(amount_native) / fx_rate - abs(amount_usd)) <= 1` (1 minor unit tolerance)
8. `amount_native` and `amount_usd` always share the same sign
9. Category depth ≤ 2: no category whose `parent_id` points at a row that itself
   has a `parent_id`
10. `person_id IS NOT NULL` ⟹ the leg's category has `people_backed = 1`
11. No transaction references an account or category that does not exist

Also part of 1 and 2: the category's `kind` must match the transaction type
(expense ⟹ kind `expense`, income ⟹ kind `income`).

## Extra invariants (added in Phase 1, not in the master prompt)

These close holes found while building and by the `data-integrity-reviewer` pass.
They are numbered after the original 11 and flagged `extra` in code. See
`DECISIONS.md` ("Phase 1 review fixes") for why each exists.

12. Money columns (`amount_native`, `amount_usd`, `opening_balance_native`) hold
    integers, never floats or text; `fx_rate` holds a number
13. `transfer_group_id` is set only on `type='transfer'` rows; transfer legs are non-zero
14. Live transfer legs in a group are on different accounts, and legs sharing a
    currency offset exactly in `amount_native`
15. Currency codes are three uppercase letters (`GLOB '[A-Z][A-Z][A-Z]'`)
16. A subcategory has the same `kind` as its parent (added 2026-09-18 at the user's
    request, resolving Phase 1 review finding 8)
17. `occurred_at` is a local timestamp shaped `YYYY-MM-DDTHH:MM:SS` (added in Phase 3; every
    date query compares this text lexicographically, so the shape is part of the schema)

Also enforced, though not a row-level invariant: account names are unique
case-insensitively (`accounts_name_ci`), because CSV rows find their account by name.

## Enforcement (decision A)

| Invariant | CHECK | Trigger | Domain function | Audit query |
|---|---|---|---|---|
| 1, 2 shape | `tx_expense_shape`, `tx_income_shape` | | | yes |
| 1, 2 category kind | | `trg_tx_category_kind_*`, `trg_cat_kind_upd` | | yes |
| 3 | `tx_transfer_shape` | | | yes |
| 4 (max 2 legs) | | `trg_tx_transfer_group_ins` | `createTransfer` | yes |
| 4 (min 2 legs) | | | `createTransfer`, `softDeleteTransfer` | yes |
| 5 | | `trg_tx_transfer_group_ins` (insert) | `createTransfer`, `softDeleteTransfer` | yes |
| 6, 7, 8 | `tx_usd_rate`, `tx_foreign_rate`, `tx_sign_match` | | | yes |
| 9 | | `trg_cat_depth_*` | | yes |
| 10 | | `trg_tx_person_*`, `trg_cat_people_backed_upd` | | yes |
| 11 | | | | yes (FKs need `PRAGMA foreign_keys = ON`) |
| 12 | `tx_money_integer`, `tx_fx_numeric`, `accounts_opening_integer` | | | yes |
| 13 | `tx_group_only_on_transfer`, `tx_transfer_nonzero` | | | yes |
| 14 | | `trg_tx_transfer_group_ins` | `createTransfer` | yes |
| 15 | `tx_currency_format`, `accounts_currency_format` | | | yes |
| 16 | | `trg_cat_kind_parent_ins`, `trg_cat_kind_parent_upd` | | yes |
| 17 | `tx_occurred_format` | | `normalizeTimestamp` in the data layer and importer | yes |

### Known limits of enforcement

- A **lone first transfer leg** cannot be rejected at insert (it is the first of
  two). Only `createTransfer` (both legs, one transaction) and the audit guard it.
- **UPDATEs and soft-deletes of one transfer leg** are not blocked by the
  database: the insert-side trigger cannot police edits without also blocking
  legitimate two-leg edits. The data layer's `updateTransfer` (both legs in one
  transaction; a damaged group is refused, never repaired) and `deleteTransfer` /
  `softDeleteTransfer` are the sanctioned paths. A raw UPDATE of one leg is still
  caught only by audits 4/5/14 afterwards (pinned by a test).
- Category-level triggers count soft-deleted transactions, so a category whose
  only history is soft-deleted still cannot change `kind`. Conservative on purpose.
- Deliberately **not** enforced: `transactions.currency = accounts.currency`. With the
  app USD-only for now (`DECISIONS.md`, "Phase 2 decisions") the question is moot;
  revisit it if INR entry ever returns.
