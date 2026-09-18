import { formatFixed2 } from './money';
import type { ImportPlan, PlannedLeg } from './plan';

const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length));
const signed = (minor: number) => (minor >= 0 ? '+' : '') + formatFixed2(minor);

/** One parsed leg as a readable line: date, type, account, amount, category path and who/what. */
export function describeLeg(leg: PlannedLeg, plan: ImportPlan): string {
  const r = leg.row;
  const cat = r.type === 'transfer'
    ? '(transfer)'
    : `${leg.categoryId ? categoryPath(leg, plan) : ''}`;
  const who = leg.personId ? `person=${r.note.trim()}` : leg.merchant ? `merchant=${leg.merchant}` : leg.note ? `note=${leg.note}` : '';
  return `${r.occurredAt}  ${pad(r.type, 8)} ${pad(r.account, 19)} ${pad(signed(r.amountNative), 10)} ${pad(cat, 30)} ${who}`.trimEnd();
}

function categoryPath(leg: PlannedLeg, plan: ImportPlan): string {
  const r = leg.row;
  const mapped = plan.categoryMappings.find((m) => m.kind === r.type && m.from === r.category);
  const top = mapped ? mapped.to : r.category;
  return r.subcategory ? `${top} > ${r.subcategory}` : top;
}

/** The dry-run report of Section 6.7. Pure text; the caller decides where it goes. */
export function formatPlan(plan: ImportPlan): string {
  const o: string[] = [];
  const h = (t: string) => o.push('', `== ${t}`);

  o.push(`Import plan for ${plan.filename}`);
  h('Row accounting');
  o.push(
    `rows read:                       ${plan.rowsRead}`,
    `would be committed (legs):       ${plan.legs.length}  (${plan.legs.length - plan.transferPairs * 2} income/expense + ${plan.transferPairs} transfers x 2 legs)`,
    `already imported (hash match):   ${plan.alreadyImported.length}`,
    `skipped, with reason:            ${plan.skipped.length}`,
    `failed validation (block commit): ${plan.issues.length}`,
    `accounted for:                   ${plan.legs.length + plan.alreadyImported.length + plan.skipped.length + plan.issues.length} of ${plan.rowsRead}`,
  );

  if (plan.issues.length) {
    h('ERRORS (nothing will be written until these are fixed)');
    for (const i of plan.issues) o.push(`  line ${i.line}: ${i.message}`, `    ${i.raw}`);
  }

  if (plan.lookalikes.length) {
    h(`LOOKALIKES: ${plan.lookalikes.length} new row(s) duplicate something the database already holds (a commit needs --allow-lookalikes)`);
    for (const l of plan.lookalikes) {
      o.push(`  line ${l.row.line}: ${l.row.raw}`, `    same minute, account, amount and category as existing row(s): ${l.existingIds.join(', ')}`);
    }
  }

  h(`Transfers: ${plan.transferPairs} pair(s) matched`);
  if (plan.skipped.length === 0) o.push('  no unpaired transfer rows');
  for (const s of plan.skipped) o.push(`  SKIPPED line ${s.row.line}: ${s.reason}`, `    ${s.row.raw}`);

  h('New records that would be created');
  o.push('  accounts:   (none; unknown accounts are errors, never auto-created)');
  o.push(`  categories: ${plan.newCategories.length === 0 ? '(none)' : ''}`);
  for (const c of plan.newCategories) o.push(`    ${c.kind}: ${c.parentName ? `${c.parentName} > ` : ''}${c.name}`);
  o.push(`  people:     ${plan.newPeople.length === 0 ? '(none)' : `${plan.newPeople.length}  <- please confirm this list before committing`}`);
  for (const p of plan.newPeople) o.push(`    ${p.name}`);

  if (plan.categoryMappings.length) {
    h('Category remapping applied');
    for (const m of plan.categoryMappings) o.push(`  ${m.kind} "${m.from}" -> "${m.to}"  (${m.rows} row(s))`);
  }
  if (plan.warnings.length) {
    h('Warnings');
    for (const w of plan.warnings) o.push(`  ${w}`);
  }

  h('Per-account totals this import would produce (sum of Amount, USD)');
  const totals = new Map<string, { n: number; sum: number }>();
  for (const l of plan.legs) {
    const t = totals.get(l.row.account) ?? { n: 0, sum: 0 };
    t.n++; t.sum += l.row.amountNative;
    totals.set(l.row.account, t);
  }
  for (const [acct, t] of [...totals].sort((a, b) => a[0].localeCompare(b[0]))) {
    o.push(`  ${pad(acct, 20)} ${pad(`${t.n} row(s)`, 10)} ${signed(t.sum)}`);
  }
  if (totals.size === 0) o.push('  (nothing to import)');

  h('Sample of parsed rows (first 10)');
  for (const l of plan.legs.slice(0, 10)) o.push(`  ${describeLeg(l, plan)}`);
  if (plan.legs.length === 0) o.push('  (none)');

  return o.join('\n');
}
