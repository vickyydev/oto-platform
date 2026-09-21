/**
 * Sample data for a staging OTO App, so the screens show a park rather than
 * eight empty lists.
 *
 * Run it as often as you like:
 *
 *   DATABASE_URL=... npx tsx script/sample/main.ts
 *
 * Every write is a find-or-create against a natural key, and nothing that
 * already exists is overwritten — edit Ploy's phone number in the UI, run this
 * again, and her new number is still there. The only writes to an existing row
 * are backfills of a column that is NULL and that the row cannot work without
 * (an employee with no branch, a department with no description), which is the
 * same rule the platform's own seed follows.
 *
 * It is NOT `script/minimal` or `script/full`. Those assume an empty database,
 * insert blindly, and call `assertDevEnv()` so they refuse to run anywhere
 * else. This one is written for a deployment that is already carrying real
 * sign-ins.
 *
 * What it deliberately does not create:
 *
 *  - `users`. Accounts on a deployment come from the platform's provisioning
 *    (S2-17a), and a local user here would be a second way in that survives
 *    being deactivated on the platform. The staff below are employee records;
 *    none of them can sign in.
 *  - `user_branch_access` for anyone whose role does not already imply every
 *    branch. Who may see which branch is decided inside this app by an
 *    administrator, and a seed that widened it would be making that decision
 *    silently. See `backfillAdminBranchAccess` below for the one case it does
 *    write, and why that one grants nothing new.
 *
 * Every person, shift and message in `people.ts` is invented. The park's real
 * export was read for SHAPES and PROPORTIONS only — how many departments, how
 * many staff per department, that a Thai legal name sits beside a short
 * nickname, that a few hires are foreign and carry visa dates — and not one
 * value was copied out of it.
 */

import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, pool } from '../../server/db';
import {
  DEFAULT_TENANT_SLUG,
  branches,
  departmentBranchAssignments,
  departments,
  employeeRoles,
  employees,
  operators,
  roleBranchAssignments,
  roles,
  tenants,
  timeEvents,
  userBranchAccess,
  users,
} from '../../shared/schema';
import { announcements, tasks } from '../../server/db/coreSchema';
import {
  DEPARTMENTS,
  PEOPLE,
  ROLES,
  SAMPLE_EMAIL_DOMAIN,
  emailFor,
  phoneFor,
  type DeptKey,
  type SamplePerson,
} from './people';

const BRANCH_NAME = 'HKT Central';
const BRANCH_ADDRESS = 'Central Phuket Floresta, Wichit, Mueang Phuket';
const OPERATOR_NAME = 'OTO Park';

/** Every count the run reports, so the summary is measured and not claimed. */
const made: Record<string, number> = {};
const count = (what: string, n = 1) => {
  made[what] = (made[what] ?? 0) + n;
};

/**
 * A stable number in [0,1) from a string. Clock-in times have to look like
 * people rather than a cron job, but they also have to be the SAME on every
 * run — a re-run matches existing time events by their exact timestamp, and a
 * fresh random would write a second clock-in a minute away from the first.
 */
function jitter(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10000) / 10000;
}

function monthsAgo(n: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - n);
  d.setHours(9, 0, 0, 0);
  return d;
}

async function ensureTenant(): Promise<string> {
  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
    .limit(1);
  if (existing) return existing.id;
  // "Default" and not something prettier: this is the row every
  // `getDefaultTenantId` in the app looks for by slug, and the app's own
  // fallback creates it under that name.
  const [created] = await db
    .insert(tenants)
    .values({ name: 'Default', slug: DEFAULT_TENANT_SLUG })
    .returning({ id: tenants.id });
  count('tenant');
  return created!.id;
}

async function ensureOperator(tenantId: string): Promise<string> {
  const [existing] = await db
    .select({ id: operators.id })
    .from(operators)
    .where(and(eq(operators.tenantId, tenantId), eq(operators.name, OPERATOR_NAME)))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(operators)
    .values({ tenantId, name: OPERATOR_NAME, status: 'active' })
    .returning({ id: operators.id });
  count('operator');
  return created!.id;
}

async function ensureBranch(tenantId: string, operatorId: string): Promise<string> {
  const [existing] = await db
    .select({ id: branches.id, operatorId: branches.operatorId })
    .from(branches)
    .where(and(eq(branches.tenantId, tenantId), eq(branches.name, BRANCH_NAME)))
    .limit(1);
  if (existing) {
    if (!existing.operatorId) {
      await db.update(branches).set({ operatorId }).where(eq(branches.id, existing.id));
      count('branch.operator backfilled');
    }
    return existing.id;
  }
  const [created] = await db
    .insert(branches)
    .values({
      tenantId,
      operatorId,
      name: BRANCH_NAME,
      address: BRANCH_ADDRESS,
      timezone: 'Asia/Bangkok',
    })
    .returning({ id: branches.id });
  count('branch');
  return created!.id;
}

async function ensureDepartments(tenantId: string, branchId: string): Promise<Map<DeptKey, string>> {
  const byKey = new Map<DeptKey, string>();
  for (const d of DEPARTMENTS) {
    const [existing] = await db
      .select({ id: departments.id, description: departments.description })
      .from(departments)
      .where(and(eq(departments.tenantId, tenantId), eq(departments.name, d.name)))
      .limit(1);
    let id: string;
    if (existing) {
      id = existing.id;
      if (!existing.description) {
        await db
          .update(departments)
          .set({ description: d.description })
          .where(eq(departments.id, id));
        count('department.description backfilled');
      }
    } else {
      const [created] = await db
        .insert(departments)
        .values({
          tenantId,
          name: d.name,
          description: d.description,
          displayOrder: d.order,
          isActive: true,
        })
        .returning({ id: departments.id });
      id = created!.id;
      count('department');
    }
    byKey.set(d.key, id);

    const [link] = await db
      .select({ id: departmentBranchAssignments.id })
      .from(departmentBranchAssignments)
      .where(
        and(
          eq(departmentBranchAssignments.departmentId, id),
          eq(departmentBranchAssignments.branchId, branchId),
        ),
      )
      .limit(1);
    if (!link) {
      await db.insert(departmentBranchAssignments).values({ departmentId: id, branchId });
      count('department-branch link');
    }
  }
  return byKey;
}

async function ensureRoles(tenantId: string, branchId: string): Promise<Map<string, string>> {
  const byName = new Map<string, string>();
  for (const r of ROLES) {
    // `roles.name` is unique across the whole table, not per tenant, so the
    // name alone is the key here.
    const [existing] = await db
      .select({ id: roles.id, description: roles.description })
      .from(roles)
      .where(eq(roles.name, r.name))
      .limit(1);
    let id: string;
    if (existing) {
      id = existing.id;
      if (!existing.description) {
        await db.update(roles).set({ description: r.description }).where(eq(roles.id, id));
        count('role.description backfilled');
      }
    } else {
      const [created] = await db
        .insert(roles)
        .values({ tenantId, name: r.name, description: r.description, isActive: true })
        .returning({ id: roles.id });
      id = created!.id;
      count('role');
    }
    byName.set(r.name, id);

    /**
     * Without this the Roles screen is empty even with twelve roles in the
     * table: it filters the list by the branch chosen in the header, and a
     * role with no row here belongs to no branch, so it is filtered out of
     * every branch.
     */
    const [link] = await db
      .select({ id: roleBranchAssignments.id })
      .from(roleBranchAssignments)
      .where(
        and(eq(roleBranchAssignments.roleId, id), eq(roleBranchAssignments.branchId, branchId)),
      )
      .limit(1);
    if (!link) {
      await db.insert(roleBranchAssignments).values({ roleId: id, branchId });
      count('role-branch link');
    }
  }
  return byName;
}

interface SeededEmployee {
  person: SamplePerson;
  id: string;
}

async function ensureEmployees(
  tenantId: string,
  branchId: string,
  depts: Map<DeptKey, string>,
  roleIds: Map<string, string>,
): Promise<SeededEmployee[]> {
  const out: SeededEmployee[] = [];
  let order = 0;
  for (const p of PEOPLE) {
    order += 1;
    const email = emailFor(p);
    const departmentId = depts.get(p.dept)!;

    const [existing] = await db
      .select({
        id: employees.id,
        branchId: employees.branchId,
        primaryDepartmentId: employees.primaryDepartmentId,
      })
      .from(employees)
      .where(and(eq(employees.tenantId, tenantId), eq(employees.email, email)))
      .limit(1);

    let id: string;
    if (existing) {
      id = existing.id;
      /**
       * The only two columns a re-run touches. Both are structural — an
       * employee with no branch is invisible on every branch-scoped screen,
       * and one with no department cannot be scheduled — and both are only
       * written when they are NULL, so a person who moved Ploy to another
       * department keeps that move.
       */
      const backfill: { branchId?: string; primaryDepartmentId?: string } = {};
      if (!existing.branchId) backfill.branchId = branchId;
      if (!existing.primaryDepartmentId) backfill.primaryDepartmentId = departmentId;
      if (Object.keys(backfill).length > 0) {
        await db.update(employees).set(backfill).where(eq(employees.id, id));
        count('employee backfilled');
      }
    } else {
      const startDate = monthsAgo(p.startedMonthsAgo);
      const [created] = await db
        .insert(employees)
        .values({
          tenantId,
          fullName: p.fullName,
          thaiName: p.thaiName,
          nickname: p.nickname,
          email,
          phone: phoneFor(p),
          phoneE164: phoneFor(p),
          branchId,
          primaryDepartmentId: departmentId,
          status: p.status,
          employmentState: p.employmentState,
          employmentBasis: p.employmentBasis,
          dailyRate: p.employmentBasis === 'PART_TIME' ? (p.dailyRate ?? null) : null,
          startDate,
          nationality: p.nationality,
          isForeignStaff: p.isForeignStaff,
          // A foreign hire's visa and work permit are the two dates the HR
          // screens chase, so the seeded ones are far enough out to be
          // uneventful and close enough to be worth showing.
          visaExpiryDate: p.isForeignStaff ? monthsAgo(-9) : null,
          workPermitExpiryDate: p.isForeignStaff ? monthsAgo(-7) : null,
          weeklyOffDays: p.weeklyOffDays,
          displayOrder: order,
          // The Employees list reads its Position column out of this jsonb
          // (`employees-page.tsx`, `defaultMergeData?.positionTitle`) rather
          // than from the roles, so without it every row shows a dash even
          // with roles assigned.
          defaultMergeData: { positionTitle: p.roles[0] },
        })
        .returning({ id: employees.id });
      id = created!.id;
      count('employee');
    }

    for (const [index, roleName] of p.roles.entries()) {
      const roleId = roleIds.get(roleName);
      if (!roleId) continue;
      const [link] = await db
        .select({ id: employeeRoles.id })
        .from(employeeRoles)
        .where(and(eq(employeeRoles.employeeId, id), eq(employeeRoles.roleId, roleId)))
        .limit(1);
      if (link) continue;
      await db.insert(employeeRoles).values({
        employeeId: id,
        roleId,
        isPrimary: index === 0,
        proficiencyLevel: index === 0 ? 'EXPERT' : 'STANDARD',
      });
      count('employee role');
    }

    out.push({ person: p, id });
  }
  return out;
}

/**
 * Give a user who already has access to every branch a row that says so.
 *
 * Narrow on purpose. `getUserWithBranchAccess` treats `admin` and
 * `global_admin` as having every branch whether or not a row exists, so this
 * grants nothing those users did not already have — what it adds is a row
 * carrying `tenant_id`, which is the first place that function looks when it
 * resolves the tenant for the session.
 *
 * Anyone else is left alone. A `manager` or `staff` user's branch access is a
 * decision an administrator makes inside this app, and a seed that made it for
 * them would be handing out visibility nobody asked for.
 */
async function backfillAdminBranchAccess(tenantId: string): Promise<string[]> {
  const admins = await db
    .select({ id: users.id })
    .from(users)
    .where(inArray(users.role, ['admin', 'global_admin']));
  for (const u of admins) {
    const [has] = await db
      .select({ id: userBranchAccess.id })
      .from(userBranchAccess)
      .where(eq(userBranchAccess.userId, u.id))
      .limit(1);
    if (has) continue;
    await db.insert(userBranchAccess).values({
      tenantId,
      userId: u.id,
      branchId: null,
      accessScope: 'all_branches',
    });
    count('admin branch access');
  }
  return admins.map((u) => u.id);
}

const ANNOUNCEMENTS = [
  {
    title: 'Sample data is loaded on this branch',
    body:
      'Everyone and everything you can see here was invented for the staging site. ' +
      'The staff are not real people: every address ends in ' +
      SAMPLE_EMAIL_DOMAIN +
      ' and every phone number starts +6695500. Edit anything you like — it saves, and ' +
      're-running the sample loader will not undo your edit.',
    priority: 'info' as const,
    days: 365,
  },
  {
    title: 'Songkran week — floor rota goes up Friday',
    body:
      'Expect the busiest three days of the quarter. Reception opens at 09:30 and the ' +
      'floor runs two supervisors on every shift. Party bookings are capped at four a day.',
    priority: 'warning' as const,
    days: 21,
  },
  {
    title: 'New allergy card at the restaurant counter',
    body:
      'Kitchen has a printed card for every set menu now. Check it against the child card ' +
      'before anything leaves the pass, and ask reception if a guardian note is unclear.',
    priority: 'urgent' as const,
    days: 14,
  },
];

async function ensureAnnouncements(tenantId: string, branchId: string): Promise<void> {
  for (const a of ANNOUNCEMENTS) {
    const [existing] = await db
      .select({ id: announcements.id })
      .from(announcements)
      .where(and(eq(announcements.tenantId, tenantId), eq(announcements.title, a.title)))
      .limit(1);
    if (existing) continue;
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + a.days);
    await db.insert(announcements).values({
      tenantId,
      title: a.title,
      body: a.body,
      priority: a.priority,
      startDate: start,
      endDate: end,
      branchIds: [branchId],
      showToEveryone: true,
      isActive: true,
    });
    count('announcement');
  }
}

const TASKS: {
  title: string;
  description: string;
  dept: DeptKey;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'low' | 'medium' | 'high';
  dueInHours: number;
}[] = [
  { title: 'Open the floor — safety walk', description: 'Netting, slide mats, ball pit depth, fire doors clear.', dept: 'floor', status: 'completed', priority: 'high', dueInHours: -2 },
  { title: 'Count the float and open the till', description: 'Two drawers. Photograph the count sheet before the first sale.', dept: 'reception', status: 'completed', priority: 'high', dueInHours: -3 },
  { title: 'Restock wristbands at the desk', description: 'Adult and child rolls, plus the spare printer ribbon.', dept: 'reception', status: 'pending', priority: 'medium', dueInHours: 3 },
  { title: 'Kitchen temperature log', description: 'Both fridges and the freezer, morning and evening.', dept: 'restaurant', status: 'in_progress', priority: 'high', dueInHours: 1 },
  { title: 'Set up party room 2 for the 14:00 booking', description: 'Eight children, one nut allergy, dinosaur theme.', dept: 'events', status: 'pending', priority: 'high', dueInHours: 2 },
  { title: 'Sanitise the soft play at changeover', description: 'Between the morning and afternoon sessions, all three zones.', dept: 'floor', status: 'pending', priority: 'medium', dueInHours: 4 },
  { title: 'Check nanny ratios for the afternoon', description: 'Drop-off bookings against nannies on shift.', dept: 'nanny', status: 'pending', priority: 'medium', dueInHours: 5 },
  { title: 'Cash-up and safe drop', description: 'Reconcile both drawers, bag the drop, log the discrepancy if any.', dept: 'management', status: 'pending', priority: 'high', dueInHours: 9 },
  { title: 'Coffee machine descale', description: 'Weekly. Takes forty minutes — start it before the lunch rush.', dept: 'restaurant', status: 'pending', priority: 'low', dueInHours: 6 },
  { title: 'Weekly rota to the group chat', description: 'Post next week once the duty manager has signed it off.', dept: 'management', status: 'in_progress', priority: 'medium', dueInHours: 26 },
];

async function ensureTasks(
  tenantId: string,
  branchId: string,
  depts: Map<DeptKey, string>,
  staff: SeededEmployee[],
  adminUserIds: string[],
): Promise<void> {
  /**
   * The Today screen's task panel is a personal workspace, not a branch board:
   * `tasks/today` in `server/core/compat/tasksCompat.ts` keeps only what is
   * assigned to the signed-in person or to their department, and drops
   * role-only, branch-only and unassigned work by design. An administrator
   * signing in from the launcher has no employee record, so without this every
   * one of the tasks below would exist and Today would still read "No pending
   * tasks" — which looks like a fault and is not one. Two of them are put in
   * the administrator's own list so the panel has something in it.
   */
  const ownedByAdmin = new Set(['Cash-up and safe drop', 'Weekly rota to the group chat']);

  for (const [index, t] of TASKS.entries()) {
    const [existing] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.tenantId, tenantId), eq(tasks.title, t.title)))
      .limit(1);
    if (existing) continue;
    const departmentId = depts.get(t.dept)!;
    const candidates = staff.filter(
      (s) => s.person.dept === t.dept && s.person.employmentState === 'ACTIVE',
    );
    const assignee = candidates[index % Math.max(candidates.length, 1)];
    const dueAt = new Date(Date.now() + t.dueInHours * 3600_000);
    await db.insert(tasks).values({
      tenantId,
      branchId,
      departmentId,
      assignedDepartmentId: departmentId,
      assignedEmployeeId: assignee?.id ?? null,
      assignedTo: ownedByAdmin.has(t.title) ? (adminUserIds[0] ?? null) : null,
      title: t.title,
      description: t.description,
      status: t.status,
      priority: t.priority,
      recurrence: 'once',
      dueAt,
      completedAt: t.status === 'completed' ? new Date(dueAt.getTime() - 600_000) : null,
      progressPercent: t.status === 'completed' ? 100 : t.status === 'in_progress' ? 40 : 0,
      taskLevel: t.dept === 'management' ? 'management' : 'line',
    });
    count('task');
  }
}

/**
 * Two weeks of clock-ins, for the Time & Attendance screens.
 *
 * Times are generated from the person and the day, so a second run produces
 * the same timestamps and matches the rows already there instead of adding a
 * near-duplicate a minute later.
 */
async function ensureTimeEvents(
  tenantId: string,
  branchId: string,
  staff: SeededEmployee[],
): Promise<void> {
  const working = staff.filter(
    (s) => s.person.employmentState === 'ACTIVE' && s.person.status === 'active',
  );
  const ids = working.map((s) => s.id);
  if (ids.length === 0) return;

  const since = new Date();
  since.setDate(since.getDate() - 14);
  since.setHours(0, 0, 0, 0);

  const already = await db
    .select({ employeeId: timeEvents.employeeId, eventTime: timeEvents.eventTime })
    .from(timeEvents)
    .where(and(inArray(timeEvents.employeeId, ids), sql`${timeEvents.eventTime} >= ${since}`));
  const seen = new Set(already.map((r) => `${r.employeeId}@${r.eventTime.toISOString()}`));

  const rows: (typeof timeEvents.$inferInsert)[] = [];
  for (const s of working) {
    for (let back = 14; back >= 1; back -= 1) {
      const day = new Date();
      day.setDate(day.getDate() - back);
      day.setHours(0, 0, 0, 0);
      if (s.person.weeklyOffDays.includes(day.getDay())) continue;

      const seed = `${s.person.key}:${day.toISOString().slice(0, 10)}`;
      const inMinutes = 9 * 60 + 30 + Math.round(jitter(`${seed}:in`) * 25) - 5;
      const shiftMinutes = 8 * 60 + 30 + Math.round(jitter(`${seed}:out`) * 60);

      const clockIn = new Date(day);
      clockIn.setMinutes(inMinutes);
      const clockOut = new Date(clockIn.getTime() + shiftMinutes * 60_000);

      for (const [eventType, at] of [
        ['IN', clockIn],
        ['OUT', clockOut],
      ] as const) {
        if (seen.has(`${s.id}@${at.toISOString()}`)) continue;
        rows.push({
          tenantId,
          employeeId: s.id,
          branchId,
          eventType,
          eventTime: at,
          // The park clocks in by face; PIN is the fallback, so a couple of
          // the seeded days use it the way a real fortnight would.
          authMethod: jitter(`${seed}:auth`) > 0.92 ? 'PIN' : 'FACE',
          confidenceScore: 92 + Math.round(jitter(`${seed}:conf`) * 7),
        });
      }
    }
  }

  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(timeEvents).values(rows.slice(i, i + 200));
  }
  count('time event', rows.length);
}

async function main(): Promise<void> {
  const tenantId = await ensureTenant();
  const operatorId = await ensureOperator(tenantId);
  const branchId = await ensureBranch(tenantId, operatorId);
  const depts = await ensureDepartments(tenantId, branchId);
  const roleIds = await ensureRoles(tenantId, branchId);
  const staff = await ensureEmployees(tenantId, branchId, depts, roleIds);
  const adminUserIds = await backfillAdminBranchAccess(tenantId);
  await ensureAnnouncements(tenantId, branchId);
  await ensureTasks(tenantId, branchId, depts, staff, adminUserIds);
  await ensureTimeEvents(tenantId, branchId, staff);

  const written = Object.entries(made).filter(([, n]) => n > 0);
  if (written.length === 0) {
    console.log('[sample] Everything was already there; nothing written.');
  } else {
    console.log('[sample] Written:');
    for (const [what, n] of written) console.log(`  ${n} × ${what}`);
  }
  console.log(
    `[sample] Every person above is invented. Addresses end in ${SAMPLE_EMAIL_DOMAIN} ` +
      `(a domain RFC 2606 reserves, so none of them can be mailed) and phone numbers ` +
      `start +6695500.`,
  );
}

main()
  .then(() => pool.end())
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
    return pool.end();
  });
