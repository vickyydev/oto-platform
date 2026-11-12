/**
 * The suite's first rows on a production database built from the OTO App's
 * dump (go-live of the HR app, 12 November 2026).
 *
 * The dump is the HR app's own database: its branches, staff, users and every
 * record they made. It holds nothing of the suite's sign-in side, because the
 * old app has no launcher: no `core.operator`, no `core.branch`, no account.
 * Staging got those three from the demo seed, which never runs on production,
 * and `platform:sync` writes none of them. Until they exist the branch
 * reconciliation has nothing to join the app's branches to, the staff accounts
 * script finds no operator, and nobody can sign in.
 *
 * This writes those rows and nothing else, each taken from the restored data
 * where the data has it:
 *
 *   1. the operator, when the database has none;
 *   2. one park for each of the app's trading branches, by the app's own row:
 *      its name with the whitespace folded (the export carries a trailing
 *      space), its address and its timezone. Which app branch is which park is
 *      `PARKS` below: the two park codes are identifiers the till catalogue,
 *      the public catalogue route and the box settings already use, so they are
 *      named here and not derived. Head Office is an office, not a place that
 *      trades, and stays the app's own row, as on staging;
 *   3. with `--admin-phone`, one administrator account (platform_admin and
 *      operator_admin), its password read from the environment, never from the
 *      command line. A database built from the dump has no account that could
 *      be named as the actor of the staff accounts script, so the first one has
 *      to be made here;
 *   4. with `--show-only <app>`, the launcher's tiles: every other app in the
 *      suite registry that is open is set to hidden, so a manager or an
 *      administrator, whose roles carry the till, the Console and the rest,
 *      sees only the app that is live. The registry has no screen or route that
 *      hides a tile yet (the Console sets maintenance only), and the Console is
 *      not on production. An app in maintenance is left as it is and reported.
 *      `--show-also <app>` puts one hidden app back to open, for the day it
 *      goes live.
 *
 * Insert-if-absent throughout: a second run writes nothing. No demo row, no
 * department, no tier, no package, no price: those belong to the till's own
 * go-live. Opening hours are the park's published 10:00 to 20:00, as staging.
 *
 * Run it after the restore (`tools/data/restore-otoapp.mjs apply`) and before
 * `scripts/otoapp-branch-reconcile.ts`, which then joins each app branch to the
 * park made from it.
 *
 * Usage, with DATABASE_URL pointing at the database:
 *   pnpm --filter @oto/db exec tsx scripts/production-bootstrap.ts
 *   pnpm --filter @oto/db exec tsx scripts/production-bootstrap.ts --apply
 *   BOOTSTRAP_ADMIN_PASSWORD=… pnpm --filter @oto/db exec tsx scripts/production-bootstrap.ts --apply --admin-phone +66…
 *
 * Flags:
 *   --apply                 write; without it nothing is written
 *   --admin-phone <e164>    also make the administrator account on this number
 *   --admin-must-change     the administrator must choose a new password at the first sign-in
 *   --admin-phone-verified  count the number as verified (SMS password reset reaches it)
 *   --show-only <app>       hide every other open tile in the suite registry
 *   --show-also <app>       put one hidden tile back to open
 *
 * Prints counts, codes and ids only: never a name, an address, a phone number
 * or a password. Exits 1 when it refuses, 2 on a crash.
 */
import { hash } from '@node-rs/argon2';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { newId, normalizePhone } from '@oto/shared';
import { closeDb, getDb } from '../src/index';
import * as s from '../src/schema/index';
import { foldBranchName } from '../src/schema/otoapp';
import { SUITE_APP_KEYS, type SuiteAppKey } from '../src/schema/suite-controls';

/** The `request_id` on every audit row this writes, so the run is findable. */
const REQUEST_ID = 'script:production-bootstrap';
const OPERATOR_NAME = 'OTO';

/** The app's trading branches, by folded name, and the park code each one carries. */
const PARKS = [
  { code: 'hkt-central', appName: 'Oto Play Park, Central Floresta' },
  { code: 'robinson-chalong', appName: 'Oto Play Park, Robinson Chalong' },
] as const;

const OPENING_HOURS = Object.fromEntries(
  ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((day) => [day, { open: '10:00', close: '20:00' }]),
);

function argValue(args: string[], name: string): string | undefined {
  const inline = args.find((a) => a.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const adminPhoneRaw = argValue(args, '--admin-phone');
  const mustChange = args.includes('--admin-must-change');
  const phoneVerified = args.includes('--admin-phone-verified');
  const adminPhone = adminPhoneRaw ? normalizePhone(adminPhoneRaw) : null;
  if (adminPhoneRaw && !adminPhone) {
    console.log('refused: --admin-phone is not a phone number.');
    return 1;
  }
  const showOnly = argValue(args, '--show-only');
  const showAlso = argValue(args, '--show-also');
  for (const [flag, value] of [
    ['--show-only', showOnly],
    ['--show-also', showAlso],
  ] as const) {
    if (value !== undefined && !(SUITE_APP_KEYS as readonly string[]).includes(value)) {
      console.log(`refused: ${flag} must be one of: ${SUITE_APP_KEYS.join(', ')}.`);
      return 1;
    }
  }
  if (showOnly && showAlso) {
    console.log('refused: --show-only and --show-also are separate runs.');
    return 1;
  }
  const adminPassword = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? '';
  if (adminPhone && adminPassword.length < 16) {
    console.log('refused: BOOTSTRAP_ADMIN_PASSWORD must be set in the environment, 16 characters or more.');
    return 1;
  }

  const db = getDb(process.env.DATABASE_URL, { max: 1, applicationName: 'oto-production-bootstrap' });
  try {
    console.log(`production bootstrap: ${apply ? 'APPLYING' : 'DRY RUN, nothing written'}`);

    const installed = await db.execute<{ reg: string | null }>(sql`select to_regclass('otoapp.branches')::text as reg`);
    if (!installed.rows[0]?.reg) {
      console.log('refused: the OTO App is not on this database; restore the dump first.');
      return 1;
    }
    const roles = await db
      .select({ id: s.role.id, name: s.role.name })
      .from(s.role)
      .where(and(eq(s.role.isSystem, true), isNull(s.role.operatorId)));
    const roleId = (name: string) => roles.find((r) => r.name === name)?.id;
    if (!roleId('platform_admin') || !roleId('operator_admin')) {
      console.log('refused: the system roles are missing; run platform:sync first.');
      return 1;
    }

    // --- 1. The operator ----------------------------------------------------
    const operators = await db.select({ id: s.operator.id }).from(s.operator).where(isNull(s.operator.archivedAt));
    if (operators.length > 1) {
      console.log(`refused: ${operators.length} live operators; this is not a database built from the dump alone.`);
      return 1;
    }
    let operatorId = operators[0]?.id ?? null;
    const operatorMade = operatorId === null;
    if (operatorMade) operatorId = newId();

    // --- 2. The parks, from the app's own branch rows -------------------------
    const appBranches = await db.execute<{ id: string; name: string; address: string; timezone: string; core_branch_id: string | null }>(
      sql`select id::text as id, name, address, timezone, core_branch_id from otoapp.branches order by name`,
    );
    const existing = operatorMade
      ? []
      : await db
          .select({ id: s.branch.id, code: s.branch.code })
          .from(s.branch)
          .where(eq(s.branch.operatorId, operatorId!));
    const parkPlans: Array<{ code: string; id: string; made: boolean; name: string; address: string; timezone: string }> = [];
    for (const park of PARKS) {
      const matches = appBranches.rows.filter((b) => foldBranchName(b.name) === foldBranchName(park.appName));
      if (matches.length !== 1) {
        console.log(`refused: ${matches.length} app branches match the park ${park.code}; expected exactly one.`);
        return 1;
      }
      const row = matches[0]!;
      const held = existing.find((e) => e.code === park.code);
      parkPlans.push({
        code: park.code,
        id: held?.id ?? newId(),
        made: !held,
        name: row.name.replace(/\s+/g, ' ').trim(),
        address: row.address.trim(),
        timezone: row.timezone,
      });
    }
    const appOnly = appBranches.rows.length - PARKS.length;

    // --- 3. The administrator -------------------------------------------------
    let adminPlan: 'none' | 'make' | 'exists' = 'none';
    if (adminPhone) {
      const held = await db.select({ id: s.account.id }).from(s.account).where(eq(s.account.phone, adminPhone));
      adminPlan = held.length > 0 ? 'exists' : 'make';
    }

    // --- 4. The launcher's tiles ----------------------------------------------
    const registry = await db
      .select({
        id: s.appRegistry.id,
        key: s.appRegistry.key,
        tileState: s.appRegistry.tileState,
        revision: s.appRegistry.revision,
      })
      .from(s.appRegistry)
      .where(isNull(s.appRegistry.archivedAt));
    const tileChanges: Array<{ id: string; key: SuiteAppKey; from: 'open' | 'hidden'; to: 'open' | 'hidden'; revision: number }> = [];
    const tilesLeft: string[] = [];
    if (showOnly) {
      for (const row of registry) {
        if (row.key === showOnly) {
          if (row.tileState !== 'open') tilesLeft.push(`${row.key} is ${row.tileState}, not open`);
        } else if (row.tileState === 'open') {
          tileChanges.push({ id: row.id, key: row.key, from: 'open', to: 'hidden', revision: row.revision });
        } else if (row.tileState !== 'hidden') {
          tilesLeft.push(`${row.key} is ${row.tileState}, left as it is`);
        }
      }
    }
    if (showAlso) {
      const row = registry.find((r) => r.key === showAlso);
      if (row?.tileState === 'hidden') {
        tileChanges.push({ id: row.id, key: row.key, from: 'hidden', to: 'open', revision: row.revision });
      } else {
        tilesLeft.push(`${showAlso} is ${row?.tileState ?? 'not in the registry'}, left as it is`);
      }
    }

    console.log(`operator: ${operatorMade ? 'to make' : 'already there'} (${operatorId})`);
    for (const p of parkPlans) console.log(`park ${p.code}: ${p.made ? 'to make from the app branch of that name' : 'already there'} (${p.id})`);
    console.log(`app branches: ${appBranches.rows.length} read, ${PARKS.length} are parks, ${appOnly} stay the app's own`);
    console.log(
      `administrator: ${adminPlan === 'none' ? 'not asked for' : adminPlan === 'exists' ? 'an account already holds that number; left alone' : `to make${mustChange ? ', must change the password at first sign-in' : ''}${phoneVerified ? ', phone counted as verified' : ', phone not verified'}`}`,
    );
    if (showOnly || showAlso) {
      const changes = tileChanges.map((t) => `${t.key} ${t.from} -> ${t.to}`).join(', ') || 'nothing to change';
      console.log(`launcher tiles: ${changes}${tilesLeft.length ? `; ${tilesLeft.join('; ')}` : ''}`);
    }
    if (!apply) return 0;

    const adminId = adminPlan === 'make' ? newId() : null;
    const passwordHash = adminPlan === 'make' ? await hash(adminPassword) : null;
    await db.transaction(async (tx) => {
      const audit = (action: string, entityType: string, entityId: string, after: Record<string, unknown>, branchId?: string) =>
        tx.insert(s.auditLog).values({
          id: newId(),
          operatorId: operatorId!,
          branchId: branchId ?? null,
          actorAccountId: null,
          requestId: REQUEST_ID,
          action,
          entityType,
          entityId,
          after,
        });
      if (operatorMade) {
        await tx.insert(s.operator).values({ id: operatorId!, name: OPERATOR_NAME });
        await audit('operator.create', 'operator', operatorId!, { via: 'production_bootstrap' });
      }
      for (const p of parkPlans) {
        if (!p.made) continue;
        await tx.insert(s.branch).values({
          id: p.id,
          operatorId: operatorId!,
          name: p.name,
          code: p.code,
          timezone: p.timezone,
          country: 'TH',
          address: p.address,
          openingHours: OPENING_HOURS,
        });
        await audit('branch.create', 'branch', p.id, { via: 'production_bootstrap', code: p.code, from: 'otoapp.branches' }, p.id);
      }
      if (adminId) {
        await tx.insert(s.account).values({
          id: adminId,
          operatorId: operatorId!,
          phone: adminPhone!,
          passwordHash,
          phoneVerifiedAt: phoneVerified ? new Date() : null,
          status: 'active',
          mustChangePassword: mustChange,
        });
        const grants = [
          { role: 'platform_admin', scopeId: null as string | null },
          { role: 'operator_admin', scopeId: operatorId },
        ];
        for (const g of grants) {
          const assignmentId = newId();
          await tx.insert(s.roleAssignment).values({
            id: assignmentId,
            accountId: adminId,
            roleId: roleId(g.role)!,
            scopeType: 'operator',
            scopeId: g.scopeId,
          });
          await audit('role_assignment.create', 'role_assignment', assignmentId, { accountId: adminId, role: g.role, scopeType: 'operator' });
        }
        await audit('account.create', 'account', adminId, {
          via: 'production_bootstrap',
          status: 'active',
          passwordSet: true,
          mustChangePassword: mustChange,
          phoneVerified,
        });
      }
      for (const t of tileChanges) {
        const changed = await tx
          .update(s.appRegistry)
          .set({ tileState: t.to, revision: t.revision + 1, updatedAt: new Date() })
          .where(
            and(
              eq(s.appRegistry.id, t.id),
              eq(s.appRegistry.revision, t.revision),
              eq(s.appRegistry.tileState, t.from),
            ),
          )
          .returning({ id: s.appRegistry.id });
        if (changed.length !== 1) {
          throw new Error(`the registry row for ${t.key} changed while this ran; nothing was written`);
        }
        await tx.insert(s.auditLog).values({
          id: newId(),
          operatorId: null,
          actorAccountId: null,
          requestId: REQUEST_ID,
          action: 'app_registry.tile_state_set',
          entityType: 'app_registry',
          entityId: t.id,
          before: { tileState: t.from, revision: t.revision },
          after: { tileState: t.to, revision: t.revision + 1 },
          targetApp: t.key,
          reason: t.to === 'hidden' ? 'not live on this deployment yet' : 'live on this deployment',
          origin: 'script',
        });
      }
    });
    console.log(
      `written: operator ${operatorMade ? 1 : 0}, parks ${parkPlans.filter((p) => p.made).length}, administrator ${adminId ? `1 (${adminId})` : 0}, tiles ${tileChanges.length}`,
    );
    return 0;
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
