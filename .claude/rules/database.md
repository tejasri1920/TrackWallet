---
description: Database and migration rules. Applies to src/db/**.
paths:
  - "src/db/**"
  - "drizzle/**"
---

- The SQLite database is the source of truth. UI state never holds unsaved
  financial data.
- Every table has `created_at` and `updated_at` as ISO-8601 strings.
- Deletion is soft: set `deleted_at`. Balance queries must filter it out.
- Foreign keys are ON. Enable `PRAGMA foreign_keys = ON` at every connection open.
- Any query that computes a balance must be covered by a test with a known
  fixture and a hand-calculated expected value.
