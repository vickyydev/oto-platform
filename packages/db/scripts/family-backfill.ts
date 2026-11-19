/**
 * Give every child saved before families existed a family (SCRUM-1024, plan
 * step F2, "B1"). The logic is `backfillFamilies` in `src/family-backfill.ts`;
 * this is its command line. Without --apply it is a dry run: the same reads
 * and counts, and nothing written. The order of a whole run (backfill, then
 * `family-verify.ts`, then the api's `family-shadow-compare.ts`) is in
 * `docs/progress/plans/dropoff-beo-20261119/FAMILY_BACKFILL_RUNBOOK.md`.
 *
 * Usage, with DATABASE_URL pointing at the database:
 *   pnpm --filter @oto/db exec tsx scripts/family-backfill.ts
 *   pnpm --filter @oto/db exec tsx scripts/family-backfill.ts --apply
 *
 * Flags:
 *   --apply                    write: one transaction per batch
 *   --batch-size <n>           members per batch, 1 to 2000 (default 200)
 *   --start-after <member id>  resume after this member id (the summary
 *                              prints it); a plain re-run also resumes
 *   --max-batches <n>          stop after n batches
 *
 * Prints counts and ids only, never a name or a phone number. Exits 0 when
 * the run finished and every child it read has a family (a dry run: when it
 * finished and nobody needs a hand); 1 when a batch failed, a member needs a
 * hand, a member was busy, it stopped at --max-batches before the end, or an
 * argument was refused; 2 on a crash.
 */
import { closeDb, getDb } from '../src/index';
import {
  backfillFamilies,
  FAMILY_BACKFILL_DEFAULT_BATCH,
  FamilyBackfillRefused,
  type FamilyBackfillBatch,
  type FamilyBackfillCounts,
  type FamilyBackfillReport,
} from '../src/family-backfill';

const FLAGS_WITH_VALUE = ['--batch-size', '--start-after', '--max-batches'] as const;

function parseArgs(args: string[]): {
  apply: boolean;
  batchSize?: number;
  startAfter?: string;
  maxBatches?: number;
} {
  const out: { apply: boolean; batchSize?: number; startAfter?: string; maxBatches?: number } = { apply: false };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    if (arg === '--apply') {
      out.apply = true;
      continue;
    }
    const [name, inline] = arg.includes('=') ? [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)] : [arg, undefined];
    if (!(FLAGS_WITH_VALUE as readonly string[]).includes(name)) {
      throw new FamilyBackfillRefused(`unknown argument "${arg}"`);
    }
    const value = inline ?? args[(i += 1)];
    if (value === undefined || value === '') throw new FamilyBackfillRefused(`${name} needs a value`);
    if (name === '--start-after') out.startAfter = value;
    else if (!/^\d+$/.test(value)) throw new FamilyBackfillRefused(`${name} must be a whole number`);
    else if (name === '--batch-size') out.batchSize = Number(value);
    else out.maxBatches = Number(value);
  }
  return out;
}

function countsLine(c: FamilyBackfillCounts): string {
  return (
    `members ${c.members}, families made ${c.familiesCreated}, families reused ${c.familiesReused}, ` +
    `guardian rows made ${c.guardiansCreated}, children given a family ${c.childrenSet}, ` +
    `needs a hand ${c.needsHand}, busy ${c.busy}`
  );
}

function printBatch(b: FamilyBackfillBatch, applied: boolean): void {
  const range = `members after ${b.afterMemberId ?? '(the first)'} up to ${b.lastMemberId}`;
  const held = applied ? `, locks held ${b.durationMs} ms` : '';
  console.log(`batch ${b.batch} (${range}): ${countsLine(b)}${held}`);
}

/** "label: n" and then the ids, wrapped. */
function list(label: string, ids: string[]): void {
  console.log(`${label}: ${ids.length}`);
  let line = ' ';
  for (const id of ids) {
    if (line.length + id.length + 1 > 110) {
      console.log(line);
      line = ' ';
    }
    line += ` ${id}`;
  }
  if (line.trim().length > 0) console.log(line);
}

function printSummary(r: FamilyBackfillReport): void {
  console.log('');
  console.log(`Family backfill, run ${r.runId}: ${r.applied ? 'APPLIED' : 'DRY RUN, nothing written'}`);
  console.log(`batch size ${r.batchSize}; started after ${r.startAfter ?? '(the first member)'}; batches ${r.batches}`);
  console.log(`totals: ${countsLine(r.totals)}`);
  if (r.needsHandMemberIds.length) list('members left for a person (several families, or a family with another guardian)', r.needsHandMemberIds);
  if (r.busyMemberIds.length) list('members busy at a till during their batch (run again)', r.busyMemberIds);
  if (r.failure) {
    console.log(
      `STOPPED: batch ${r.failure.batch} failed and was rolled back whole (members after ${r.failure.afterMemberId ?? '(the first)'}): ${r.failure.message}`,
    );
  }
  if (r.finished) {
    console.log('finished: no member after the last batch has a child without a family.');
  } else if (r.lastMemberId) {
    console.log(`not finished. To resume: --start-after ${r.lastMemberId} (or run again without it).`);
  } else {
    console.log('not finished. To resume: run again.');
  }
}

async function main(): Promise<number> {
  let args: ReturnType<typeof parseArgs>;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    if (err instanceof FamilyBackfillRefused) {
      console.log(`refused: ${err.message}`);
      return 1;
    }
    throw err;
  }
  const db = getDb(process.env.DATABASE_URL, { max: 1, applicationName: 'oto-family-backfill' });
  try {
    console.log(
      `Family backfill: ${args.apply ? 'applying' : 'dry run'}, batches of ${args.batchSize ?? FAMILY_BACKFILL_DEFAULT_BATCH} members.`,
    );
    let report: FamilyBackfillReport;
    try {
      report = await backfillFamilies(db, {
        apply: args.apply,
        batchSize: args.batchSize,
        startAfter: args.startAfter ?? null,
        maxBatches: args.maxBatches ?? null,
        onBatch: (b) => printBatch(b, args.apply),
      });
    } catch (err) {
      if (err instanceof FamilyBackfillRefused) {
        console.log(`refused: ${err.message}`);
        return 1;
      }
      throw err;
    }
    printSummary(report);
    const clean =
      report.failure === null &&
      report.finished &&
      report.needsHandMemberIds.length === 0 &&
      report.busyMemberIds.length === 0;
    return clean ? 0 : 1;
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
