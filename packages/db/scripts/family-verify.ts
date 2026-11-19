/**
 * The five family checks (SCRUM-1024, plan step F2, "V1"), read only. The
 * logic is `verifyFamilies` in `src/family-verify.ts`; this is its command
 * line. Run after `family-backfill.ts --apply`; every count must be zero
 * before any reader is switched to the family. The runbook is
 * `docs/progress/plans/dropoff-beo-20261119/FAMILY_BACKFILL_RUNBOOK.md`.
 *
 * Usage, with DATABASE_URL pointing at the database:
 *   pnpm --filter @oto/db exec tsx scripts/family-verify.ts
 *   pnpm --filter @oto/db exec tsx scripts/family-verify.ts --sample 50
 *
 * Prints each check with its count and up to --sample row ids (default 20),
 * never a name or a phone number. Exits 0 when every count is zero, 1 when
 * any is above zero or an argument was refused, 2 on a crash.
 */
import { closeDb, getDb } from '../src/index';
import { verifyFamilies } from '../src/family-verify';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let sample = 20;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const value = arg.startsWith('--sample=') ? arg.slice('--sample='.length) : arg === '--sample' ? args[(i += 1)] : null;
    if (value === null || value === undefined || !/^\d+$/.test(value)) {
      console.log(`refused: unknown argument "${arg}" (only --sample <n>)`);
      return 1;
    }
    sample = Number(value);
  }
  // The checks read every child and family once: give them longer than the
  // api's ten seconds a statement.
  const db = getDb(process.env.DATABASE_URL, {
    max: 1,
    applicationName: 'oto-family-verify',
    statementTimeoutMs: 120_000,
  });
  try {
    const report = await verifyFamilies(db, { sample });
    console.log('Family checks (each must be 0):');
    report.checks.forEach((c, i) => {
      console.log(`  ${i + 1}. ${c.label}: ${c.count}`);
      for (const s of c.samples) console.log(`       ${s}`);
      if (c.count > c.samples.length && c.samples.length > 0) console.log(`       ... and ${c.count - c.samples.length} more`);
    });
    console.log(report.ok ? 'ALL ZERO' : 'NOT ZERO: see the runbook before going on');
    return report.ok ? 0 : 1;
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
