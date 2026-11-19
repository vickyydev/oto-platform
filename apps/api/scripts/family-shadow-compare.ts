/**
 * The shadow compare for the family reader switch (SCRUM-1024, plan step R1),
 * read only. The logic is `compareFamilyReads` in
 * `src/services/family-shadow.ts`; this is its command line. For every member
 * of every operator it compares the children first saved under the member
 * (`child.member_id`, the read at `off`) with the children the member holds
 * through its families (the read at `read`), and counts the members that
 * differ under each kind of difference. After a clean backfill and verify
 * (`family-backfill.ts` and `family-verify.ts` in `packages/db/scripts`) every
 * count must be zero. The runbook is
 * `docs/progress/plans/dropoff-beo-20261119/FAMILY_BACKFILL_RUNBOOK.md`.
 *
 * It lives beside the api rather than beside the other two scripts because it
 * calls the read rule the readers call (`src/services/family.ts`), which the
 * db package cannot import.
 *
 * Usage, with DATABASE_URL pointing at the database:
 *   pnpm --filter @oto/api exec tsx scripts/family-shadow-compare.ts
 *   pnpm --filter @oto/api exec tsx scripts/family-shadow-compare.ts --sample 50
 *
 * Prints counts and, under each kind, up to --sample member ids (default 20)
 * with their operator and child ids, never a name or a phone number. Exits 0
 * when no member differs, 1 when one does or an argument was refused, 2 on a
 * crash.
 */
import { closeDb, getDb } from '@oto/db';
import { compareFamilyReads, FAMILY_SHADOW_DEFAULT_SAMPLE } from '../src/services/family-shadow';

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  let sample = FAMILY_SHADOW_DEFAULT_SAMPLE;
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]!;
    const value = arg.startsWith('--sample=') ? arg.slice('--sample='.length) : arg === '--sample' ? args[(i += 1)] : null;
    if (value === null || value === undefined || !/^\d+$/.test(value)) {
      console.log(`refused: unknown argument "${arg}" (only --sample <n>)`);
      return 1;
    }
    sample = Number(value);
  }
  const db = getDb(process.env.DATABASE_URL, {
    max: 1,
    applicationName: 'oto-family-shadow-compare',
    statementTimeoutMs: 120_000,
  });
  try {
    const report = await compareFamilyReads(db, { sample });
    console.log('Family shadow compare: children by member_id beside children through the family, every member.');
    console.log(
      `members compared ${report.membersCompared}; children by member_id ${report.childrenByMember}; ` +
        `children through the family ${report.childrenThroughFamily}; members with a difference ${report.membersWithDifference}`,
    );
    console.log('Members that differ, by kind (each must be 0):');
    report.kinds.forEach((k, i) => {
      console.log(`  ${i + 1}. ${k.label}: ${k.members} members, ${k.children} children`);
      for (const s of k.samples) {
        console.log(`       member ${s.memberId} (operator ${s.operatorId}): children ${s.childIds.join(' ')}`);
      }
      if (k.members > k.samples.length && k.samples.length > 0) console.log(`       ... and ${k.members - k.samples.length} more members`);
    });
    console.log(report.ok ? 'NO DIFFERENCE' : 'DIFFERENCES: see the runbook before going on');
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
