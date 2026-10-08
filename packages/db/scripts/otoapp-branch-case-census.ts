/**
 * The OTO App branch id census (S2-17b round 1): the read-back that says
 * whether any `otoapp.branches.core_branch_id` is spelled in anything but
 * lower case.
 *
 * A row like that falls out of the branch seam: the `otoapp_v` views and every
 * lookup by the platform's id match lower case only, so the park's events
 * would never reach the till (`canonicalCoreBranchId` in
 * `src/schema/otoapp.ts`). The doors are lower-cased from round 1 on; this
 * checks nothing written before them is left behind.
 *
 * READ ONLY. It runs inside a `read only` transaction and writes nothing. The
 * fix is the reconciliation (`POST /branches/oto-app/reconcile`, the Console's
 * Branches page), which lowers a row in place when no other row holds the
 * lower-case id and lists it, never merging, when one does.
 *
 * Usage, with DATABASE_URL pointing at the database to read:
 *   pnpm --filter @oto/db exec tsx scripts/otoapp-branch-case-census.ts
 *
 * The same question in plain SQL, for a psql read-back:
 *   select id, name, core_branch_id from otoapp.branches
 *    where core_branch_id is not null and core_branch_id <> lower(core_branch_id);
 *
 * Exits 0 when clean, 1 when a row is found, 2 when it could not ask.
 */
import { sql } from 'drizzle-orm';
import { censusAppBranchIdCase, closeDb, getDb } from '../src/index';

async function main(): Promise<number> {
  const db = getDb(process.env.DATABASE_URL, { max: 1, applicationName: 'oto-otoapp-case-census' });
  try {
    const { census, mapped } = await db.transaction(async (tx) => {
      await tx.execute(sql`set transaction read only`);
      const result = await censusAppBranchIdCase(tx);
      const counted = result.installed
        ? await tx.execute<{ n: number }>(
            sql`select count(*)::int as n from otoapp.branches where core_branch_id is not null`,
          )
        : null;
      return { census: result, mapped: counted?.rows[0]?.n ?? 0 };
    });
    if (!census.installed) {
      console.log(
        'OTO App branch id census: the OTO App is not installed on this database (no otoapp.branches).',
      );
      return 0;
    }
    if (census.found.length === 0) {
      console.log(
        `OTO App branch id census: clean — every core_branch_id is lower case (${mapped} mapped app branch row${mapped === 1 ? '' : 's'}).`,
      );
      return 0;
    }
    const n = census.found.length;
    console.log(
      `OTO App branch id census: ${n} app branch row${n === 1 ? ' carries' : 's carry'} a core_branch_id that is not lower case:`,
    );
    for (const f of census.found) {
      console.log(
        `  - ${f.appBranchId} "${f.appBranchName}": ${f.coreBranchId}` +
          (f.heldBy
            ? ` — COLLISION: app row ${f.heldBy} already holds ${f.canonical}; settle by hand, never merged`
            : ` — lowered to ${f.canonical} in place by its operator's next reconciliation`),
      );
    }
    return 1;
  } finally {
    await closeDb();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(
      `OTO App branch id census could not run: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(2);
  },
);
