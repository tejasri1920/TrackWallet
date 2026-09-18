---
name: schema-check
description: Verify every database invariant holds against the live SQLite file. Use after any migration, any importer run, or before declaring a phase complete.
---

Run every invariant listed in `docs/INVARIANTS.md` (Section 5.4 of
`docs/MASTER_PROMPT.md`) as a SQL query against the current database. For each
one, print the invariant name, the query, the row count returned, and PASS (zero
rows) or FAIL (with the offending rows).

Run it with:

    npm run schema-check -- <path-to-sqlite-file>

The queries live in `src/db/invariants.ts`; the command prints all of them, one
block per invariant, and exits 1 if any fail. It opens the file read-only.

Never summarize. Print the actual output of every check. If any check fails, stop
and report rather than attempting a fix in the same turn.
