import { and, asc, desc, eq, inArray, isNull, like, ne, or, sql } from 'drizzle-orm';
import {
  account,
  auditLog,
  boothDutyAssignment,
  boothDutySync,
  boothSettings,
  branch,
  employee,
  findAppBranchForCore,
  otoAppScheduleInstalled,
  otoappCasualWorkers,
  otoappDepartments,
  otoappDutyBlocks,
  otoappDutyTypes,
  otoappEmployees,
  otoappRoles,
  otoappScheduleAssignments,
  otoappScheduleShiftRowRoles,
  otoappScheduleShiftRows,
  otoappShiftGroups,
  station,
  type BoothDutySource,
  type Db,
} from '@oto/db';
import {
  boothDutyLabel,
  businessDate,
  newId,
  parseDayStart,
  type BoothDutyRoster,
} from '@oto/shared';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import type { BoothStationRow } from './booth';
import { isBranchStaff } from './booth-admin';
import { listAppEmployeesByIds, otoAppEmployeesInstalled } from './otoapp-employees';
import { OtoAppSeamNotGrantedError } from './otoapp-events';
import { withTx, type Exec, type OpContext } from './tx';

/**
 * The day's booth staff (SCRUM-473, plan decisions D4-D6 in
 * `docs/progress/plans/booth/TEMPLATES_AND_DUTY_PLAN.md`).
 *
 * **What this is.** The OTO App's scheduling already says who works the booth
 * on a given day: a shift assignment in the "Sale Booth" shift group, or a duty
 * block named "Sales booth". This file reads that — through the narrow
 * re-declaration in `packages/db/src/schema/otoapp.ts`, the same seam
 * `oto-app-users.ts` uses, and ONLY reads it: the rota is the staff app's and
 * nothing here writes to it — and writes the booth's dated roster,
 * `booth.booth_duty_assignment`, which the box receives beside `allowedStaff`
 * and prints as one merged label on every voucher that day ("Tom and Jerry").
 *
 * **The match rule** is per booth, on `booth_settings`, and its defaults are
 * the recommended rule: a shift row whose group, department or one of whose
 * roles contains `duty_group_text` ("Sale Booth"), and a duty block whose name
 * contains `duty_match_text` ("booth"). Both are compared normalised — trimmed,
 * inner whitespace collapsed, case-folded — because the real rows carry
 * "Sales booth " with a trailing space and nobody is going to tidy the app's
 * data for us.
 *
 * **Who ends up on the roster, and who does not:**
 *
 *   - an employee the app's own rule links to a platform account of this
 *     operator — named, and may sign in that day. The account is read from
 *     `otoapp_v.employees` through the employee repository, the column the
 *     employee copy reads too (S2-17b round 2): `user_id` first, else the
 *     app's email match;
 *   - a casual worker — named on the slip, never signs in (no account ever);
 *   - an employee with no app user, or a user with no linked account — NOT on
 *     the roster, and listed by name as unmatched in the sync's own record and
 *     in its answer. Never silently dropped (D5): somebody has to link them.
 *
 * **Idempotent by construction.** A sync compares what the app says with what
 * the roster already holds and writes only the difference: a new person is
 * inserted and audited `booth_duty.assign`, a person the app no longer names is
 * deleted and audited `booth_duty.unassign`, and a re-run with nothing changed
 * writes no roster row and no audit row — not even its own `booth_duty.sync`
 * line or the day's sync record, which are written only by the day's first
 * sync and by a sync that changed the roster, the app state or the unmatched
 * list. Rows people made — `manual` and
 * `self_assigned` — belong to people, and a sync never removes them. When the
 * app cannot be read at all (not installed on this deployment, the branch not
 * mapped into it), the sync removes nothing: an unreadable rota is not an
 * empty one.
 *
 * **And under a race.** Two syncs of the same booth's day at once — "Sync now"
 * pressed twice, or beside the morning job — are serialised by an advisory
 * lock taken as the transaction's first statement, so the second reads what
 * the first committed instead of the roster both started from. Independently
 * of the lock, every write a log line answers for is `.returning()`-guarded:
 * the delete, the rename (filtered on the name actually differing) and the
 * day's sync record are counted and audited only for a row that came back. An
 * audit line therefore never describes a row another sync had already changed
 * — neither remedy is carrying the other.
 */

// --- The rule -----------------------------------------------------------------

export const BOOTH_DUTY_GROUP_TEXT_DEFAULT = 'Sale Booth';
export const BOOTH_DUTY_MATCH_TEXT_DEFAULT = 'booth';
export const BOOTH_DUTY_RULE_MAX_CHARS = 100;
export const BOOTH_DUTY_NAME_MAX_CHARS = 100;

export interface BoothDutyRule {
  /** Matched inside a shift row's group, department or role name. */
  groupText: string;
  /** Matched inside a duty block's name. */
  dutyText: string;
}

/** "  Sales   booth " → "sales booth". The one normalisation both sides get. */
export function normaliseDutyText(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').toLowerCase() : '';
}

/** Whether `candidate` contains `rule`, both normalised. An empty rule matches nothing. */
export function dutyTextMatches(candidate: string | null | undefined, rule: string): boolean {
  const needle = normaliseDutyText(rule);
  if (needle === '') return false;
  return normaliseDutyText(candidate).includes(needle);
}

// --- The matcher, over rows shaped as the app's --------------------------------

/** One schedule assignment on the day, with the names its shift row sits under. */
export interface AppAssignmentRow {
  assigneeType: string;
  employeeId: string | null;
  casualWorkerId: string | null;
  groupName: string | null;
  departmentName: string | null;
  /** The shift row's roles, and the assignment's own role when it names one. */
  roleNames: string[];
}

export interface AppDutyBlockRow {
  employeeId: string;
  dutyName: string | null;
  /** The duty type's name — used when the block names nothing of its own. */
  dutyTypeName: string | null;
}

export interface AppEmployeeRow {
  id: string;
  fullName: string;
  nickname: string;
  /** `otoapp.users.id`, or null for somebody never given a login. */
  userId: string | null;
  /**
   * The platform account the app's own rule links to this employee —
   * `otoapp_v.employees.platform_user_id`, the column the employee copy reads
   * too (S2-17b round 2, H24): its `user_id` first, else its email match.
   */
  platformUserId: string | null;
}

export interface AppCasualRow {
  id: string;
  fullName: string;
  nickname: string;
}

export type BoothDutyUnmatchedReason = 'no_app_user' | 'no_platform_account';

export interface BoothDutyUnmatched {
  name: string;
  reason: BoothDutyUnmatchedReason;
}

export interface BoothDutyPerson {
  accountId: string | null;
  /**
   * The app's casual worker id, for a casual. A casual is keyed by it, not by
   * the name: two different casuals called "Nok" are two people on the roster.
   */
  casualWorkerId: string | null;
  displayName: string;
  source: Extract<BoothDutySource, 'app_schedule' | 'app_duty_block'>;
}

/** The nickname the slip prints, or the full name when the nickname is blank. */
function nameOf(person: { nickname: string; fullName: string }): string {
  const name = person.nickname.trim() || person.fullName.trim();
  return name.slice(0, BOOTH_DUTY_NAME_MAX_CHARS);
}

/**
 * Who the app puts on this booth, from rows already read — no database here,
 * so the rule is testable over real-shaped rows.
 *
 * `ourAccounts` is the set of platform account ids that are this operator's:
 * a `platform_user_id` naming anything else is treated as no link at all, so a
 * stray id in the app can never put somebody else's account on a booth.
 *
 * Assignments are taken first and duty blocks second, so a person with both is
 * on the roster once, under `app_schedule`.
 */
export function matchBoothDuty(input: {
  rule: BoothDutyRule;
  assignments: readonly AppAssignmentRow[];
  dutyBlocks: readonly AppDutyBlockRow[];
  employees: ReadonlyMap<string, AppEmployeeRow>;
  casuals: ReadonlyMap<string, AppCasualRow>;
  ourAccounts: ReadonlySet<string>;
}): { people: BoothDutyPerson[]; unmatched: BoothDutyUnmatched[] } {
  const people: BoothDutyPerson[] = [];
  const unmatched: BoothDutyUnmatched[] = [];
  const seenPeople = new Set<string>();
  const seenUnmatched = new Set<string>();

  const takeEmployee = (employeeId: string, source: BoothDutyPerson['source']): void => {
    const emp = input.employees.get(employeeId);
    if (!emp) return;
    const name = nameOf(emp);
    if (name === '') return;
    const accountId =
      emp.platformUserId && input.ourAccounts.has(emp.platformUserId) ? emp.platformUserId : null;
    if (!accountId) {
      if (seenUnmatched.has(employeeId)) return;
      seenUnmatched.add(employeeId);
      unmatched.push({ name, reason: emp.userId ? 'no_platform_account' : 'no_app_user' });
      return;
    }
    if (seenPeople.has(accountId)) return;
    seenPeople.add(accountId);
    people.push({ accountId, casualWorkerId: null, displayName: name, source });
  };

  for (const a of input.assignments) {
    const matches =
      dutyTextMatches(a.groupName, input.rule.groupText) ||
      dutyTextMatches(a.departmentName, input.rule.groupText) ||
      a.roleNames.some((r) => dutyTextMatches(r, input.rule.groupText));
    if (!matches) continue;
    if (a.assigneeType === 'casual') {
      const casual = a.casualWorkerId ? input.casuals.get(a.casualWorkerId) : undefined;
      if (!casual) continue;
      const name = nameOf(casual);
      // Keyed by the casual's own id: nicknames repeat (two "Nok"s on one
      // shift is ordinary), and folding them by name would drop a person.
      const key = `casual:${casual.id}`;
      if (name === '' || seenPeople.has(key)) continue;
      seenPeople.add(key);
      people.push({ accountId: null, casualWorkerId: casual.id, displayName: name, source: 'app_schedule' });
      continue;
    }
    if (a.employeeId) takeEmployee(a.employeeId, 'app_schedule');
  }

  for (const b of input.dutyBlocks) {
    const label = b.dutyName && b.dutyName.trim() !== '' ? b.dutyName : b.dutyTypeName;
    if (!dutyTextMatches(label, input.rule.dutyText)) continue;
    takeEmployee(b.employeeId, 'app_duty_block');
  }

  return { people, unmatched };
}

// --- Reading the app ----------------------------------------------------------

export type BoothDutyAppState = 'ok' | 'app_not_installed' | 'no_app_branch' | 'ambiguous_app_branch';

interface AppRead {
  state: BoothDutyAppState;
  assignments: AppAssignmentRow[];
  dutyBlocks: AppDutyBlockRow[];
  employees: Map<string, AppEmployeeRow>;
  casuals: Map<string, AppCasualRow>;
}

const emptyRead = (state: BoothDutyAppState): AppRead => ({
  state,
  assignments: [],
  dutyBlocks: [],
  employees: new Map(),
  casuals: new Map(),
});

/**
 * The app's rows for one platform branch on one date. Read-only: every
 * statement here is a SELECT against `otoapp.*`.
 */
async function readAppDuty(
  exec: Exec,
  input: { operatorId: string; branchId: string; branchName: string; date: string },
): Promise<AppRead> {
  if (!(await otoAppScheduleInstalled(exec))) return emptyRead('app_not_installed');
  // Without the employee view nobody on the rota can be told apart from
  // anybody else: an app whose migrator has not reached 0005 is not read at
  // all, and an unreadable rota removes nobody (see the note at the top).
  if (!(await employeeSeamReadable(exec))) return emptyRead('app_not_installed');
  const appBranch = await findAppBranchForCore(exec, {
    operatorId: input.operatorId,
    coreBranchId: input.branchId,
    name: input.branchName,
  });
  if (appBranch === null) return emptyRead('no_app_branch');
  if (appBranch === 'ambiguous') return emptyRead('ambiguous_app_branch');

  const assignmentRows = await exec
    .select({
      assigneeType: otoappScheduleAssignments.assigneeType,
      employeeId: otoappScheduleAssignments.employeeId,
      casualWorkerId: otoappScheduleAssignments.casualWorkerId,
      shiftRowId: otoappScheduleAssignments.shiftRowId,
      ownRoleName: otoappRoles.name,
      groupName: otoappShiftGroups.name,
      departmentName: otoappDepartments.name,
    })
    .from(otoappScheduleAssignments)
    .innerJoin(otoappScheduleShiftRows, eq(otoappScheduleShiftRows.id, otoappScheduleAssignments.shiftRowId))
    .leftJoin(otoappShiftGroups, eq(otoappShiftGroups.id, otoappScheduleShiftRows.shiftGroupId))
    .leftJoin(otoappDepartments, eq(otoappDepartments.id, otoappScheduleShiftRows.departmentId))
    .leftJoin(otoappRoles, eq(otoappRoles.id, otoappScheduleAssignments.roleId))
    .where(
      and(
        eq(otoappScheduleShiftRows.branchId, appBranch.id),
        eq(otoappScheduleAssignments.shiftDate, input.date),
      ),
    )
    .orderBy(asc(otoappScheduleAssignments.id));

  const shiftRowIds = [...new Set(assignmentRows.map((r) => r.shiftRowId))];
  const rowRoles = shiftRowIds.length
    ? await exec
        .select({ shiftRowId: otoappScheduleShiftRowRoles.shiftRowId, name: otoappRoles.name })
        .from(otoappScheduleShiftRowRoles)
        .innerJoin(otoappRoles, eq(otoappRoles.id, otoappScheduleShiftRowRoles.roleId))
        .where(inArray(otoappScheduleShiftRowRoles.shiftRowId, shiftRowIds))
    : [];
  const rolesByRow = new Map<string, string[]>();
  for (const r of rowRoles) rolesByRow.set(r.shiftRowId, [...(rolesByRow.get(r.shiftRowId) ?? []), r.name]);

  const dutyBlocks = await exec
    .select({
      employeeId: otoappDutyBlocks.employeeId,
      dutyName: otoappDutyBlocks.dutyName,
      dutyTypeName: otoappDutyTypes.name,
    })
    .from(otoappDutyBlocks)
    .leftJoin(otoappDutyTypes, eq(otoappDutyTypes.id, otoappDutyBlocks.dutyTypeId))
    .where(and(eq(otoappDutyBlocks.branchId, appBranch.id), eq(otoappDutyBlocks.date, input.date)))
    .orderBy(asc(otoappDutyBlocks.id));

  const employeeIds = [
    ...new Set([
      ...assignmentRows.flatMap((r) => (r.employeeId ? [r.employeeId] : [])),
      ...dutyBlocks.map((b) => b.employeeId),
    ]),
  ];
  const casualIds = [...new Set(assignmentRows.flatMap((r) => (r.casualWorkerId ? [r.casualWorkerId] : [])))];

  /**
   * WHO each person is — their names and the platform account they sign in as
   * — through the employee repository (S2-17b round 2, H24): the same column,
   * the same rule, the employee copy reads, so the roster and the copy can
   * never name two accounts for one person. Only whether the app ever gave the
   * person a login of their own (`user_id`) is still read from the table, for
   * the reason an unmatched name is listed under.
   */
  const seen = employeeIds.length ? await listAppEmployeesByIds(exec, employeeIds) : [];
  const logins = employeeIds.length
    ? new Map(
        (
          await exec
            .select({ id: otoappEmployees.id, userId: otoappEmployees.userId })
            .from(otoappEmployees)
            .where(inArray(otoappEmployees.id, employeeIds))
        ).map((e) => [e.id, e.userId]),
      )
    : new Map<string, string | null>();
  const employees: AppEmployeeRow[] = seen.map((e) => ({
    id: e.id,
    fullName: e.fullName,
    nickname: e.nickname,
    userId: logins.get(e.id) ?? null,
    platformUserId: e.platformUserId,
  }));
  const casuals = casualIds.length
    ? await exec
        .select({
          id: otoappCasualWorkers.id,
          fullName: otoappCasualWorkers.fullName,
          nickname: otoappCasualWorkers.nickname,
        })
        .from(otoappCasualWorkers)
        .where(inArray(otoappCasualWorkers.id, casualIds))
    : [];

  return {
    state: 'ok',
    assignments: assignmentRows.map((r) => ({
      assigneeType: r.assigneeType,
      employeeId: r.employeeId,
      casualWorkerId: r.casualWorkerId,
      groupName: r.groupName,
      departmentName: r.departmentName,
      roleNames: [...(rolesByRow.get(r.shiftRowId) ?? []), ...(r.ownRoleName ? [r.ownRoleName] : [])],
    })),
    dutyBlocks,
    employees: new Map(employees.map((e) => [e.id, e])),
    casuals: new Map(casuals.map((c) => [c.id, c])),
  };
}

/**
 * Is the employee view there to read? A deployment that has it but has not
 * granted this role SELECT on it is a fault to fix, never "nobody is on the
 * booth": answered as a 503 that names the missing grant.
 */
async function employeeSeamReadable(exec: Exec): Promise<boolean> {
  try {
    return await otoAppEmployeesInstalled(exec);
  } catch (err) {
    if (err instanceof OtoAppSeamNotGrantedError) {
      throw new AppError(503, 'EMPLOYEES_SEAM_NOT_GRANTED', err.message, { missing: err.missing });
    }
    throw err;
  }
}

// --- The booth's side -----------------------------------------------------------

/** The rule stored for a booth, or the defaults for a booth nobody has configured. */
export async function loadBoothDutyRule(exec: Exec, stationId: string): Promise<BoothDutyRule> {
  const [row] = await exec
    .select({ groupText: boothSettings.dutyGroupText, dutyText: boothSettings.dutyMatchText })
    .from(boothSettings)
    .where(eq(boothSettings.stationId, stationId))
    .limit(1);
  return row ?? { groupText: BOOTH_DUTY_GROUP_TEXT_DEFAULT, dutyText: BOOTH_DUTY_MATCH_TEXT_DEFAULT };
}

interface BranchClock {
  name: string;
  timezone: string;
  businessDayStart: string;
  openingHours: unknown;
}

async function branchClock(exec: Exec, branchId: string): Promise<BranchClock> {
  const [row] = await exec
    .select({
      name: branch.name,
      timezone: branch.timezone,
      businessDayStart: branch.businessDayStart,
      openingHours: branch.openingHours,
    })
    .from(branch)
    .where(eq(branch.id, branchId))
    .limit(1);
  if (!row) throw new AppError(404, 'BRANCH_NOT_FOUND', 'No branch with that id');
  return row;
}

/** The branch's trading day at `at` — the date a roster is for. */
export async function boothBusinessDate(exec: Exec, branchId: string, at: Date = new Date()): Promise<string> {
  const clock = await branchClock(exec, branchId);
  return businessDate(at, clock.timezone, parseDayStart(clock.businessDayStart));
}

export interface BoothDutyAssignmentView {
  id: string;
  accountId: string | null;
  displayName: string;
  source: BoothDutySource;
  syncedAt: string | null;
  addedByAccountId: string | null;
  createdAt: string;
}

async function rosterRows(exec: Exec, stationId: string, date: string) {
  return exec
    .select()
    .from(boothDutyAssignment)
    .where(and(eq(boothDutyAssignment.stationId, stationId), eq(boothDutyAssignment.businessDate, date)))
    .orderBy(asc(boothDutyAssignment.createdAt), asc(boothDutyAssignment.id));
}

type RosterRow = typeof boothDutyAssignment.$inferSelect;

const viewOf = (r: RosterRow): BoothDutyAssignmentView => ({
  id: r.id,
  accountId: r.accountId,
  displayName: r.displayName,
  source: r.source,
  syncedAt: r.syncedAt?.toISOString() ?? null,
  addedByAccountId: r.addedByAccountId,
  createdAt: r.createdAt.toISOString(),
});

/**
 * The key a person is unique by on one booth's day — the unique index's own
 * expression: the account, else the app's casual worker id, else the name.
 */
const personKey = (p: { accountId: string | null; casualWorkerId: string | null; displayName: string }): string =>
  p.accountId ??
  (p.casualWorkerId ? `casual:${p.casualWorkerId}` : `name:${p.displayName.trim().toLowerCase()}`);

const auditAfter = (row: BoothStationRow, date: string, r: Pick<RosterRow, 'accountId' | 'displayName' | 'source'>) => ({
  stationId: row.stationId,
  businessDate: date,
  accountId: r.accountId,
  displayName: r.displayName,
  source: r.source,
});

export interface BoothDutySyncResult {
  businessDate: string;
  appState: BoothDutyAppState;
  added: number;
  removed: number;
  unmatched: BoothDutyUnmatched[];
  roster: BoothDutyAssignmentView[];
}

/**
 * The advisory lock namespace for one booth's roster on one trading day. Ours,
 * beside the others in this api: `0x070a` the job runner, `0x070b` the QR
 * invoice number, `0x070c` an operator's barcodes, `0x070d` a person's voucher
 * misses, `0x070e` the virtual box lease.
 */
const BOOTH_DUTY_LOCK_NAMESPACE = 0x070f;

/**
 * Sync one booth's roster for one trading day from the app.
 *
 * `actorAccountId` is the person who pressed "Sync now", or null for the
 * morning job. See the note at the top of this file for what is written.
 */
export async function syncBoothDuty(
  db: Db,
  ctx: OpContext,
  input: { row: BoothStationRow; date?: string; actorAccountId: string | null; now?: Date },
): Promise<BoothDutySyncResult> {
  const { row } = input;
  const now = input.now ?? new Date();
  const clock = await branchClock(db, row.branchId);
  const date = input.date ?? businessDate(now, clock.timezone, parseDayStart(clock.businessDayStart));
  const rule = await loadBoothDutyRule(db, row.stationId);

  return withTx(db, ctx, 'booth_duty.sync', async (tx) => {
    /**
     * One sync of this booth's day at a time, until this transaction ends.
     * Without it, two syncs racing after the app drops a person both read the
     * row, both delete it (one deletes nothing) and both log an unassign. The
     * key is the booth and the day, so two booths, or two days of one booth,
     * never wait on each other. The lock is taken BEFORE the app is read: a
     * sync that waited here goes on to read the roster the winner committed.
     */
    await tx.execute(
      sql`select pg_advisory_xact_lock(${BOOTH_DUTY_LOCK_NAMESPACE}::int4, hashtext(${`${row.stationId}:${date}`})::int4)`,
    );

    const read = await readAppDuty(tx, {
      operatorId: row.operatorId,
      branchId: row.branchId,
      branchName: clock.name,
      date,
    });
    const linked = [...read.employees.values()].flatMap((e) => (e.platformUserId ? [e.platformUserId] : []));
    const ours = linked.length
      ? await tx
          .select({ id: account.id })
          .from(account)
          .where(and(inArray(account.id, linked), eq(account.operatorId, row.operatorId)))
      : [];
    const matched = matchBoothDuty({
      rule,
      assignments: read.assignments,
      dutyBlocks: read.dutyBlocks,
      employees: read.employees,
      casuals: read.casuals,
      ourAccounts: new Set(ours.map((a) => a.id)),
    });

    const existing = await rosterRows(tx, row.stationId, date);
    const held = new Map(existing.map((r) => [personKey(r), r]));
    const wanted = new Map(matched.people.map((p) => [personKey(p), p]));
    let added = 0;
    let removed = 0;
    let renamed = 0;

    for (const [key, person] of wanted) {
      const have = held.get(key);
      if (have) {
        // Already on the roster, by any source. A name the app has since
        // changed follows the app on the app's own rows, and only then.
        if (
          (have.source === 'app_schedule' || have.source === 'app_duty_block') &&
          have.displayName !== person.displayName
        ) {
          // Filtered on the row's name actually differing, and counted and
          // logged only for a row that came back: a sync that renamed it
          // first leaves nothing to rename here and nothing to log.
          const renamedRows = await tx
            .update(boothDutyAssignment)
            .set({ displayName: person.displayName, syncedAt: now, updatedAt: now })
            .where(
              and(
                eq(boothDutyAssignment.id, have.id),
                ne(boothDutyAssignment.displayName, person.displayName),
              ),
            )
            .returning({ id: boothDutyAssignment.id });
          if (renamedRows.length === 0) continue;
          renamed += 1;
          await audit.record(tx, {
            actorAccountId: input.actorAccountId,
            operatorId: row.operatorId,
            branchId: row.branchId,
            action: 'booth_duty.rename',
            entityType: 'booth_duty_assignment',
            entityId: have.id,
            before: auditAfter(row, date, have),
            after: auditAfter(row, date, { ...have, displayName: person.displayName }),
            requestId: ctx.requestId ?? null,
          });
        }
        continue;
      }
      const id = newId();
      const inserted = await tx
        .insert(boothDutyAssignment)
        .values({
          id,
          operatorId: row.operatorId,
          branchId: row.branchId,
          stationId: row.stationId,
          businessDate: date,
          accountId: person.accountId,
          casualWorkerId: person.casualWorkerId,
          displayName: person.displayName,
          source: person.source,
          syncedAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: boothDutyAssignment.id });
      if (inserted.length === 0) continue;
      added += 1;
      await audit.record(tx, {
        actorAccountId: input.actorAccountId,
        operatorId: row.operatorId,
        branchId: row.branchId,
        action: 'booth_duty.assign',
        entityType: 'booth_duty_assignment',
        entityId: id,
        after: auditAfter(row, date, person),
        requestId: ctx.requestId ?? null,
      });
    }

    // An unreadable rota is not an empty one: nothing is removed unless the
    // app was actually read.
    if (read.state === 'ok') {
      for (const [key, have] of held) {
        if (have.source !== 'app_schedule' && have.source !== 'app_duty_block') continue;
        if (wanted.has(key)) continue;
        // Counted and logged only for a row this statement actually removed:
        // a row another sync already deleted comes back as nothing, and an
        // unassign line for it would describe a removal that never happened.
        const gone = await tx
          .delete(boothDutyAssignment)
          .where(eq(boothDutyAssignment.id, have.id))
          .returning({ id: boothDutyAssignment.id });
        if (gone.length === 0) continue;
        removed += 1;
        await audit.record(tx, {
          actorAccountId: input.actorAccountId,
          operatorId: row.operatorId,
          branchId: row.branchId,
          action: 'booth_duty.unassign',
          entityType: 'booth_duty_assignment',
          entityId: have.id,
          before: auditAfter(row, date, have),
          requestId: ctx.requestId ?? null,
        });
      }
    }

    /**
     * A re-run that changed nothing writes nothing: no roster row moved, the
     * app reads the same way it did, and the same people are unmatched — so the
     * day's sync row stays as it is and no `booth_duty.sync` line is added.
     * Pressing "Sync now" ten times on a quiet day leaves one line, not ten.
     * The day's FIRST sync always writes (there is no row yet), which is also
     * what tells the morning job the booth is done for the day.
     */
    const [last] = await tx
      .select({ appState: boothDutySync.appState, unmatched: boothDutySync.unmatched })
      .from(boothDutySync)
      .where(and(eq(boothDutySync.stationId, row.stationId), eq(boothDutySync.businessDate, date)))
      .limit(1);
    const unchanged =
      last !== undefined &&
      added === 0 &&
      removed === 0 &&
      renamed === 0 &&
      last.appState === read.state &&
      sameUnmatched(last.unmatched as BoothDutyUnmatched[] | null, matched.unmatched);
    if (unchanged) {
      return {
        businessDate: date,
        appState: read.state,
        added,
        removed,
        unmatched: matched.unmatched,
        roster: existing.map(viewOf),
      };
    }

    /**
     * The day's record is rewritten only when it would actually differ: when
     * the roster moved (the counts above answer for real rows), or when the
     * app state or the unmatched list held in the row is not what this run
     * found. The row that comes back is what the sync line below answers for
     * — a run that got here with nothing to write leaves no line.
     */
    const rosterMoved = added + removed + renamed > 0;
    const written = await tx
      .insert(boothDutySync)
      .values({
        operatorId: row.operatorId,
        branchId: row.branchId,
        stationId: row.stationId,
        businessDate: date,
        syncedAt: now,
        appState: read.state,
        unmatched: matched.unmatched,
        syncedByAccountId: input.actorAccountId,
      })
      .onConflictDoUpdate({
        target: [boothDutySync.stationId, boothDutySync.businessDate],
        set: {
          syncedAt: now,
          appState: read.state,
          unmatched: matched.unmatched,
          syncedByAccountId: input.actorAccountId,
          updatedAt: now,
        },
        ...(rosterMoved
          ? {}
          : {
              setWhere: sql`${boothDutySync.appState} is distinct from ${read.state} or ${boothDutySync.unmatched} <> ${JSON.stringify(matched.unmatched)}::jsonb`,
            }),
      })
      .returning({ stationId: boothDutySync.stationId });

    /**
     * The sync itself is on the record too, once per run that changed
     * something: who pressed it (or the morning job), what the app state was
     * and whom it could not match.
     * Its entity is the booth, so "when was this booth last synced" reads off
     * the booth's own Activity.
     */
    if (written.length > 0) {
      await audit.record(tx, {
        actorAccountId: input.actorAccountId,
        operatorId: row.operatorId,
        branchId: row.branchId,
        action: 'booth_duty.sync',
        entityType: 'station',
        entityId: row.stationId,
        after: {
          stationId: row.stationId,
          businessDate: date,
          appState: read.state,
          added,
          removed,
          renamed,
          unmatched: matched.unmatched,
        },
        requestId: ctx.requestId ?? null,
      });
    }

    return {
      businessDate: date,
      appState: read.state,
      added,
      removed,
      unmatched: matched.unmatched,
      roster: (await rosterRows(tx, row.stationId, date)).map(viewOf),
    };
  });
}

/** Whether two unmatched lists name the same people for the same reasons, in any order. */
function sameUnmatched(a: readonly BoothDutyUnmatched[] | null, b: readonly BoothDutyUnmatched[]): boolean {
  const key = (list: readonly BoothDutyUnmatched[]) =>
    list.map((u) => `${u.reason}|${u.name}`).sort();
  const left = key(a ?? []);
  const right = key(b);
  return left.length === right.length && left.every((k, i) => k === right[i]);
}

// --- People's own rows ----------------------------------------------------------

/** The name a platform account prints: its employee's nickname, or name. */
async function platformNameOf(exec: Exec, accountId: string): Promise<string | null> {
  const [row] = await exec
    .select({ name: employee.name, nickname: employee.nickname })
    .from(account)
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(eq(account.id, accountId))
    .limit(1);
  const name = row?.nickname?.trim() || row?.name?.trim() || '';
  return name === '' ? null : name.slice(0, BOOTH_DUTY_NAME_MAX_CHARS);
}

/**
 * An administrator puts somebody on today's roster by hand (D5.1).
 *
 * Either an account — which must be one of the branch's staff, the rule the
 * standing list keeps (`isBranchStaff`) — or a name alone, which is how a
 * casual the app has not been told about is named on the slip. Audited
 * `booth_duty.assign` with source `manual`. Adding somebody already on the
 * roster is a no-op with no audit row.
 */
export async function addManualBoothDuty(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  row: BoothStationRow,
  input: { accountId?: string | null; displayName?: string | null; date?: string },
): Promise<{ roster: BoothDutyAssignmentView[] }> {
  const date = input.date ?? (await boothBusinessDate(db, row.branchId));
  let accountId: string | null = null;
  let displayName = (input.displayName ?? '').trim();
  if (input.accountId) {
    if (!(await isBranchStaff(db, actor.operatorId, row.branchId, input.accountId))) {
      throw new AppError(
        400,
        'STAFF_NOT_AT_BRANCH',
        'That account is not among this branch’s staff, so it cannot be put on this booth',
        { accountId: input.accountId },
      );
    }
    accountId = input.accountId;
    if (displayName === '') displayName = (await platformNameOf(db, accountId)) ?? '';
  }
  if (displayName === '') {
    throw new AppError(
      400,
      'BOOTH_DUTY_NAME_REQUIRED',
      'A name is needed: it is what the voucher prints',
    );
  }
  displayName = displayName.slice(0, BOOTH_DUTY_NAME_MAX_CHARS);

  await withTx(db, ctx, 'booth_duty.assign', async (tx) => {
    const id = newId();
    const inserted = await tx
      .insert(boothDutyAssignment)
      .values({
        id,
        operatorId: row.operatorId,
        branchId: row.branchId,
        stationId: row.stationId,
        businessDate: date,
        accountId,
        displayName,
        source: 'manual',
        addedByAccountId: actor.accountId,
      })
      .onConflictDoNothing()
      .returning({ id: boothDutyAssignment.id });
    if (inserted.length === 0) return;
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: row.operatorId,
      branchId: row.branchId,
      action: 'booth_duty.assign',
      entityType: 'booth_duty_assignment',
      entityId: id,
      after: auditAfter(row, date, { accountId, displayName, source: 'manual' }),
      requestId: ctx.requestId ?? null,
    });
  });
  return { roster: (await rosterRows(db, row.stationId, date)).map(viewOf) };
}

/**
 * Take somebody off a booth's roster, whatever put them there.
 *
 * A row the app put there comes back at the next sync if the app still names
 * the person — the rota is the staff app's, and the fix for a wrong shift is
 * made there. Audited `booth_duty.unassign`.
 */
export async function removeBoothDuty(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string },
  row: BoothStationRow,
  assignmentId: string,
): Promise<{ roster: BoothDutyAssignmentView[] }> {
  const date = await withTx(db, ctx, 'booth_duty.unassign', async (tx) => {
    const [gone] = await tx
      .delete(boothDutyAssignment)
      .where(and(eq(boothDutyAssignment.id, assignmentId), eq(boothDutyAssignment.stationId, row.stationId)))
      .returning();
    if (!gone) {
      throw new AppError(404, 'BOOTH_DUTY_NOT_FOUND', 'That person is not on this booth’s roster');
    }
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: row.operatorId,
      branchId: row.branchId,
      action: 'booth_duty.unassign',
      entityType: 'booth_duty_assignment',
      entityId: gone.id,
      before: auditAfter(row, gone.businessDate, gone),
      requestId: ctx.requestId ?? null,
    });
    return gone.businessDate;
  });
  return { roster: (await rosterRows(db, row.stationId, date)).map(viewOf) };
}

/**
 * A stand-in joins the day's roster (D5.2): somebody who signed in at the
 * booth through the standing list without being on today's roster.
 *
 * Called from two places, and they are the whole mechanism:
 *
 *   - the staff-verify path (`box-booth-staff.ts`), the moment the platform
 *     lets a phone-and-password sign-in through — so the Console shows the
 *     stand-in at once;
 *   - the spin's arrival (`sync-booth.ts`), for a sign-in the box checked on
 *     its own — a PIN, possibly offline — because the spin names the signed-in
 *     account and its trading day, and the box has printed their name on the
 *     slip by then. No new sync event: the fact that proves the stand-in
 *     worked the booth is the one that already travels.
 *
 * Runs on the caller's executor (a transaction there), inserts nothing when
 * the person is already on the day's roster by any source, and audits
 * `booth_duty.assign` with source `self_assigned` exactly once.
 */
export async function selfAssignBoothDuty(
  exec: Exec,
  input: {
    stationId: string;
    operatorId: string;
    branchId: string;
    businessDate: string;
    accountId: string;
    displayName?: string | null;
    via: 'sign_in' | 'spin';
    requestId?: string | null;
    sourceEventId?: string | null;
  },
): Promise<boolean> {
  const displayName =
    (input.displayName ?? '').trim().slice(0, BOOTH_DUTY_NAME_MAX_CHARS) ||
    (await platformNameOf(exec, input.accountId));
  if (!displayName) return false;
  const id = newId();
  const inserted = await exec
    .insert(boothDutyAssignment)
    .values({
      id,
      operatorId: input.operatorId,
      branchId: input.branchId,
      stationId: input.stationId,
      businessDate: input.businessDate,
      accountId: input.accountId,
      displayName,
      source: 'self_assigned',
    })
    .onConflictDoNothing()
    .returning({ id: boothDutyAssignment.id });
  if (inserted.length === 0) return false;
  await audit.record(exec, {
    actorAccountId: input.accountId,
    operatorId: input.operatorId,
    branchId: input.branchId,
    action: 'booth_duty.assign',
    entityType: 'booth_duty_assignment',
    entityId: id,
    after: {
      stationId: input.stationId,
      businessDate: input.businessDate,
      accountId: input.accountId,
      displayName,
      source: 'self_assigned',
      via: input.via,
    },
    requestId: input.requestId ?? null,
    sourceEventId: input.sourceEventId ?? null,
  });
  return true;
}

/** Whether an account is on a booth's roster for a day — sign-in eligibility's other half. */
export async function isOnBoothDuty(
  exec: Exec,
  stationId: string,
  date: string,
  accountId: string,
): Promise<boolean> {
  const [row] = await exec
    .select({ id: boothDutyAssignment.id })
    .from(boothDutyAssignment)
    .where(
      and(
        eq(boothDutyAssignment.stationId, stationId),
        eq(boothDutyAssignment.businessDate, date),
        eq(boothDutyAssignment.accountId, accountId),
      ),
    )
    .limit(1);
  return row !== undefined;
}

/**
 * The roster as the box receives it: the day, the names, the account ids.
 * Ordered by when each person joined, so the label reads in the same order on
 * every pull and a person added later is said last.
 */
export async function boothDutyRosterForBox(
  exec: Exec,
  stationId: string,
  date: string,
): Promise<BoothDutyRoster> {
  const rows = await rosterRows(exec, stationId, date);
  return {
    date,
    people: rows.map((r) => ({ accountId: r.accountId, displayName: r.displayName })),
  };
}

// --- The Console's view -----------------------------------------------------------

export interface BoothDutyLogLine {
  at: string;
  action: string;
  actorAccountId: string | null;
  detail: Record<string, unknown> | null;
}

export interface BoothDutyView {
  businessDate: string;
  rule: BoothDutyRule;
  roster: BoothDutyAssignmentView[];
  /** What prints on every voucher today when nobody else signs in. Null prints "unattributed". */
  label: string | null;
  lastSync: {
    syncedAt: string;
    appState: BoothDutyAppState;
    unmatched: BoothDutyUnmatched[];
    syncedByAccountId: string | null;
  } | null;
  /** The day's audit rows for this booth's roster, newest first — the log the owner asked for. */
  log: BoothDutyLogLine[];
}

export async function boothDutyView(
  db: Db,
  row: BoothStationRow,
  opts: { date?: string } = {},
): Promise<BoothDutyView> {
  const date = opts.date ?? (await boothBusinessDate(db, row.branchId));
  const rule = await loadBoothDutyRule(db, row.stationId);
  const roster = await rosterRows(db, row.stationId, date);
  const [sync] = await db
    .select()
    .from(boothDutySync)
    .where(and(eq(boothDutySync.stationId, row.stationId), eq(boothDutySync.businessDate, date)))
    .limit(1);
  const log = await db
    .select({
      at: auditLog.createdAt,
      action: auditLog.action,
      actorAccountId: auditLog.actorAccountId,
      before: auditLog.before,
      after: auditLog.after,
    })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.operatorId, row.operatorId),
        like(auditLog.action, 'booth_duty.%'),
        or(
          sql`${auditLog.after}->>'stationId' = ${row.stationId}`,
          sql`${auditLog.before}->>'stationId' = ${row.stationId}`,
        ),
        or(
          sql`${auditLog.after}->>'businessDate' = ${date}`,
          sql`${auditLog.before}->>'businessDate' = ${date}`,
        ),
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(100);

  return {
    businessDate: date,
    rule,
    roster: roster.map(viewOf),
    label: boothDutyLabel({
      roster: { date, people: roster.map((r) => ({ accountId: r.accountId, displayName: r.displayName })) },
      today: date,
      signedIn: null,
    }),
    lastSync: sync
      ? {
          syncedAt: sync.syncedAt.toISOString(),
          appState: sync.appState as BoothDutyAppState,
          unmatched: (sync.unmatched as BoothDutyUnmatched[]) ?? [],
          syncedByAccountId: sync.syncedByAccountId,
        }
      : null,
    log: log.map((l) => ({
      at: l.at.toISOString(),
      action: l.action,
      actorAccountId: l.actorAccountId,
      detail: ((l.after ?? l.before) as Record<string, unknown> | null) ?? null,
    })),
  };
}

/**
 * Change a booth's match rule. Upserts the two columns only: a booth with no
 * settings row gets one carrying every other default, which is what it was
 * already running on (`SETTINGS_DEFAULTS` in `booth-admin.ts`). Neither
 * column is published, so this never changes a bundle or its hash.
 */
export async function updateBoothDutyRule(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string },
  row: BoothStationRow,
  patch: Partial<BoothDutyRule>,
): Promise<BoothDutyRule> {
  const clean = (v: string | undefined): string | undefined => {
    if (v === undefined) return undefined;
    const t = v.trim();
    if (t.length > BOOTH_DUTY_RULE_MAX_CHARS) {
      throw new AppError(
        400,
        'BOOTH_DUTY_RULE_TOO_LONG',
        `A match text is at most ${BOOTH_DUTY_RULE_MAX_CHARS} characters`,
      );
    }
    return t;
  };
  const groupText = clean(patch.groupText);
  const dutyText = clean(patch.dutyText);
  return withTx(db, ctx, 'booth_duty.rule', async (tx) => {
    const before = await loadBoothDutyRule(tx, row.stationId);
    const after: BoothDutyRule = {
      groupText: groupText ?? before.groupText,
      dutyText: dutyText ?? before.dutyText,
    };
    if (after.groupText === before.groupText && after.dutyText === before.dutyText) return before;
    await tx
      .insert(boothSettings)
      .values({
        stationId: row.stationId,
        operatorId: row.operatorId,
        branchId: row.branchId,
        dutyGroupText: after.groupText,
        dutyMatchText: after.dutyText,
      })
      .onConflictDoUpdate({
        target: boothSettings.stationId,
        set: { dutyGroupText: after.groupText, dutyMatchText: after.dutyText, updatedAt: new Date() },
      });
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: row.operatorId,
      branchId: row.branchId,
      action: 'booth_duty.rule',
      entityType: 'booth_settings',
      entityId: row.stationId,
      before,
      after,
      requestId: ctx.requestId ?? null,
    });
    return after;
  });
}

// --- The morning job ------------------------------------------------------------

export const BOOTH_DUTY_JOB = 'job:booth.duty_sync';

/**
 * Sync every live booth once per trading day, at the branch's open (D4).
 *
 * Runs on a short tick and does the work only when it is due: a booth is
 * synced when it has no sync recorded for today's trading day AND its branch
 * is open now. A branch with no opening hours set is synced from the start of
 * its trading day — "nobody has said when the park opens" must not mean "the
 * booth's roster is never read". A booth synced earlier by "Sync now" is not
 * synced again by the job that day. One booth failing does not stop the rest:
 * it is counted, logged by the caller, and tried again on the next tick.
 */
export async function runMorningBoothDutySync(
  db: Db,
  now: Date,
  /**
   * `withinOpeningHours` from `services/box.ts`, passed in by the job rather
   * than imported here: `box.ts` imports the job runner, and the job runner
   * imports this file.
   */
  isOpen: (openingHours: unknown, timezone: string, at: Date) => boolean,
): Promise<{ booths: number; synced: number; notDue: number; failed: number }> {
  const booths = await db
    .select({
      stationId: station.id,
      name: station.name,
      operatorId: station.operatorId,
      branchId: station.branchId,
      boxId: station.boxId,
      timezone: branch.timezone,
      businessDayStart: branch.businessDayStart,
      openingHours: branch.openingHours,
    })
    .from(station)
    .innerJoin(branch, eq(branch.id, station.branchId))
    .where(and(eq(station.kind, 'booth'), isNull(station.archivedAt), isNull(branch.archivedAt)));

  const summary = { booths: booths.length, synced: 0, notDue: 0, failed: 0 };
  for (const b of booths) {
    const date = businessDate(now, b.timezone, parseDayStart(b.businessDayStart));
    const [done] = await db
      .select({ at: boothDutySync.syncedAt })
      .from(boothDutySync)
      .where(and(eq(boothDutySync.stationId, b.stationId), eq(boothDutySync.businessDate, date)))
      .limit(1);
    const open = b.openingHours ? isOpen(b.openingHours, b.timezone, now) : true;
    if (done || !open) {
      summary.notDue += 1;
      continue;
    }
    try {
      await syncBoothDuty(
        db,
        { actorAccountId: null, operatorId: b.operatorId, branchId: b.branchId },
        {
          row: {
            stationId: b.stationId,
            name: b.name,
            operatorId: b.operatorId,
            branchId: b.branchId,
            boxId: b.boxId,
          },
          date,
          actorAccountId: null,
          now,
        },
      );
      summary.synced += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}
