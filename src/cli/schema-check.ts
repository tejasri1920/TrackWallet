// Usage: npm run schema-check -- <path-to-sqlite-file>
import fs from 'node:fs';
import { INVARIANTS, runInvariants, type Row } from '../db/invariants';
import { openNodeDb } from '../db/node';

const file = process.argv[2];
if (!file) {
  console.error('usage: npm run schema-check -- <path-to-sqlite-file>');
  process.exit(2);
}
if (!fs.existsSync(file)) {
  console.error(`no such database file: ${file}`);
  process.exit(2);
}

const { sqlite } = openNodeDb(file, { readonly: true });
const results = runInvariants((sql) => sqlite.prepare(sql).all() as Row[]);

for (const { invariant, rows, passed } of results) {
  const label = invariant.extra ? `extra ${invariant.id}` : `invariant ${invariant.id}`;
  console.log(`\n[${label}] ${invariant.name}`);
  console.log(invariant.sql.split('\n').map((l) => `    ${l}`).join('\n'));
  console.log(`  rows returned: ${rows.length}  =>  ${passed ? 'PASS' : 'FAIL'}`);
  if (!passed) console.log(JSON.stringify(rows, null, 2));
}

const failed = results.filter((r) => !r.passed);
console.log(
  `\n${results.length - failed.length}/${INVARIANTS.length} passed` +
    (failed.length ? `; FAILED: ${failed.map((r) => r.invariant.id).join(', ')}` : ''),
);
sqlite.close();
process.exit(failed.length ? 1 : 0);
