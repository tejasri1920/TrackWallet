---
name: import-verify
description: Verify a TrackWallet CSV import was lossless. Use after any importer change or any real import run.
---

Given a source CSV and the database it was imported into, verify:

1. Row accounting — every source row is either a committed leg or is on the
   explicitly-skipped list with a reason. No silent drops.
2. Per-account totals — for each account, the sum of `Amount` in the CSV equals
   the sum of `amount_native` in the database.
3. Transfer pairing — every transfer group has exactly two legs summing to zero,
   and those two legs are a genuine pair from the CSV.
4. Orphans — no transfer leg without a partner.
5. Round-trip — export the imported range back to CSV and diff against the
   source. Report every differing field.
6. No extra copies — the database holds no un-attributed row duplicating an
   imported one.

Run it with:

    npm run import-verify -- <csv> --db <sqlite file>

It opens the database read-only, prints every check with the numbers on both sides
of each comparison, and exits 1 if any check fails. The importer runs the same
verification inside its commit transaction (`npm run import -- <csv> --db <file>
--commit --confirm-new`), so a failing import is rolled back rather than left behind.

Print the actual numbers on both sides of each comparison. Never summarize.

Differences tolerated by check 5 are exactly the counted normalizations: timestamp
seconds added, expense `Returned` -> `Repaid`, and case/whitespace of account,
category, subcategory and person names. Anything else is a real difference.
