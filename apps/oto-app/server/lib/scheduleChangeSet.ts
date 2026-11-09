// SCRUM-777 — undo one Schedule History action without touching later changes.
//
// Each logged action (a template applied, a week cleared) records its own
// change set as it runs: the schedule rows it created and the rows it changed
// as they stood right after it, and the rows it deleted in full. It is taken
// by reading the branch's schedule for the action's dates just before and just
// after the action and comparing the two (the actions themselves are not one
// transaction, so a write somebody else makes in that same instant would be
// counted in; the window is the action's own run time).
//
// "Undo this action" then reverses only that, in one transaction:
//   - a row it created is removed if it is still exactly as the action left
//     it; a row somebody changed since is left alone and reported, and so is
//     a shift row that has shifts on it now, or a shift that has a duty block
//     or a hand-set break on it now;
//   - a row it deleted is put back if its slot is still free (a shift: the
//     same person, date and shift row has no shift now; a day off: the same
//     person has none that day); otherwise it is left out and reported;
//   - a row it changed is changed back if nobody has changed it since.
// Automatic breaks (source auto_rule) are derived from the shifts on a row and
// date: they go with their shift and are worked out again afterwards for
// every row and date the undo touched, as every other shift write does.
import { and, eq, getTableColumns, inArray, ne, sql } from "drizzle-orm";
import {
  dutyBlocks,
  employeeTimeOff,
  scheduleAssignments,
  scheduleShiftBreaks,
  scheduleShiftRowRoles,
  scheduleShiftRows,
  scheduleWeekPlans,
} from "@shared/schema";
import { db } from "../db";
import { scheduleParkPredicate } from "../schedule-scope";

type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ScheduleRow = Record<string, unknown> & { id: string };

/** The schedule tables an action can write, parents before children. */
export const CHANGE_SET_GROUPS = ["weekPlans", "shiftRows", "rowRoles", "assignments", "breaks", "dutyBlocks", "timeOff"] as const;
export type ChangeSetGroup = (typeof CHANGE_SET_GROUPS)[number];

const TABLES = {
  weekPlans: scheduleWeekPlans,
  shiftRows: scheduleShiftRows,
  rowRoles: scheduleShiftRowRoles,
  assignments: scheduleAssignments,
  breaks: scheduleShiftBreaks,
  dutyBlocks,
  timeOff: employeeTimeOff,
} as const;

export const CHANGE_SET_TABLE_NAMES: Record<ChangeSetGroup, string> = {
  weekPlans: "schedule_week_plans",
  shiftRows: "schedule_shift_rows",
  rowRoles: "schedule_shift_row_roles",
  assignments: "schedule_assignments",
  breaks: "schedule_shift_breaks",
  dutyBlocks: "duty_blocks",
  timeOff: "employee_time_off",
};

// Drizzle types each table on its own; a lookup over the seven of them does
// not narrow to one, so the generic reads and writes below go through this
// one loosely typed view of a table (every one of them has a text `id`).
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
type AnyTable = any;
const tableOf = (group: ChangeSetGroup): AnyTable => TABLES[group];

/** The branch and dates an action works on. */
export type ScheduleScope = { branchId: string; from: string; to: string };

export type ScheduleState = Record<ChangeSetGroup, ScheduleRow[]>;

export interface ScheduleChangeSet {
  version: 1;
  scope: ScheduleScope;
  /** Rows the action created, as they stood right after it. */
  created: Partial<Record<ChangeSetGroup, ScheduleRow[]>>;
  /** Rows the action changed: before it and right after it. */
  updated: Partial<Record<ChangeSetGroup, Array<{ before: ScheduleRow; after: ScheduleRow }>>>;
  /** Rows the action deleted, in full. */
  deleted: Partial<Record<ChangeSetGroup, ScheduleRow[]>>;
}

/** A row as JSON keeps it: dates as ISO text, no undefined fields. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Key order does not matter (jsonb reorders keys); everything else does. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}
export const sameScheduleRow = (a: unknown, b: unknown): boolean => canonical(plain(a)) === canonical(plain(b));

const addDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

/** The week a week start names: Monday to Sunday. */
export const weekScope = (branchId: string, weekStartDate: string): ScheduleScope => ({
  branchId,
  from: weekStartDate.slice(0, 10),
  to: addDays(weekStartDate.slice(0, 10), 6),
});

/**
 * Everything an action on this branch and these dates can create, change or
 * delete: the branch's shift rows and their roles (a template adds rows that
 * start today, whatever week it is applied to), the shifts on those rows in
 * the dates with their breaks and duty blocks, the time off that starts in the
 * dates, and the week plans of those weeks.
 */
export async function captureScheduleState(scope: ScheduleScope, tenantId: string, executor: Executor = db): Promise<ScheduleState> {
  const park = (table: string) => scheduleParkPredicate(table, tenantId);
  const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const weekPlans = await executor.select().from(scheduleWeekPlans).where(and(
    eq(scheduleWeekPlans.branchId, scope.branchId),
    sql`${scheduleWeekPlans.weekStartDate} >= ${addDays(scope.from, -6)}::date`,
    sql`${scheduleWeekPlans.weekStartDate} <= ${scope.to}::date`,
    park("schedule_week_plans"),
  ));
  const shiftRows = await executor.select().from(scheduleShiftRows)
    .where(and(eq(scheduleShiftRows.branchId, scope.branchId), park("schedule_shift_rows")));
  const rowIds = shiftRows.map((row) => row.id);
  const rowRoles = rowIds.length
    ? await executor.select().from(scheduleShiftRowRoles)
      .where(and(inArray(scheduleShiftRowRoles.shiftRowId, rowIds), park("schedule_shift_row_roles")))
    : [];
  const assignments = rowIds.length
    ? await executor.select().from(scheduleAssignments).where(and(
      inArray(scheduleAssignments.shiftRowId, rowIds),
      sql`${scheduleAssignments.shiftDate} >= ${scope.from}::date`,
      sql`${scheduleAssignments.shiftDate} <= ${scope.to}::date`,
      park("schedule_assignments"),
    ))
    : [];
  const assignmentIds = assignments.map((assignment) => assignment.id);
  const breaks = assignmentIds.length
    ? await executor.select().from(scheduleShiftBreaks)
      .where(and(inArray(scheduleShiftBreaks.assignmentId, assignmentIds), park("schedule_shift_breaks")))
    : [];
  const blocks = assignmentIds.length
    ? await executor.select().from(dutyBlocks)
      .where(and(inArray(dutyBlocks.assignmentId, assignmentIds), park("duty_blocks")))
    : [];
  const timeOff = await executor.select().from(employeeTimeOff).where(and(
    eq(employeeTimeOff.branchId, scope.branchId),
    sql`${employeeTimeOff.startDate}::date >= ${scope.from}::date`,
    sql`${employeeTimeOff.startDate}::date <= ${scope.to}::date`,
    park("employee_time_off"),
  ));
  return plain({
    weekPlans: [...weekPlans].sort(byId),
    shiftRows: [...shiftRows].sort(byId),
    rowRoles: [...rowRoles].sort(byId),
    assignments: [...assignments].sort(byId),
    breaks: [...breaks].sort(byId),
    dutyBlocks: [...blocks].sort(byId),
    timeOff: [...timeOff].sort(byId),
  }) as ScheduleState;
}

/** What changed between two readings of the same scope. */
export function diffScheduleStates(scope: ScheduleScope, before: ScheduleState, after: ScheduleState): ScheduleChangeSet {
  const changeSet: ScheduleChangeSet = { version: 1, scope, created: {}, updated: {}, deleted: {} };
  for (const group of CHANGE_SET_GROUPS) {
    const was = new Map(before[group].map((row) => [row.id, row]));
    const is = new Map(after[group].map((row) => [row.id, row]));
    const created = after[group].filter((row) => !was.has(row.id));
    const deleted = before[group].filter((row) => !is.has(row.id));
    const updated = after[group]
      .filter((row) => was.has(row.id) && !sameScheduleRow(was.get(row.id), row))
      .map((row) => ({ before: was.get(row.id)!, after: row }));
    if (created.length) changeSet.created[group] = created;
    if (updated.length) changeSet.updated[group] = updated;
    if (deleted.length) changeSet.deleted[group] = deleted;
  }
  return changeSet;
}

/** Runs one action and returns what it changed in the scope. */
export async function recordScheduleChange<T>(
  scope: ScheduleScope,
  tenantId: string,
  action: () => Promise<T>,
): Promise<{ result: T; changeSet: ScheduleChangeSet }> {
  const before = await captureScheduleState(scope, tenantId);
  const result = await action();
  const after = await captureScheduleState(scope, tenantId);
  return { result, changeSet: diffScheduleStates(scope, before, after) };
}

/** A stored change set this code can read, or null. */
export function readScheduleChangeSet(value: unknown): ScheduleChangeSet | null {
  if (!value || typeof value !== "object") return null;
  const changeSet = value as Partial<ScheduleChangeSet>;
  const scope = changeSet.scope as Partial<ScheduleScope> | undefined;
  if (changeSet.version !== 1 || !scope || typeof scope.branchId !== "string") return null;
  for (const part of ["created", "updated", "deleted"] as const) {
    const groups = changeSet[part];
    if (!groups || typeof groups !== "object") return null;
    for (const [group, rows] of Object.entries(groups)) {
      if (!(CHANGE_SET_GROUPS as readonly string[]).includes(group) || !Array.isArray(rows)) return null;
      for (const entry of rows as unknown[]) {
        const records = part === "updated" ? [(entry as { before?: unknown })?.before, (entry as { after?: unknown })?.after] : [entry];
        if (records.some((row) => !row || typeof row !== "object" || typeof (row as { id?: unknown }).id !== "string")) return null;
      }
    }
  }
  return changeSet as ScheduleChangeSet;
}

export interface ScheduleUndoSkip {
  kind: ChangeSetGroup;
  id: string;
  reason: string;
}

export interface ScheduleUndoResult {
  /** Rows the action created that the undo removed. */
  removed: number;
  /** Rows the action deleted that the undo put back. */
  putBack: number;
  /** Rows the action changed that the undo changed back. */
  changedBack: number;
  /** Rows the undo left as they are, each with the reason. */
  skipped: ScheduleUndoSkip[];
  /** What the undo itself did, as a change set of its own. */
  changeSet: ScheduleChangeSet;
}

/** Plain words for the reasons, so a toast can name them. */
export const UNDO_SKIP_REASONS = {
  alreadyRemoved: "already removed",
  alreadyBack: "already back",
  changedSince: "changed since",
  removedSince: "removed since",
  inUse: "still has shifts on it",
  rolesChanged: "its roles changed since",
  heldByLaterRows: "has a duty block or a hand-set break added or changed since",
  slotTaken: "that slot is taken now",
  dayTaken: "that day already has time off",
  parentGone: "what it belonged to no longer exists",
} as const;

const FOREIGN_KEY_VIOLATION = "23503";
const UNIQUE_VIOLATION = "23505";
const pgCode = (error: unknown): string | undefined => {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};

/** A stored row as values for its table: dates back to Date, the park group's own. */
function rowValues(group: ChangeSetGroup, row: ScheduleRow, tenantId: string): Record<string, unknown> {
  const columns = getTableColumns(TABLES[group]) as Record<string, { columnType: string }>;
  const values: Record<string, unknown> = {};
  for (const [key, column] of Object.entries(columns)) {
    if (!(key in row)) continue;
    const value = row[key];
    values[key] = column.columnType === "PgTimestamp" && typeof value === "string" ? new Date(value) : value;
  }
  values.tenantId = tenantId;
  return values;
}

/**
 * Reverses one change set (see the top of this file). Runs in one
 * transaction; `inside` runs at its end, in the same transaction, with the
 * result (the route writes the undo's own history entry there). Returns the
 * result and every shift row and date it touched, whose automatic breaks the
 * caller works out again once it has committed.
 */
export async function undoScheduleChangeSet(
  changeSet: ScheduleChangeSet,
  tenantId: string,
  inside?: (tx: Executor, result: ScheduleUndoResult) => Promise<void>,
): Promise<{ result: ScheduleUndoResult; touched: Array<{ shiftRowId: string; shiftDate: string }> }> {
  return db.transaction(async (tx) => {
    const park = (group: ChangeSetGroup) => scheduleParkPredicate(CHANGE_SET_TABLE_NAMES[group], tenantId);
    const skipped: ScheduleUndoSkip[] = [];
    const skip = (kind: ChangeSetGroup, id: string, reason: string) => skipped.push({ kind, id, reason });
    const own: ScheduleChangeSet = { version: 1, scope: changeSet.scope, created: {}, updated: {}, deleted: {} };
    const note = <K extends "created" | "deleted">(part: K, group: ChangeSetGroup, row: ScheduleRow) => {
      (own[part][group] ??= []).push(row);
    };
    const reverted: Array<{ group: ChangeSetGroup; before: ScheduleRow; id: string }> = [];
    const touched = new Map<string, { shiftRowId: string; shiftDate: string }>();
    const touch = (row: ScheduleRow) => {
      const shiftRowId = String(row.shiftRowId ?? "");
      const shiftDate = String(row.shiftDate ?? "");
      if (shiftRowId && shiftDate) touched.set(`${shiftRowId}|${shiftDate}`, { shiftRowId, shiftDate });
    };

    const current = async (group: ChangeSetGroup, ids: string[]): Promise<Map<string, ScheduleRow>> => {
      if (!ids.length) return new Map();
      const table = tableOf(group);
      const rows = (await tx.select().from(table).where(and(inArray(table.id, ids), park(group))).execute()) as ScheduleRow[];
      return new Map(rows.map((row) => [row.id, plain(row)]));
    };
    const remove = async (group: ChangeSetGroup, id: string): Promise<boolean> => {
      const table = tableOf(group);
      const gone = (await tx.delete(table).where(and(eq(table.id, id), park(group))).returning({ id: table.id })) as unknown[];
      return gone.length > 0;
    };
    /** One write in a savepoint: a row whose parent is gone, or that is back already, is skipped, not fatal. */
    const attempt = async (write: (sp: Executor) => Promise<unknown>): Promise<"ok" | "parentGone" | "exists"> => {
      try {
        await tx.transaction(async (sp) => {
          await write(sp);
        });
        return "ok";
      } catch (error) {
        const code = pgCode(error);
        if (code === FOREIGN_KEY_VIOLATION) return "parentGone";
        if (code === UNIQUE_VIOLATION) return "exists";
        throw error;
      }
    };
    const isAutoBreak = (group: ChangeSetGroup, row: ScheduleRow) => group === "breaks" && row.source === "auto_rule";

    // ── 1. Remove what it created, children first ────────────────────────────
    const created = changeSet.created;
    let removed = 0;
    for (const group of ["breaks", "dutyBlocks", "timeOff"] as const) {
      const records = (created[group] ?? []).filter((row) => !isAutoBreak(group, row));
      const now = await current(group, records.map((row) => row.id));
      for (const record of records) {
        const row = now.get(record.id);
        if (!row) skip(group, record.id, UNDO_SKIP_REASONS.alreadyRemoved);
        else if (!sameScheduleRow(row, record)) skip(group, record.id, UNDO_SKIP_REASONS.changedSince);
        else if (await remove(group, record.id)) {
          removed++;
          note("deleted", group, row);
          touch(row);
        }
      }
    }

    const createdAssignments = created.assignments ?? [];
    if (createdAssignments.length) {
      const ids = createdAssignments.map((row) => row.id);
      const now = await current("assignments", ids);
      // A shift with a duty block or a hand-set break on it now has been
      // worked on since; its automatic breaks go with it.
      const handBreaks = await tx.select({ assignmentId: scheduleShiftBreaks.assignmentId }).from(scheduleShiftBreaks)
        .where(and(inArray(scheduleShiftBreaks.assignmentId, ids), ne(scheduleShiftBreaks.source, "auto_rule"), park("breaks")));
      const blocks = await tx.select({ assignmentId: dutyBlocks.assignmentId }).from(dutyBlocks)
        .where(and(inArray(dutyBlocks.assignmentId, ids), park("dutyBlocks")));
      const held = new Set([...handBreaks, ...blocks].map((row) => row.assignmentId));
      for (const record of createdAssignments) {
        const row = now.get(record.id);
        if (!row) skip("assignments", record.id, UNDO_SKIP_REASONS.alreadyRemoved);
        else if (!sameScheduleRow(row, record)) skip("assignments", record.id, UNDO_SKIP_REASONS.changedSince);
        else if (held.has(record.id)) skip("assignments", record.id, UNDO_SKIP_REASONS.heldByLaterRows);
        else if (await remove("assignments", record.id)) {
          removed++;
          note("deleted", "assignments", row);
          touch(row);
        }
      }
    }

    const createdRows = created.shiftRows ?? [];
    const createdRoles = created.rowRoles ?? [];
    const createdRowIds = new Set(createdRows.map((row) => row.id));
    if (createdRows.length) {
      const ids = createdRows.map((row) => row.id);
      const now = await current("shiftRows", ids);
      const inUse = new Set((await tx.select({ shiftRowId: scheduleAssignments.shiftRowId }).from(scheduleAssignments)
        .where(and(inArray(scheduleAssignments.shiftRowId, ids), park("assignments")))).map((row) => row.shiftRowId));
      const rolesNow = (await tx.select().from(scheduleShiftRowRoles)
        .where(and(inArray(scheduleShiftRowRoles.shiftRowId, ids), park("rowRoles")))).map((row) => plain(row) as ScheduleRow);
      const recordedRoles = new Map(createdRoles.map((role) => [role.id, role]));
      for (const record of createdRows) {
        const row = now.get(record.id);
        const roles = rolesNow.filter((role) => role.shiftRowId === record.id);
        if (!row) skip("shiftRows", record.id, UNDO_SKIP_REASONS.alreadyRemoved);
        else if (!sameScheduleRow(row, record)) skip("shiftRows", record.id, UNDO_SKIP_REASONS.changedSince);
        else if (inUse.has(record.id)) skip("shiftRows", record.id, UNDO_SKIP_REASONS.inUse);
        else if (roles.some((role) => !recordedRoles.has(role.id) || !sameScheduleRow(role, recordedRoles.get(role.id))) ||
          createdRoles.some((role) => role.shiftRowId === record.id && !roles.some((now) => now.id === role.id))) {
          skip("shiftRows", record.id, UNDO_SKIP_REASONS.rolesChanged);
        } else {
          for (const role of roles) {
            if (await remove("rowRoles", role.id)) {
              removed++;
              note("deleted", "rowRoles", role);
            }
          }
          if (await remove("shiftRows", record.id)) {
            removed++;
            note("deleted", "shiftRows", row);
          }
        }
      }
    }
    // Roles it added to a row it did not create.
    const looseRoles = createdRoles.filter((role) => !createdRowIds.has(String(role.shiftRowId)));
    if (looseRoles.length) {
      const now = await current("rowRoles", looseRoles.map((role) => role.id));
      for (const record of looseRoles) {
        const row = now.get(record.id);
        if (!row) skip("rowRoles", record.id, UNDO_SKIP_REASONS.alreadyRemoved);
        else if (!sameScheduleRow(row, record)) skip("rowRoles", record.id, UNDO_SKIP_REASONS.changedSince);
        else if (await remove("rowRoles", record.id)) {
          removed++;
          note("deleted", "rowRoles", row);
        }
      }
    }

    const createdPlans = created.weekPlans ?? [];
    if (createdPlans.length) {
      const ids = createdPlans.map((row) => row.id);
      const now = await current("weekPlans", ids);
      const usedByShifts = await tx.select({ id: scheduleAssignments.weekPlanId }).from(scheduleAssignments)
        .where(and(inArray(scheduleAssignments.weekPlanId, ids), park("assignments")));
      const usedByRows = await tx.select({ id: scheduleShiftRows.weekPlanId }).from(scheduleShiftRows)
        .where(and(inArray(scheduleShiftRows.weekPlanId, ids), park("shiftRows")));
      const used = new Set([...usedByShifts, ...usedByRows].map((row) => row.id));
      for (const record of createdPlans) {
        const row = now.get(record.id);
        if (!row) skip("weekPlans", record.id, UNDO_SKIP_REASONS.alreadyRemoved);
        else if (!sameScheduleRow(row, record)) skip("weekPlans", record.id, UNDO_SKIP_REASONS.changedSince);
        else if (used.has(record.id)) skip("weekPlans", record.id, UNDO_SKIP_REASONS.inUse);
        else if (await remove("weekPlans", record.id)) {
          removed++;
          note("deleted", "weekPlans", row);
        }
      }
    }

    // ── 2. Put back what it deleted, parents first ───────────────────────────
    const deleted = changeSet.deleted;
    let putBack = 0;
    const planMap = new Map<string, string>();
    const mapPlan = (row: ScheduleRow): ScheduleRow =>
      typeof row.weekPlanId === "string" && planMap.has(row.weekPlanId) ? { ...row, weekPlanId: planMap.get(row.weekPlanId) } : row;
    const putBackRow = async (group: ChangeSetGroup, record: ScheduleRow) => {
      const row = mapPlan(record);
      const outcome = await attempt((sp) => sp.insert(tableOf(group)).values(rowValues(group, row, tenantId)));
      if (outcome === "ok") {
        putBack++;
        note("created", group, row);
        touch(row);
      } else {
        skip(group, record.id, outcome === "exists" ? UNDO_SKIP_REASONS.alreadyBack : UNDO_SKIP_REASONS.parentGone);
      }
    };

    for (const record of deleted.weekPlans ?? []) {
      const [exists] = await current("weekPlans", [record.id]).then((m) => [...m.values()]);
      if (exists) {
        skip("weekPlans", record.id, UNDO_SKIP_REASONS.alreadyBack);
        continue;
      }
      // Another plan made for the same week since takes this one's place.
      const [sameWeek] = await tx.select({ id: scheduleWeekPlans.id }).from(scheduleWeekPlans).where(and(
        eq(scheduleWeekPlans.branchId, String(record.branchId)),
        sql`${scheduleWeekPlans.weekStartDate} = ${String(record.weekStartDate)}::date`,
        park("weekPlans"),
      )).limit(1);
      if (sameWeek) planMap.set(record.id, sameWeek.id);
      else await putBackRow("weekPlans", record);
    }

    for (const group of ["shiftRows", "rowRoles", "assignments", "breaks", "dutyBlocks", "timeOff"] as const) {
      const records = (deleted[group] ?? []).filter((row) => !isAutoBreak(group, row));
      if (!records.length) continue;
      const now = await current(group, records.map((row) => row.id));
      for (const record of records) {
        if (now.has(record.id)) {
          skip(group, record.id, UNDO_SKIP_REASONS.alreadyBack);
          continue;
        }
        if (group === "rowRoles") {
          const [taken] = await tx.select({ id: scheduleShiftRowRoles.id }).from(scheduleShiftRowRoles).where(and(
            eq(scheduleShiftRowRoles.shiftRowId, String(record.shiftRowId)),
            eq(scheduleShiftRowRoles.roleId, String(record.roleId)),
            park("rowRoles"),
          )).limit(1);
          if (taken) {
            skip(group, record.id, UNDO_SKIP_REASONS.alreadyBack);
            continue;
          }
        }
        if (group === "assignments") {
          const person = typeof record.employeeId === "string"
            ? eq(scheduleAssignments.employeeId, record.employeeId)
            : typeof record.casualWorkerId === "string"
              ? eq(scheduleAssignments.casualWorkerId, record.casualWorkerId)
              : sql`${scheduleAssignments.employeeId} IS NULL AND ${scheduleAssignments.casualWorkerId} IS NULL`;
          const [taken] = await tx.select({ id: scheduleAssignments.id }).from(scheduleAssignments).where(and(
            eq(scheduleAssignments.shiftRowId, String(record.shiftRowId)),
            sql`${scheduleAssignments.shiftDate} = ${String(record.shiftDate)}::date`,
            person,
            park("assignments"),
          )).limit(1);
          if (taken) {
            skip(group, record.id, UNDO_SKIP_REASONS.slotTaken);
            continue;
          }
        }
        if (group === "timeOff") {
          const [taken] = await tx.select({ id: employeeTimeOff.id }).from(employeeTimeOff).where(and(
            eq(employeeTimeOff.employeeId, String(record.employeeId)),
            sql`${employeeTimeOff.startDate}::date = ${String(record.startDate)}::timestamp::date`,
            park("timeOff"),
          )).limit(1);
          if (taken) {
            skip(group, record.id, UNDO_SKIP_REASONS.dayTaken);
            continue;
          }
        }
        await putBackRow(group, record);
      }
    }

    // ── 3. Change back what it changed ───────────────────────────────────────
    let changedBack = 0;
    for (const group of CHANGE_SET_GROUPS) {
      const entries = (changeSet.updated[group] ?? []).filter((entry) => !isAutoBreak(group, entry.after));
      if (!entries.length) continue;
      const now = await current(group, entries.map((entry) => entry.after.id));
      for (const entry of entries) {
        const row = now.get(entry.after.id);
        if (!row) {
          skip(group, entry.after.id, UNDO_SKIP_REASONS.removedSince);
          continue;
        }
        if (!sameScheduleRow(row, entry.after)) {
          skip(group, entry.after.id, UNDO_SKIP_REASONS.changedSince);
          continue;
        }
        const before = mapPlan(entry.before);
        const { id: _id, ...fields } = rowValues(group, before, tenantId);
        const table = tableOf(group);
        const outcome = await attempt((sp) => sp.update(table).set(fields).where(and(eq(table.id, entry.after.id), park(group))));
        if (outcome === "ok") {
          changedBack++;
          reverted.push({ group, before: row, id: entry.after.id });
          touch(row);
          touch(before);
        } else {
          skip(group, entry.after.id, UNDO_SKIP_REASONS.parentGone);
        }
      }
    }

    // The undo's own record: what it put back and changed back, as they stand now.
    for (const group of CHANGE_SET_GROUPS) {
      const ids = (own.created[group] ?? []).map((row) => row.id);
      if (ids.length) {
        const now = await current(group, ids);
        own.created[group] = ids.map((id) => now.get(id)).filter((row): row is ScheduleRow => !!row);
      }
    }
    for (const { group, before, id } of reverted) {
      const [after] = [...(await current(group, [id])).values()];
      if (after) (own.updated[group] ??= []).push({ before, after });
    }

    const result: ScheduleUndoResult = { removed, putBack, changedBack, skipped, changeSet: own };
    if (inside) await inside(tx, result);
    return { result, touched: [...touched.values()] };
  });
}
