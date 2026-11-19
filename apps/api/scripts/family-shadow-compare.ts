/**
 * The shadow compare for the family reader switch (SCRUM-1024, plan step R1),
 * read only. The logic is `compareFamilyReads` in
 * `src/services/family-shadow.ts`; this is its command line. For every
 * member it compares today's read of their children (by `child.member_id`)
 * with the read through the family (`childrenSeenBy`), and prints every
 * member whose two sets differ. After a clean backfill (`family-backfill.ts`
 * and `family-verify.ts` in `packages/db/scripts`) it must print none. The
 * runbook is `docs/progress/plans/dropoff-beo-20261119/FAMILY_BACKFILL_RUNBOOK.md`.
 *
 * Usage, with DATABASE_URL pointing at the database:
 *   pnpm --filter @oto/api exec tsx scripts/family-shadow-compare.ts
 *
 * Prints member, operator and child ids and counts only, never a name or a
 * phone number. Exits 0 when no member differs, 1 when one does or an
 * argument was given, 2 on a crash.
 */
import { closeDb, getDb } from '@oto/db';
import { compareFamilyReads, type FamilyShadowDifference } from '../src/services/family-shadow';

function printDifference(d: FamilyShadowDifference): void {
  console.log(
    `member ${d.memberId} (operator ${d.operatorId}, ${d.memberLive ? 'live' : 'archived'}): ` +
      `only by member_id [${d.onlyByMember.join(' ')}]; only through the family [${d.onlyThroughFamily.join(' ')}]`,
  );
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.length > 0) {
    console.log(`refused: this takes no arguments (got "${args[0]}")`);
    return 1;
  }
  const db = getDb(process.env.DATABASE_URL, { max: 1, applicationName: 'oto-family-shadow-compare' });
  try {
    console.log('Family shadow compare: children by member_id beside children through the family, every member.');
    const report = await compareFamilyReads(db, { onDifference: printDifference });
    console.log(
      `members compared ${report.membersCompared}; children by member_id ${report.childrenByMember}; ` +
        `children through the family ${report.childrenThroughFamily}; members with a difference ${report.differences.length}`,
    );
    console.log(report.differences.length === 0 ? 'NO DIFFERENCE' : 'DIFFERENCES: see the runbook before going on');
    return report.differences.length === 0 ? 0 : 1;
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
