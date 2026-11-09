/**
 * Give every OTO App user who has no suite sign-in a platform account
 * (SCRUM-795), so staff and managers sign in on the launcher with their phone
 * and their existing app password.
 *
 * The logic is `provisionOtoAppStaffAccounts` in
 * `src/otoapp-staff-accounts.ts`; this is its command line. Without --apply it
 * is a dry run: it prints what it would do and writes nothing.
 *
 * Usage, with DATABASE_URL pointing at the database:
 *   pnpm --filter @oto/db exec tsx scripts/otoapp-staff-accounts.ts
 *   pnpm --filter @oto/db exec tsx scripts/otoapp-staff-accounts.ts --apply --actor <account id>
 *
 * Flags:
 *   --apply             write: one transaction per person
 *   --actor <uuid>      the administrator's platform account, recorded as who
 *                       made each link; required with --apply. The dry run
 *                       lists the accounts that may be named.
 *   --operator <uuid>   the platform operator. Default: the one live operator
 *                       the OTO App's park groups are anchored to.
 *
 * Prints counts and ids only — never a name or a phone number. Exits 1 when
 * the run is refused or a person's transaction failed, 2 on a crash.
 */
import { sql } from 'drizzle-orm';
import { closeDb, getDb, mappedAppBranches, otoAppBranchesInstalled } from '../src/index';
import {
  provisionOtoAppStaffAccounts,
  STAFF_ACCOUNT_OUTCOMES,
  StaffAccountsRefused,
  type StaffAccountsReport,
} from '../src/otoapp-staff-accounts';

function argValue(args: string[], name: string): string | undefined {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
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

function print(r: StaffAccountsReport): void {
  console.log(
    `OTO App staff accounts, operator ${r.operatorId}: ${r.applied ? 'APPLIED' : 'DRY RUN, nothing written'}`,
  );
  console.log(`app users read: ${r.read}`);
  console.log('outcomes:');
  for (const o of STAFF_ACCOUNT_OUTCOMES) console.log(`  ${o.padEnd(18)} ${r.outcomes[o]}`);
  console.log('by app role:');
  for (const [appRole, counts] of Object.entries(r.byAppRole).sort()) {
    const parts = STAFF_ACCOUNT_OUTCOMES.filter((o) => counts[o]).map((o) => `${o} ${counts[o]}`);
    console.log(`  ${appRole.padEnd(15)} ${parts.join(', ')}`);
  }
  const p = r.phoneSources;
  console.log(
    `phone, of those ${r.applied ? 'provisioned' : 'to provision'}: user phone_e164 ${p.user_phone_e164}, user phone_number ${p.user_phone_number}, employee record ${p.employee}`,
  );
  const e = r.employeeLinks;
  console.log(
    `employee record: linked ${e.linked}, none carries the user ${e.none}, ambiguous ${e.ambiguous}, no platform copy yet ${e.no_copy}`,
  );
  const a = r.roleAssignments;
  console.log(
    `platform role assignments: staff ${a.staff} (branch), branch_manager ${a.branch_manager} (branch), operator_admin ${a.operator_admin} (operator-wide); with the app tile only ${r.withoutPlatformRole}`,
  );
  if (r.globalAdminUserIds.length) list('global_admin skipped, link by hand in the Console', r.globalAdminUserIds);
  const failed = r.people.filter((x) => x.outcome === 'failed');
  for (const f of failed) console.log(`  FAILED app user ${f.userId}: ${f.failure}`);
  list('accounts that may be named with --actor', r.eligibleActorIds);
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const actor = argValue(args, '--actor') ?? null;

  const db = getDb(process.env.DATABASE_URL, { max: 1, applicationName: 'oto-otoapp-staff-accounts' });
  try {
    let operatorId = argValue(args, '--operator');
    if (!operatorId) {
      if (!(await otoAppBranchesInstalled(db))) {
        console.log('The OTO App is not on this database.');
        return 1;
      }
      const live = await db.execute<{ id: string }>(
        sql`select id from core.operator where archived_at is null order by created_at`,
      );
      const anchored: string[] = [];
      for (const op of live.rows) {
        if ((await mappedAppBranches(db, op.id)).length > 0) anchored.push(op.id);
      }
      if (anchored.length !== 1) {
        console.log(
          `Expected one live operator the app's park groups are anchored to, found ${anchored.length}: name one with --operator.`,
        );
        return 1;
      }
      operatorId = anchored[0]!;
    }

    let report: StaffAccountsReport;
    try {
      report = await provisionOtoAppStaffAccounts(db, { operatorId, apply, actorAccountId: actor });
    } catch (err) {
      if (err instanceof StaffAccountsRefused) {
        console.log(`refused (${err.code}): ${err.message}`);
        return 1;
      }
      throw err;
    }
    if (!report.installed) {
      console.log('The OTO App is not on this database.');
      return 1;
    }
    if (!apply && actor) {
      console.log(
        report.eligibleActorIds.includes(actor)
          ? '--actor names an account that may apply this.'
          : '--actor does NOT name an active operator_admin or platform_admin account of this operator.',
      );
    }
    print(report);
    return report.outcomes.failed > 0 ? 1 : 0;
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
