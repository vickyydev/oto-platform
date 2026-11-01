import { and, asc, desc, eq, gt, inArray, isNull, like, lt, ne, or, sql } from 'drizzle-orm';
import {
  auditLog,
  branch,
  employee,
  findAppBranchForCore,
  nanny,
  nannyShift,
  nannySync,
  otoAppScheduleInstalled,
  otoappCasualWorkers,
  otoappDepartments,
  otoappRoles,
  otoappScheduleAssignments,
  otoappScheduleShiftRowRoles,
  otoappScheduleShiftRows,
  otoappShiftGroups,
  supervisionPolicy,
  type Db,
  type NannySource,
} from '@oto/db';
import { addDaysToIsoDate, businessDate, newId, parseDayStart } from '@oto/shared';
import { AppError } from '../lib/errors';
import { audit } from './audit';
import { dutyTextMatches, employeeSeamReadable, type BoothDutyAppState } from './booth-duty';
import { nannyRosterOf, policyRowFor } from './checkin';
import { listAppEmployeesByIds } from './otoapp-employees';
import { withTx, type Exec, type OpContext } from './tx';

/**
 * The park's nannies and their shifts, from the OTO App's rota (SCRUM-699).
 *
 * **Why this exists.** A drop-off child on the Nanny service must be given a
 * nanny on shift at that park before the sale can go on, and the till reads
 * who is on shift from `pos.nanny_shift` (`nannyRosterOf` in `checkin.ts`,
 * whose contract this file does not change). Until now only the demo seed
 * wrote those rows, so once the seeded fortnight passed every nanny showed
 * "Off shift" and a nanny drop-off could not be paid.
 *
 * **What it does**, the booth's day roster (`booth-duty.ts`) transposed:
 *
 *   - **reads** the app's schedule for one platform branch and one trading day
 *     through the read-only `otoapp.*` seam — and only reads it: nothing here
 *     writes a shift, an assignment or anything else back to the app;
 *   - **matches** (D1) an assignment whose shift row's group, department or
 *     one of whose roles (the row's, or the assignment's own) contains the
 *     branch's match text, "Nanny" by default, or the Thai word พี่เลี้ยง,
 *     which always matches as the app's own nanny rule names both;
 *   - **writes** the difference into `pos.nanny` (one row per app employee per
 *     branch, `source` 'app_schedule', its name following the app) and
 *     `pos.nanny_shift` (one 'app_schedule' row per assignment, its hours
 *     the shift row's on the branch's own clock);
 *   - lets a person **add a nanny for today by hand** (D2) — a name and hours
 *     — so a sale never blocks on an empty rota.
 *
 * **What a sync never does (D3).** It never archives or deletes a nanny, and
 * it never reads or touches a manual or seed shift. A shift the app no longer
 * names is removed only while it has not started; one in progress is cut
 * short at the moment of the sync; one that has ended stays exactly as it
 * was. And when the rota cannot be read at all, nothing is removed: an
 * unreadable rota is not an empty one.
 *
 * **Idempotent, and serialised.** A re-run that changed nothing writes
 * nothing — no shift, no sync record, no audit line. Two syncs of the same
 * branch's day at once take turns on an advisory lock taken as the
 * transaction's first statement, and every write an audit line answers for
 * is `.returning()`-guarded, as on the booth.
 *
 * **What the audit lines carry**: names and platform ids only — never an app
 * id, and never a child's name.
 */

// --- The rule -------------------------------------------------------------------

export const NANNY_MATCH_TEXT_DEFAULT = 'Nanny';
/**
 * Always matches as well, whatever the match text says (the OTO App's own rule
 * names both, `srv/checkin-routes.ts:72`). An empty match text turns off only
 * the English term.
 */
export const NANNY_MATCH_ALWAYS = ['พี่เลี้ยง'] as const;
export const NANNY_MATCH_TEXT_MAX_CHARS = 100;
export const NANNY_NAME_MAX_CHARS = 100;
export const NANNY_DUTY_JOB = 'job:nanny.duty_sync';

/**
 * The advisory lock namespace for one branch's nanny roster on one trading
 * day. `0x070a`..`0x0711` are taken (the job runner, the QR invoice number,
 * an operator's barcodes, a person's voucher misses, the virtual box lease,
 * the booth roster and voucher promotions, the employee sync, exclusive jobs),
 * and the OTO App, on the same database, holds `0x0712` (its night batches,
 * apps/oto-app/server/lib/nightBatchLock.ts) and `0x0713` (its attention items).
 */
const NANNY_DUTY_LOCK_NAMESPACE = 0x0714;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Whether `candidate` names a nanny: the branch's match text, or the Thai word. */
export function nannyTextMatches(candidate: string | null | undefined, matchText: string): boolean {
  return dutyTextMatches(candidate, matchText) || NANNY_MATCH_ALWAYS.some((w) => dutyTextMatches(candidate, w));
}

// --- The matcher, over rows shaped as the app's --------------------------------

export type NannyDutyAppState = BoothDutyAppState;

/** One schedule assignment on the day, with the names its shift row sits under and its hours. */
export interface AppNannyAssignmentRow {
  /** `schedule_assignments.id`. */
  id: string;
  /** `employee` or `casual`. */
  assigneeType: string;
  employeeId: string | null;
  casualWorkerId: string | null;
  groupName: string | null;
  departmentName: string | null;
  /** The shift row's roles, then the assignment's own role. */
  roleNames: string[];
  startsAt: Date;
  endsAt: Date;
}

export interface AppNannyEmployeeRow {
  id: string;
  fullName: string;
  nickname: string;
}

export interface AppNannyCasualRow {
  id: string;
  fullName: string;
  nickname: string;
}

export type NannyDutyUnmatchedReason = 'no_employee_row' | 'no_name' | 'casual_worker';

export interface NannyDutyUnmatched {
  name: string | null;
  reason: NannyDutyUnmatchedReason;
}

export interface NannyDutyAppShift {
  appAssignmentId: string;
  startsAt: Date;
  endsAt: Date;
}

export interface NannyDutyPerson {
  appEmployeeId: string;
  displayName: string;
  shifts: NannyDutyAppShift[];
}

/** The name the till shows: the nickname, or the full name when the nickname is blank. */
function nameOf(person: { nickname: string; fullName: string }): string {
  const name = (person.nickname ?? '').trim() || (person.fullName ?? '').trim();
  return name.slice(0, NANNY_NAME_MAX_CHARS);
}

/**
 * Who the app makes a nanny at this park today, from rows already read — no
 * database here, so the rule is testable over real-shaped rows.
 *
 * D1 says "an employee": a casual worker on a nanny shift is listed as
 * unmatched (`casual_worker`) for reception to add by hand, never made a
 * nanny. Unmatched entries are listed once per app id. People come out in the
 * order of their first matched assignment, each with one shift per matched
 * assignment (a split shift is two), shifts in time order.
 */
export function matchNannyDuty(input: {
  matchText: string;
  assignments: readonly AppNannyAssignmentRow[];
  employees: ReadonlyMap<string, AppNannyEmployeeRow>;
  casuals: ReadonlyMap<string, AppNannyCasualRow>;
}): { people: NannyDutyPerson[]; unmatched: NannyDutyUnmatched[] } {
  const people: NannyDutyPerson[] = [];
  const byEmployee = new Map<string, NannyDutyPerson>();
  const unmatched: NannyDutyUnmatched[] = [];
  const seenUnmatched = new Set<string>();
  const miss = (key: string, entry: NannyDutyUnmatched): void => {
    if (seenUnmatched.has(key)) return;
    seenUnmatched.add(key);
    unmatched.push(entry);
  };

  for (const a of input.assignments) {
    const matches =
      nannyTextMatches(a.groupName, input.matchText) ||
      nannyTextMatches(a.departmentName, input.matchText) ||
      a.roleNames.some((r) => nannyTextMatches(r, input.matchText));
    if (!matches) continue;

    if (a.assigneeType === 'casual') {
      const casual = a.casualWorkerId ? input.casuals.get(a.casualWorkerId) : undefined;
      const name = casual ? nameOf(casual) : '';
      miss(`casual:${a.casualWorkerId ?? `assignment:${a.id}`}`, {
        name: name === '' ? null : name,
        reason: 'casual_worker',
      });
      continue;
    }

    const emp = a.employeeId ? input.employees.get(a.employeeId) : undefined;
    if (!emp) {
      miss(`employee:${a.employeeId ?? `assignment:${a.id}`}`, { name: null, reason: 'no_employee_row' });
      continue;
    }
    const name = nameOf(emp);
    if (name === '') {
      miss(`employee:${emp.id}`, { name: null, reason: 'no_name' });
      continue;
    }
    let person = byEmployee.get(emp.id);
    if (!person) {
      person = { appEmployeeId: emp.id, displayName: name, shifts: [] };
      byEmployee.set(emp.id, person);
      people.push(person);
    }
    person.shifts.push({ appAssignmentId: a.id, startsAt: a.startsAt, endsAt: a.endsAt });
  }

  for (const p of people) p.shifts.sort((x, y) => x.startsAt.getTime() - y.startsAt.getTime());
  return { people, unmatched };
}

// --- Reading the app ----------------------------------------------------------

interface AppNannyRead {
  state: NannyDutyAppState;
  assignments: AppNannyAssignmentRow[];
  employees: Map<string, AppNannyEmployeeRow>;
  casuals: Map<string, AppNannyCasualRow>;
}

const emptyRead = (state: NannyDutyAppState): AppNannyRead => ({
  state,
  assignments: [],
  employees: new Map(),
  casuals: new Map(),
});

/**
 * The app's assignments for one platform branch on one date, with their
 * hours as instants on the branch's clock. Read-only: every statement here is
 * a SELECT against `otoapp.*`. Same guards, in the same order, as the booth's
 * reader; duty blocks are not read (a nanny is rostered by her shift).
 */
export async function readAppNannies(
  exec: Exec,
  input: { operatorId: string; branchId: string; branchName: string; timezone: string; date: string },
): Promise<AppNannyRead> {
  if (!(await otoAppScheduleInstalled(exec))) return emptyRead('app_not_installed');
  // Without the employee view nobody on the rota can be named: the app is not
  // read at all, and an unreadable rota removes nobody. A missing grant is a
  // 503 that names it, never "nobody is on shift".
  if (!(await employeeSeamReadable(exec))) return emptyRead('app_not_installed');
  const appBranch = await findAppBranchForCore(exec, {
    operatorId: input.operatorId,
    coreBranchId: input.branchId,
    name: input.branchName,
  });
  if (appBranch === null) return emptyRead('no_app_branch');
  if (appBranch === 'ambiguous') return emptyRead('ambiguous_app_branch');

  const rows = await exec
    .select({
      id: otoappScheduleAssignments.id,
      assigneeType: otoappScheduleAssignments.assigneeType,
      employeeId: otoappScheduleAssignments.employeeId,
      casualWorkerId: otoappScheduleAssignments.casualWorkerId,
      shiftRowId: otoappScheduleAssignments.shiftRowId,
      ownRoleName: otoappRoles.name,
      groupName: otoappShiftGroups.name,
      departmentName: otoappDepartments.name,
      // The shift's wall-clock hours on the assignment's date, made instants
      // by Postgres in the branch's time zone (the repo's idiom). An end at or
      // before the start is an overnight shift and ends the next day.
      startsAt: sql<Date>`((${otoappScheduleAssignments.shiftDate}::date + ${otoappScheduleShiftRows.startTime}::time) at time zone ${input.timezone})`.mapWith(
        nannyShift.startsAt,
      ),
      endsAt: sql<Date>`((${otoappScheduleAssignments.shiftDate}::date + ${otoappScheduleShiftRows.endTime}::time + case when ${otoappScheduleShiftRows.endTime}::time <= ${otoappScheduleShiftRows.startTime}::time then interval '1 day' else interval '0 days' end) at time zone ${input.timezone})`.mapWith(
        nannyShift.endsAt,
      ),
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

  const shiftRowIds = [...new Set(rows.map((r) => r.shiftRowId))];
  const rowRoles = shiftRowIds.length
    ? await exec
        .select({ shiftRowId: otoappScheduleShiftRowRoles.shiftRowId, name: otoappRoles.name })
        .from(otoappScheduleShiftRowRoles)
        .innerJoin(otoappRoles, eq(otoappRoles.id, otoappScheduleShiftRowRoles.roleId))
        .where(inArray(otoappScheduleShiftRowRoles.shiftRowId, shiftRowIds))
    : [];
  const rolesByRow = new Map<string, string[]>();
  for (const r of rowRoles) rolesByRow.set(r.shiftRowId, [...(rolesByRow.get(r.shiftRowId) ?? []), r.name]);

  const employeeIds = [...new Set(rows.flatMap((r) => (r.employeeId ? [r.employeeId] : [])))];
  const casualIds = [...new Set(rows.flatMap((r) => (r.casualWorkerId ? [r.casualWorkerId] : [])))];
  // Names through the employee repository, the same view and rule the
  // employee copy and the booth roster read.
  const seen = employeeIds.length ? await listAppEmployeesByIds(exec, employeeIds) : [];
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
    assignments: rows.map((r) => ({
      id: r.id,
      assigneeType: r.assigneeType,
      employeeId: r.employeeId,
      casualWorkerId: r.casualWorkerId,
      groupName: r.groupName,
      departmentName: r.departmentName,
      roleNames: [...(rolesByRow.get(r.shiftRowId) ?? []), ...(r.ownRoleName ? [r.ownRoleName] : [])],
      startsAt: r.startsAt,
      endsAt: r.endsAt,
    })),
    employees: new Map(seen.map((e) => [e.id, { id: e.id, fullName: e.fullName, nickname: e.nickname }])),
    casuals: new Map(casuals.map((c) => [c.id, c])),
  };
}

// --- The branch's side ----------------------------------------------------------

interface BranchClock {
  name: string;
  timezone: string;
  businessDayStart: string;
  openingHours: unknown;
}

/** The branch, refused 404 when it is missing or another operator's. */
async function branchOf(exec: Exec, operatorId: string, branchId: string): Promise<BranchClock> {
  const [row] = await exec
    .select({
      operatorId: branch.operatorId,
      name: branch.name,
      timezone: branch.timezone,
      businessDayStart: branch.businessDayStart,
      openingHours: branch.openingHours,
    })
    .from(branch)
    .where(eq(branch.id, branchId))
    .limit(1);
  if (!row || row.operatorId !== operatorId) throw new AppError(404, 'BRANCH_NOT_FOUND', 'No branch with that id');
  return {
    name: row.name,
    timezone: row.timezone,
    businessDayStart: row.businessDayStart,
    openingHours: row.openingHours,
  };
}

const tradingDayOf = (clock: BranchClock, at: Date): string =>
  businessDate(at, clock.timezone, parseDayStart(clock.businessDayStart));

/** The branch's match text, or the default for a branch with no policy row yet. */
export async function loadNannyMatchText(exec: Exec, branchId: string): Promise<string> {
  const [row] = await exec
    .select({ matchText: supervisionPolicy.nannyMatchText })
    .from(supervisionPolicy)
    .where(eq(supervisionPolicy.branchId, branchId))
    .limit(1);
  return row?.matchText ?? NANNY_MATCH_TEXT_DEFAULT;
}

/** The branch's trading day at `at` — the date a nanny roster is for. */
export async function nannyBusinessDate(
  exec: Exec,
  operatorId: string,
  branchId: string,
  at: Date = new Date(),
): Promise<string> {
  return tradingDayOf(await branchOf(exec, operatorId, branchId), at);
}

const asDate = (v: Date | string): Date => (v instanceof Date ? v : new Date(v));

/**
 * Wall-clock `from`..`to` on `date` in `timezone`, as instants — the same
 * arithmetic the app's shifts get. `to` at or before `from` is the next day.
 */
async function wallClockSpan(
  exec: Exec,
  date: string,
  from: string,
  to: string,
  timezone: string,
): Promise<{ startsAt: Date; endsAt: Date }> {
  const res = await exec.execute<{ s: Date | string; e: Date | string }>(sql`
    select ((${date}::date + ${from}::time) at time zone ${timezone}) as s,
           ((${date}::date + ${to}::time + case when ${to}::time <= ${from}::time then interval '1 day' else interval '0 days' end) at time zone ${timezone}) as e`);
  const row = res.rows[0]!;
  return { startsAt: asDate(row.s), endsAt: asDate(row.e) };
}

/** `[start of trading day D, start of trading day D+1)` on the branch's clock. */
async function tradingDayWindow(exec: Exec, clock: BranchClock, date: string): Promise<[Date, Date]> {
  const next = addDaysToIsoDate(date, 1);
  const res = await exec.execute<{ s: Date | string; e: Date | string }>(sql`
    select ((${date}::date + ${clock.businessDayStart}::time) at time zone ${clock.timezone}) as s,
           ((${next}::date + ${clock.businessDayStart}::time) at time zone ${clock.timezone}) as e`);
  const row = res.rows[0]!;
  return [asDate(row.s), asDate(row.e)];
}

/**
 * The route's own answer is what the idempotency store keeps: every write
 * here answers with a view read after the transaction, so the transaction
 * must not store its intermediate result as the response (the pattern
 * `payments/routing.ts` uses).
 */
const writeCtx = (ctx: OpContext): OpContext => ({ ...ctx, idempotency: undefined });

const lockDay = (tx: Exec, branchId: string, date: string) =>
  tx.execute(
    sql`select pg_advisory_xact_lock(${NANNY_DUTY_LOCK_NAMESPACE}::int4, hashtext(${`${branchId}:${date}`})::int4)`,
  );

type ShiftRow = typeof nannyShift.$inferSelect;

const shiftAudit = (
  r: Pick<ShiftRow, 'branchId' | 'nannyId' | 'source' | 'startsAt' | 'endsAt'>,
  date: string,
  name: string,
) => ({
  branchId: r.branchId,
  businessDate: date,
  nannyId: r.nannyId,
  name,
  source: r.source,
  startsAt: r.startsAt.toISOString(),
  endsAt: r.endsAt.toISOString(),
});

// --- The sync -------------------------------------------------------------------

export interface NannyDutySyncResult {
  businessDate: string;
  appState: NannyDutyAppState;
  added: number;
  removed: number;
  renamed: number;
  reshifted: number;
  unmatched: NannyDutyUnmatched[];
}

/**
 * Sync one branch's nannies for one trading day from the app.
 *
 * `actorAccountId` is the person who pressed "Sync now", or null for the
 * morning job. See the note at the top of this file for what is written and
 * what never is.
 */
export async function syncNannyDuty(
  db: Db,
  ctx: OpContext,
  input: { operatorId: string; branchId: string; date?: string; actorAccountId: string | null; now?: Date },
): Promise<NannyDutySyncResult> {
  const { operatorId, branchId } = input;
  const now = input.now ?? new Date();
  const clock = await branchOf(db, operatorId, branchId);
  const date = input.date ?? tradingDayOf(clock, now);
  const requestId = ctx.requestId ?? null;

  return withTx(db, writeCtx(ctx), 'nanny_duty.sync', async (tx) => {
    /**
     * One sync of this branch's day at a time, until this transaction ends,
     * taken BEFORE the app is read: a sync that waited here reads the roster
     * the winner committed. Keyed on the branch and the day, so two parks, or
     * two days of one park, never wait on each other.
     */
    await lockDay(tx, branchId, date);

    const matchText = await loadNannyMatchText(tx, branchId);
    const read = await readAppNannies(tx, {
      operatorId,
      branchId,
      branchName: clock.name,
      timezone: clock.timezone,
      date,
    });
    const matched = matchNannyDuty({
      matchText,
      assignments: read.assignments,
      employees: read.employees,
      casuals: read.casuals,
    });

    let added = 0;
    let removed = 0;
    let renamed = 0;
    let reshifted = 0;

    // --- The nannies: found by the app's employee id, never archived here (D3).
    const nannyOf = new Map<string, { id: string; name: string; created: boolean }>();
    for (const person of matched.people) {
      const find = () =>
        tx
          .select({ id: nanny.id, name: nanny.name })
          .from(nanny)
          .where(
            and(
              eq(nanny.branchId, branchId),
              eq(nanny.appEmployeeId, person.appEmployeeId),
              isNull(nanny.archivedAt),
            ),
          )
          .limit(1);
      let [row] = await find();
      let created = false;
      if (!row) {
        // The platform's own copy of the person, when the employee copy has
        // made one, so the nanny is tied to the employee record too.
        const [emp] = await tx
          .select({ id: employee.id })
          .from(employee)
          .where(
            and(
              eq(employee.operatorId, operatorId),
              eq(employee.externalId, person.appEmployeeId),
              isNull(employee.archivedAt),
            ),
          )
          .limit(1);
        const inserted = await tx
          .insert(nanny)
          .values({
            id: newId(),
            operatorId,
            branchId,
            name: person.displayName,
            employeeId: emp?.id ?? null,
            source: 'app_schedule',
            appEmployeeId: person.appEmployeeId,
          })
          .onConflictDoNothing()
          .returning({ id: nanny.id });
        created = inserted.length > 0;
        [row] = await find();
      } else if (row.name !== person.displayName) {
        // A name the app has since changed follows the app — only on the
        // app's own row (an app employee id is only ever on one), and logged
        // only for a row this statement actually renamed.
        const done = await tx
          .update(nanny)
          .set({ name: person.displayName, updatedAt: now })
          .where(and(eq(nanny.id, row.id), ne(nanny.name, person.displayName)))
          .returning({ id: nanny.id });
        if (done.length > 0) {
          renamed += 1;
          await audit.record(tx, {
            actorAccountId: input.actorAccountId,
            operatorId,
            branchId,
            action: 'nanny_duty.rename',
            entityType: 'nanny',
            entityId: row.id,
            before: { branchId, businessDate: date, nannyId: row.id, name: row.name, source: 'app_schedule' },
            after: { branchId, businessDate: date, nannyId: row.id, name: person.displayName, source: 'app_schedule' },
            requestId,
          });
        }
        row = { id: row.id, name: person.displayName };
      }
      if (row) nannyOf.set(person.appEmployeeId, { id: row.id, name: row.name, created });
    }

    // --- The shifts: only the app's own rows are read or written.
    const wanted = new Map<string, { nannyId: string; name: string; created: boolean; shift: NannyDutyAppShift }>();
    for (const person of matched.people) {
      const n = nannyOf.get(person.appEmployeeId);
      if (!n) continue;
      for (const shift of person.shifts) {
        wanted.set(`${shift.appAssignmentId}|${n.id}`, { nannyId: n.id, name: n.name, created: n.created, shift });
      }
    }
    const wantedAssignments = [...new Set([...wanted.values()].map((w) => w.shift.appAssignmentId))];
    /**
     * The day's app shifts, and any app shift of another day for an
     * assignment the app now puts on this day (an assignment moved between
     * days keeps its id, and the unique key is per assignment, not per day).
     * Only this day's rows can ever be removed: the others are here solely
     * because the app wants them.
     */
    const heldRows = await tx
      .select({ shift: nannyShift, name: nanny.name })
      .from(nannyShift)
      .innerJoin(nanny, eq(nanny.id, nannyShift.nannyId))
      .where(
        and(
          eq(nannyShift.branchId, branchId),
          eq(nannyShift.source, 'app_schedule'),
          wantedAssignments.length
            ? or(eq(nannyShift.businessDate, date), inArray(nannyShift.appAssignmentId, wantedAssignments))
            : eq(nannyShift.businessDate, date),
        ),
      );
    const held = new Map(heldRows.map((h) => [`${h.shift.appAssignmentId}|${h.shift.nannyId}`, h]));

    for (const [key, want] of wanted) {
      const have = held.get(key);
      const { shift } = want;
      if (!have) {
        const id = newId();
        // A shift that has already ended is still written, as a record of the rota.
        const inserted = await tx
          .insert(nannyShift)
          .values({
            id,
            operatorId,
            branchId,
            nannyId: want.nannyId,
            startsAt: shift.startsAt,
            endsAt: shift.endsAt,
            source: 'app_schedule',
            businessDate: date,
            appAssignmentId: shift.appAssignmentId,
            syncedAt: now,
          })
          .onConflictDoNothing()
          .returning({ id: nannyShift.id });
        if (inserted.length === 0) continue;
        added += 1;
        await audit.record(tx, {
          actorAccountId: input.actorAccountId,
          operatorId,
          branchId,
          action: 'nanny_duty.assign',
          entityType: 'nanny_shift',
          entityId: id,
          after: {
            ...shiftAudit(
              { branchId, nannyId: want.nannyId, source: 'app_schedule', startsAt: shift.startsAt, endsAt: shift.endsAt },
              date,
              want.name,
            ),
            nannyCreated: want.created,
          },
          requestId,
        });
        continue;
      }

      const row = have.shift;
      const movedDay = row.businessDate !== date;
      const sameTimes =
        row.startsAt.getTime() === shift.startsAt.getTime() && row.endsAt.getTime() === shift.endsAt.getTime();
      if (sameTimes && !movedDay) continue;
      // The past stays (D3): an ended shift is never rewritten.
      if (row.endsAt.getTime() <= now.getTime()) continue;

      let next: { startsAt: Date; endsAt: Date; businessDate: string };
      if (row.startsAt.getTime() >= now.getTime()) {
        // Not started: it takes the app's hours (and day) whole.
        next = { startsAt: shift.startsAt, endsAt: shift.endsAt, businessDate: date };
      } else {
        // In progress: its start is history; only its end follows the app,
        // never into the past, and it stays on the day it began.
        const end = new Date(Math.max(shift.endsAt.getTime(), now.getTime()));
        if (end.getTime() === row.endsAt.getTime()) continue;
        next = { startsAt: row.startsAt, endsAt: end, businessDate: row.businessDate ?? date };
      }
      const done = await tx
        .update(nannyShift)
        .set({ ...next, syncedAt: now, updatedAt: now })
        .where(and(eq(nannyShift.id, row.id), gt(nannyShift.endsAt, now)))
        .returning({ id: nannyShift.id });
      if (done.length === 0) continue;
      reshifted += 1;
      await audit.record(tx, {
        actorAccountId: input.actorAccountId,
        operatorId,
        branchId,
        action: 'nanny_duty.reshift',
        entityType: 'nanny_shift',
        entityId: row.id,
        before: shiftAudit(row, row.businessDate ?? date, have.name),
        after: shiftAudit({ ...row, ...next }, next.businessDate, want.name),
        requestId,
      });
    }

    // An unreadable rota is not an empty one: nothing is removed unless the
    // app was actually read.
    if (read.state === 'ok') {
      for (const [key, have] of held) {
        if (wanted.has(key)) continue;
        const row = have.shift;
        if (row.businessDate !== date) continue;
        // The past stays (D3).
        if (row.endsAt.getTime() <= now.getTime()) continue;
        if (row.startsAt.getTime() >= now.getTime()) {
          const gone = await tx
            .delete(nannyShift)
            .where(and(eq(nannyShift.id, row.id), eq(nannyShift.source, 'app_schedule')))
            .returning({ id: nannyShift.id });
          if (gone.length === 0) continue;
          removed += 1;
          await audit.record(tx, {
            actorAccountId: input.actorAccountId,
            operatorId,
            branchId,
            action: 'nanny_duty.unassign',
            entityType: 'nanny_shift',
            entityId: row.id,
            before: shiftAudit(row, date, have.name),
            requestId,
          });
          continue;
        }
        // In progress: cut short now, so the till stops offering her.
        const cut = await tx
          .update(nannyShift)
          .set({ endsAt: now, syncedAt: now, updatedAt: now })
          .where(and(eq(nannyShift.id, row.id), gt(nannyShift.endsAt, now)))
          .returning({ id: nannyShift.id });
        if (cut.length === 0) continue;
        removed += 1;
        await audit.record(tx, {
          actorAccountId: input.actorAccountId,
          operatorId,
          branchId,
          action: 'nanny_duty.unassign',
          entityType: 'nanny_shift',
          entityId: row.id,
          before: shiftAudit(row, date, have.name),
          after: { ...shiftAudit({ ...row, endsAt: now }, date, have.name), cutShort: true },
          requestId,
        });
      }
    }

    /**
     * A re-run that changed nothing writes nothing: no shift moved, the app
     * reads the same way and the same people are unmatched, so the day's sync
     * row stays as it is and no `nanny_duty.sync` line is added. The day's
     * FIRST sync always writes, which is what tells the morning job the
     * branch is done for the day.
     */
    const [last] = await tx
      .select({ appState: nannySync.appState, unmatched: nannySync.unmatched })
      .from(nannySync)
      .where(and(eq(nannySync.branchId, branchId), eq(nannySync.businessDate, date)))
      .limit(1);
    const moved = added + removed + renamed + reshifted > 0;
    const result: NannyDutySyncResult = {
      businessDate: date,
      appState: read.state,
      added,
      removed,
      renamed,
      reshifted,
      unmatched: matched.unmatched,
    };
    if (
      last !== undefined &&
      !moved &&
      last.appState === read.state &&
      sameUnmatched(last.unmatched as NannyDutyUnmatched[] | null, matched.unmatched)
    ) {
      return result;
    }

    const written = await tx
      .insert(nannySync)
      .values({
        operatorId,
        branchId,
        businessDate: date,
        syncedAt: now,
        appState: read.state,
        unmatched: matched.unmatched,
        syncedByAccountId: input.actorAccountId,
      })
      .onConflictDoUpdate({
        target: [nannySync.branchId, nannySync.businessDate],
        set: {
          syncedAt: now,
          appState: read.state,
          unmatched: matched.unmatched,
          syncedByAccountId: input.actorAccountId,
          updatedAt: now,
        },
        ...(moved
          ? {}
          : {
              setWhere: sql`${nannySync.appState} is distinct from ${read.state} or ${nannySync.unmatched} <> ${JSON.stringify(matched.unmatched)}::jsonb`,
            }),
      })
      .returning({ branchId: nannySync.branchId });

    if (written.length > 0) {
      await audit.record(tx, {
        actorAccountId: input.actorAccountId,
        operatorId,
        branchId,
        action: 'nanny_duty.sync',
        entityType: 'branch',
        entityId: branchId,
        after: {
          branchId,
          businessDate: date,
          appState: read.state,
          added,
          removed,
          renamed,
          reshifted,
          unmatched: matched.unmatched,
        },
        requestId,
      });
    }
    return result;
  });
}

/** Whether two unmatched lists name the same people for the same reasons, in any order. */
function sameUnmatched(a: readonly NannyDutyUnmatched[] | null, b: readonly NannyDutyUnmatched[]): boolean {
  const key = (list: readonly NannyDutyUnmatched[]) => list.map((u) => `${u.reason}|${u.name ?? ''}`).sort();
  const left = key(a ?? []);
  const right = key(b);
  return left.length === right.length && left.every((k, i) => k === right[i]);
}

// --- People's own rows (D2) -----------------------------------------------------

/**
 * Somebody adds a nanny for the day by hand, when nobody is rostered: a name
 * and wall-clock hours on the branch's day (`to` at or before `from` ends the
 * next day). The oldest live nanny of the branch with that name is reused,
 * whatever put her there; otherwise a 'manual' nanny is made. The same manual
 * shift twice is a no-op with no audit row. A sync never touches the result.
 */
export async function addManualNanny(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  branchId: string,
  input: { name: string; from: string; to: string; date?: string },
  opts: { now?: Date } = {},
): Promise<{ businessDate: string; nannyId: string; shiftId: string | null }> {
  const now = opts.now ?? new Date();
  const name = input.name.trim();
  if (name.length < 1 || name.length > NANNY_NAME_MAX_CHARS) {
    throw new AppError(
      400,
      'NANNY_NAME_REQUIRED',
      `A name is needed, at most ${NANNY_NAME_MAX_CHARS} characters: it is what the till shows`,
    );
  }
  if (!HHMM.test(input.from) || !HHMM.test(input.to) || input.from === input.to) {
    throw new AppError(400, 'NANNY_SHIFT_TIMES_INVALID', 'A shift needs a start and an end time that differ');
  }
  if (input.date !== undefined && !ISO_DATE.test(input.date)) {
    throw new AppError(400, 'NANNY_SHIFT_TIMES_INVALID', 'The day must be written YYYY-MM-DD');
  }
  const clock = await branchOf(db, actor.operatorId, branchId);
  const date = input.date ?? tradingDayOf(clock, now);
  const span = await wallClockSpan(db, date, input.from, input.to, clock.timezone);
  if (span.endsAt.getTime() <= now.getTime()) {
    throw new AppError(400, 'NANNY_SHIFT_OVER', 'That shift has already ended');
  }

  return withTx(db, writeCtx(ctx), 'nanny_duty.assign', async (tx) => {
    await lockDay(tx, branchId, date);

    const [found] = await tx
      .select({ id: nanny.id, name: nanny.name })
      .from(nanny)
      .where(
        and(
          eq(nanny.branchId, branchId),
          isNull(nanny.archivedAt),
          sql`lower(btrim(${nanny.name})) = lower(${name})`,
        ),
      )
      .orderBy(asc(nanny.createdAt), asc(nanny.id))
      .limit(1);
    let nannyId = found?.id;
    const nannyName = found?.name ?? name;
    const nannyCreated = !found;
    if (!nannyId) {
      nannyId = newId();
      await tx.insert(nanny).values({ id: nannyId, operatorId: actor.operatorId, branchId, name, source: 'manual' });
    } else {
      const [same] = await tx
        .select({ id: nannyShift.id })
        .from(nannyShift)
        .where(
          and(
            eq(nannyShift.nannyId, nannyId),
            eq(nannyShift.branchId, branchId),
            eq(nannyShift.source, 'manual'),
            eq(nannyShift.startsAt, span.startsAt),
            eq(nannyShift.endsAt, span.endsAt),
          ),
        )
        .limit(1);
      if (same) return { businessDate: date, nannyId, shiftId: null };
    }

    const shiftId = newId();
    await tx.insert(nannyShift).values({
      id: shiftId,
      operatorId: actor.operatorId,
      branchId,
      nannyId,
      startsAt: span.startsAt,
      endsAt: span.endsAt,
      source: 'manual',
      businessDate: date,
      addedByAccountId: actor.accountId,
    });
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId,
      action: 'nanny_duty.assign',
      entityType: 'nanny_shift',
      entityId: shiftId,
      after: {
        ...shiftAudit({ branchId, nannyId, source: 'manual', startsAt: span.startsAt, endsAt: span.endsAt }, date, nannyName),
        nannyCreated,
      },
      requestId: ctx.requestId ?? null,
    });
    return { businessDate: date, nannyId, shiftId };
  });
}

/**
 * Take a shift off the roster, whatever put it there. One that has not
 * started is deleted; one in progress is cut short now; a finished one stays
 * on the record. An app shift deleted here comes back at the next sync while
 * the rota still names her, as on the booth — the rota is the staff app's,
 * and a wrong shift is fixed there.
 */
export async function removeNannyShift(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  branchId: string,
  shiftId: string,
  opts: { now?: Date } = {},
): Promise<{ businessDate: string | null; outcome: 'deleted' | 'cut_short' }> {
  const now = opts.now ?? new Date();
  const clock = await branchOf(db, actor.operatorId, branchId);
  const notFound = () => new AppError(404, 'NANNY_SHIFT_NOT_FOUND', 'That shift is not on this branch’s roster');
  const ended = () => new AppError(409, 'NANNY_SHIFT_ENDED', 'A finished shift stays on the record');

  return withTx(db, writeCtx(ctx), 'nanny_duty.unassign', async (tx) => {
    const [have] = await tx
      .select({ shift: nannyShift, name: nanny.name })
      .from(nannyShift)
      .innerJoin(nanny, eq(nanny.id, nannyShift.nannyId))
      .where(and(eq(nannyShift.id, shiftId), eq(nannyShift.branchId, branchId)))
      .limit(1);
    if (!have) throw notFound();
    const row = have.shift;
    if (row.endsAt.getTime() <= now.getTime()) throw ended();
    const date = row.businessDate ?? tradingDayOf(clock, row.startsAt);
    const before = shiftAudit(row, date, have.name);

    if (row.startsAt.getTime() >= now.getTime()) {
      const gone = await tx
        .delete(nannyShift)
        .where(and(eq(nannyShift.id, row.id), eq(nannyShift.branchId, branchId)))
        .returning({ id: nannyShift.id });
      if (gone.length === 0) throw notFound();
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: actor.operatorId,
        branchId,
        action: 'nanny_duty.unassign',
        entityType: 'nanny_shift',
        entityId: row.id,
        before,
        requestId: ctx.requestId ?? null,
      });
      return { businessDate: date, outcome: 'deleted' as const };
    }

    const cut = await tx
      .update(nannyShift)
      .set({ endsAt: now, updatedAt: now })
      .where(and(eq(nannyShift.id, row.id), gt(nannyShift.endsAt, now)))
      .returning({ id: nannyShift.id });
    if (cut.length === 0) throw ended();
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId,
      action: 'nanny_duty.unassign',
      entityType: 'nanny_shift',
      entityId: row.id,
      before,
      after: { ...shiftAudit({ ...row, endsAt: now }, date, have.name), cutShort: true },
      requestId: ctx.requestId ?? null,
    });
    return { businessDate: date, outcome: 'cut_short' as const };
  });
}

/**
 * Change the text that makes somebody on the rota a nanny at this branch.
 * Trimmed, at most 100 characters; an empty text turns off only the English
 * term (พี่เลี้ยง still matches). Audited `nanny_duty.rule`; the next sync
 * applies it.
 */
export async function updateNannyMatchText(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  branchId: string,
  matchText: string,
): Promise<{ matchText: string }> {
  const text = matchText.trim();
  if (text.length > NANNY_MATCH_TEXT_MAX_CHARS) {
    throw new AppError(
      400,
      'NANNY_MATCH_TEXT_TOO_LONG',
      `The match text is at most ${NANNY_MATCH_TEXT_MAX_CHARS} characters`,
    );
  }
  await branchOf(db, actor.operatorId, branchId);
  if ((await loadNannyMatchText(db, branchId)) === text) return { matchText: text };

  return withTx(db, writeCtx(ctx), 'nanny_duty.rule', async (tx) => {
    const row = await policyRowFor(tx, actor.operatorId, branchId);
    if (row.nannyMatchText === text) return { matchText: text };
    await tx
      .update(supervisionPolicy)
      .set({ nannyMatchText: text, updatedAt: new Date() })
      .where(eq(supervisionPolicy.id, row.id));
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: actor.operatorId,
      branchId,
      action: 'nanny_duty.rule',
      entityType: 'supervision_policy',
      entityId: row.id,
      before: { matchText: row.nannyMatchText },
      after: { matchText: text },
      requestId: ctx.requestId ?? null,
    });
    return { matchText: text };
  });
}

// --- The Console's view -----------------------------------------------------------

export interface NannyDutyShiftView {
  id: string;
  source: NannySource;
  startsAt: string;
  endsAt: string;
  syncedAt: string | null;
  addedByAccountId: string | null;
}

export interface NannyDutyRosterRow {
  id: string;
  name: string;
  source: NannySource;
  employeeId: string | null;
  onShift: boolean;
  load: number;
  shifts: NannyDutyShiftView[];
}

export interface NannyDutyLogLine {
  at: string;
  action: string;
  actorAccountId: string | null;
  detail: Record<string, unknown> | null;
}

export interface NannyDutyView {
  branchId: string;
  businessDate: string;
  timezone: string;
  /** The instant `onShift` was measured at. */
  asOf: string;
  rule: { matchText: string; alsoMatches: string[] };
  nannies: NannyDutyRosterRow[];
  lastSync: {
    syncedAt: string;
    appState: NannyDutyAppState;
    unmatched: NannyDutyUnmatched[];
    syncedByAccountId: string | null;
  } | null;
  /** The day's `nanny_duty.*` audit rows, newest first, at most 100. */
  log: NannyDutyLogLine[];
}

/**
 * The branch's nannies for the Console. On shift and load come from
 * `nannyRosterOf` itself, unchanged, so the Console says what the till says;
 * each nanny carries where she came from and every shift of hers, of any
 * source, that overlaps the trading day. On shift first, then those with a
 * shift that day, then by name; an off-shift nanny with no shift is still
 * listed, as the till lists her.
 */
export async function nannyDutyView(
  db: Exec,
  input: { operatorId: string; branchId: string; date?: string; now?: Date },
): Promise<NannyDutyView> {
  const now = input.now ?? new Date();
  const { operatorId, branchId } = input;
  const clock = await branchOf(db, operatorId, branchId);
  const date = input.date ?? tradingDayOf(clock, now);
  const matchText = await loadNannyMatchText(db, branchId);
  const roster = await nannyRosterOf(db, branchId, now);
  const ids = roster.map((n) => n.id);

  const meta = ids.length
    ? await db
        .select({ id: nanny.id, source: nanny.source, employeeId: nanny.employeeId })
        .from(nanny)
        .where(inArray(nanny.id, ids))
    : [];
  const metaOf = new Map(meta.map((m) => [m.id, m]));

  const [dayStart, dayEnd] = await tradingDayWindow(db, clock, date);
  const shifts = ids.length
    ? await db
        .select()
        .from(nannyShift)
        .where(
          and(
            eq(nannyShift.branchId, branchId),
            inArray(nannyShift.nannyId, ids),
            lt(nannyShift.startsAt, dayEnd),
            gt(nannyShift.endsAt, dayStart),
          ),
        )
        .orderBy(asc(nannyShift.startsAt), asc(nannyShift.id))
    : [];
  const shiftsOf = new Map<string, NannyDutyShiftView[]>();
  for (const s of shifts) {
    shiftsOf.set(s.nannyId, [
      ...(shiftsOf.get(s.nannyId) ?? []),
      {
        id: s.id,
        source: s.source,
        startsAt: s.startsAt.toISOString(),
        endsAt: s.endsAt.toISOString(),
        syncedAt: s.syncedAt?.toISOString() ?? null,
        addedByAccountId: s.addedByAccountId,
      },
    ]);
  }

  const rank = (r: NannyDutyRosterRow) => (r.onShift ? 0 : r.shifts.length > 0 ? 1 : 2);
  // `nannyRosterOf` lists by name; the sort is stable, so name order holds within each rank.
  const nannies = roster
    .map(
      (n): NannyDutyRosterRow => ({
        id: n.id,
        name: n.name,
        source: metaOf.get(n.id)?.source ?? 'manual',
        employeeId: metaOf.get(n.id)?.employeeId ?? null,
        onShift: n.onShift,
        load: n.load,
        shifts: shiftsOf.get(n.id) ?? [],
      }),
    )
    .sort((a, b) => rank(a) - rank(b));

  const [sync] = await db
    .select()
    .from(nannySync)
    .where(and(eq(nannySync.branchId, branchId), eq(nannySync.businessDate, date)))
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
        eq(auditLog.operatorId, operatorId),
        eq(auditLog.branchId, branchId),
        like(auditLog.action, 'nanny_duty.%'),
        or(
          sql`${auditLog.after}->>'businessDate' = ${date}`,
          sql`${auditLog.before}->>'businessDate' = ${date}`,
        ),
      ),
    )
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
    .limit(100);

  return {
    branchId,
    businessDate: date,
    timezone: clock.timezone,
    asOf: now.toISOString(),
    rule: { matchText, alsoMatches: [...NANNY_MATCH_ALWAYS] },
    nannies,
    lastSync: sync
      ? {
          syncedAt: sync.syncedAt.toISOString(),
          appState: sync.appState as NannyDutyAppState,
          unmatched: (sync.unmatched as NannyDutyUnmatched[] | null) ?? [],
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

// --- The morning job ------------------------------------------------------------

/**
 * Sync every live branch once per trading day, at its open.
 *
 * Runs on a short tick and does the work only when it is due: a branch is
 * synced when it has no sync recorded for today's trading day AND it is open
 * now. A branch with no opening hours set counts as open — "nobody has said
 * when the park opens" must not mean "its nannies are never read". A branch
 * synced earlier by "Sync now" is not synced again by the job that day. One
 * branch failing does not stop the rest: it is counted and tried again on
 * the next tick.
 */
export async function runMorningNannyDutySync(
  db: Db,
  now: Date,
  /** `withinOpeningHours` from `services/box.ts`, passed in by the job (box.ts imports the job runner). */
  isOpen: (openingHours: unknown, timezone: string, at: Date) => boolean,
): Promise<{ branches: number; synced: number; notDue: number; failed: number }> {
  const branches = await db
    .select({
      id: branch.id,
      operatorId: branch.operatorId,
      timezone: branch.timezone,
      businessDayStart: branch.businessDayStart,
      openingHours: branch.openingHours,
    })
    .from(branch)
    .where(isNull(branch.archivedAt));

  const summary = { branches: branches.length, synced: 0, notDue: 0, failed: 0 };
  for (const b of branches) {
    const date = businessDate(now, b.timezone, parseDayStart(b.businessDayStart));
    const [done] = await db
      .select({ at: nannySync.syncedAt })
      .from(nannySync)
      .where(and(eq(nannySync.branchId, b.id), eq(nannySync.businessDate, date)))
      .limit(1);
    const open = b.openingHours ? isOpen(b.openingHours, b.timezone, now) : true;
    if (done || !open) {
      summary.notDue += 1;
      continue;
    }
    try {
      await syncNannyDuty(
        db,
        { actorAccountId: null, operatorId: b.operatorId, branchId: b.id },
        { operatorId: b.operatorId, branchId: b.id, date, actorAccountId: null, now },
      );
      summary.synced += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}
