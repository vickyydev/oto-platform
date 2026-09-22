/**
 * Load the sampled park into a deployment, so the screens show a park rather
 * than eight empty lists.
 *
 * Run it as often as you like:
 *
 *   DATABASE_URL=... npx tsx script/sample/main.ts
 *
 * Every write is a find-or-create against a natural key, and nothing that
 * already exists is overwritten — change a phone number in the UI, run this
 * again, and the new number is still there. The only writes to an existing row
 * are backfills of a column that is NULL and that the row cannot work without
 * (an employee with no branch, a branch with no operator), which is the same
 * rule the platform's own seed follows.
 *
 * The one thing to know about that: the *key itself* is how a row is
 * recognised, and the keys are an employee's email address and a task's title
 * with its due and start times. Edit any other field and the edit survives.
 * Edit the key — rename a task, change an address — and the next run no longer
 * recognises the row and writes the original back beside it. Measured, not
 * assumed: renaming one task's title turned 49 rows into 50 on the next run.
 * Nothing is lost either way; there is simply a duplicate to delete.
 *
 * It is NOT `script/minimal` or `script/full`. Those assume an empty database,
 * insert blindly, and call `assertDevEnv()` so they refuse to run anywhere
 * else. This one is written for a deployment that is already carrying real
 * sign-ins.
 *
 * ## Where the rows come from
 *
 * They are the park's own. `data.generated.ts` is a sample cut from the
 * production export by `script/sample/extract.ts`, which is where the sampling
 * rule and the list of columns deliberately left behind are written down. The
 * export is never committed and is not needed to run this; the sample is
 * committed and is.
 *
 * An earlier version of this seed carried twenty-six invented people. It does
 * not any more.
 *
 * ## What it deliberately does not create
 *
 * The rows are the park's own and they are carried as they are — real
 * addresses, home addresses, pay figures, photograph paths, the lot. What is
 * held back is credentials only, and the reason is not squeamishness about
 * personal data: a hash or a kiosk code is a *way in* on an internet-facing
 * deployment, and none of it renders on any screen.
 *
 *  - `users`. Accounts on a deployment come from the platform's provisioning
 *    (S2-17a), and a local user here would be a second way in that survives
 *    being deactivated on the platform. The staff below are employee records;
 *    none of them can sign in, and none of them is linked to an account even
 *    though the export links sixty-seven of sixty-nine.
 *  - `user_branch_access` for anyone whose role does not already imply every
 *    branch. Who may see which branch is decided inside this app by an
 *    administrator, and a seed that widened it would be making that decision
 *    silently. See `backfillAdminBranchAccess` below for the one case it does
 *    write, and why that one grants nothing new.
 *  - `people`, and therefore `employees.person_id`. That table carries its own
 *    PIN hash, face id and phone number for each person.
 *
 * ## One thing to know about the dates
 *
 * The clock-ins and the task board carry the export's real timestamps, which
 * end on the day the export was taken. Screens that ask for a date range show
 * them; screens that ask for *today* will be empty until somebody clocks in.
 * That is the price of real data and it is the right way round — the fix is a
 * fresher export through `extract.ts`, not invented timestamps here.
 *
 * Every screen that carries this data can be moved off today: attendance and
 * the timesheet take a date range, the task board has an All filter, and the
 * two that only ever showed today — the attendance day view and the Today
 * panel — now name the day they are showing and say how to change it, instead
 * of rendering an empty panel that reads as a fault. The run prints the last
 * day the sample carries so whoever seeded it knows where to look.
 */

// First, and before the database module: the sample's timestamps are wall
// clocks with no offset, and this has to write them back exactly as they were
// read — on a laptop in Bangkok and on a deployment running in UTC alike.
import './utc';

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
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
  ANNOUNCEMENTS,
  BRANCHES,
  DEPARTMENTS,
  LEGACY_SAMPLE_EMAIL_DOMAIN,
  OPERATOR,
  PEOPLE,
  ROLES,
  SAMPLE_BANNER,
  SAMPLE_COUNTS,
  TASKS,
  TASKS_OWNED_BY_ADMIN,
  TIME_EVENTS,
} from './people';

/** Every count the run reports, so the summary is measured and not claimed. */
const made: Record<string, number> = {};
const count = (what: string, n = 1): void => {
  made[what] = (made[what] ?? 0) + n;
};

const at = (value: string | null): Date | null => (value ? new Date(value) : null);

async function ensureTenant(): Promise<string> {
  const [existing] = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
    .limit(1);
  if (existing) return existing.id;
  // "Default" and not something prettier: this is the row every
  // `getDefaultTenantId` in the app looks for by slug, and it is also what the
  // export calls it.
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
    .where(and(eq(operators.tenantId, tenantId), eq(operators.name, OPERATOR.name)))
    .limit(1);
  if (existing) return existing.id;
  const [created] = await db
    .insert(operators)
    .values({ tenantId, name: OPERATOR.name, status: OPERATOR.status })
    .returning({ id: operators.id });
  count('operator');
  return created!.id;
}

/**
 * All three of the park's branches, not one.
 *
 * Names are written exactly as the export holds them, trailing space and all.
 * That looks like a typo and is not one: it is the string the find-or-create
 * matches on, and trimming it here would mean a re-run against a deployment
 * that already carries the untrimmed name creates a second branch beside it.
 */
async function ensureBranches(tenantId: string, operatorId: string): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  for (const b of BRANCHES) {
    const [existing] = await db
      .select({ id: branches.id, operatorId: branches.operatorId })
      .from(branches)
      .where(and(eq(branches.tenantId, tenantId), eq(branches.name, b.name)))
      .limit(1);
    if (existing) {
      if (!existing.operatorId) {
        await db.update(branches).set({ operatorId }).where(eq(branches.id, existing.id));
        count('branch.operator backfilled');
      }
      byKey.set(b.key, existing.id);
      continue;
    }
    const [created] = await db
      .insert(branches)
      .values({
        tenantId,
        operatorId,
        name: b.name,
        address: b.address,
        timezone: b.timezone,
        logoUrl: b.logoUrl,
        // The label, not the folder id — see WITHHELD in `extract.ts`.
        googleDriveFolderName: b.googleDriveFolderName,
        // Unique per tenant on `lower(calendar_color)`, so a colour already
        // taken by a branch somebody made by hand would fail the insert.
        // Dropping ours is the safe half of that trade: the calendar picks a
        // colour when none is set, and the branch is still created.
        calendarColor: b.calendarColor,
      })
      .returning({ id: branches.id })
      .onConflictDoNothing();
    if (created) {
      byKey.set(b.key, created.id);
      count('branch');
      continue;
    }
    const [retry] = await db
      .insert(branches)
      .values({
        tenantId,
        operatorId,
        name: b.name,
        address: b.address,
        timezone: b.timezone,
        logoUrl: b.logoUrl,
        googleDriveFolderName: b.googleDriveFolderName,
      })
      .returning({ id: branches.id });
    byKey.set(b.key, retry!.id);
    count('branch (without its calendar colour)');
  }
  return byKey;
}

async function ensureDepartments(
  tenantId: string,
  branchIds: Map<string, string>,
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  for (const d of DEPARTMENTS) {
    const [existing] = await db
      .select({ id: departments.id, description: departments.description })
      .from(departments)
      .where(and(eq(departments.tenantId, tenantId), eq(departments.name, d.name)))
      .limit(1);
    let id: string;
    if (existing) {
      id = existing.id;
      if (!existing.description && d.description) {
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
          displayOrder: d.displayOrder,
          isActive: d.isActive,
        })
        .returning({ id: departments.id });
      id = created!.id;
      count('department');
    }
    byKey.set(d.key, id);

    for (const bk of d.branchKeys) {
      const branchId = branchIds.get(bk);
      if (!branchId) continue;
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
      if (link) continue;
      await db.insert(departmentBranchAssignments).values({ departmentId: id, branchId });
      count('department-branch link');
    }
  }
  return byKey;
}

async function ensureRoles(
  tenantId: string,
  branchIds: Map<string, string>,
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
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
      if (!existing.description && r.description) {
        await db.update(roles).set({ description: r.description }).where(eq(roles.id, id));
        count('role.description backfilled');
      }
    } else {
      const [created] = await db
        .insert(roles)
        .values({ tenantId, name: r.name, description: r.description, isActive: r.isActive })
        .returning({ id: roles.id });
      id = created!.id;
      count('role');
    }
    byKey.set(r.key, id);

    /**
     * Without this the Roles screen is empty even with twelve roles in the
     * table: it filters the list by the branch chosen in the header, and a
     * role with no row here belongs to no branch, so it is filtered out of
     * every branch.
     */
    for (const bk of r.branchKeys) {
      const branchId = branchIds.get(bk);
      if (!branchId) continue;
      const [link] = await db
        .select({ id: roleBranchAssignments.id })
        .from(roleBranchAssignments)
        .where(
          and(
            eq(roleBranchAssignments.roleId, id),
            eq(roleBranchAssignments.branchId, branchId),
          ),
        )
        .limit(1);
      if (link) continue;
      await db.insert(roleBranchAssignments).values({ roleId: id, branchId });
      count('role-branch link');
    }
  }
  return byKey;
}

/**
 * Find a person this seed wrote under the older sample's address.
 *
 * An earlier cut rewrote every address onto `sample.oto.test`, and the address
 * is the seed's key for an employee. Changing the key without looking for the
 * old one would not update those rows — it would write the whole staff list a
 * second time beside itself, because `employees.email` has no unique
 * constraint to stop it.
 *
 * So: look for the legacy address, and adopt the row only if its address is
 * still *exactly* what the old seed wrote. Somebody who corrected an address by
 * hand has a value that matches neither key, and their row is left alone rather
 * than quietly overwritten — which is the rule everywhere else in this file.
 */
async function adoptLegacyEmail(
  tenantId: string,
  email: string,
): Promise<{ id: string; branchId: string | null; primaryDepartmentId: string | null } | null> {
  const legacy = `${email.split('@')[0]}@${LEGACY_SAMPLE_EMAIL_DOMAIN}`;
  if (legacy === email) return null;
  const [row] = await db
    .select({
      id: employees.id,
      branchId: employees.branchId,
      primaryDepartmentId: employees.primaryDepartmentId,
    })
    .from(employees)
    .where(and(eq(employees.tenantId, tenantId), eq(employees.email, legacy)))
    .limit(1);
  if (!row) return null;
  await db.update(employees).set({ email }).where(eq(employees.id, row.id));
  count('employee address restored from the sampled domain');
  return row;
}

async function ensureEmployees(
  tenantId: string,
  branchIds: Map<string, string>,
  deptIds: Map<string, string>,
  roleIds: Map<string, string>,
): Promise<Map<string, string>> {
  const byKey = new Map<string, string>();
  for (const p of PEOPLE) {
    const email = p.email;
    const branchId = p.branchKey ? (branchIds.get(p.branchKey) ?? null) : null;
    const departmentId = deptIds.get(p.deptKey) ?? null;

    const [found] = await db
      .select({
        id: employees.id,
        branchId: employees.branchId,
        primaryDepartmentId: employees.primaryDepartmentId,
      })
      .from(employees)
      .where(and(eq(employees.tenantId, tenantId), eq(employees.email, email)))
      .limit(1);
    const existing = found ?? (await adoptLegacyEmail(tenantId, email));

    let id: string;
    if (existing) {
      id = existing.id;
      /**
       * The only two columns a re-run touches. Both are structural — an
       * employee with no branch is invisible on every branch-scoped screen,
       * and one with no department cannot be scheduled — and both are only
       * written when they are NULL, so somebody who moved a person to another
       * department keeps that move.
       */
      const backfill: { branchId?: string; primaryDepartmentId?: string } = {};
      if (!existing.branchId && branchId) backfill.branchId = branchId;
      if (!existing.primaryDepartmentId && departmentId) {
        backfill.primaryDepartmentId = departmentId;
      }
      if (Object.keys(backfill).length > 0) {
        await db.update(employees).set(backfill).where(eq(employees.id, id));
        count('employee backfilled');
      }
    } else {
      const [created] = await db
        .insert(employees)
        .values({
          tenantId,
          fullName: p.fullName,
          thaiName: p.thaiName,
          nickname: p.nickname,
          email,
          /**
           * The export's phone numbers, exactly as they are: `0955551234`,
           * `66955551234`, `+66 95 555 1234`, one `+44`. They are not tidied
           * here. That mess is the real input `script/backfill-phone-numbers.ts`
           * has to cope with, and a seed that normalised it first would leave
           * that script with nothing to prove.
           */
          phone: p.phone,
          // NULL in the export for all sixty-nine, so NULL here. The backfill
          // above is what fills it.
          phoneE164: p.phoneE164,
          address: p.address,
          branchId,
          primaryDepartmentId: departmentId,
          status: p.status as typeof employees.$inferInsert.status,
          employmentState: p.employmentState as typeof employees.$inferInsert.employmentState,
          employmentBasis: p.employmentBasis as typeof employees.$inferInsert.employmentBasis,
          dailyRate: p.dailyRate,
          foodAllowancePerDay: p.foodAllowancePerDay,
          incentiveClauseText: p.incentiveClauseText,
          createdAt: at(p.createdAt) ?? undefined,
          startDate: at(p.startDate),
          probationDays: p.probationDays,
          probationEndDate: at(p.probationEndDate),
          probationReviewCompletedAt: at(p.probationReviewCompletedAt),
          noticeDate: at(p.noticeDate),
          lastWorkingDay: at(p.lastWorkingDay),
          endReason: p.endReason,
          offboardingType: p.offboardingType as typeof employees.$inferInsert.offboardingType,
          resignationFormPath: p.resignationFormPath,
          terminationLetterPath: p.terminationLetterPath,
          nationality: p.nationality,
          isForeignStaff: p.isForeignStaff,
          visaExpiryDate: at(p.visaExpiryDate),
          workPermitExpiryDate: at(p.workPermitExpiryDate),
          ssoNumber: p.ssoNumber,
          taxIdNumber: p.taxIdNumber,
          visaWpCompanyHandles: p.visaWpCompanyHandles,
          visaWpCompanyPays: p.visaWpCompanyPays,
          visaWpCostThb: p.visaWpCostThb,
          visaWpRepaymentIfFailProbation: p.visaWpRepaymentIfFailProbation,
          visaWpRepaymentIfLeaveBefore1y: p.visaWpRepaymentIfLeaveBefore1y,
          visaWpRepaymentTermsText: p.visaWpRepaymentTermsText,
          visaWpNotes: p.visaWpNotes,
          jobDescription: p.jobDescription,
          /**
           * NO face enrolment is carried, whatever the export says.
           *
           * An earlier version of this comment claimed an enrolled record was
           * harmless here because the face id points into a collection this
           * deployment does not have, so a face clock-in "would fail". That
           * was measured false: with USE_AWS_REKOGNITION unset — the default,
           * and what staging runs — the mock matcher returns the FIRST
           * ENROLLED EMPLOYEE for any face at all. Random bytes as a face came
           * back as a named person. So with real rows and an enrolled status,
           * anyone at a provisioned kiosk is clocked in as, and shown the name
           * of, whoever sorts first in that park.
           *
           * Leaving everybody unenrolled is what makes the real rows safe to
           * load. The phone and PIN paths, which check a credential and a
           * named person, are the ones a kiosk uses on this deployment.
           */
          faceEnrollmentStatus: null,
          faceId: null,
          faceEnrolledAt: null,
          // The policy flag, not the PIN. No PIN hash is carried.
          timeclockPinRequired: p.timeclockPinRequired,
          phoneFallbackCount30Day: p.phoneFallbackCount30Day,
          phoneFallbackCountResetAt: at(p.phoneFallbackCountResetAt),
          pinUsageCount30Day: p.pinUsageCount30Day,
          pinUsageCountResetAt: at(p.pinUsageCountResetAt),
          /**
           * The real path, `/api/files/profile-photos/…`. The object lives in
           * the park's storage, so on a deployment without it the route 404s
           * and `EmployeeAvatar` shows initials — it preloads the image and
           * only renders it on success, so no screen shows a broken image.
           */
          profilePhotoPath: p.profilePhotoPath,
          profilePhotoCapturedAt: at(p.profilePhotoCapturedAt),
          profilePhotoSource:
            p.profilePhotoSource as typeof employees.$inferInsert.profilePhotoSource,
          weeklyOffDays: p.weeklyOffDays,
          displayOrder: p.displayOrder,
          // The Employees list reads its Position column out of this jsonb
          // (`employees-page.tsx`, `defaultMergeData?.positionTitle`) rather
          // than from the roles, so without it every row shows a dash even
          // with roles assigned.
          defaultMergeData:
            (p.defaultMergeData as typeof employees.$inferInsert.defaultMergeData) ?? undefined,
        })
        .returning({ id: employees.id });
      id = created!.id;
      count('employee');
    }

    for (const roleKey of p.roleKeys) {
      const roleId = roleIds.get(roleKey);
      if (!roleId) continue;
      const [link] = await db
        .select({ id: employeeRoles.id })
        .from(employeeRoles)
        .where(and(eq(employeeRoles.employeeId, id), eq(employeeRoles.roleId, roleId)))
        .limit(1);
      if (link) continue;
      // `is_primary` is false and `proficiency_level` NULL on all 101 rows in
      // the export, so both are left at their defaults rather than guessed.
      await db.insert(employeeRoles).values({ employeeId: id, roleId });
      count('employee role');
    }

    byKey.set(p.key, id);
  }
  return byKey;
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

async function ensureAnnouncements(
  tenantId: string,
  branchIds: Map<string, string>,
): Promise<void> {
  const all = [
    ...ANNOUNCEMENTS.map((a) => ({
      title: a.title,
      body: a.body,
      priority: a.priority as typeof announcements.$inferInsert.priority,
      startDate: new Date(a.startDate),
      endDate: new Date(a.endDate),
      showToEveryone: a.showToEveryone,
      isActive: a.isActive,
      branchIds: a.branchKeys
        .map((k) => branchIds.get(k))
        .filter((id): id is string => Boolean(id)),
    })),
    (() => {
      const start = new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + SAMPLE_BANNER.days);
      return {
        title: SAMPLE_BANNER.title,
        body: SAMPLE_BANNER.body,
        priority: SAMPLE_BANNER.priority as typeof announcements.$inferInsert.priority,
        startDate: start,
        endDate: end,
        showToEveryone: true,
        isActive: true,
        branchIds: [...branchIds.values()],
      };
    })(),
  ];

  for (const a of all) {
    const [existing] = await db
      .select({ id: announcements.id })
      .from(announcements)
      .where(and(eq(announcements.tenantId, tenantId), eq(announcements.title, a.title)))
      .limit(1);
    if (existing) continue;
    await db.insert(announcements).values({ tenantId, ...a });
    count('announcement');
  }
}

/**
 * The sampled task board.
 *
 * Parents before children: a recurring task in the export is a definition row
 * with up to thirty-four generated instances hanging off it, and the instance
 * carries its parent's id. Ids are minted by the database here, so the parent
 * has to be inserted and its new id learned before a child can point at it.
 * `extract.ts` samples whole families for the same reason — a child whose
 * parent was not sampled would point at nothing.
 */
async function ensureTasks(
  tenantId: string,
  branchIds: Map<string, string>,
  deptIds: Map<string, string>,
  staffIds: Map<string, string>,
  roleIds: Map<string, string>,
  adminUserIds: string[],
): Promise<void> {
  const ordered = [...TASKS].sort(
    (a, b) => Number(Boolean(a.parentKey)) - Number(Boolean(b.parentKey)),
  );

  // The two oldest live tasks, so the Today panel has something in it for an
  // administrator who has no employee record. See TASKS_OWNED_BY_ADMIN.
  const ownedByAdmin = new Set(
    TASKS.filter((t) => t.status !== 'completed')
      .sort((a, b) => (a.dueAt ?? '').localeCompare(b.dueAt ?? ''))
      .slice(0, TASKS_OWNED_BY_ADMIN)
      .map((t) => t.key),
  );

  const idByKey = new Map<string, string>();
  for (const t of ordered) {
    /**
     * The title alone is not a key. A weekly task in the export is one
     * definition and thirty-odd generated instances that all carry the same
     * title and differ only by date — keying on the title collapsed
     * forty-nine sampled rows to thirty-five on the first run here. The due
     * and start times separate them; `extract.ts` asserts that the three
     * together are unique across whatever it samples, so a future cut cannot
     * quietly reintroduce this.
     */
    const dueAt = at(t.dueAt);
    const startAt = at(t.startAt);
    const [existing] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(
        and(
          eq(tasks.tenantId, tenantId),
          eq(tasks.title, t.title),
          dueAt ? eq(tasks.dueAt, dueAt) : isNull(tasks.dueAt),
          startAt ? eq(tasks.startAt, startAt) : isNull(tasks.startAt),
        ),
      )
      .limit(1);
    if (existing) {
      idByKey.set(t.key, existing.id);
      continue;
    }
    const [created] = await db
      .insert(tasks)
      .values({
        tenantId,
        branchId: t.branchKey ? (branchIds.get(t.branchKey) ?? null) : null,
        departmentId: t.deptKey ? (deptIds.get(t.deptKey) ?? null) : null,
        parentTaskId: t.parentKey ? (idByKey.get(t.parentKey) ?? null) : null,
        title: t.title,
        description: t.description,
        status: t.status as typeof tasks.$inferInsert.status,
        priority: t.priority as typeof tasks.$inferInsert.priority,
        recurrence: t.recurrence as typeof tasks.$inferInsert.recurrence,
        weeklyDays: t.weeklyDays,
        monthlyDay: t.monthlyDay,
        preferredDueTime: t.preferredDueTime,
        isRecurringDefinition: t.isRecurringDefinition,
        dueAt,
        startAt,
        scheduledMode: t.scheduledMode,
        progressPercent: t.progressPercent,
        statusManualOverride: t.statusManualOverride,
        blockedReason: t.blockedReason,
        completedAt: at(t.completedAt),
        assignedEmployeeId: t.assigneeKey ? (staffIds.get(t.assigneeKey) ?? null) : null,
        assignedDepartmentId: t.assignedDeptKey ? (deptIds.get(t.assignedDeptKey) ?? null) : null,
        assignedRoleId: t.assignedRoleKey ? (roleIds.get(t.assignedRoleKey) ?? null) : null,
        assignedTo: ownedByAdmin.has(t.key) ? (adminUserIds[0] ?? null) : null,
        taskLevel: t.taskLevel as typeof tasks.$inferInsert.taskLevel,
        requiresPhotoEvidence: t.requiresPhotoEvidence,
        requiresResponses: t.requiresResponses,
        referencePhotoUrl: t.referencePhotoUrl,
        escalated: t.escalated,
        /**
         * Carried, not defaulted. `lastMovementAt` defaults to now, and the
         * board ages a task by it — left to the default, every sampled task
         * would read as touched on the day the seed ran.
         */
        lastMovementAt: at(t.lastMovementAt),
        archivedAt: at(t.archivedAt),
        generatedForDate: t.generatedForDate,
        createdAt: at(t.createdAt) ?? undefined,
      })
      .returning({ id: tasks.id });
    idByKey.set(t.key, created!.id);
    count('task');
  }
}

/**
 * The sampled clock-ins, for the Time & Attendance screens.
 *
 * Matched on the employee and the exact timestamp, which is what makes a
 * second run a no-op: the export's times are fixed values, so the row written
 * last time is found rather than written again a minute away from itself.
 */
async function ensureTimeEvents(
  tenantId: string,
  branchIds: Map<string, string>,
  staffIds: Map<string, string>,
): Promise<void> {
  const ids = [...staffIds.values()];
  if (ids.length === 0 || TIME_EVENTS.length === 0) return;

  const since = new Date(
    TIME_EVENTS.reduce((min, e) => (e[3] < min ? e[3] : min), TIME_EVENTS[0]![3]),
  );
  /**
   * The event type is part of the key, not decoration. The export holds two
   * cases of one person having an IN and an OUT recorded at the same second —
   * a clock-out and a clock-in that landed together, or an admin correction —
   * and a key of employee-and-time alone would treat the second of the pair as
   * already present and drop it for good.
   */
  const already = await db
    .select({
      employeeId: timeEvents.employeeId,
      eventTime: timeEvents.eventTime,
      eventType: timeEvents.eventType,
    })
    .from(timeEvents)
    .where(and(inArray(timeEvents.employeeId, ids), sql`${timeEvents.eventTime} >= ${since}`));
  const seen = new Set(
    already.map((r) => `${r.employeeId}@${r.eventTime.toISOString()}#${r.eventType}`),
  );

  const rows: (typeof timeEvents.$inferInsert)[] = [];
  for (const [
    personKey,
    branchKey,
    eventType,
    atIso,
    authMethod,
    confidence,
    liveness,
    notes,
  ] of TIME_EVENTS) {
    const employeeId = staffIds.get(personKey);
    const branchId = branchIds.get(branchKey);
    if (!employeeId || !branchId) continue;
    const when = new Date(atIso);
    if (seen.has(`${employeeId}@${when.toISOString()}#${eventType}`)) continue;
    rows.push({
      tenantId,
      employeeId,
      branchId,
      eventType: eventType as typeof timeEvents.$inferInsert.eventType,
      eventTime: when,
      authMethod: authMethod as typeof timeEvents.$inferInsert.authMethod,
      confidenceScore: confidence,
      livenessScore: liveness,
      // The line the attendance screen shows against a correction. Without it
      // an admin override is indistinguishable from an ordinary clock-in.
      notes,
    });
  }

  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(timeEvents).values(rows.slice(i, i + 200));
  }
  if (rows.length > 0) count('time event', rows.length);
}

async function main(): Promise<void> {
  const tenantId = await ensureTenant();
  const operatorId = await ensureOperator(tenantId);
  const branchIds = await ensureBranches(tenantId, operatorId);
  const deptIds = await ensureDepartments(tenantId, branchIds);
  const roleIds = await ensureRoles(tenantId, branchIds);
  const staffIds = await ensureEmployees(tenantId, branchIds, deptIds, roleIds);
  const adminUserIds = await backfillAdminBranchAccess(tenantId);
  await ensureAnnouncements(tenantId, branchIds);
  await ensureTasks(tenantId, branchIds, deptIds, staffIds, roleIds, adminUserIds);
  await ensureTimeEvents(tenantId, branchIds, staffIds);

  const written = Object.entries(made).filter(([, n]) => n > 0);
  if (written.length === 0) {
    console.log('[sample] Everything was already there; nothing written.');
  } else {
    console.log('[sample] Written:');
    for (const [what, n] of written) console.log(`  ${n} × ${what}`);
  }
  const staff = SAMPLE_COUNTS.employees;
  console.log(
    `[sample] These are the park's own rows — ${staff?.sample ?? PEOPLE.length} of its ` +
      `${staff?.export ?? '?'} staff and the work that belongs to them, carried as they ` +
      `are. Nobody here can sign in: no password, no PIN, no kiosk registration and no ` +
      `link to an account was copied.`,
  );
  /**
   * Said out loud, because it is the one thing about this data that looks like
   * a fault and is not: the clock-ins stop on the day the export was taken.
   */
  const last = TIME_EVENTS.reduce((max, e) => (e[3] > max ? e[3] : max), TIME_EVENTS[0]?.[3] ?? '');
  if (last) {
    console.log(
      `[sample] The clock-ins run to ${last.slice(0, 10)} — a screen showing today will ` +
        `be empty until somebody clocks in. Move the date back to see them.`,
    );
  }
}

main()
  .then(() => pool.end())
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
    return pool.end();
  });
