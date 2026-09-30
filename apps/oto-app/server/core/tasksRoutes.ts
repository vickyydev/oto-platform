import { Router, Request, Response } from "express";
import { db } from "../db";
import { eq, and, gte, lte, inArray, sql, desc, or, isNull } from "drizzle-orm";
import { format } from "date-fns";
import { z } from "zod";
import { requireAuth } from "../auth";
import { canUserAccessBranch } from "../auth-middleware";
import { STORAGE_ENV_PREFIX } from "../config/env";
import { uploadToObjectStorage, fileExistsInObjectStorage } from "../file-storage";
import { presignedUploadUrl } from "../storage/presignedUpload";
import { fixMulterFilenames } from "../middleware/fixMulterFilenames";
import { tenants, users, files, employees, accessPolicies, people, branches, operators, employeeRoles as employeeRolesTable, DEFAULT_TENANT_SLUG } from "../../shared/schema";
import {
  getTaskStakeholderUserIds,
  createTaskStatusNotification,
  createTaskAssignedNotification,
  createTaskAttachmentNotification,
  createTaskChecklistNotification,
  createTaskDueDateNotification,
  createTaskPriorityNotification,
  createTaskEscalatedNotification,
  createTaskDescriptionNotification,
} from "../notification-service";
import multer from "multer";
import {
  tasks,
  taskQuestions,
  taskCompletions,
  taskActivities,
  taskAttachments,
  taskChecklistItems,
  taskAssignments,
  insertTaskSchema,
  insertTaskCompletionSchema,
} from "../db/coreSchema";
import { generateInstanceForDefinition } from "./taskGeneration";

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
});

const router = Router();

async function getDefaultTenantId(): Promise<string> {
  const result = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(eq(tenants.slug, DEFAULT_TENANT_SLUG))
    .limit(1);
  if (!result.length) throw new Error(`Default tenant ${DEFAULT_TENANT_SLUG} not found`);
  return result[0].id;
}

function getUserAllowedBranchIds(req: Request): string[] | null {
  const userWithAccess = req.userWithAccess;
  if (!userWithAccess) return [];
  if (userWithAccess.hasAllBranchesAccess) return null;
  return userWithAccess.allowedBranchIds;
}

async function getUserDisplayName(userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  try {
    const [result] = await db
      .select({ fullName: users.fullName, nickname: employees.nickname, empFullName: employees.fullName })
      .from(users)
      .leftJoin(employees, and(eq(users.id, employees.userId), eq(employees.status, "active")))
      .where(eq(users.id, userId))
      .limit(1);
    if (!result) return null;
    return result.nickname || result.empFullName || result.fullName;
  } catch {
    return null;
  }
}

async function logTaskActivity(
  tenantId: string,
  taskId: string,
  branchId: string | null | undefined,
  activityType: string,
  description: string,
  userId: string | null | undefined,
  metadata?: Record<string, unknown>
) {
  try {
    await db.insert(taskActivities).values({
      tenantId,
      taskId,
      branchId: branchId ?? null,
      activityType: activityType as any,
      description,
      userId: userId ?? null,
      metadata: metadata ?? null,
    });
  } catch (err) {
    console.error("[TaskActivity] Failed to log activity:", err);
  }
}

const listQuerySchema = z.object({
  branchId: z.string().optional(),
  status: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  myOnly: z.string().optional(),
  showArchived: z.string().optional(),
  showStagnant: z.string().optional(),
  showEscalated: z.string().optional(),
  hideRecurring: z.string().optional(),
  taskScope: z.enum(["all", "my_tasks", "my_department", "assigned_by_me"]).optional(),
  taskLevel: z.string().optional(),
  assignedTo: z.string().optional(),
});

const BRANCH_TZ = "Asia/Bangkok";

function formatInBranchTZ(date: Date, fmt: "date" | "time" | "datetime"): string {
  if (fmt === "date") {
    return new Intl.DateTimeFormat("sv-SE", { timeZone: BRANCH_TZ }).format(date);
  }
  if (fmt === "time") {
    return new Intl.DateTimeFormat("en-GB", { timeZone: BRANCH_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  }
  return new Intl.DateTimeFormat("sv-SE", { timeZone: BRANCH_TZ, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

function formatDateDisplay(date: Date): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: BRANCH_TZ, day: "numeric", month: "short", year: "numeric" }).format(date);
}

function formatTaskResult(task: any) {
  const dueAt = task.dueAt ? new Date(task.dueAt) : null;
  const startAt = task.startAt ? new Date(task.startAt) : null;
  
  const lastMovement = task.lastMovementAt ? new Date(task.lastMovementAt) : null;
  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const isStagnant = lastMovement && 
    lastMovement < threeDaysAgo && 
    !['completed', 'cancelled'].includes(task.status);
  
  const isOverdue = dueAt && dueAt < now && task.status !== 'completed';
  
  const completedAt = task.completedAt ? new Date(task.completedAt) : null;
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const isArchived = task.archivedAt || (completedAt && completedAt < sevenDaysAgo);
  
  return {
    ...task,
    dueDate: dueAt ? formatInBranchTZ(dueAt, "date") : null,
    dueTime: dueAt ? formatInBranchTZ(dueAt, "time") : null,
    startDate: startAt ? formatInBranchTZ(startAt, "date") : null,
    assignedUserName: task.assignedEmployeeNickname || task.assignedAdvisorNickname || task.assignedEmployeeFullName || task.assignedAdvisorFullName || task.assignedUserFullName || null,
    isStagnant: !!isStagnant,
    isOverdue: !!isOverdue,
    isArchived: !!isArchived,
  };
}

function formatCompletionResult(completion: any) {
  return {
    ...completion,
    completedByName: completion.completedByNickname || completion.completedByFullName || null,
  };
}

async function batchResolveAssignments(taskIds: string[]): Promise<Record<string, Array<{ id: string; assignmentType: string; assignmentId: string; label: string }>>> {
  if (taskIds.length === 0) return {};
  const rows = await db.select().from(taskAssignments).where(inArray(taskAssignments.taskId, taskIds));
  if (rows.length === 0) return {};

  const empIds = new Set<string>();
  const advIds = new Set<string>();
  const roleIds = new Set<string>();
  const deptIds = new Set<string>();
  const branchIds = new Set<string>();

  for (const r of rows) {
    if (r.assignmentType === "employee") empIds.add(r.assignmentId);
    else if (r.assignmentType === "advisor") advIds.add(r.assignmentId);
    else if (r.assignmentType === "role") roleIds.add(r.assignmentId);
    else if (r.assignmentType === "department") deptIds.add(r.assignmentId);
    else if (r.assignmentType === "branch") branchIds.add(r.assignmentId);
  }

  const labels: Record<string, string> = {};

  if (empIds.size > 0) {
    const emps = await db.select({ id: employees.id, nickname: employees.nickname, fullName: employees.fullName }).from(employees).where(inArray(employees.id, [...empIds]));
    for (const e of emps) labels[`employee:${e.id}`] = e.nickname || e.fullName;
  }
  if (advIds.size > 0) {
    const advs = await db.select({ id: people.id, preferredName: people.preferredName, fullName: people.fullName }).from(people).where(inArray(people.id, [...advIds]));
    for (const a of advs) labels[`advisor:${a.id}`] = a.preferredName || a.fullName;
  }
  if (roleIds.size > 0) {
    const roleIdArr = [...roleIds];
    const rResult = await db.execute(sql`SELECT id, name FROM roles WHERE id IN (${sql.join(roleIdArr.map(id => sql`${id}`), sql`, `)})`);
    const rRows = Array.isArray(rResult) ? rResult : (rResult as any).rows || [];
    for (const r of rRows) labels[`role:${(r as any).id}`] = (r as any).name;
  }
  if (deptIds.size > 0) {
    const deptIdArr = [...deptIds];
    const dResult = await db.execute(sql`SELECT id, name FROM departments WHERE id IN (${sql.join(deptIdArr.map(id => sql`${id}`), sql`, `)})`);
    const dRows = Array.isArray(dResult) ? dResult : (dResult as any).rows || [];
    for (const d of dRows) labels[`department:${(d as any).id}`] = (d as any).name;
  }
  if (branchIds.size > 0) {
    const bResult = await db.select({ id: branches.id, name: branches.name }).from(branches).where(inArray(branches.id, [...branchIds]));
    for (const b of bResult) labels[`branch:${b.id}`] = b.name;
  }

  const result: Record<string, Array<{ id: string; assignmentType: string; assignmentId: string; label: string }>> = {};
  for (const r of rows) {
    if (!result[r.taskId]) result[r.taskId] = [];
    const key = `${r.assignmentType}:${r.assignmentId}`;
    result[r.taskId].push({
      id: r.id,
      assignmentType: r.assignmentType,
      assignmentId: r.assignmentId,
      label: labels[key] || r.assignmentId,
    });
  }
  return result;
}

async function attachAssignmentsToTasks(taskList: any[]): Promise<any[]> {
  const ids = taskList.map(t => t.id);
  const assignmentsMap = await batchResolveAssignments(ids);
  return taskList.map(t => ({
    ...t,
    assignments: assignmentsMap[t.id] || [],
  }));
}

// Helper function to apply taskScope filtering consistently for all users
interface LinkedEmployeeContext {
  id: string;
  roleIds: string[];
  departmentId: string | null;
  primaryDepartmentId?: string | null;
  branchIds: string[];
}

async function getLinkedEmployeeContext(userId: string): Promise<LinkedEmployeeContext | undefined> {
  const [emp] = await db
    .select({ id: employees.id, departmentId: employees.primaryDepartmentId, branchId: employees.branchId })
    .from(employees)
    .where(eq(employees.userId, userId))
    .limit(1);
  if (!emp) return undefined;
  const roleRows = await db
    .select({ roleId: employeeRolesTable.roleId })
    .from(employeeRolesTable)
    .where(eq(employeeRolesTable.employeeId, emp.id));
  return {
    id: emp.id,
    roleIds: roleRows.map(r => r.roleId),
    departmentId: emp.departmentId || null,
    branchIds: emp.branchId ? [emp.branchId] : [],
  };
}

function isTaskVisibleToEmployee(task: any, linkedEmployee: LinkedEmployeeContext | undefined, userId: string): boolean {
  if (task.assignedTo && task.assignedTo === userId) return true;
  if (linkedEmployee) {
    if (task.assignedEmployeeId && task.assignedEmployeeId === linkedEmployee.id) return true;
    if (task.assignedRoleId && linkedEmployee.roleIds.includes(task.assignedRoleId)) return true;
    if (task.assignedDepartmentId && task.assignedDepartmentId === linkedEmployee.departmentId) return true;
  }

  const newAssignments = task.assignments as Array<{ assignmentType: string; assignmentId: string }> | undefined;
  if (newAssignments && newAssignments.length > 0) {
    for (const a of newAssignments) {
      if (a.assignmentType === "employee" && linkedEmployee && a.assignmentId === linkedEmployee.id) return true;
      if (a.assignmentType === "advisor" && a.assignmentId === userId) return true;
      if (a.assignmentType === "role" && linkedEmployee && linkedEmployee.roleIds.includes(a.assignmentId)) return true;
      if (a.assignmentType === "department" && linkedEmployee && linkedEmployee.departmentId === a.assignmentId) return true;
      if (a.assignmentType === "branch" && linkedEmployee && linkedEmployee.branchIds.includes(a.assignmentId)) return true;
    }
    return false;
  }

  // Unassigned tasks are NOT visible to everyone — only to the creator
  // and managers/admins via the main task board.
  return false;
}

function applyTaskScopeFilter(
  tasks: any[], 
  taskScope: string | undefined, 
  linkedEmployee: LinkedEmployeeContext | undefined,
  userId: string
): any[] {
  if (!taskScope || taskScope === "all") {
    return tasks;
  }
  
  const employeeDepartmentId = linkedEmployee?.departmentId || linkedEmployee?.primaryDepartmentId || null;
  
  if (taskScope === "my_tasks") {
    return tasks.filter((task: any) => isTaskVisibleToEmployee(task, linkedEmployee, userId));
  } else if (taskScope === "my_department") {
    return tasks.filter((task: any) => {
      if (!employeeDepartmentId) return false;
      return task.departmentId === employeeDepartmentId || 
             task.assignedDepartmentId === employeeDepartmentId ||
             task.assignedEmployeeDepartmentId === employeeDepartmentId;
    });
  } else if (taskScope === "assigned_by_me") {
    return tasks.filter((task: any) => {
      return task.createdBy === userId;
    });
  }
  
  return tasks;
}

router.get("/assignable-users", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const [tenantOperator] = await db
      .select({ id: operators.id })
      .from(operators)
      .where(eq(operators.tenantId, tenantId))
      .limit(1);
    const operatorId = tenantOperator?.id;

    const allUsers = await db
      .select({
        id: users.id,
        fullName: users.fullName,
        role: users.role,
        nickname: sql<string | null>`COALESCE(
          (SELECT e.nickname FROM employees e WHERE e.user_id = "users"."id" LIMIT 1),
          (SELECT p.preferred_name FROM access_policies ap JOIN people p ON p.id = ap.person_id WHERE ap.core_user_id = "users"."id" LIMIT 1)
        )`.as('nickname'),
        hasEmployee: sql<boolean>`EXISTS(SELECT 1 FROM employees e WHERE e.user_id = "users"."id")`.as('has_employee'),
      })
      .from(users)
      .where(and(
        operatorId ? or(eq(users.operatorId, operatorId), isNull(users.operatorId)) : undefined,
        inArray(users.role, ['global_admin', 'operator_admin', 'admin', 'manager']),
        eq(users.isActive, true)
      ));

    const result = allUsers.map(u => ({
      id: u.id,
      fullName: u.fullName,
      nickname: u.nickname,
      displayName: u.nickname || u.fullName,
      isEmployee: u.hasEmployee,
      role: u.role,
    }));

    res.json(result);
  } catch (error) {
    console.error("Error fetching assignable users:", error);
    res.status(500).json({ message: "Failed to fetch assignable users" });
  }
});

router.get("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const query = listQuerySchema.parse(req.query);
    const tenantId = await getDefaultTenantId();
    const allowedBranches = getUserAllowedBranchIds(req);

    const conditions: any[] = [eq(tasks.tenantId, tenantId)];

    if (query.branchId) {
      if (!req.userWithAccess || !canUserAccessBranch(req.userWithAccess, query.branchId)) {
        return res.status(403).json({ message: "Access denied to this branch" });
      }
      // Include tasks for the requested branch AND global tasks (branchId IS NULL)
      conditions.push(or(eq(tasks.branchId, query.branchId), isNull(tasks.branchId)));
    } else if (allowedBranches !== null) {
      if (allowedBranches.length === 0) {
        return res.json([]);
      }
      // Include tasks for allowed branches AND global tasks (branchId IS NULL)
      conditions.push(or(inArray(tasks.branchId, allowedBranches), isNull(tasks.branchId)));
    }

    if (query.status) {
      conditions.push(eq(tasks.status, query.status as any));
    }
    if (query.from) {
      const fromDate = new Date(query.from);
      fromDate.setHours(0, 0, 0, 0);
      conditions.push(gte(tasks.dueAt, fromDate));
    }
    if (query.to) {
      const toDate = new Date(query.to);
      toDate.setHours(23, 59, 59, 999);
      conditions.push(lte(tasks.dueAt, toDate));
    }

    // Filter by task level if specified
    if (query.taskLevel) {
      conditions.push(eq(tasks.taskLevel, query.taskLevel as any));
    }
    
    // Filter by specific assignee if specified
    if (query.assignedTo) {
      conditions.push(eq(tasks.assignedTo, query.assignedTo));
    }
    
    // Filter escalated tasks if showEscalated is specified
    if (query.showEscalated === "true") {
      conditions.push(eq(tasks.escalated, true));
    }
    
    // Default: exclude archived tasks unless showArchived=true
    if (query.showArchived !== "true") {
      conditions.push(sql`${tasks.archivedAt} IS NULL`);
      // Also exclude completed tasks older than 7 days (virtual archive)
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      conditions.push(sql`(${tasks.completedAt} IS NULL OR ${tasks.completedAt} > ${sevenDaysAgo})`);
    }
    
    // Always exclude recurring task definitions from the main task list.
    // Definitions are visible via the /scheduled endpoint instead.
    // The hideRecurring flag is kept for backward compatibility but the default
    // now filters definitions regardless.
    conditions.push(eq(tasks.isRecurringDefinition, false));
    
    // "Assigned by Me" filter at SQL level - shows tasks created by the current user
    // This must be applied at SQL level to work regardless of myOnly toggle
    if (query.taskScope === "assigned_by_me" && req.user) {
      conditions.push(eq(tasks.createdBy, req.user.id));
    }

    const result = await db
      .select({
        id: tasks.id,
        branchId: tasks.branchId,
        branchName: branches.name,
        departmentId: tasks.departmentId,
        title: tasks.title,
        description: tasks.description,
        status: tasks.status,
        priority: tasks.priority,
        recurrence: tasks.recurrence,
        dueAt: tasks.dueAt,
        startAt: tasks.startAt,
        scheduledMode: tasks.scheduledMode,
        progressPercent: tasks.progressPercent,
        statusManualOverride: tasks.statusManualOverride,
        blockedReason: tasks.blockedReason,
        completedAt: tasks.completedAt,
        archivedAt: tasks.archivedAt,
        assignedTo: tasks.assignedTo,
        assignedEmployeeId: tasks.assignedEmployeeId,
        assignedRoleId: tasks.assignedRoleId,
        assignedDepartmentId: tasks.assignedDepartmentId,
        requiresPhotoEvidence: tasks.requiresPhotoEvidence,
        requiresResponses: tasks.requiresResponses,
        referencePhotoUrl: tasks.referencePhotoUrl,
        createdBy: tasks.createdBy,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        taskLevel: tasks.taskLevel,
        escalated: tasks.escalated,
        lastMovementAt: tasks.lastMovementAt,
        ownerUserId: tasks.ownerUserId,
        assignedUserEmail: users.email,
        assignedUserFullName: users.fullName,
        assignedEmployeeNickname: sql<string>`COALESCE(${employees.nickname}, (SELECT e2.nickname FROM employees e2 WHERE e2.id = ${tasks.assignedEmployeeId}))`.as('assigned_employee_nickname'),
        assignedEmployeeFullName: sql<string>`COALESCE(${employees.fullName}, (SELECT e2.full_name FROM employees e2 WHERE e2.id = ${tasks.assignedEmployeeId}))`.as('assigned_employee_full_name'),
        assignedAdvisorNickname: people.preferredName,
        assignedAdvisorFullName: people.fullName,
        assignedRoleName: sql<string>`(SELECT r.name FROM roles r WHERE r.id = ${tasks.assignedRoleId})`.as('assigned_role_name'),
        assignedDepartmentName: sql<string>`(SELECT d.name FROM departments d WHERE d.id = ${tasks.assignedDepartmentId})`.as('assigned_department_name'),
        assignedEmployeeDepartmentId: sql<string>`COALESCE(
          (SELECT e2.primary_department_id FROM employees e2 WHERE e2.id = ${tasks.assignedEmployeeId}),
          (SELECT e2.primary_department_id FROM employees e2 WHERE e2.user_id = ${tasks.assignedTo})
        )`.as('assigned_employee_department_id'),
        assignedEmployeeRoleIds: sql<string>`(SELECT string_agg(er.role_id::text, ',') FROM employee_roles er WHERE er.employee_id = COALESCE(${tasks.assignedEmployeeId}, (SELECT e2.id FROM employees e2 WHERE e2.user_id = ${tasks.assignedTo} LIMIT 1)))`.as('assigned_employee_role_ids'),
        assignedUserRole: sql<string>`COALESCE(
          (SELECT u2.role FROM users u2 WHERE u2.id = ${tasks.assignedTo}),
          (SELECT u3.role FROM users u3 JOIN employees e3 ON e3.user_id = u3.id WHERE e3.id = ${tasks.assignedEmployeeId}),
          (SELECT CASE WHEN EXISTS(SELECT 1 FROM employee_roles er JOIN roles r ON r.id = er.role_id WHERE er.employee_id = ${tasks.assignedEmployeeId} AND LOWER(r.name) = 'manager') THEN 'manager' ELSE 'staff' END)
        )`.as('assigned_user_role'),
      })
      .from(tasks)
      .leftJoin(branches, eq(tasks.branchId, branches.id))
      .leftJoin(users, eq(tasks.assignedTo, users.id))
      .leftJoin(employees, eq(employees.userId, users.id))
      .leftJoin(accessPolicies, eq(accessPolicies.coreUserId, users.id))
      .leftJoin(people, eq(people.id, accessPolicies.personId))
      .where(and(...conditions))
      .orderBy(desc(tasks.createdAt));

    // Apply assignment visibility filtering
    const userWithAccess = req.userWithAccess;
    const isAdminOrManager = userWithAccess?.role === 'global_admin' || 
                             userWithAccess?.role === 'operator_admin' || 
                             userWithAccess?.role === 'admin' || 
                             userWithAccess?.role === 'manager';
    
    const formatted = result.map(formatTaskResult);
    const withAssignments = await attachAssignmentsToTasks(formatted);
    
    const linkedEmployee = req.user ? await getLinkedEmployeeContext(req.user.id) : undefined;
    
    const withIsMine = withAssignments.map((task: any) => ({
      ...task,
      isMine: req.user ? isTaskVisibleToEmployee(task, linkedEmployee, req.user.id) : false,
    }));
    
    let finalResult = withIsMine;
    
    if (query.myOnly === "true" && isAdminOrManager && req.user && query.taskScope !== "assigned_by_me") {
      finalResult = withIsMine.filter((task: any) => task.isMine);
    } else if (!isAdminOrManager && req.user) {
      if (query.taskScope !== "assigned_by_me") {
        const filteredResult = withIsMine.filter((task: any) => task.isMine);
        finalResult = applyTaskScopeFilter(filteredResult, query.taskScope, linkedEmployee, req.user!.id);
      }
    } else if (query.taskScope && query.taskScope !== "all" && req.user) {
      finalResult = applyTaskScopeFilter(withIsMine, query.taskScope, linkedEmployee, req.user.id);
    }

    res.json(finalResult);
  } catch (error: any) {
    console.error("[Core Tasks] GET error:", error);
    res.status(500).json({ message: error.message });
  }
});

const taskQuestionSchema = z.object({
  prompt: z.string().min(1),
  questionType: z.enum(["text", "number", "boolean", "multiple_choice"]),
  options: z.array(z.string()).optional(),
  isRequired: z.boolean().optional(),
});

router.get("/scheduled", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const allowedBranches = getUserAllowedBranchIds(req);

    const conditions: any[] = [
      eq(tasks.tenantId, tenantId),
      eq(tasks.isRecurringDefinition, true),
    ];

    if (allowedBranches !== null) {
      if (allowedBranches.length === 0) return res.json([]);
      conditions.push(inArray(tasks.branchId, allowedBranches));
    }

    const scheduledTasks = await db
      .select({
        id: tasks.id,
        title: tasks.title,
        description: tasks.description,
        branchId: tasks.branchId,
        branchName: branches.name,
        recurrence: tasks.recurrence,
        weeklyDays: tasks.weeklyDays,
        monthlyDay: tasks.monthlyDay,
        preferredDueTime: tasks.preferredDueTime,
        requiresPhotoEvidence: tasks.requiresPhotoEvidence,
        requiresResponses: tasks.requiresResponses,
        status: tasks.status,
        createdAt: tasks.createdAt,
        assignedTo: tasks.assignedTo,
        assignedEmployeeId: tasks.assignedEmployeeId,
        assignedRoleId: tasks.assignedRoleId,
        assignedDepartmentId: tasks.assignedDepartmentId,
        assignedUserFullName: sql<string>`(SELECT u2.full_name FROM users u2 WHERE u2.id = ${tasks.assignedTo})`.as('assigned_user_full_name'),
        assignedEmployeeNickname: sql<string>`COALESCE(
          (SELECT e2.nickname FROM employees e2 WHERE e2.id = ${tasks.assignedEmployeeId}),
          (SELECT e2.nickname FROM employees e2 WHERE e2.user_id = ${tasks.assignedTo})
        )`.as('assigned_employee_nickname'),
        assignedEmployeeFullName: sql<string>`COALESCE(
          (SELECT e2.full_name FROM employees e2 WHERE e2.id = ${tasks.assignedEmployeeId}),
          (SELECT e2.full_name FROM employees e2 WHERE e2.user_id = ${tasks.assignedTo})
        )`.as('assigned_employee_full_name'),
        assignedAdvisorNickname: sql<string>`(SELECT p.preferred_name FROM people p JOIN access_policies ap ON ap.person_id = p.id WHERE ap.core_user_id = ${tasks.assignedTo} LIMIT 1)`.as('assigned_advisor_nickname'),
        assignedAdvisorFullName: sql<string>`(SELECT p.full_name FROM people p JOIN access_policies ap ON ap.person_id = p.id WHERE ap.core_user_id = ${tasks.assignedTo} LIMIT 1)`.as('assigned_advisor_full_name'),
        assignedRoleName: sql<string>`(SELECT r.name FROM roles r WHERE r.id = ${tasks.assignedRoleId})`.as('assigned_role_name'),
        assignedDepartmentName: sql<string>`(SELECT d.name FROM departments d WHERE d.id = ${tasks.assignedDepartmentId})`.as('assigned_department_name'),
        assignedEmployeeDepartmentId: sql<string>`COALESCE(
          (SELECT e2.primary_department_id FROM employees e2 WHERE e2.id = ${tasks.assignedEmployeeId}),
          (SELECT e2.primary_department_id FROM employees e2 WHERE e2.user_id = ${tasks.assignedTo})
        )`.as('assigned_employee_department_id'),
        assignedEmployeeRoleIds: sql<string>`(SELECT string_agg(er.role_id::text, ',') FROM employee_roles er WHERE er.employee_id = COALESCE(${tasks.assignedEmployeeId}, (SELECT e2.id FROM employees e2 WHERE e2.user_id = ${tasks.assignedTo} LIMIT 1)))`.as('assigned_employee_role_ids'),
        assignedUserRole: sql<string>`COALESCE(
          (SELECT u2.role FROM users u2 WHERE u2.id = ${tasks.assignedTo}),
          (SELECT u3.role FROM users u3 JOIN employees e3 ON e3.user_id = u3.id WHERE e3.id = ${tasks.assignedEmployeeId}),
          (SELECT CASE WHEN EXISTS(SELECT 1 FROM employee_roles er JOIN roles r ON r.id = er.role_id WHERE er.employee_id = ${tasks.assignedEmployeeId} AND LOWER(r.name) = 'manager') THEN 'manager' ELSE 'staff' END)
        )`.as('assigned_user_role'),
      })
      .from(tasks)
      .leftJoin(branches, eq(tasks.branchId, branches.id))
      .where(and(...conditions))
      .orderBy(desc(tasks.createdAt));

    const taskIds = scheduledTasks.map(row => row.id);
    const allQuestions = taskIds.length > 0
      ? await db
          .select()
          .from(taskQuestions)
          .where(inArray(taskQuestions.taskId, taskIds))
          .orderBy(taskQuestions.sortOrder)
      : [];

    const questionsByTaskId = allQuestions.reduce((acc, q) => {
      if (!acc[q.taskId]) acc[q.taskId] = [];
      acc[q.taskId].push({
        id: q.id,
        prompt: q.prompt,
        questionType: q.questionType,
        options: q.options,
        isRequired: q.isRequired,
      });
      return acc;
    }, {} as Record<string, any[]>);

    const scheduledFormatted = scheduledTasks.map(row => ({
      ...row,
      questions: questionsByTaskId[row.id] || [],
    }));
    const scheduledWithAssignments = await attachAssignmentsToTasks(scheduledFormatted);
    res.json(scheduledWithAssignments);
  } catch (error: any) {
    console.error("[Core Tasks] GET /scheduled error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.delete("/scheduled/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const { id } = req.params;

    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId), eq(tasks.isRecurringDefinition, true)))
      .limit(1);

    if (!task) {
      return res.status(404).json({ message: "Scheduled task not found" });
    }

    if (task.branchId && req.userWithAccess && !canUserAccessBranch(req.userWithAccess, task.branchId)) {
      return res.status(403).json({ message: "Access denied to this branch" });
    }

    await db.delete(taskQuestions).where(eq(taskQuestions.taskId, id));
    await db.delete(tasks).where(eq(tasks.id, id));

    res.json({ message: "Scheduled task deleted" });
  } catch (error: any) {
    console.error("[Core Tasks] DELETE /scheduled error:", error);
    res.status(500).json({ message: error.message });
  }
});

const assignmentEntrySchema = z.object({
  assignmentType: z.enum(["employee", "advisor", "role", "department", "branch"]),
  assignmentId: z.string(),
});

const createTaskSchema = z.object({
  branchId: z.string().optional(),
  branchIds: z.array(z.string()).optional(),
  departmentId: z.string().optional().nullable(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  recurrence: z.enum(["once", "daily", "weekly", "monthly"]).optional(),
  weeklyDays: z.array(z.string()).optional(),
  monthlyDay: z.number().optional().nullable(),
  scheduledMode: z.boolean().optional(),
  startAt: z.string().optional().nullable(),
  dueAt: z.string().optional().nullable(),
  preferredDueTime: z.string().optional().nullable(),
  assignedTo: z.string().optional().nullable(),
  assignedEmployeeId: z.string().optional().nullable(),
  assignedRoleId: z.string().optional().nullable(),
  assignedDepartmentId: z.string().optional().nullable(),
  assignments: z.array(assignmentEntrySchema).optional(),
  requiresPhotoEvidence: z.boolean().optional(),
  requiresResponses: z.boolean().optional(),
  questions: z.array(taskQuestionSchema).optional(),
  referencePhotoUrl: z.string().optional().nullable(),
  taskLevel: z.enum(["line", "management", "strategic"]).optional(),
  escalated: z.boolean().optional(),
  ownerUserId: z.string().optional().nullable(),
});

router.post("/", requireAuth, async (req: Request, res: Response) => {
  try {
    const body = createTaskSchema.parse(req.body);
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ message: "Task access denied" });
    if (body.referencePhotoUrl) return res.status(400).json({ message: "Add the reference photo after creating the task" });

    const targetBranchIds: string[] = body.branchIds && body.branchIds.length > 0
      ? body.branchIds
      : body.branchId ? [body.branchId] : [];

    if (targetBranchIds.length === 0) {
      return res.status(400).json({ message: "At least one branch is required" });
    }

    for (const bid of targetBranchIds) {
      if (!req.userWithAccess || !canUserAccessBranch(req.userWithAccess, bid)) {
        return res.status(403).json({ message: `Access denied to branch ${bid}` });
      }
    }

    let dueAtDate: Date | null = null;
    if (body.dueAt) {
      const rawDateStr = body.dueAt.split('T')[0];
      const timeStr = body.preferredDueTime || "18:00";
      dueAtDate = new Date(`${rawDateStr}T${timeStr}:00+07:00`);
    }

    let startAtDate: Date;
    if (body.scheduledMode && body.startAt) {
      const startStr = body.startAt.includes('+') || body.startAt.includes('Z')
        ? body.startAt : `${body.startAt}+07:00`;
      startAtDate = new Date(startStr);
      if (dueAtDate && startAtDate > dueAtDate) {
        return res.status(400).json({ message: "Start date cannot be after due date" });
      }
    } else if (dueAtDate) {
      startAtDate = dueAtDate;
    } else {
      startAtDate = new Date();
    }

    const now = new Date();
    const creatorName = await getUserDisplayName(req.user!.id);
    const createdTasks: any[] = [];

    let resolvedAssignedTo = body.assignedTo ?? null;
    if (!resolvedAssignedTo && body.assignedEmployeeId) {
      const [emp] = await db.select({ userId: employees.userId }).from(employees).where(eq(employees.id, body.assignedEmployeeId)).limit(1);
      if (emp?.userId) resolvedAssignedTo = emp.userId;
    }

    for (const branchId of targetBranchIds) {
      const [task] = await db
        .insert(tasks)
        .values({
          tenantId,
          branchId,
          departmentId: body.departmentId ?? null,
          title: body.title,
          description: body.description ?? null,
          priority: body.priority ?? "medium",
          recurrence: body.recurrence ?? "once",
          weeklyDays: body.weeklyDays ?? [],
          monthlyDay: body.monthlyDay ?? null,
          scheduledMode: body.scheduledMode ?? false,
          isRecurringDefinition: (body.recurrence ?? "once") !== "once",
          preferredDueTime: body.preferredDueTime || "18:00",
          startAt: startAtDate,
          dueAt: (body.recurrence ?? "once") !== "once" ? null : dueAtDate,
          progressPercent: 0,
          assignedTo: resolvedAssignedTo,
          assignedEmployeeId: body.assignedEmployeeId ?? null,
          assignedRoleId: body.assignedRoleId ?? null,
          assignedDepartmentId: body.assignedDepartmentId ?? null,
          requiresPhotoEvidence: body.requiresPhotoEvidence ?? false,
          requiresResponses: body.requiresResponses ?? false,
          referencePhotoUrl: body.referencePhotoUrl ?? null,
          taskLevel: body.taskLevel ?? "line",
          escalated: body.escalated ?? false,
          ownerUserId: body.ownerUserId ?? null,
          lastMovementAt: now,
          createdBy: req.user!.id,
          status: "pending",
        })
        .returning();

      if (body.assignments && body.assignments.length > 0) {
        const seen = new Set<string>();
        for (const a of body.assignments) {
          const key = `${a.assignmentType}:${a.assignmentId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          await db.insert(taskAssignments).values({
            tenantId,
            taskId: task.id,
            assignmentType: a.assignmentType as any,
            assignmentId: a.assignmentId,
          });
        }
      } else {
        // Mirror legacy single-field assignments into task_assignments so that
        // isTaskVisibleToEmployee has a single consistent place to look.
        const legacyEntries: { assignmentType: string; assignmentId: string }[] = [];
        if (body.assignedEmployeeId)
          legacyEntries.push({ assignmentType: "employee", assignmentId: body.assignedEmployeeId });
        if (body.assignedRoleId)
          legacyEntries.push({ assignmentType: "role", assignmentId: body.assignedRoleId });
        if (body.assignedDepartmentId)
          legacyEntries.push({ assignmentType: "department", assignmentId: body.assignedDepartmentId });
        if (body.assignedTo && !body.assignedEmployeeId)
          legacyEntries.push({ assignmentType: "advisor", assignmentId: body.assignedTo });
        for (const a of legacyEntries) {
          await db.insert(taskAssignments).values({
            tenantId,
            taskId: task.id,
            assignmentType: a.assignmentType as any,
            assignmentId: a.assignmentId,
          });
        }
      }

      if (body.questions && body.questions.length > 0) {
        for (let i = 0; i < body.questions.length; i++) {
          const q = body.questions[i];
          await db.insert(taskQuestions).values({
            tenantId,
            taskId: task.id,
            prompt: q.prompt,
            questionType: q.questionType as any,
            options: q.options ?? null,
            isRequired: q.isRequired ?? true,
            sortOrder: i,
          });
        }
      }

      await logTaskActivity(
        tenantId, task.id, task.branchId, "created",
        `${creatorName || "Someone"} created task "${task.title}"`,
        req.user!.id,
        { title: task.title, priority: task.priority, taskTitle: task.title }
      );

      if (task.isRecurringDefinition) {
        // Generate an instance for the task's start date so it appears in the
        // Kanban immediately — whether that's today or a future date.
        // startAtDate is UTC midnight of the calendar date the user picked,
        // which is exactly the targetDate generateInstanceForDefinition needs.
        await generateInstanceForDefinition(tenantId, task.id, startAtDate);
      }

      createdTasks.push(task);
    }

    res.status(201).json(createdTasks.length === 1 ? createdTasks[0] : createdTasks);
  } catch (error: any) {
    console.error("[Core Tasks] POST error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    res.status(500).json({ message: error.message });
  }
});

// Get tasks by tab (Today, Active, Upcoming, Completed) - MUST be before /:id route
const multiDayQuerySchema = z.object({
  tab: z.enum(["today", "active", "upcoming", "completed"]).optional(),
  branchId: z.string().optional(),
  myOnly: z.string().optional(),
});

router.get("/multi-day", requireAuth, async (req: Request, res: Response) => {
  try {
    const query = multiDayQuerySchema.parse(req.query);
    const tenantId = await getDefaultTenantId();
    const allowedBranches = getUserAllowedBranchIds(req);
    const tab = query.tab || "active";
    
    // Use Bangkok timezone (UTC+7) for date comparisons
    const nowBangkok = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Bangkok" }));
    const today = new Date(nowBangkok);
    today.setHours(0, 0, 0, 0);

    const conditions: any[] = [eq(tasks.tenantId, tenantId)];

    if (query.branchId) {
      if (!req.userWithAccess || !canUserAccessBranch(req.userWithAccess, query.branchId)) {
        return res.status(403).json({ message: "Access denied to this branch" });
      }
      // Include tasks for the requested branch AND global tasks (branchId IS NULL)
      conditions.push(or(eq(tasks.branchId, query.branchId), isNull(tasks.branchId)));
    } else if (allowedBranches !== null) {
      if (allowedBranches.length === 0) {
        return res.json([]);
      }
      // Include tasks for allowed branches AND global tasks (branchId IS NULL)
      conditions.push(or(inArray(tasks.branchId, allowedBranches), isNull(tasks.branchId)));
    }

    // Tab-based filtering (all use same start-of-day boundary in Bangkok timezone)
    if (tab === "today") {
      // Today tab: startAt <= today (start of day) AND status != completed
      // Shows all tasks that have started (including scheduled/multi-day tasks)
      conditions.push(
        sql`(${tasks.startAt} IS NULL OR ${tasks.startAt} <= ${today})`
      );
      conditions.push(
        sql`${tasks.status} != 'completed'`
      );
      // Exclude recurring definitions
      conditions.push(eq(tasks.isRecurringDefinition, false));
    } else if (tab === "active") {
      // Active tab: startAt <= today AND status != completed (same as today but includes all)
      conditions.push(
        sql`(${tasks.startAt} IS NULL OR ${tasks.startAt} <= ${today})`
      );
      conditions.push(
        sql`${tasks.status} != 'completed'`
      );
      // Exclude recurring definitions
      conditions.push(eq(tasks.isRecurringDefinition, false));
    } else if (tab === "upcoming") {
      // startAt > today AND status != completed
      conditions.push(
        sql`${tasks.startAt} > ${today}`
      );
      conditions.push(
        sql`${tasks.status} != 'completed'`
      );
      // Exclude recurring definitions
      conditions.push(eq(tasks.isRecurringDefinition, false));
    } else if (tab === "completed") {
      conditions.push(eq(tasks.status, "completed"));
    }

    const result = await db
      .select({
        id: tasks.id,
        branchId: tasks.branchId,
        departmentId: tasks.departmentId,
        title: tasks.title,
        description: tasks.description,
        status: tasks.status,
        priority: tasks.priority,
        recurrence: tasks.recurrence,
        dueAt: tasks.dueAt,
        startAt: tasks.startAt,
        scheduledMode: tasks.scheduledMode,
        progressPercent: tasks.progressPercent,
        statusManualOverride: tasks.statusManualOverride,
        blockedReason: tasks.blockedReason,
        completedAt: tasks.completedAt,
        assignedTo: tasks.assignedTo,
        assignedEmployeeId: tasks.assignedEmployeeId,
        assignedRoleId: tasks.assignedRoleId,
        assignedDepartmentId: tasks.assignedDepartmentId,
        requiresPhotoEvidence: tasks.requiresPhotoEvidence,
        createdBy: tasks.createdBy,
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        assignedUserEmail: users.email,
        assignedUserFullName: users.fullName,
        assignedEmployeeNickname: sql<string>`COALESCE(${employees.nickname}, (SELECT e2.nickname FROM employees e2 WHERE e2.id = ${tasks.assignedEmployeeId}))`.as('assigned_employee_nickname'),
        assignedEmployeeFullName: sql<string>`COALESCE(${employees.fullName}, (SELECT e2.full_name FROM employees e2 WHERE e2.id = ${tasks.assignedEmployeeId}))`.as('assigned_employee_full_name'),
        assignedAdvisorNickname: people.preferredName,
        assignedAdvisorFullName: people.fullName,
        assignedRoleName: sql<string>`(SELECT r.name FROM roles r WHERE r.id = ${tasks.assignedRoleId})`.as('assigned_role_name'),
        assignedDepartmentName: sql<string>`(SELECT d.name FROM departments d WHERE d.id = ${tasks.assignedDepartmentId})`.as('assigned_department_name'),
        assignedEmployeeDepartmentId: sql<string>`COALESCE(
          (SELECT e2.primary_department_id FROM employees e2 WHERE e2.id = ${tasks.assignedEmployeeId}),
          (SELECT e2.primary_department_id FROM employees e2 WHERE e2.user_id = ${tasks.assignedTo})
        )`.as('assigned_employee_department_id'),
        assignedEmployeeRoleIds: sql<string>`(SELECT string_agg(er.role_id::text, ',') FROM employee_roles er WHERE er.employee_id = COALESCE(${tasks.assignedEmployeeId}, (SELECT e2.id FROM employees e2 WHERE e2.user_id = ${tasks.assignedTo} LIMIT 1)))`.as('assigned_employee_role_ids'),
        assignedUserRole: sql<string>`COALESCE(
          (SELECT u2.role FROM users u2 WHERE u2.id = ${tasks.assignedTo}),
          (SELECT u3.role FROM users u3 JOIN employees e3 ON e3.user_id = u3.id WHERE e3.id = ${tasks.assignedEmployeeId}),
          (SELECT CASE WHEN EXISTS(SELECT 1 FROM employee_roles er JOIN roles r ON r.id = er.role_id WHERE er.employee_id = ${tasks.assignedEmployeeId} AND LOWER(r.name) = 'manager') THEN 'manager' ELSE 'staff' END)
        )`.as('assigned_user_role'),
      })
      .from(tasks)
      .leftJoin(users, eq(tasks.assignedTo, users.id))
      .leftJoin(employees, eq(employees.userId, users.id))
      .leftJoin(accessPolicies, eq(accessPolicies.coreUserId, users.id))
      .leftJoin(people, eq(people.id, accessPolicies.personId))
      .where(and(...conditions))
      .orderBy(tab === "completed" ? desc(tasks.completedAt) : tasks.dueAt);

    const formattedMultiDay = result.map(formatTaskResult);
    const withAssignmentsMultiDay = await attachAssignmentsToTasks(formattedMultiDay);

    if (query.myOnly === "true" && req.user) {
      const linkedEmployee = await getLinkedEmployeeContext(req.user.id);
      const filtered = withAssignmentsMultiDay.filter((task: any) => isTaskVisibleToEmployee(task, linkedEmployee, req.user!.id));
      return res.json(filtered);
    }

    res.json(withAssignmentsMultiDay);
  } catch (error: any) {
    console.error("[Core Tasks] GET /multi-day error:", error);
    res.status(500).json({ message: error.message });
  }
});

// Task activities endpoint - MUST be before /:id to avoid route conflict
const activityQuerySchema = z.object({
  branchId: z.string().optional(),
  limit: z.string().optional(),
});

router.get("/activities/recent", requireAuth, async (req: Request, res: Response) => {
  try {
    const query = activityQuerySchema.parse(req.query);
    const tenantId = await getDefaultTenantId();
    const allowedBranches = getUserAllowedBranchIds(req);
    const limitNum = Math.min(parseInt(query.limit || "30", 10), 100);

    const conditions: any[] = [eq(taskActivities.tenantId, tenantId)];

    if (query.branchId && query.branchId !== "all") {
      if (!req.userWithAccess || !canUserAccessBranch(req.userWithAccess, query.branchId)) {
        return res.status(403).json({ message: "Access denied to this branch" });
      }
      conditions.push(eq(taskActivities.branchId, query.branchId));
    } else if (allowedBranches !== null) {
      if (allowedBranches.length === 0) return res.json([]);
      conditions.push(inArray(taskActivities.branchId, allowedBranches));
    }

    const result = await db
      .select({
        id: taskActivities.id,
        taskId: taskActivities.taskId,
        branchId: taskActivities.branchId,
        activityType: taskActivities.activityType,
        description: taskActivities.description,
        userId: taskActivities.userId,
        metadata: taskActivities.metadata,
        createdAt: taskActivities.createdAt,
        taskTitle: tasks.title,
        taskStatus: tasks.status,
        userName: users.fullName,
        employeeNickname: employees.nickname,
      })
      .from(taskActivities)
      .leftJoin(tasks, eq(taskActivities.taskId, tasks.id))
      .leftJoin(users, eq(taskActivities.userId, users.id))
      .leftJoin(employees, and(eq(users.id, employees.userId), eq(employees.status, "active")))
      .where(and(...conditions))
      .orderBy(desc(taskActivities.createdAt))
      .limit(limitNum);

    const enriched = [];
    for (const a of result) {
      let nickname = a.employeeNickname;
      if (!nickname && a.userName) {
        const empByName = await db
          .select({ nickname: employees.nickname })
          .from(employees)
          .where(and(eq(employees.fullName, a.userName), eq(employees.status, "active")))
          .limit(1);
        if (empByName.length > 0) {
          nickname = empByName[0].nickname;
        }
      }
      enriched.push({ ...a, employeeNickname: nickname || null });
    }
    res.json(enriched);
  } catch (error: any) {
    console.error("[Core Tasks] GET /activities/recent error:", error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================
// TASK ATTACHMENTS
// ============================================

router.get("/:id/attachments", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const taskId = req.params.id;

    const result = await db
      .select({
        id: taskAttachments.id,
        taskId: taskAttachments.taskId,
        fileName: taskAttachments.fileName,
        fileUrl: taskAttachments.fileUrl,
        fileSize: taskAttachments.fileSize,
        mimeType: taskAttachments.mimeType,
        uploadedBy: taskAttachments.uploadedBy,
        createdAt: taskAttachments.createdAt,
        uploaderNickname: employees.nickname,
        uploaderName: users.fullName,
      })
      .from(taskAttachments)
      .leftJoin(users, eq(taskAttachments.uploadedBy, users.id))
      .leftJoin(employees, eq(users.id, employees.userId))
      .where(and(
        eq(taskAttachments.tenantId, tenantId),
        eq(taskAttachments.taskId, taskId)
      ))
      .orderBy(desc(taskAttachments.createdAt));

    res.json(result.map(a => ({
      ...a,
      uploaderDisplayName: a.uploaderNickname || a.uploaderName || "Unknown",
    })));
  } catch (error: any) {
    console.error("[Core Tasks] GET /:id/attachments error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.post("/:id/attachments", requireAuth, attachmentUpload.array("files", 10), fixMulterFilenames, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const taskId = req.params.id;
    const userId = (req.user as any)?.id;
    const uploadedFiles = req.files as Express.Multer.File[];

    if (!uploadedFiles || uploadedFiles.length === 0) {
      return res.status(400).json({ message: "No files provided" });
    }

    const inserted = [];
    for (const file of uploadedFiles) {
      const timestamp = Date.now();
      const safeName = file.originalname.replace(/[\/\\:*?"<>|]/g, "_");
      const storageFilename = `${timestamp}_${safeName}`;
      const fileUrl = await uploadToObjectStorage(
        file.buffer,
        "task-attachments",
        storageFilename,
        file.mimetype
      );

      const [attachment] = await db.insert(taskAttachments).values({
        tenantId,
        taskId,
        fileName: file.originalname,
        fileUrl,
        fileSize: file.size,
        mimeType: file.mimetype,
        uploadedBy: userId,
      }).returning();

      inserted.push(attachment);
    }

    const [taskInfo] = await db.select({ branchId: tasks.branchId, title: tasks.title }).from(tasks).where(eq(tasks.id, taskId));
    const uploaderName = await getUserDisplayName(userId);
    for (const att of inserted) {
      await logTaskActivity(
        tenantId, taskId, taskInfo?.branchId, "attachment_added",
        `${uploaderName || "Someone"} added attachment "${att.fileName}"`,
        userId,
        { attachmentId: att.id, fileName: att.fileName }
      );
    }

    try {
      if (taskInfo?.title && userId) {
        const stakeholders = await getTaskStakeholderUserIds(taskId, tenantId);
        const fileNames = inserted.map(a => a.fileName).join(", ");
        await createTaskAttachmentNotification({
          tenantId,
          taskId,
          taskTitle: taskInfo.title,
          fileName: inserted.length === 1 ? inserted[0].fileName : `${inserted.length} files`,
          actorUserId: userId,
          recipientUserIds: stakeholders.filter(id => id !== userId),
        });
      }
    } catch (notifErr) {
      console.error("[Core Tasks] Failed to create attachment notification:", notifErr);
    }

    res.json(inserted);
  } catch (error: any) {
    console.error("[Core Tasks] POST /:id/attachments error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.delete("/:id/attachments/:attachmentId", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const taskId = req.params.id;
    const { attachmentId } = req.params;
    const userId = (req.user as any)?.id;

    const [att] = await db.select({ fileName: taskAttachments.fileName }).from(taskAttachments)
      .where(and(eq(taskAttachments.id, attachmentId), eq(taskAttachments.tenantId, tenantId)));

    await db.delete(taskAttachments).where(and(
      eq(taskAttachments.id, attachmentId),
      eq(taskAttachments.tenantId, tenantId)
    ));

    const [taskInfo] = await db.select({ branchId: tasks.branchId }).from(tasks).where(eq(tasks.id, taskId));
    const removerName = await getUserDisplayName(userId);
    await logTaskActivity(
      tenantId, taskId, taskInfo?.branchId, "attachment_removed",
      `${removerName || "Someone"} removed attachment "${att?.fileName || "unknown"}"`,
      userId,
      { attachmentId, fileName: att?.fileName }
    );

    res.json({ success: true });
  } catch (error: any) {
    console.error("[Core Tasks] DELETE attachment error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/:id/checklist", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const taskId = req.params.id;

    const items = await db
      .select()
      .from(taskChecklistItems)
      .where(and(
        eq(taskChecklistItems.tenantId, tenantId),
        eq(taskChecklistItems.taskId, taskId)
      ))
      .orderBy(taskChecklistItems.sortOrder, taskChecklistItems.createdAt);

    res.json(items);
  } catch (error: any) {
    console.error("[Core Tasks] GET checklist error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.post("/:id/checklist", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const taskId = req.params.id;
    const { title } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ message: "Title is required" });
    }

    const maxOrder = await db
      .select({ maxSort: sql<number>`COALESCE(MAX(${taskChecklistItems.sortOrder}), -1)` })
      .from(taskChecklistItems)
      .where(and(
        eq(taskChecklistItems.tenantId, tenantId),
        eq(taskChecklistItems.taskId, taskId)
      ));

    const userId = (req.user as any)?.id;

    const [item] = await db.insert(taskChecklistItems).values({
      tenantId,
      taskId,
      title: title.trim(),
      sortOrder: (maxOrder[0]?.maxSort ?? -1) + 1,
    }).returning();

    const [taskInfo] = await db.select({ branchId: tasks.branchId, title: tasks.title }).from(tasks).where(eq(tasks.id, taskId));
    const adderName = await getUserDisplayName(userId);
    await logTaskActivity(
      tenantId, taskId, taskInfo?.branchId, "checklist_item_added",
      `${adderName || "Someone"} added checklist item "${title.trim()}"`,
      userId,
      { checklistItemId: item.id, title: title.trim() }
    );

    try {
      if (taskInfo?.title && userId) {
        const stakeholders = await getTaskStakeholderUserIds(taskId, tenantId);
        await createTaskChecklistNotification({
          tenantId,
          taskId,
          taskTitle: taskInfo.title,
          itemTitle: title.trim(),
          action: "added",
          actorUserId: userId,
          recipientUserIds: stakeholders.filter(id => id !== userId),
        });
      }
    } catch (notifErr) {
      console.error("[Core Tasks] Failed to create checklist notification:", notifErr);
    }

    res.json(item);
  } catch (error: any) {
    console.error("[Core Tasks] POST checklist error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.patch("/:id/checklist/:itemId", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const taskId = req.params.id;
    const { itemId } = req.params;
    const userId = (req.user as any)?.id;
    const updates: Record<string, unknown> = {};

    if (req.body.title !== undefined) updates.title = req.body.title;
    if (req.body.isChecked !== undefined) updates.isChecked = req.body.isChecked;
    if (req.body.sortOrder !== undefined) updates.sortOrder = req.body.sortOrder;
    if (req.body.dueAt !== undefined) updates.dueAt = req.body.dueAt ? new Date(req.body.dueAt) : null;
    updates.updatedAt = new Date();

    const [updated] = await db
      .update(taskChecklistItems)
      .set(updates)
      .where(and(
        eq(taskChecklistItems.id, itemId),
        eq(taskChecklistItems.tenantId, tenantId)
      ))
      .returning();

    if (req.body.isChecked !== undefined) {
      const [taskInfo] = await db.select({ branchId: tasks.branchId, title: tasks.title }).from(tasks).where(eq(tasks.id, taskId));
      const checkerName = await getUserDisplayName(userId);
      const actType = req.body.isChecked ? "checklist_item_checked" : "checklist_item_unchecked";
      const verb = req.body.isChecked ? "checked" : "unchecked";
      await logTaskActivity(
        tenantId, taskId, taskInfo?.branchId, actType,
        `${checkerName || "Someone"} ${verb} "${updated?.title || "item"}"`,
        userId,
        { checklistItemId: itemId, title: updated?.title }
      );

      try {
        if (taskInfo?.title && userId) {
          const stakeholders = await getTaskStakeholderUserIds(taskId, tenantId);
          await createTaskChecklistNotification({
            tenantId,
            taskId,
            taskTitle: taskInfo.title,
            itemTitle: updated?.title || "item",
            action: req.body.isChecked ? "checked" : "unchecked",
            actorUserId: userId,
            recipientUserIds: stakeholders.filter(id => id !== userId),
          });
        }
      } catch (notifErr) {
        console.error("[Core Tasks] Failed to create checklist notification:", notifErr);
      }
    }

    res.json(updated);
  } catch (error: any) {
    console.error("[Core Tasks] PATCH checklist error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.put("/:id/checklist/reorder", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const taskId = req.params.id;
    const { orderedIds } = req.body;

    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
      return res.status(400).json({ message: "orderedIds array is required" });
    }

    await db.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx
          .update(taskChecklistItems)
          .set({ sortOrder: i, updatedAt: new Date() })
          .where(and(
            eq(taskChecklistItems.id, orderedIds[i]),
            eq(taskChecklistItems.tenantId, tenantId),
            eq(taskChecklistItems.taskId, taskId)
          ));
      }
    });

    res.json({ success: true });
  } catch (error: any) {
    console.error("[Core Tasks] PUT checklist reorder error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.delete("/:id/checklist/:itemId", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const taskId = req.params.id;
    const { itemId } = req.params;
    const userId = (req.user as any)?.id;

    const [existing] = await db.select({ title: taskChecklistItems.title }).from(taskChecklistItems)
      .where(and(eq(taskChecklistItems.id, itemId), eq(taskChecklistItems.tenantId, tenantId)));

    await db.delete(taskChecklistItems).where(and(
      eq(taskChecklistItems.id, itemId),
      eq(taskChecklistItems.tenantId, tenantId)
    ));

    const [taskInfo] = await db.select({ branchId: tasks.branchId, title: tasks.title }).from(tasks).where(eq(tasks.id, taskId));
    const removerName = await getUserDisplayName(userId);
    await logTaskActivity(
      tenantId, taskId, taskInfo?.branchId, "checklist_item_removed",
      `${removerName || "Someone"} removed checklist item "${existing?.title || "item"}"`,
      userId,
      { checklistItemId: itemId, title: existing?.title }
    );

    try {
      if (taskInfo?.title && userId) {
        const stakeholders = await getTaskStakeholderUserIds(taskId, tenantId);
        await createTaskChecklistNotification({
          tenantId,
          taskId,
          taskTitle: taskInfo.title,
          itemTitle: existing?.title || "item",
          action: "removed",
          actorUserId: userId,
          recipientUserIds: stakeholders.filter(id => id !== userId),
        });
      }
    } catch (notifErr) {
      console.error("[Core Tasks] Failed to create checklist notification:", notifErr);
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error("[Core Tasks] DELETE checklist error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/:id/activities", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const taskId = req.params.id;

    const result = await db
      .select({
        id: taskActivities.id,
        taskId: taskActivities.taskId,
        activityType: taskActivities.activityType,
        description: taskActivities.description,
        userId: taskActivities.userId,
        metadata: taskActivities.metadata,
        createdAt: taskActivities.createdAt,
        userName: users.fullName,
        employeeNickname: employees.nickname,
        employeePhoto: employees.profilePhotoPath,
      })
      .from(taskActivities)
      .leftJoin(users, eq(taskActivities.userId, users.id))
      .leftJoin(employees, and(eq(users.id, employees.userId), eq(employees.status, "active")))
      .where(and(
        eq(taskActivities.tenantId, tenantId),
        eq(taskActivities.taskId, taskId)
      ))
      .orderBy(desc(taskActivities.createdAt));

    const enriched = [];
    for (const a of result) {
      let nickname = a.employeeNickname;
      let avatar = a.employeePhoto || null;
      if (!nickname && a.userName) {
        const empByName = await db
          .select({ nickname: employees.nickname, profilePhotoPath: employees.profilePhotoPath })
          .from(employees)
          .where(and(eq(employees.fullName, a.userName), eq(employees.status, "active")))
          .limit(1);
        if (empByName.length > 0) {
          nickname = empByName[0].nickname;
          avatar = empByName[0].profilePhotoPath || null;
        }
      }
      const actorName = nickname || a.userName || "System";
      const actorAvatar = avatar;
      let desc = a.description;
      if (a.userName && desc.startsWith(a.userName)) {
        desc = desc.slice(a.userName.length).trimStart();
      }
      if (nickname && desc.startsWith(nickname)) {
        desc = desc.slice(nickname.length).trimStart();
      }
      enriched.push({ ...a, actorName, actorAvatar, description: desc });
    }
    res.json(enriched);
  } catch (error: any) {
    console.error("[Core Tasks] GET /:id/activities error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const [task] = await db
      .select({
        id: tasks.id,
        branchId: tasks.branchId,
        departmentId: tasks.departmentId,
        title: tasks.title,
        description: tasks.description,
        status: tasks.status,
        priority: tasks.priority,
        recurrence: tasks.recurrence,
        dueAt: tasks.dueAt,
        startAt: tasks.startAt,
        scheduledMode: tasks.scheduledMode,
        progressPercent: tasks.progressPercent,
        statusManualOverride: tasks.statusManualOverride,
        blockedReason: tasks.blockedReason,
        assignedTo: tasks.assignedTo,
        assignedRoleId: tasks.assignedRoleId,
        assignedDepartmentId: tasks.assignedDepartmentId,
        requiresPhotoEvidence: tasks.requiresPhotoEvidence,
        requiresResponses: tasks.requiresResponses,
        referencePhotoUrl: tasks.referencePhotoUrl,
        createdBy: tasks.createdBy,
        createdByName: sql<string>`COALESCE(
          (SELECT e2.nickname FROM employees e2 WHERE e2.user_id = ${tasks.createdBy} LIMIT 1),
          (SELECT e2.full_name FROM employees e2 WHERE e2.user_id = ${tasks.createdBy} LIMIT 1),
          (SELECT u2.full_name FROM users u2 WHERE u2.id = ${tasks.createdBy}),
          (SELECT u2.email FROM users u2 WHERE u2.id = ${tasks.createdBy})
        )`.as('created_by_name'),
        createdAt: tasks.createdAt,
        updatedAt: tasks.updatedAt,
        tenantId: tasks.tenantId,
        assignedEmployeeId: tasks.assignedEmployeeId,
        assignedRoleId: tasks.assignedRoleId,
        assignedDepartmentId: tasks.assignedDepartmentId,
        assignedUserEmail: users.email,
        assignedUserFullName: users.fullName,
        assignedEmployeeNickname: sql<string>`COALESCE(${employees.nickname}, (SELECT e2.nickname FROM employees e2 WHERE e2.id = ${tasks.assignedEmployeeId}))`.as('assigned_employee_nickname'),
        assignedEmployeeFullName: sql<string>`COALESCE(${employees.fullName}, (SELECT e2.full_name FROM employees e2 WHERE e2.id = ${tasks.assignedEmployeeId}))`.as('assigned_employee_full_name'),
        assignedAdvisorNickname: people.preferredName,
        assignedAdvisorFullName: people.fullName,
        assignedRoleName: sql<string>`(SELECT r.name FROM roles r WHERE r.id = ${tasks.assignedRoleId})`.as('assigned_role_name'),
        assignedDepartmentName: sql<string>`(SELECT d.name FROM departments d WHERE d.id = ${tasks.assignedDepartmentId})`.as('assigned_department_name'),
        assignedEmployeeDepartmentId: sql<string>`COALESCE(
          (SELECT e2.primary_department_id FROM employees e2 WHERE e2.id = ${tasks.assignedEmployeeId}),
          (SELECT e2.primary_department_id FROM employees e2 WHERE e2.user_id = ${tasks.assignedTo})
        )`.as('assigned_employee_department_id'),
        assignedEmployeeRoleIds: sql<string>`(SELECT string_agg(er.role_id::text, ',') FROM employee_roles er WHERE er.employee_id = COALESCE(${tasks.assignedEmployeeId}, (SELECT e2.id FROM employees e2 WHERE e2.user_id = ${tasks.assignedTo} LIMIT 1)))`.as('assigned_employee_role_ids'),
        assignedUserRole: sql<string>`COALESCE(
          (SELECT u2.role FROM users u2 WHERE u2.id = ${tasks.assignedTo}),
          (SELECT u3.role FROM users u3 JOIN employees e3 ON e3.user_id = u3.id WHERE e3.id = ${tasks.assignedEmployeeId}),
          (SELECT CASE WHEN EXISTS(SELECT 1 FROM employee_roles er JOIN roles r ON r.id = er.role_id WHERE er.employee_id = ${tasks.assignedEmployeeId} AND LOWER(r.name) = 'manager') THEN 'manager' ELSE 'staff' END)
        )`.as('assigned_user_role'),
      })
      .from(tasks)
      .leftJoin(users, eq(tasks.assignedTo, users.id))
      .leftJoin(employees, eq(employees.userId, users.id))
      .leftJoin(accessPolicies, eq(accessPolicies.coreUserId, users.id))
      .leftJoin(people, eq(people.id, accessPolicies.personId))
      .where(and(eq(tasks.id, req.params.id), eq(tasks.tenantId, tenantId)))
      .limit(1);

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (!req.userWithAccess || !canUserAccessBranch(req.userWithAccess, task.branchId)) {
      return res.status(403).json({ message: "Access denied to this branch" });
    }

    const questions = await db
      .select()
      .from(taskQuestions)
      .where(eq(taskQuestions.taskId, task.id))
      .orderBy(taskQuestions.sortOrder);

    const completions = await db
      .select({
        id: taskCompletions.id,
        completedBy: taskCompletions.completedBy,
        responses: taskCompletions.responses,
        photoUrls: taskCompletions.photoUrls,
        note: taskCompletions.note,
        completedAt: taskCompletions.completedAt,
        completedByEmail: users.email,
        completedByFullName: users.fullName,
        completedByNickname: employees.nickname,
      })
      .from(taskCompletions)
      .leftJoin(users, eq(taskCompletions.completedBy, users.id))
      .leftJoin(employees, eq(employees.userId, users.id))
      .where(eq(taskCompletions.taskId, task.id))
      .orderBy(desc(taskCompletions.completedAt));

    const assignmentRows = await db
      .select()
      .from(taskAssignments)
      .where(eq(taskAssignments.taskId, task.id));

    const resolvedAssignments = await Promise.all(assignmentRows.map(async (a) => {
      let label = a.assignmentId;
      try {
        if (a.assignmentType === "employee") {
          const [emp] = await db.select({ nickname: employees.nickname, fullName: employees.fullName }).from(employees).where(eq(employees.id, a.assignmentId)).limit(1);
          if (emp) label = emp.nickname || emp.fullName;
        } else if (a.assignmentType === "advisor") {
          const [adv] = await db.select({ preferredName: people.preferredName, fullName: people.fullName }).from(people).where(eq(people.id, a.assignmentId)).limit(1);
          if (adv) label = adv.preferredName || adv.fullName;
        } else if (a.assignmentType === "role") {
          const [r] = await db.execute(sql`SELECT name FROM roles WHERE id = ${a.assignmentId} LIMIT 1`);
          if (r) label = (r as any).name;
        } else if (a.assignmentType === "department") {
          const [d] = await db.execute(sql`SELECT name FROM departments WHERE id = ${a.assignmentId} LIMIT 1`);
          if (d) label = (d as any).name;
        } else if (a.assignmentType === "branch") {
          const [b] = await db.select({ name: branches.name }).from(branches).where(eq(branches.id, a.assignmentId)).limit(1);
          if (b) label = b.name;
        }
      } catch {}
      return { id: a.id, assignmentType: a.assignmentType, assignmentId: a.assignmentId, label };
    }));

    res.json({ 
      ...formatTaskResult(task), 
      questions, 
      completions: completions.map(formatCompletionResult),
      assignments: resolvedAssignments,
    });
  } catch (error: any) {
    console.error("[Core Tasks] GET /:id error:", error);
    res.status(500).json({ message: error.message });
  }
});

const updateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  status: z.enum(["pending", "in_progress", "completed", "overdue", "cancelled", "blocked"]).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  startAt: z.string().optional().nullable(),
  dueAt: z.string().optional().nullable(),
  progressPercent: z.number().min(0).max(100).optional(),
  statusManualOverride: z.boolean().optional(),
  blockedReason: z.string().optional().nullable(),
  assignedTo: z.string().optional().nullable(),
  assignedEmployeeId: z.string().optional().nullable(),
  assignedRoleId: z.string().optional().nullable(),
  assignedDepartmentId: z.string().optional().nullable(),
  assignments: z.array(assignmentEntrySchema).optional(),
  description: z.string().optional().nullable(),
  requiresPhotoEvidence: z.boolean().optional(),
  requiresResponses: z.boolean().optional(),
  referencePhotoUrl: z.string().optional().nullable(),
  taskLevel: z.enum(["line", "management", "strategic"]).optional(),
  escalated: z.boolean().optional(),
  ownerUserId: z.string().optional().nullable(),
});

router.patch("/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const body = updateTaskSchema.parse(req.body);
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ message: "Task access denied" });

    const [existing] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, req.params.id), eq(tasks.tenantId, tenantId)))
      .limit(1);

    if (!existing) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (!req.userWithAccess || !canUserAccessBranch(req.userWithAccess, existing.branchId)) {
      return res.status(403).json({ message: "Access denied to this branch" });
    }

    const now = new Date();
    const updateData: any = { updatedAt: now };
    
    // Track if we should update lastMovementAt (status change, reassignment, or escalation change)
    let shouldUpdateMovement = false;
    
    if (body.title !== undefined) updateData.title = body.title;
    if (body.status !== undefined) {
      updateData.status = body.status;
      shouldUpdateMovement = true;
      
      // Set completedAt when status changes to completed
      if (body.status === 'completed' && existing.status !== 'completed') {
        updateData.completedAt = now;
      }
      // Clear completedAt if status changes from completed to something else
      if (body.status !== 'completed' && existing.status === 'completed') {
        updateData.completedAt = null;
        updateData.archivedAt = null;
      }
    }
    if (body.priority !== undefined) updateData.priority = body.priority;
    if (body.dueAt !== undefined) {
      if (body.dueAt) {
        const dueStr = body.dueAt.includes('+') || body.dueAt.includes('Z')
          ? body.dueAt : `${body.dueAt}+07:00`;
        updateData.dueAt = new Date(dueStr);
      } else {
        updateData.dueAt = null;
      }
      if (!existing.scheduledMode && updateData.dueAt) {
        updateData.startAt = updateData.dueAt;
      }
    }
    if (body.startAt !== undefined) {
      if (body.startAt) {
        const startStr = body.startAt.includes('+') || body.startAt.includes('Z')
          ? body.startAt : `${body.startAt}+07:00`;
        updateData.startAt = new Date(startStr);
      } else {
        updateData.startAt = null;
      }
    }
    if (body.assignedTo !== undefined) {
      updateData.assignedTo = body.assignedTo;
      shouldUpdateMovement = true;
    }
    if (body.assignedEmployeeId !== undefined) {
      updateData.assignedEmployeeId = body.assignedEmployeeId;
      shouldUpdateMovement = true;
    }
    if (body.assignedRoleId !== undefined) {
      updateData.assignedRoleId = body.assignedRoleId;
      shouldUpdateMovement = true;
    }
    if (body.assignedDepartmentId !== undefined) {
      updateData.assignedDepartmentId = body.assignedDepartmentId;
      shouldUpdateMovement = true;
    }
    if (body.description !== undefined) updateData.description = body.description;
    if (body.requiresPhotoEvidence !== undefined) updateData.requiresPhotoEvidence = body.requiresPhotoEvidence;
    if (body.requiresResponses !== undefined) updateData.requiresResponses = body.requiresResponses;
    if (body.referencePhotoUrl !== undefined) {
      if (body.referencePhotoUrl && body.referencePhotoUrl !== existing.referencePhotoUrl) {
        const filename = taskPhotoUrl(existing.id, body.referencePhotoUrl);
        if (!filename || !await fileExistsInObjectStorage("task-photos", filename)) {
          return res.status(400).json({ message: "Reference photo does not belong to this task" });
        }
      }
      updateData.referencePhotoUrl = body.referencePhotoUrl;
    }
    if (body.taskLevel !== undefined) updateData.taskLevel = body.taskLevel;
    if (body.escalated !== undefined) {
      updateData.escalated = body.escalated;
      shouldUpdateMovement = true;
    }
    if (body.ownerUserId !== undefined) updateData.ownerUserId = body.ownerUserId;
    
    let assignmentsChanged = false;
    let newAssignmentLabels: string[] = [];
    let oldRows: { assignmentType: string; assignmentId: string }[] = [];
    if (body.assignments !== undefined) {
      shouldUpdateMovement = true;
      oldRows = await db.select().from(taskAssignments)
        .where(and(eq(taskAssignments.taskId, req.params.id), eq(taskAssignments.tenantId, tenantId)));
      const oldKeys = new Set(oldRows.map(r => `${r.assignmentType}:${r.assignmentId}`));
      const newKeys = new Set(body.assignments.map(a => `${a.assignmentType}:${a.assignmentId}`));
      assignmentsChanged = oldKeys.size !== newKeys.size || [...oldKeys].some(k => !newKeys.has(k));

      await db.delete(taskAssignments).where(
        and(eq(taskAssignments.taskId, req.params.id), eq(taskAssignments.tenantId, tenantId))
      );
      if (body.assignments.length > 0) {
        const seen = new Set<string>();
        for (const a of body.assignments) {
          const key = `${a.assignmentType}:${a.assignmentId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          await db.insert(taskAssignments).values({
            tenantId,
            taskId: req.params.id,
            assignmentType: a.assignmentType as any,
            assignmentId: a.assignmentId,
          });
        }
      }
      if (assignmentsChanged) {
        newAssignmentLabels = await Promise.all(body.assignments.map(async (a) => {
          try {
            if (a.assignmentType === "employee") {
              const [emp] = await db.select({ nickname: employees.nickname, fullName: employees.fullName }).from(employees).where(eq(employees.id, a.assignmentId)).limit(1);
              if (emp) return emp.nickname || emp.fullName;
            } else if (a.assignmentType === "advisor") {
              const [adv] = await db.select({ preferredName: people.preferredName, fullName: people.fullName }).from(people).where(eq(people.id, a.assignmentId)).limit(1);
              if (adv) return adv.preferredName || adv.fullName;
            } else if (a.assignmentType === "role") {
              const [r] = await db.execute(sql`SELECT name FROM roles WHERE id = ${a.assignmentId} LIMIT 1`);
              if (r) return (r as any).name;
            } else if (a.assignmentType === "department") {
              const [d] = await db.execute(sql`SELECT name FROM departments WHERE id = ${a.assignmentId} LIMIT 1`);
              if (d) return (d as any).name;
            } else if (a.assignmentType === "branch") {
              const [b] = await db.select({ name: branches.name }).from(branches).where(eq(branches.id, a.assignmentId)).limit(1);
              if (b) return b.name;
            }
          } catch {}
          return a.assignmentId;
        }));
      }
    }

    if (shouldUpdateMovement) {
      updateData.lastMovementAt = now;
    }

    const [updated] = await db
      .update(tasks)
      .set(updateData)
      .where(and(eq(tasks.id, req.params.id), eq(tasks.tenantId, tenantId)))
      .returning();

    // Log appropriate activity with nickname
    const updaterName = await getUserDisplayName(req.user!.id);
    const who = updaterName || "Someone";
    if (body.status !== undefined && body.status !== existing.status) {
      const actType = body.status === "completed" ? "completed" : "status_changed";
      await logTaskActivity(
        tenantId, existing.id, existing.branchId, actType,
        `${who} changed status to "${body.status}"`,
        req.user!.id,
        { oldStatus: existing.status, newStatus: body.status, taskTitle: existing.title }
      );
    }
    if (body.priority !== undefined && body.priority !== existing.priority) {
      await logTaskActivity(
        tenantId, existing.id, existing.branchId, "priority_changed",
        `${who} changed priority to "${body.priority}"`,
        req.user!.id,
        { oldPriority: existing.priority, newPriority: body.priority, taskTitle: existing.title }
      );
    }
    if (body.assignedTo !== undefined && body.assignedTo !== existing.assignedTo) {
      const assigneeName = body.assignedTo ? await getUserDisplayName(body.assignedTo) : null;
      await logTaskActivity(
        tenantId, existing.id, existing.branchId, "assigned",
        assigneeName ? `${who} assigned task to ${assigneeName}` : `${who} unassigned task`,
        req.user!.id,
        { taskTitle: existing.title }
      );
    }
    if (assignmentsChanged) {
      const desc = newAssignmentLabels.length > 0
        ? `${who} assigned task to ${newAssignmentLabels.join(", ")}`
        : `${who} unassigned task`;
      const oldAssignmentsData = oldRows.map(r => ({ assignmentType: r.assignmentType, assignmentId: r.assignmentId }));
      await logTaskActivity(
        tenantId, existing.id, existing.branchId, "assigned",
        desc,
        req.user!.id,
        { taskTitle: existing.title, assignments: newAssignmentLabels, oldAssignments: oldAssignmentsData }
      );
    }
    if (body.assignedEmployeeId !== undefined && body.assignedEmployeeId !== existing.assignedEmployeeId && !body.assignments) {
      let empName: string | null = null;
      if (body.assignedEmployeeId) {
        const [emp] = await db.select({ nickname: employees.nickname, fullName: employees.fullName }).from(employees).where(eq(employees.id, body.assignedEmployeeId)).limit(1);
        if (emp) empName = emp.nickname || emp.fullName;
      }
      await logTaskActivity(
        tenantId, existing.id, existing.branchId, "assigned",
        empName ? `${who} assigned task to ${empName}` : `${who} unassigned task`,
        req.user!.id,
        { taskTitle: existing.title }
      );
    }
    if (body.assignedRoleId !== undefined && body.assignedRoleId !== existing.assignedRoleId && !body.assignments) {
      let roleName: string | null = null;
      if (body.assignedRoleId) {
        const [r] = await db.execute(sql`SELECT name FROM roles WHERE id = ${body.assignedRoleId} LIMIT 1`);
        if (r) roleName = (r as any).name;
      }
      await logTaskActivity(
        tenantId, existing.id, existing.branchId, "assigned",
        roleName ? `${who} assigned task to role: ${roleName}` : `${who} removed role assignment`,
        req.user!.id,
        { taskTitle: existing.title }
      );
    }
    if (body.assignedDepartmentId !== undefined && body.assignedDepartmentId !== existing.assignedDepartmentId && !body.assignments) {
      let deptName: string | null = null;
      if (body.assignedDepartmentId) {
        const [d] = await db.execute(sql`SELECT name FROM departments WHERE id = ${body.assignedDepartmentId} LIMIT 1`);
        if (d) deptName = (d as any).name;
      }
      await logTaskActivity(
        tenantId, existing.id, existing.branchId, "assigned",
        deptName ? `${who} assigned task to dept: ${deptName}` : `${who} removed department assignment`,
        req.user!.id,
        { taskTitle: existing.title }
      );
    }
    if (body.escalated !== undefined && body.escalated !== existing.escalated) {
      await logTaskActivity(
        tenantId, existing.id, existing.branchId,
        body.escalated ? "escalated" : "de_escalated",
        body.escalated ? `${who} escalated task` : `${who} de-escalated task`,
        req.user!.id,
        { taskTitle: existing.title }
      );
    }
    if (body.description !== undefined && body.description !== existing.description) {
      const oldDesc = existing.description || "";
      const newDesc = body.description || "";
      const action = !oldDesc && newDesc ? "added" : !newDesc && oldDesc ? "removed" : "updated";
      await logTaskActivity(
        tenantId, existing.id, existing.branchId, "description_changed",
        `${who} ${action} description`,
        req.user!.id,
        { oldDescription: oldDesc, newDescription: newDesc, taskTitle: existing.title }
      );
    }
    if (body.dueAt !== undefined) {
      const oldDueStr = existing.dueAt ? formatDateDisplay(new Date(existing.dueAt)) : "none";
      const newDueStr = updateData.dueAt ? formatDateDisplay(new Date(updateData.dueAt)) : "none";
      if (oldDueStr !== newDueStr) {
        await logTaskActivity(
          tenantId, existing.id, existing.branchId, "due_date_changed",
          `${who} changed due date from ${oldDueStr} to ${newDueStr}`,
          req.user!.id,
          { oldDueDate: oldDueStr, newDueDate: newDueStr, taskTitle: existing.title }
        );
      }
    }

    try {
      const actorUserId = req.user!.id;
      const stakeholders = await getTaskStakeholderUserIds(existing.id, tenantId);
      const recipients = stakeholders.filter(id => id !== actorUserId);

      if (body.status !== undefined && body.status !== existing.status) {
        await createTaskStatusNotification({
          tenantId,
          taskId: existing.id,
          taskTitle: existing.title,
          newStatus: body.status,
          actorUserId,
          recipientUserIds: recipients,
        });
      }
      if (body.assignedTo !== undefined && body.assignedTo !== existing.assignedTo && body.assignedTo) {
        await createTaskAssignedNotification({
          tenantId,
          taskId: existing.id,
          taskTitle: existing.title,
          assignedUserId: body.assignedTo,
          assignerUserId: actorUserId,
        });
      }
      if (body.dueAt !== undefined) {
        const oldDueStr2 = existing.dueAt ? formatDateDisplay(new Date(existing.dueAt)) : "none";
        const newDueStr2 = updateData.dueAt ? formatDateDisplay(new Date(updateData.dueAt)) : "none";
        if (oldDueStr2 !== newDueStr2) {
          await createTaskDueDateNotification({
            tenantId,
            taskId: existing.id,
            taskTitle: existing.title,
            oldDueDate: oldDueStr2,
            newDueDate: newDueStr2,
            actorUserId,
            recipientUserIds: recipients,
          });
        }
      }
      if (body.priority !== undefined && body.priority !== existing.priority) {
        await createTaskPriorityNotification({
          tenantId,
          taskId: existing.id,
          taskTitle: existing.title,
          oldPriority: existing.priority || "medium",
          newPriority: body.priority,
          actorUserId,
          recipientUserIds: recipients,
        });
      }
      if (body.escalated !== undefined && body.escalated !== existing.escalated) {
        await createTaskEscalatedNotification({
          tenantId,
          taskId: existing.id,
          taskTitle: existing.title,
          escalated: body.escalated,
          actorUserId,
          recipientUserIds: recipients,
        });
      }
      if (body.description !== undefined && body.description !== existing.description) {
        const oldDesc = existing.description || "";
        const newDesc = body.description || "";
        const action: "added" | "updated" | "removed" = !oldDesc && newDesc ? "added" : !newDesc && oldDesc ? "removed" : "updated";
        await createTaskDescriptionNotification({
          tenantId,
          taskId: existing.id,
          taskTitle: existing.title,
          action,
          actorUserId,
          recipientUserIds: recipients,
        });
      }
    } catch (notifErr) {
      console.error("[Core Tasks] Failed to create task update notifications:", notifErr);
    }

    res.json(updated);
  } catch (error: any) {
    console.error("[Core Tasks] PATCH error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    res.status(500).json({ message: error.message });
  }
});

const completeTaskSchema = z.object({
  note: z.string().optional().nullable(),
  responses: z.record(z.unknown()).optional().nullable(),
  photoFileIds: z.array(z.string().uuid()).optional(),
  photoUrls: z.array(z.string()).optional(),
});

const taskPhotoUrl = (taskId: string, url: string): string | null => {
  const match = /^\/api\/files\/task-photos\/([a-zA-Z0-9._-]+)$/.exec(url);
  return match?.[1]?.startsWith(`task_${taskId}_`) ? match[1] : null;
};

router.post("/:id/complete", requireAuth, async (req: Request, res: Response) => {
  try {
    const body = completeTaskSchema.parse(req.body);
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ message: "Task access denied" });

    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, req.params.id), eq(tasks.tenantId, tenantId)))
      .limit(1);

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (!req.userWithAccess || !canUserAccessBranch(req.userWithAccess, task.branchId)) {
      return res.status(403).json({ message: "Access denied to this branch" });
    }

    if (body.photoFileIds?.length && body.photoUrls?.length) {
      return res.status(400).json({ message: "Choose one photo evidence format" });
    }

    let photoUrls: string[] = [];

    if (body.photoFileIds && body.photoFileIds.length > 0) {
      if (new Set(body.photoFileIds).size !== body.photoFileIds.length) {
        return res.status(400).json({ message: "Duplicate photo evidence" });
      }
      const fileRecords = await db
        .select({ storageKey: files.storageKey })
        .from(files)
        .where(and(eq(files.tenantId, tenantId), eq(files.source, `core_task_evidence:${task.id}`), inArray(files.id, body.photoFileIds)));
      if (fileRecords.length !== body.photoFileIds.length || fileRecords.some(f =>
        !f.storageKey.startsWith(`${STORAGE_ENV_PREFIX}/tenants/${tenantId}/core/tasks/${task.id}/evidence/`))) {
        return res.status(400).json({ message: "Photo evidence does not belong to this task" });
      }
      photoUrls = fileRecords.map((f) => f.storageKey);
    }

    if (body.photoUrls && body.photoUrls.length > 0 && photoUrls.length === 0) {
      for (let i = 0; i < body.photoUrls.length; i++) {
        const dataUrl = body.photoUrls[i];
        if (dataUrl.startsWith("data:")) {
          try {
            const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
            if (matches && ["image/jpeg", "image/png", "image/webp", "image/heic"].includes(matches[1])) {
              const mimeType = matches[1];
              const base64Data = matches[2];
              const buffer = Buffer.from(base64Data, "base64");
              if (buffer.length === 0 || buffer.length > 10 * 1024 * 1024) {
                return res.status(400).json({ message: "Photo evidence exceeds the 10 MB limit" });
              }
              const ext = mimeType.includes("png") ? "png" : mimeType.includes("webp") ? "webp" : mimeType.includes("heic") ? "heic" : "jpg";
              const filename = `task_${task.id}_${Date.now()}_${i}.${ext}`;
              const url = await uploadToObjectStorage(buffer, "task-photos", filename, mimeType);
              if (url) {
                photoUrls.push(url);
              }
            } else {
              return res.status(400).json({ message: "Invalid photo evidence" });
            }
          } catch (uploadErr) {
            console.error("[Core Tasks] Photo upload error:", uploadErr);
          }
        } else if (taskPhotoUrl(task.id, dataUrl) && await fileExistsInObjectStorage("task-photos", taskPhotoUrl(task.id, dataUrl)!)) {
          photoUrls.push(dataUrl);
        } else {
          return res.status(400).json({ message: "Photo evidence does not belong to this task" });
        }
      }
    }

    if (task.requiresPhotoEvidence && photoUrls.length === 0) {
      return res.status(400).json({ message: "Photo evidence is required to complete this task" });
    }

    const [completion] = await db
      .insert(taskCompletions)
      .values({
        tenantId,
        taskId: task.id,
        completedBy: req.user!.id,
        responses: body.responses ?? null,
        photoUrls: photoUrls.length > 0 ? photoUrls : null,
        note: body.note ?? null,
      })
      .returning();

    const completedNow = new Date();
    await db
      .update(tasks)
      .set({ status: "completed", updatedAt: completedNow, lastMovementAt: completedNow, completedAt: completedNow })
      .where(and(eq(tasks.id, task.id), eq(tasks.tenantId, tenantId)));

    const completerName = await getUserDisplayName(req.user!.id);
    await logTaskActivity(
      tenantId, task.id, task.branchId, "completed",
      `${completerName || "Someone"} completed task`,
      req.user!.id,
      { taskTitle: task.title }
    );

    try {
      const stakeholders = await getTaskStakeholderUserIds(task.id, tenantId);
      await createTaskStatusNotification({
        tenantId,
        taskId: task.id,
        taskTitle: task.title,
        newStatus: "completed",
        actorUserId: req.user!.id,
        recipientUserIds: stakeholders.filter(id => id !== req.user!.id),
      });
    } catch (notifErr) {
      console.error("[Core Tasks] Failed to create completion notification:", notifErr);
    }

    res.json(completion);
  } catch (error: any) {
    console.error("[Core Tasks] POST /:id/complete error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    res.status(500).json({ message: error.message });
  }
});

const uploadUrlSchema = z.object({
  taskId: z.string().uuid(),
  originalFilename: z.string().min(1),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp", "image/heic"]),
  sizeBytes: z.number().int().positive().max(10 * 1024 * 1024),
});

router.post("/files/upload-url", requireAuth, async (req: Request, res: Response) => {
  try {
    const body = uploadUrlSchema.parse(req.body);
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ message: "Task access denied" });
    const [task] = await db.select({ branchId: tasks.branchId }).from(tasks)
      .where(and(eq(tasks.id, body.taskId), eq(tasks.tenantId, tenantId))).limit(1);
    if (!task || !req.userWithAccess || !canUserAccessBranch(req.userWithAccess, task.branchId)) {
      return res.status(404).json({ message: "Task not found" });
    }
    const safeFilename = body.originalFilename.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 120);

    const [file] = await db
      .insert(files)
      .values({
        tenantId,
        source: `core_task_evidence:${body.taskId}`,
        originalFilename: safeFilename,
        storageKey: "",
        mimeType: body.mimeType,
        sizeBytes: body.sizeBytes,
      })
      .returning();

    const storageKey = `${STORAGE_ENV_PREFIX}/tenants/${tenantId}/core/tasks/${body.taskId}/evidence/${file.id}/${safeFilename}`;

    await db.update(files).set({ storageKey }).where(eq(files.id, file.id));

    const uploadUrl = await presignedUploadUrl(storageKey, body.mimeType);

    res.json({
      uploadUrl,
      fileId: file.id,
      storageKey,
    });
  } catch (error: any) {
    console.error("[Core Tasks] POST /files/upload-url error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    res.status(500).json({ message: error.message });
  }
});

// ============================================
// MULTI-DAY TASK PROGRESS & STATUS MANAGEMENT
// ============================================

// Helper to derive status from progress (if not manually overridden)
type TaskStatus = "pending" | "in_progress" | "completed" | "overdue" | "cancelled" | "blocked";

function deriveTaskStatus(progressPercent: number, isBlocked: boolean): TaskStatus {
  if (isBlocked) return "blocked";
  if (progressPercent === 0) return "pending";
  if (progressPercent >= 100) return "completed";
  return "in_progress";
}

// Update progress endpoint
const updateProgressSchema = z.object({
  progressPercent: z.number().min(0).max(100),
  note: z.string().optional(),
});

router.patch("/:id/progress", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = updateProgressSchema.parse(req.body);
    const tenantId = await getDefaultTenantId();

    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId)));

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (task.branchId && (!req.userWithAccess || !canUserAccessBranch(req.userWithAccess, task.branchId))) {
      return res.status(403).json({ message: "Access denied to this branch" });
    }

    const progressNow = new Date();
    const updates: any = {
      progressPercent: body.progressPercent,
      updatedAt: progressNow,
      lastMovementAt: progressNow,
    };

    // Derive status if not manually overridden and not blocked
    if (!task.statusManualOverride && task.status !== "blocked") {
      updates.status = deriveTaskStatus(body.progressPercent, false);
      if (body.progressPercent >= 100) {
        updates.completedAt = progressNow;
      }
    }

    const [updated] = await db
      .update(tasks)
      .set(updates)
      .where(eq(tasks.id, id))
      .returning();

    const progressUpdater = await getUserDisplayName(req.user!.id);
    await logTaskActivity(
      tenantId, task.id, task.branchId, "progress_updated",
      `${progressUpdater || "Someone"} updated progress to ${body.progressPercent}%`,
      req.user!.id,
      { taskTitle: task.title, oldProgress: task.progressPercent, newProgress: body.progressPercent }
    );

    res.json(formatTaskResult(updated));
  } catch (error: any) {
    console.error("[Core Tasks] PATCH /:id/progress error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    res.status(500).json({ message: error.message });
  }
});

// Block task endpoint
const blockTaskSchema = z.object({
  blockedReason: z.string().min(1, "Blocked reason is required"),
});

router.post("/:id/block", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = blockTaskSchema.parse(req.body);
    const tenantId = await getDefaultTenantId();

    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId)));

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (task.branchId && (!req.userWithAccess || !canUserAccessBranch(req.userWithAccess, task.branchId))) {
      return res.status(403).json({ message: "Access denied to this branch" });
    }

    const blockNow = new Date();
    const [updated] = await db
      .update(tasks)
      .set({
        status: "blocked",
        blockedReason: body.blockedReason,
        statusManualOverride: true,
        updatedAt: blockNow,
        lastMovementAt: blockNow,
      })
      .where(eq(tasks.id, id))
      .returning();

    const blockerName = await getUserDisplayName(req.user!.id);
    await logTaskActivity(
      tenantId, task.id, task.branchId, "blocked",
      `${blockerName || "Someone"} blocked task: ${body.blockedReason}`,
      req.user!.id,
      { taskTitle: task.title, reason: body.blockedReason }
    );

    res.json(formatTaskResult(updated));
  } catch (error: any) {
    console.error("[Core Tasks] POST /:id/block error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    res.status(500).json({ message: error.message });
  }
});

// Unblock task endpoint
router.post("/:id/unblock", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = await getDefaultTenantId();

    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId)));

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (task.branchId && (!req.userWithAccess || !canUserAccessBranch(req.userWithAccess, task.branchId))) {
      return res.status(403).json({ message: "Access denied to this branch" });
    }

    // Derive new status from current progress
    const newStatus = deriveTaskStatus(task.progressPercent, false);
    const unblockNow = new Date();

    const [updated] = await db
      .update(tasks)
      .set({
        status: newStatus,
        blockedReason: null,
        statusManualOverride: false,
        updatedAt: unblockNow,
        lastMovementAt: unblockNow,
      })
      .where(eq(tasks.id, id))
      .returning();

    const unblockerName = await getUserDisplayName(req.user!.id);
    await logTaskActivity(
      tenantId, task.id, task.branchId, "unblocked",
      `${unblockerName || "Someone"} unblocked task`,
      req.user!.id,
      { taskTitle: task.title }
    );

    res.json(formatTaskResult(updated));
  } catch (error: any) {
    console.error("[Core Tasks] POST /:id/unblock error:", error);
    res.status(500).json({ message: error.message });
  }
});

// ============================================
// ROLLBACK ACTIVITY CHANGE
// ============================================
router.post("/:id/rollback/:activityId", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const { id, activityId } = req.params;

    const [existing] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId)));

    if (!existing) return res.status(404).json({ message: "Task not found" });

    const [activity] = await db
      .select()
      .from(taskActivities)
      .where(and(eq(taskActivities.id, activityId), eq(taskActivities.taskId, id)));

    if (!activity) return res.status(404).json({ message: "Activity not found" });

    const meta = activity.metadata as Record<string, unknown> | null;
    if (!meta) return res.status(400).json({ message: "Activity has no rollback data" });

    const updateData: Record<string, unknown> = { updatedAt: new Date() };
    const actType = activity.activityType;
    let rollbackDescription = "";
    const rollerName = await getUserDisplayName(req.user!.id);
    const who = rollerName || "Someone";

    if (actType === "status_changed" && meta.oldStatus) {
      updateData.status = meta.oldStatus;
      rollbackDescription = `${who} rolled back status to "${meta.oldStatus}"`;
    } else if (actType === "priority_changed" && meta.oldPriority) {
      updateData.priority = meta.oldPriority;
      rollbackDescription = `${who} rolled back priority to "${meta.oldPriority}"`;
    } else if (actType === "due_date_changed") {
      if (meta.oldDueDate === "none") {
        updateData.dueAt = null;
        rollbackDescription = `${who} rolled back due date (removed)`;
      } else if (typeof meta.oldDueDate === "string") {
        const dateStr = meta.oldDueDate as string;
        const parsed = new Date(dateStr);
        if (!isNaN(parsed.getTime())) {
          updateData.dueAt = parsed;
          if (!existing.scheduledMode) {
            updateData.startAt = parsed;
          }
          rollbackDescription = `${who} rolled back due date to ${dateStr}`;
        }
      }
    } else if (actType === "description_changed" && meta.oldDescription !== undefined) {
      updateData.description = meta.oldDescription;
      rollbackDescription = `${who} rolled back description`;
    } else if (actType === "assigned" && meta.oldAssignments !== undefined) {
      const oldAssignments = meta.oldAssignments as Array<{ assignmentType: string; assignmentId: string }>;
      await db.delete(taskAssignments).where(
        and(eq(taskAssignments.taskId, id), eq(taskAssignments.tenantId, tenantId))
      );
      for (const a of oldAssignments) {
        await db.insert(taskAssignments).values({
          tenantId,
          taskId: id,
          assignmentType: a.assignmentType as any,
          assignmentId: a.assignmentId,
        });
      }
      updateData.lastMovementAt = new Date();
      rollbackDescription = oldAssignments.length > 0
        ? `${who} rolled back assignment`
        : `${who} rolled back to unassigned`;
    } else {
      return res.status(400).json({ message: "This activity type cannot be rolled back" });
    }

    if (!rollbackDescription) {
      return res.status(400).json({ message: "Could not determine rollback value" });
    }

    const [updated] = await db
      .update(tasks)
      .set(updateData)
      .where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId)))
      .returning();

    await logTaskActivity(
      tenantId, id, existing.branchId, actType,
      rollbackDescription,
      req.user!.id,
      { rollbackFromActivityId: activityId, taskTitle: existing.title }
    );

    res.json(formatTaskResult(updated));
  } catch (error: any) {
    console.error("[Core Tasks] POST /:id/rollback/:activityId error:", error);
    res.status(500).json({ message: error.message });
  }
});

export default router;
