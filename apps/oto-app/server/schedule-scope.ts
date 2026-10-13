import type { RequestHandler } from "express";
import { sql, type SQL } from "drizzle-orm";
import { db } from "./db";

/** Scheduling keeps its existing branch rules inside one park group. */
export class ScheduleScopeError extends Error {
  readonly status = 404;
  constructor() { super("Scheduling record not found"); }
}

const entities = {
  branch: "branches", department: "departments", employee: "employees",
  casualWorker: "casual_workers", week: "schedule_week_plans", group: "shift_groups",
  row: "schedule_shift_rows", assignment: "schedule_assignments", template: "schedule_templates",
  timeOff: "employee_time_off", dutyType: "duty_types", dutyBlock: "duty_blocks",
  history: "schedule_audit_log", role: "roles", rowRole: "schedule_shift_row_roles", shiftBreak: "schedule_shift_breaks",
} as const;
type Entity = keyof typeof entities;
type RecordData = Record<string, unknown>;
const parents: Partial<Record<Entity, Record<string, Entity>>> = {
  employee: { branch_id: "branch", primary_department_id: "department" },
  casualWorker: { branch_id: "branch" },
  week: { branch_id: "branch" }, group: { branch_id: "branch" },
  row: { branch_id: "branch", department_id: "department", shift_group_id: "group", week_plan_id: "week" },
  assignment: { week_plan_id: "week", shift_row_id: "row", employee_id: "employee", casual_worker_id: "casualWorker", borrowed_from_branch_id: "branch", role_id: "role" },
  template: { branch_id: "branch", department_id: "department", shift_group_id: "group", source_week_plan_id: "week" },
  timeOff: { employee_id: "employee", branch_id: "branch" },
  dutyBlock: { branch_id: "branch", employee_id: "employee", assignment_id: "assignment", duty_type_id: "dutyType" },
  history: { branch_id: "branch", department_id: "department" },
  rowRole: { shift_row_id: "row", role_id: "role" },
  shiftBreak: { assignment_id: "assignment", shift_row_id: "row", branch_id: "branch", employee_id: "employee", casual_worker_id: "casualWorker" },
};

const tableParents: Record<string, Record<string, string>> = Object.fromEntries(
  Object.entries(entities).map(([kind, table]) => [table, Object.fromEntries(
    Object.entries(parents[kind as Entity] || {}).map(([column, parent]) => [column, entities[parent]]),
  )]),
);
Object.assign(tableParents, {
  employee_roles: { employee_id: "employees", role_id: "roles" },
  employee_changes: { employee_id: "employees", old_branch_id: "branches", new_branch_id: "branches", old_department_id: "departments", new_department_id: "departments" },
  schedule_shift_row_roles: { shift_row_id: "schedule_shift_rows", role_id: "roles" },
  schedule_shift_breaks: { assignment_id: "schedule_assignments", shift_row_id: "schedule_shift_rows", branch_id: "branches", employee_id: "employees", casual_worker_id: "casual_workers" },
  schedule_template_rows: { template_id: "schedule_templates", department_id: "departments", shift_group_id: "shift_groups" },
  schedule_template_row_roles: { template_row_id: "schedule_template_rows", role_id: "roles" },
  schedule_template_assignments: { template_row_id: "schedule_template_rows", employee_id: "employees" },
  schedule_template_time_off: { template_id: "schedule_templates", employee_id: "employees" },
  schedule_template_duty_blocks: { template_assignment_id: "schedule_template_assignments", duty_type_id: "duty_types" },
});
const inheritedTenant = new Set(["roles", "employee_roles", "employee_changes", "schedule_template_assignments", "schedule_template_duty_blocks"]);

/** Include every canonical parent in the SQL boundary, even for historical mixed links. */
export function scheduleParkPredicate(tableName: string, tenantId?: string): SQL | undefined {
  if (tenantId === undefined) return undefined; // Non-request internal callers retain their contract.
  if (!tenantId || !Object.hasOwn(tableParents, tableName)) throw new ScheduleScopeError();
  let sequence = 0;
  const column = (alias: string, name: string) => sql.raw('"' + alias + '"."' + name + '"');
  const build = (table: string, alias: string): SQL => {
    const conditions: SQL[] = inheritedTenant.has(table) ? [sql`true`] : [sql`${column(alias, "tenant_id")}=${tenantId}`];
    for (const [field, parent] of Object.entries(tableParents[table]!)) {
      const parentAlias = "schedule_parent_" + sequence++;
      conditions.push(sql`(${column(alias, field)} IS NULL OR EXISTS (
        SELECT 1 FROM ${sql.raw('"otoapp"."' + parent + '"')} AS ${sql.raw('"' + parentAlias + '"')}
        WHERE ${column(parentAlias, "id")}=${column(alias, field)} AND (${build(parent, parentAlias)})
      ))`);
    }
    return sql.join(conditions, sql` AND `);
  };
  return build(tableName, tableName);
}

function scopeReader(tenantId: string) {
  const seen = new Map<string, RecordData>();
  const read = async (kind: Entity, id: unknown, allowMissing = false): Promise<RecordData | undefined> => {
    if (typeof id !== "string" || !id) throw new ScheduleScopeError();
    const cacheKey = kind + ":" + id;
    if (seen.has(cacheKey)) return seen.get(cacheKey);
    const result = await db.execute(sql`SELECT * FROM ${sql.raw('"otoapp"."' + entities[kind] + '"')} WHERE id::text=${id}`);
    const row = result.rows[0] as RecordData | undefined;
    if (!row && allowMissing) return undefined;
    // Role definitions are shared metadata (Q54); their schedule links remain park-owned.
    if (!row || (kind !== "role" && row.tenant_id !== tenantId)) throw new ScheduleScopeError();
    seen.set(cacheKey, row);
    for (const [column, parent] of Object.entries(parents[kind] || {})) {
      if (row[column] != null) await read(parent, row[column]);
    }
    return row;
  };
  return read;
}

/** Storage writers can enforce the same parent placement without an HTTP request. */
export async function assertScheduleWriteScope(value: RecordData, tenantId: string): Promise<void> {
  if (!tenantId || (value.tenantId != null && value.tenantId !== tenantId)) throw new ScheduleScopeError();
  const read = scopeReader(tenantId);
  const fields: Record<string, Entity> = {
    branchId: "branch", borrowedFromBranchId: "branch", departmentId: "department",
    shiftGroupId: "group", weekPlanId: "week", shiftRowId: "row", employeeId: "employee",
    casualWorkerId: "casualWorker", assignmentId: "assignment", dutyTypeId: "dutyType",
    templateId: "template", sourceWeekPlanId: "week", roleId: "role",
  };
  for (const [field, kind] of Object.entries(fields)) {
    if (value[field] != null) await read(kind, value[field]);
  }
  if (value.roleIds != null) {
    if (!Array.isArray(value.roleIds)) throw new ScheduleScopeError();
    for (const id of value.roleIds) await read("role", id);
  }
}

/** Validate historical JSON before any restore can delete or recreate live rows. */
export async function assertScheduleSnapshotScope(value: unknown, tenantId: string): Promise<void> {
  if (!tenantId || !value || typeof value !== "object") throw new ScheduleScopeError();
  const snapshot = value as RecordData;
  const read = scopeReader(tenantId);
  const local = new Map<string, RecordData>();
  const camel = (s: string) => s.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
  const groups: Array<[string, Entity | undefined]> = [
    ["shiftRows", "row"], ["assignments", "assignment"], ["rowRoles", "rowRole"],
    ["breaks", "shiftBreak"], ["timeOff", "timeOff"],
  ];
  const records: Array<{ row: RecordData; kind?: Entity }> = [];
  if (snapshot.weekPlan) records.push({ row: snapshot.weekPlan as RecordData, kind: "week" });
  for (const [field, kind] of groups) {
    if (snapshot[field] != null && !Array.isArray(snapshot[field])) throw new ScheduleScopeError();
    for (const row of (snapshot[field] || []) as RecordData[]) records.push({ row, kind });
  }
  if (!snapshot.weekPlan && !snapshot.meta) throw new ScheduleScopeError();
  for (const { row, kind } of records) {
    if (!row || typeof row !== "object" || row.tenantId !== tenantId || typeof row.id !== "string") throw new ScheduleScopeError();
    if (kind) {
      await read(kind, row.id, true); // A historical ID must not collide with another park's row.
      local.set(kind + ":" + row.id, row);
    }
  }
  const reference = async (kind: Entity, id: unknown) => {
    if (id == null) return;
    if (typeof id !== "string" || !id) throw new ScheduleScopeError();
    if (!local.has(kind + ":" + id)) await read(kind, id);
  };
  const common: Record<string, Entity> = {
    branchId: "branch", departmentId: "department", shiftGroupId: "group", weekPlanId: "week",
    shiftRowId: "row", assignmentId: "assignment", employeeId: "employee", casualWorkerId: "casualWorker",
    borrowedFromBranchId: "branch", roleId: "role", dutyTypeId: "dutyType",
  };
  for (const { row, kind } of records) {
    for (const [field, parent] of Object.entries(common)) await reference(parent, row[field]);
    for (const [field, parent] of Object.entries(kind ? parents[kind] || {} : {})) await reference(parent, row[camel(field)]);
  }
  if (snapshot.meta) {
    const meta = snapshot.meta as RecordData;
    await reference("branch", meta.branchId);
    await reference("department", meta.departmentId);
  }
}

/** Explicit request references are all checked before the original handler runs. */
export const requireSchedulePark: RequestHandler = (req, res, next) => {
  void (async () => {
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ message: "Park group context required" });
    const read = scopeReader(tenantId);
    const route = String(req.route.path);
    let pathKind: Entity | undefined;
    if (route.includes("/shift-rows/:id")) pathKind = "row";
    else if (route.includes("/shift-groups/:id")) pathKind = "group";
    else if (route.includes("/assignments/:id")) pathKind = "assignment";
    else if (route.includes("/templates/:id")) pathKind = "template";
    else if (route.includes("/week/:id")) pathKind = "week";
    else if (route.includes("/audit-log/:id")) pathKind = "history";
    else if (route.includes("/duty-blocks/:id")) pathKind = "dutyBlock";
    else if (route.includes("/duty-types/:id")) pathKind = "dutyType";
    if (pathKind) {
      const row = await read(pathKind, req.params.id);
      if (pathKind === "history" && route.endsWith("/restore") && row?.snapshot_data) {
        await assertScheduleSnapshotScope(row.snapshot_data, tenantId);
      }
    }
    const fields: Record<string, Entity> = {
      branchId: "branch", borrowedFromBranchId: "branch", departmentId: "department",
      shiftGroupId: "group", targetGroupId: "group", weekPlanId: "week", shiftRowId: "row",
      targetRowId: "row", employeeId: "employee", casualWorkerId: "casualWorker", roleId: "role",
      dutyTypeId: "dutyType", assignmentId: "assignment", keepAssignmentId: "assignment",
    };
    for (const values of [req.params, req.query, req.body || {}]) {
      for (const [field, kind] of Object.entries(fields)) {
        if (values[field] != null && values[field] !== "") await read(kind, values[field]);
      }
    }
    const body = req.body || {};
    const arrays: Record<string, Entity> = {
      sourceRowIds: "row", employeeIds: "employee", roleIds: "role",
      deleteAssignmentIds: "assignment", deleteDayOffIds: "timeOff",
    };
    if (route.endsWith("/reorder")) arrays.orderedIds = route.includes("shift-groups") ? "group" : "row";
    for (const [field, kind] of Object.entries(arrays)) {
      if (body[field] == null) continue;
      if (!Array.isArray(body[field])) throw new ScheduleScopeError();
      for (const id of body[field]) await read(kind, id);
    }
    if (Array.isArray(body.conflictResolutions)) {
      for (const resolution of body.conflictResolutions) await read("assignment", resolution?.sourceAssignmentId);
    }
    next();
  })().catch(error => {
    if (error instanceof ScheduleScopeError) res.status(404).json({ message: error.message });
    else next(error);
  });
};
