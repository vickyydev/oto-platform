/**
 * Load the park's real till catalogue onto one park (2026-11-09 documents).
 *
 * The logic is `seedRealCatalog` in `src/seed/real-catalog/index.ts`; this is
 * its command line. Without --apply it is a dry run: it prints the plan and
 * writes nothing.
 *
 * Usage, with DATABASE_URL pointing at the database:
 *   pnpm --filter @oto/db exec tsx scripts/real-catalog.ts --park central
 *   pnpm --filter @oto/db exec tsx scripts/real-catalog.ts --park central --apply
 *   pnpm --filter @oto/db exec tsx scripts/real-catalog.ts --park chalong --retire-demo
 *
 * Flags:
 *   --park central|chalong   which park (branch code hkt-central / robinson-chalong)
 *   --apply                  write; without it nothing is written
 *   --retire-demo            also archive this park's demo products (see DEMO_CODES_KEPT);
 *                            a demo product linked to stock is kept and reported
 *   --retire-stock-linked    with --retire-demo: archive the stock-linked demo products too
 *   --include-free-drinks    also write the Free Drinks Menu card's drinks (0 THB, inactive;
 *                            the till's F&B grid still shows them, see README.md)
 *
 * Prints counts and codes only, in well under 100 lines. Exits 1 when a code is
 * live on another branch (nothing is written for it) or the park is not found.
 */
import { and, eq, isNull } from 'drizzle-orm';
import { closeDb, getDb } from '../src/index';
import * as s from '../src/schema/index';
import { PARK_BRANCH_CODE, PARKS, seedRealCatalog, type Park } from '../src/seed/real-catalog/index';

function argValue(args: string[], name: string): string | undefined {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

/** "label: n" and then the codes, wrapped. */
function list(label: string, codes: string[]): void {
  console.log(`  ${label}: ${codes.length}`);
  let line = '   ';
  for (const code of codes) {
    if (line.length + code.length + 1 > 110) {
      console.log(line);
      line = '   ';
    }
    line += ` ${code}`;
  }
  if (line.trim().length > 0) console.log(line);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const park = argValue(args, '--park') as Park | undefined;
  if (!park || !(PARKS as readonly string[]).includes(park)) {
    console.log(`--park must be one of: ${PARKS.join(', ')}`);
    return 1;
  }
  const apply = args.includes('--apply');
  const retireDemo = args.includes('--retire-demo');
  const retireStockLinked = args.includes('--retire-stock-linked');
  if (retireStockLinked && !retireDemo) {
    console.log('--retire-stock-linked needs --retire-demo');
    return 1;
  }
  const includeFreeDrinks = args.includes('--include-free-drinks');

  const db = getDb(process.env.DATABASE_URL, { max: 1, applicationName: 'oto-real-catalog' });
  try {
    const branchCode = PARK_BRANCH_CODE[park];
    const branches = await db
      .select({ id: s.branch.id, operatorId: s.branch.operatorId })
      .from(s.branch)
      .innerJoin(s.operator, eq(s.operator.id, s.branch.operatorId))
      .where(and(eq(s.branch.code, branchCode), isNull(s.branch.archivedAt), isNull(s.operator.archivedAt)));
    if (branches.length !== 1) {
      console.log(`expected one live branch with code ${branchCode}, found ${branches.length}`);
      return 1;
    }
    const { id: branchId, operatorId } = branches[0]!;

    const r = await seedRealCatalog(db, {
      operatorId,
      branchId,
      park,
      retireDemo,
      retireStockLinked,
      includeFreeDrinks,
      apply,
    });

    console.log(
      `real catalog, park ${park} (branch ${branchCode}): ${r.applied ? 'APPLIED' : 'DRY RUN, nothing written'}` +
        `${retireDemo ? ', retire demo' : ''}${retireStockLinked ? ' (stock-linked too)' : ''}` +
        `${includeFreeDrinks ? ', with free drinks' : ''}`,
    );
    console.log(
      `categories: create ${r.categories.created.length}, update ${r.categories.updated.length}, unchanged ${r.categories.unchanged.length}`,
    );
    if (r.categories.created.length) list('create', r.categories.created);
    if (r.categories.updated.length) list('update', r.categories.updated);
    const p = r.products;
    console.log(
      `products: insert ${p.inserted.length}, update ${p.updated.length}, unchanged ${p.unchanged.length}, ` +
        `left archived ${p.skippedArchived.length}, conflicts ${p.conflicts.length}`,
    );
    if (p.inserted.length) list('insert', p.inserted);
    if (p.updated.length) list('update', p.updated);
    if (p.skippedArchived.length) list('left archived', p.skippedArchived);
    if (p.conflicts.length) list('CONFLICT (code live on another branch)', p.conflicts);
    const g = r.groups;
    console.log(
      `modifier groups: create ${g.created}, update ${g.updated}, unchanged ${g.unchanged}, ` +
        `archive ${g.archived.length} (and ${g.optionsArchived.length} options), left alone ${g.leftAlone.length}`,
    );
    for (const x of g.archived) console.log(`    archive group ${x} (ours, no longer in the data)`);
    for (const x of g.optionsArchived) console.log(`    archive option ${x} (ours, no longer in the data)`);
    for (const x of g.leftAlone) console.log(`    left alone ${x} (not in the data, not written by this loader)`);
    if (retireDemo) {
      console.log(`demo retirement: archive ${r.retire.archived.length}, kept ${r.retire.kept.length}`);
      if (r.retire.archived.length) list('archive', r.retire.archived);
      for (const k of r.retire.kept) console.log(`    kept ${k.code}: ${k.reason}`);
    }
    for (const w of r.warnings) console.log(`warning: ${w}`);
    console.log(
      `demo products left live here: ${r.demoLive.length}` +
        `${retireDemo || r.demoLive.length === 0 ? '' : ' (add --retire-demo to plan their retirement)'}`,
    );
    if (r.stale.length) list('stale (our prefix, no longer in the data; left alone)', r.stale);
    console.log(`untouched live products here: ${r.untouched.codes.length} with a code, ${r.untouched.codeless} without`);
    if (r.untouched.codes.length) list('untouched codes', r.untouched.codes);
    const withCode = r.notSeeded.filter((n) => n.code);
    const freeDrinks = withCode.filter((n) => n.code!.includes('-FREE-'));
    const others = withCode.filter((n) => !n.code!.includes('-FREE-'));
    console.log(`not seeded: ${r.notSeeded.length}`);
    for (const n of others) console.log(`    ${n.code}: ${n.reason}`);
    if (freeDrinks.length) {
      console.log(
        `    ${freeDrinks.length} free drinks (${freeDrinks[0]!.code} .. ${freeDrinks[freeDrinks.length - 1]!.code}): ` +
          'withheld, the F&B grid would show them though inactive (a question to the owner)',
      );
    }
    for (const n of r.notSeeded.filter((x) => !x.code)) console.log(`    ${n.name}: ${n.reason}`);
    return p.conflicts.length > 0 ? 1 : 0;
  } finally {
    await closeDb();
  }
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  },
);
