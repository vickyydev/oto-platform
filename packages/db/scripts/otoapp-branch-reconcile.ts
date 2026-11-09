/**
 * Join the OTO App's branches to the platform's parks (S2-22 restore step).
 *
 * The same reconciliation the Console's Branches page runs
 * (`POST /branches/oto-app/reconcile`, `reconcileAppBranches` in
 * `src/schema/otoapp.ts`), callable right after a production restore when
 * every app branch has lost its platform link. The platform-only pre-deploy
 * (`platform:sync`) does not run it; only the demo seed does.
 *
 * Before the reconciliation, an app branch whose name equals a park's name
 * once whitespace is folded (the production rows carry a doubled space) is
 * joined to that park, so the reconciliation finds it mapped and does not
 * create a second, empty branch for the park in the app.
 *
 * Usage, with DATABASE_URL pointing at the database:
 *   pnpm --filter @oto/db exec tsx scripts/otoapp-branch-reconcile.ts
 *
 * Prints park and branch names and counts only. Exits 1 when a park is left
 * without a joined app branch or an app row needs a hand.
 */
import { sql } from 'drizzle-orm';
import { closeDb, getDb } from '../src/index';
import { foldBranchName, reconcileAppBranches } from '../src/schema/otoapp';

async function main(): Promise<number> {
  const db = getDb(process.env.DATABASE_URL, { max: 1, applicationName: 'oto-otoapp-branch-reconcile' });
  try {
    const operator = await db.execute<{ id: string; name: string }>(
      sql`select id, name from core.operator where archived_at is null order by created_at limit 1`,
    );
    const operatorId = operator.rows[0]?.id;
    if (!operatorId) {
      console.log('No operator on this database.');
      return 1;
    }
    const parks = await db.execute<{ id: string; name: string }>(
      sql`select id, name from core.branch where operator_id = ${operatorId} and archived_at is null order by name`,
    );
    const appRows = await db.execute<{ id: string; name: string; core_branch_id: string | null }>(
      sql`select id, name, core_branch_id from otoapp.branches order by name`,
    );
    const byFolded = new Map<string, { id: string; name: string }[]>();
    for (const p of parks.rows) byFolded.set(foldBranchName(p.name), [...(byFolded.get(foldBranchName(p.name)) ?? []), p]);
    let joined = 0;
    for (const row of appRows.rows) {
      if (row.core_branch_id) continue;
      const candidates = byFolded.get(foldBranchName(row.name)) ?? [];
      const peers = appRows.rows.filter((r) => foldBranchName(r.name) === foldBranchName(row.name));
      if (candidates.length !== 1 || peers.length !== 1) continue;
      await db.execute(
        sql`update otoapp.branches set core_branch_id = ${candidates[0]!.id.toLowerCase()}, core_sync_status = 'SUCCESS', core_synced_at = now(), core_sync_error = null where id = ${row.id} and core_branch_id is null`,
      );
      joined += 1;
      console.log(`joined by name: "${row.name.trim()}" -> "${candidates[0]!.name}"`);
    }
    const report = await reconcileAppBranches(db, { operatorId });
    console.log(
      `reconciliation: ${report.alreadyMapped} already mapped, ${report.matchedByName.length} matched by name, ${report.created.length} created in the app, ${report.appOnly.length} app-only, ${report.ambiguous.length} ambiguous, ${report.unmapped.length} parks unmapped`,
    );
    for (const c of report.created) console.log(`  created in the app for park "${c.branchName}"`);
    for (const a of report.appOnly) console.log(`  app-only: "${a.appBranchName.trim()}"`);
    for (const a of report.ambiguous) console.log(`  needs a hand: "${a.appBranchName.trim()}" (${a.why})`);
    for (const u of report.unmapped) console.log(`  park without an app branch: "${u.branchName}" (${u.reason})`);
    const after = await db.execute<{ mapped: number; total: number }>(
      sql`select count(*) filter (where core_branch_id is not null)::int as mapped, count(*)::int as total from otoapp.branches`,
    );
    console.log(`app branches joined to a park: ${after.rows[0]!.mapped} of ${after.rows[0]!.total} (${joined} joined here by folded name)`);
    return report.ambiguous.length || report.unmapped.length ? 1 : 0;
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
