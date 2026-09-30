import { Router, Request, Response } from "express";
import { db } from "../../db";
import { eq, and, gte, lt, desc, asc, sql, isNull, or, ne, SQL, inArray, getTableColumns } from "drizzle-orm";
import { z } from "zod";
import { requireAuth } from "../../auth";
import { uploadToObjectStorage, getFileFromObjectStorage, fileExistsInObjectStorage } from "../../file-storage";
import { canUserAccessBranch } from "../../auth-middleware";
import { randomUUID } from "crypto";
import { 
  tasks, 
  taskQuestions, 
  taskCompletions,
  taskComments,
  taskActivities,
  taskAssignments,
} from "../../db/coreSchema";
import { tenants, branches, users, departments, roles, employees, accessPolicies, people, files, DEFAULT_TENANT_SLUG } from "../../../shared/schema";
import { STORAGE_ENV_PREFIX } from "../../config/env";
import { format, parseISO, startOfDay, endOfDay, addDays, isToday } from "date-fns";

import {
  createTaskCommentNotification,
  createTaskAssignedNotification,
  createTaskStatusNotification,
  createTaskDueDateNotification,
  createTaskPriorityNotification,
  createTaskEscalatedNotification,
  getTaskStakeholderUserIds,
} from "../../notification-service";

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

interface AssigneeInfo {
  type: "user" | "employee" | "role" | "department" | "unassigned";
  id: string | null;
  name: string | null;
  label: string;
}

interface ActorContext {
  userId: string;
  employeeId: string | null;
  advisorPersonId: string | null;
  departmentId: string | null;
  roleIds: string[];
  branchIds: string[];
}

async function batchResolveAssignmentsCompat(taskIds: string[]): Promise<Record<string, Array<{ id: string; assignmentType: string; assignmentId: string; label: string }>>> {
  if (taskIds.length === 0) return {};
  const rows = await db.select().from(taskAssignments).where(inArray(taskAssignments.taskId, taskIds));
  if (rows.length === 0) return {};

  const empIds = new Set<string>();
  const advIds = new Set<string>();
  const roleIdSet = new Set<string>();
  const deptIds = new Set<string>();
  const branchIdSet = new Set<string>();

  for (const r of rows) {
    if (r.assignmentType === "employee") empIds.add(r.assignmentId);
    else if (r.assignmentType === "advisor") advIds.add(r.assignmentId);
    else if (r.assignmentType === "role") roleIdSet.add(r.assignmentId);
    else if (r.assignmentType === "department") deptIds.add(r.assignmentId);
    else if (r.assignmentType === "branch") branchIdSet.add(r.assignmentId);
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
  if (roleIdSet.size > 0) {
    const roleIdArr = [...roleIdSet];
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
  if (branchIdSet.size > 0) {
    const bResult = await db.select({ id: branches.id, name: branches.name }).from(branches).where(inArray(branches.id, [...branchIdSet]));
    for (const b of bResult) labels[`branch:${b.id}`] = b.name;
  }

  const result: Record<string, Array<{ id: string; assignmentType: string; assignmentId: string; label: string }>> = {};
  for (const r of rows) {
    if (!result[r.taskId]) result[r.taskId] = [];
    result[r.taskId].push({
      id: r.id,
      assignmentType: r.assignmentType,
      assignmentId: r.assignmentId,
      label: labels[`${r.assignmentType}:${r.assignmentId}`] || r.assignmentId,
    });
  }
  return result;
}

function resolveAssignee(task: any, extras?: { assignedUserName?: string; assignedRoleName?: string; assignedDepartmentName?: string }): AssigneeInfo {
  if (task.assignedEmployeeId) {
    return {
      type: "employee",
      id: task.assignedEmployeeId,
      name: extras?.assignedUserName || null,
      label: extras?.assignedUserName || "Assigned employee",
    };
  }
  if (task.assignedTo) {
    return {
      type: "user",
      id: task.assignedTo,
      name: extras?.assignedUserName || null,
      label: extras?.assignedUserName || "Assigned user",
    };
  }
  if (task.assignedRoleId) {
    return {
      type: "role",
      id: task.assignedRoleId,
      name: extras?.assignedRoleName || null,
      label: extras?.assignedRoleName || "Role",
    };
  }
  if (task.assignedDepartmentId) {
    return {
      type: "department",
      id: task.assignedDepartmentId,
      name: extras?.assignedDepartmentName || null,
      label: extras?.assignedDepartmentName || "Department",
    };
  }
  return { type: "unassigned", id: null, name: null, label: "Everyone" };
}

/**
 * Dedicated Today personal-workspace predicate.
 * A task is visible iff:
 *   (a) Directly assigned to the actor by userId, employeeId, or an explicit
 *       assignment row targeting that employee/advisor.
 *   (b) Has a department assignment (legacy field OR assignment row) matching the
 *       actor's primary department AND has NO direct person (user/employee) assignment.
 * Creator visibility, role-only, branch-only, and fully-unassigned tasks are excluded.
 */
function isTaskVisibleInToday(task: any, actor: ActorContext, assignments: Array<{ assignmentType: string; assignmentId: string }>): boolean {
  // Determine whether the task has any direct person assignment (legacy fields)
  const hasDirectPersonLegacy = !!(task.assignedTo || task.assignedEmployeeId);

  // (a) Legacy direct user assignment
  if (task.assignedTo && task.assignedTo === actor.userId) return true;
  // (a) Legacy direct employee assignment
  if (task.assignedEmployeeId && actor.employeeId && task.assignedEmployeeId === actor.employeeId) return true;

  // Classify assignment rows
  const hasDirectPersonRow = assignments.some(a => a.assignmentType === 'employee' || a.assignmentType === 'advisor');
  const hasDeptRow = assignments.some(a => a.assignmentType === 'department');

  // (a) Explicit assignment row for actor's employee or advisor person
  for (const a of assignments) {
    if (a.assignmentType === 'employee' && actor.employeeId && a.assignmentId === actor.employeeId) return true;
    if (a.assignmentType === 'advisor' && actor.advisorPersonId && a.assignmentId === actor.advisorPersonId) return true;
  }

  // (b) Legacy department field: only when no direct person assignment exists
  if (task.assignedDepartmentId && actor.departmentId && task.assignedDepartmentId === actor.departmentId) {
    if (!hasDirectPersonLegacy) return true;
  }

  // (b) Department assignment row: only when no direct person assignment (legacy or row)
  if (hasDeptRow && !hasDirectPersonLegacy && !hasDirectPersonRow) {
    for (const a of assignments) {
      if (a.assignmentType === 'department' && actor.departmentId && a.assignmentId === actor.departmentId) return true;
    }
  }

  return false;
}

function isTaskMine(task: any, actor: ActorContext, newAssignments?: Array<{ assignmentType: string; assignmentId: string }>): boolean {
  // Creator can always see their own tasks
  if (task.createdBy && task.createdBy === actor.userId) return true;
  if (task.assignedTo && task.assignedTo === actor.userId) return true;
  if (task.assignedEmployeeId && actor.employeeId && task.assignedEmployeeId === actor.employeeId) return true;
  if (task.assignedRoleId && actor.roleIds.length > 0 && actor.roleIds.includes(task.assignedRoleId)) return true;
  if (task.assignedDepartmentId && actor.departmentId && task.assignedDepartmentId === actor.departmentId) return true;

  if (newAssignments && newAssignments.length > 0) {
    for (const a of newAssignments) {
      if (a.assignmentType === "employee" && actor.employeeId && a.assignmentId === actor.employeeId) return true;
      if (a.assignmentType === "advisor" && actor.advisorPersonId && a.assignmentId === actor.advisorPersonId) return true;
      if (a.assignmentType === "role" && actor.roleIds.includes(a.assignmentId)) return true;
      if (a.assignmentType === "department" && actor.departmentId === a.assignmentId) return true;
      if (a.assignmentType === "branch" && actor.branchIds.includes(a.assignmentId)) return true;
    }
    return false;
  }

  // Unassigned tasks are NOT visible to everyone — they should only be visible
  // to managers/admins via the main task board, not to individual staff.
  return false;
}

async function getActorContext(userId: string): Promise<ActorContext> {
  const empResult = await db.execute(sql`
    SELECT id, primary_department_id, branch_id FROM employees WHERE user_id = ${userId} LIMIT 1
  `);
  const empRows = Array.isArray(empResult) ? empResult : (empResult as any).rows || [];
  const emp = empRows[0];
  const roleIds: string[] = [];
  const branchIds: string[] = [];
  if (emp?.id) {
    const roleResult = await db.execute(sql`
      SELECT role_id FROM employee_roles WHERE employee_id = ${emp.id}
    `);
    const roleRows = Array.isArray(roleResult) ? roleResult : (roleResult as any).rows || [];
    for (const r of roleRows) {
      if (r.role_id) roleIds.push(r.role_id);
    }
  }
  if (emp?.branch_id) branchIds.push(emp.branch_id);

  let advisorPersonId: string | null = null;
  const userRow = await db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  if (userRow[0]?.email) {
    const personRow = await db.select({ id: people.id }).from(people)
      .where(and(eq(people.email, userRow[0].email), eq(people.personType, "ADVISOR")))
      .limit(1);
    if (personRow[0]) advisorPersonId = personRow[0].id;
  }

  return {
    userId,
    employeeId: emp?.id || null,
    advisorPersonId,
    departmentId: emp?.primary_department_id || null,
    roleIds,
    branchIds,
  };
}

function toBangkokDate(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}
function toBangkokTime(d: Date): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Bangkok', hour: '2-digit', minute: '2-digit', hour12: false }).format(d);
}

function formatTaskForUI(task: any, extras?: { assignedUserName?: string; assignedRoleName?: string; assignedDepartmentName?: string }, actor?: ActorContext | null) {
  const dueAt = task.dueAt ? new Date(task.dueAt) : null;
  const startAt = task.startAt ? new Date(task.startAt) : null;
  const assignee = resolveAssignee(task, extras);
  return {
    id: task.id,
    tenantId: task.tenantId,
    branchId: task.branchId,
    departmentId: task.departmentId,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    recurrence: task.recurrence,
    dueDate: dueAt ? toBangkokDate(dueAt) : null,
    dueTime: dueAt ? toBangkokTime(dueAt) : null,
    dueAt: task.dueAt,
    startAt: task.startAt,
    startDate: startAt ? toBangkokDate(startAt) : null,
    scheduledMode: task.scheduledMode || false,
    progressPercent: task.progressPercent || 0,
    assignedTo: task.assignedTo,
    assignedEmployeeId: task.assignedEmployeeId || null,
    assignedRoleId: task.assignedRoleId,
    assignedDepartmentId: task.assignedDepartmentId,
    assignedUserName: extras?.assignedUserName || null,
    assignedRoleName: extras?.assignedRoleName || null,
    assignedDepartmentName: extras?.assignedDepartmentName || null,
    assignee,
    isMine: actor ? isTaskMine(task, actor) : null,
    requiresPhotoEvidence: task.requiresPhotoEvidence,
    requiresResponses: task.requiresResponses,
    referencePhotoUrl: task.referencePhotoUrl,
    isRecurring: task.recurrence !== "once",
    eventId: null,
    createdBy: task.createdBy,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function parseDateTime(dateStr: string, timeStr: string): Date {
  return new Date(`${dateStr}T${timeStr}:00+07:00`);
}

router.get("/tasks/grouped", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const now = new Date();
    const todayStart = startOfDay(now);
    const todayEnd = endOfDay(now);
    const futureEnd = addDays(todayEnd, 14);

    // Alias tables for different joins
    const completedByUser = db.select().from(users).as('completedByUser');

    const taskCols2 = getTableColumns(tasks);
    const allTasks = await db
      .select({
        ...taskCols2,
        completionId: taskCompletions.id,
        completionCompletedBy: taskCompletions.completedBy,
        completionCompletedAt: taskCompletions.completedAt,
        completedByFullName: users.fullName,
        completedByNickname: employees.nickname,
        assignedUserName: sql<string>`COALESCE(
          (SELECT e.nickname FROM employees e WHERE e.id = ${tasks.assignedEmployeeId}),
          (SELECT e.full_name FROM employees e WHERE e.id = ${tasks.assignedEmployeeId}),
          (SELECT e.nickname FROM employees e WHERE e.user_id = ${tasks.assignedTo}),
          (SELECT full_name FROM users WHERE id = ${tasks.assignedTo})
        )`.as('assignedUserName'),
        assignedRoleName: sql<string>`(SELECT name FROM roles WHERE id = ${tasks.assignedRoleId})`.as('assignedRoleName'),
        assignedDeptName: sql<string>`(SELECT name FROM departments WHERE id = ${tasks.assignedDepartmentId})`.as('assignedDeptName'),
      })
      .from(tasks)
      .leftJoin(taskCompletions, eq(tasks.id, taskCompletions.taskId))
      .leftJoin(users, eq(taskCompletions.completedBy, users.id))
      .leftJoin(employees, eq(employees.userId, users.id))
      .where(and(
        eq(tasks.tenantId, tenantId),
        eq(tasks.isRecurringDefinition, false)
      ))
      .orderBy(tasks.dueAt);

    const today: any[] = [];
    const upcoming: any[] = [];
    const completedToday: any[] = [];
    const overdue: any[] = [];

    for (const row of allTasks) {
      const formatted = formatTaskForUI(row, {
        assignedUserName: row.assignedUserName || undefined,
        assignedRoleName: row.assignedRoleName || undefined,
        assignedDepartmentName: row.assignedDeptName || undefined,
      });
      const taskDue = row.dueAt ? new Date(row.dueAt) : null;

      if (row.completionId) {
        const completedAt = new Date(row.completionCompletedAt!);
        (formatted as any).completion = {
          id: row.completionId,
          completedById: row.completionCompletedBy,
          completedAt: row.completionCompletedAt,
        };
        (formatted as any).completedByName = row.completedByNickname || row.completedByFullName;
        
        if (completedAt >= todayStart && completedAt <= todayEnd) {
          completedToday.push(formatted);
        }
      } else {
        if (taskDue) {
          if (taskDue < todayStart) {
            // Overdue (before today)
            overdue.push(formatted);
          } else if (taskDue >= todayStart && taskDue <= todayEnd) {
            today.push(formatted);
          } else if (taskDue > todayEnd && taskDue <= futureEnd) {
            upcoming.push(formatted);
          }
        }
      }
    }

    // Include overdue tasks in today array for display
    res.json({ today: [...overdue, ...today], upcoming, completedToday });
  } catch (error: any) {
    console.error("[TasksCompat] GET /tasks/grouped error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/tasks/today", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const now = new Date();
    
    // Calculate today's boundaries in Bangkok timezone
    // Bangkok is UTC+7, so Bangkok midnight = 17:00 UTC previous day
    const bangkokDateStr = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok' }).format(now);
    // Parse the Bangkok date and calculate UTC boundaries
    const [year, month, day] = bangkokDateStr.split('-').map(Number);
    // Bangkok 00:00:00 = UTC of previous day 17:00:00
    const todayStartBangkok = new Date(Date.UTC(year, month - 1, day, -7, 0, 0, 0));
    // Bangkok 23:59:59.999 = UTC same day 16:59:59.999
    const todayEndBangkok = new Date(Date.UTC(year, month - 1, day + 1, -7, 0, 0, 0));
    
    const myOnly = req.query.myOnly === "true";
    const branchId = req.query.branchId as string | undefined;
    const userId = req.user?.id;
    let userRole = (req as any).userWithAccess?.role;
    if (!userRole && userId) {
      const userResult = await db.execute(sql`SELECT role FROM users WHERE id = ${userId}`);
      const userRows = Array.isArray(userResult) ? userResult : (userResult as any).rows || [];
      userRole = userRows[0]?.role;
    }
    const isAdminOrManager = ['global_admin', 'operator_admin', 'admin', 'manager'].includes(userRole || '');

    const actor = userId ? await getActorContext(userId) : null;

    const branchFilter = branchId ? sql`AND t.branch_id = ${branchId}` : sql``;
    
    const rawResult = await db.execute(sql`
      SELECT t.*, 
        COALESCE(
          (SELECT nickname FROM employees WHERE id = t.assigned_employee_id),
          (SELECT full_name FROM employees WHERE id = t.assigned_employee_id),
          (SELECT e.nickname FROM employees e WHERE e.user_id = t.assigned_to),
          (SELECT full_name FROM users WHERE id = t.assigned_to)
        ) as resolved_assignee_name,
        (SELECT name FROM roles WHERE id = t.assigned_role_id) as assigned_role_name,
        (SELECT name FROM departments WHERE id = t.assigned_department_id) as assigned_dept_name
      FROM tasks t
      WHERE t.tenant_id = ${tenantId}
        AND (t.start_at IS NULL OR t.start_at <= ${todayEndBangkok})
        AND t.is_recurring_definition = false
        AND t.status != 'completed'
        AND t.id NOT IN (SELECT task_id FROM task_completions)
        ${branchFilter}
      ORDER BY t.due_at ASC
    `);
    
    const rows = Array.isArray(rawResult) ? rawResult : (rawResult as any).rows || [];

    const formatted = rows.map((row: any) => {
      const camelRow = {
        id: row.id,
        tenantId: row.tenant_id,
        templateId: row.template_id,
        generatedForDate: row.generated_for_date,
        eventId: row.event_id,
        branchId: row.branch_id,
        departmentId: row.department_id,
        title: row.title,
        description: row.description,
        status: row.status,
        priority: row.priority,
        recurrence: row.recurrence,
        weeklyDays: row.weekly_days,
        monthlyDay: row.monthly_day,
        preferredDueTime: row.preferred_due_time,
        isRecurringDefinition: row.is_recurring_definition,
        parentTaskId: row.parent_task_id,
        dueAt: row.due_at,
        startAt: row.start_at,
        scheduledMode: row.scheduled_mode,
        progressPercent: row.progress_percent,
        statusManualOverride: row.status_manual_override,
        blockedReason: row.blocked_reason,
        completedAt: row.completed_at,
        assignedTo: row.assigned_to,
        assignedEmployeeId: row.assigned_employee_id,
        assignedRoleId: row.assigned_role_id,
        assignedDepartmentId: row.assigned_department_id,
        requiresPhotoEvidence: row.requires_photo_evidence,
        requiresResponses: row.requires_responses,
        referencePhotoUrl: row.reference_photo_url,
        taskLevel: row.task_level,
        escalated: row.escalated,
        lastMovementAt: row.last_movement_at,
        ownerUserId: row.owner_user_id,
        archivedAt: row.archived_at,
        createdBy: row.created_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      
      return formatTaskForUI(camelRow, {
        assignedUserName: row.resolved_assignee_name || undefined,
        assignedRoleName: row.assigned_role_name || undefined,
        assignedDepartmentName: row.assigned_dept_name || undefined,
      }, actor);
    });

    const assignmentsMap = await batchResolveAssignmentsCompat(formatted.map((t: any) => t.id));
    const withAssignments = formatted.map((t: any) => {
      const taskAssigns = assignmentsMap[t.id] || [];
      const mine = actor ? isTaskMine(t, actor, taskAssigns.length > 0 ? taskAssigns : undefined) : t.isMine;
      return { ...t, assignments: taskAssigns, isMine: mine };
    });

    // Always enforce personal-workspace filter for all users in Today view.
    // Uses a dedicated predicate — narrower than isTaskMine — matching only:
    //   (a) Directly assigned to actor by userId / employeeId / explicit assignment row
    //   (b) Department-assigned (legacy field or assignment row) with no direct person assignment
    // Creator visibility, role-only, branch-only, and fully-unassigned tasks are excluded.
    const result = actor ? withAssignments.filter((t: any) => isTaskVisibleInToday(t, actor, t.assignments || [])) : [];
    res.json(result);
  } catch (error: any) {
    console.error("[TasksCompat] GET /tasks/today error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/tasks/:taskId", requireAuth, async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const tenantId = await getDefaultTenantId();

    const taskCols3 = getTableColumns(tasks);
    const [taskRow] = await db
      .select({
        ...taskCols3,
        completionId: taskCompletions.id,
        completionCompletedBy: taskCompletions.completedBy,
        completionCompletedAt: taskCompletions.completedAt,
        completionPhotoUrls: taskCompletions.photoUrls,
        completionResponses: taskCompletions.responses,
        completedByUserFullName: users.fullName,
        completedByUserEmail: users.email,
        completedByNickname: employees.nickname,
        resolvedAssigneeName: sql<string>`COALESCE(
          (SELECT e.nickname FROM employees e WHERE e.id = ${tasks.assignedEmployeeId}),
          (SELECT e.full_name FROM employees e WHERE e.id = ${tasks.assignedEmployeeId}),
          (SELECT e.nickname FROM employees e WHERE e.user_id = ${tasks.assignedTo}),
          (SELECT u2.full_name FROM users u2 WHERE u2.id = ${tasks.assignedTo})
        )`.as('resolvedAssigneeName'),
        resolvedRoleName: sql<string>`(SELECT name FROM roles WHERE id = ${tasks.assignedRoleId})`.as('resolvedRoleName'),
        resolvedDeptName: sql<string>`(SELECT name FROM departments WHERE id = ${tasks.assignedDepartmentId})`.as('resolvedDeptName'),
      })
      .from(tasks)
      .leftJoin(taskCompletions, eq(tasks.id, taskCompletions.taskId))
      .leftJoin(users, eq(taskCompletions.completedBy, users.id))
      .leftJoin(employees, eq(employees.userId, users.id))
      .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)));

    if (!taskRow) {
      return res.status(404).json({ message: "Task not found" });
    }

    let questions = await db
      .select()
      .from(taskQuestions)
      .where(eq(taskQuestions.taskId, taskId))
      .orderBy(taskQuestions.sortOrder);
    
    if (questions.length === 0 && taskRow.parentTaskId) {
      questions = await db
        .select()
        .from(taskQuestions)
        .where(eq(taskQuestions.taskId, taskRow.parentTaskId))
        .orderBy(taskQuestions.sortOrder);
    }

    const formatted = formatTaskForUI(taskRow, {
      assignedUserName: taskRow.resolvedAssigneeName || undefined,
      assignedRoleName: taskRow.resolvedRoleName || undefined,
      assignedDepartmentName: taskRow.resolvedDeptName || undefined,
    });
    
    if (taskRow.completionId) {
      const responsesObj = taskRow.completionResponses as Record<string, unknown> | null;
      const responsesArray = responsesObj 
        ? Object.entries(responsesObj).map(([questionId, response]) => ({ questionId, response }))
        : undefined;
      
      (formatted as any).completion = {
        id: taskRow.completionId,
        completedById: taskRow.completionCompletedBy,
        completedAt: taskRow.completionCompletedAt,
        photoUrls: taskRow.completionPhotoUrls,
        responses: responsesArray,
      };
      (formatted as any).completedByName = taskRow.completedByNickname || taskRow.completedByUserFullName || taskRow.completedByUserEmail;
    }

    (formatted as any).questions = questions.map(q => ({
      id: q.id,
      prompt: q.prompt,
      questionType: q.questionType === "single_choice" ? "choice" : q.questionType,
      options: q.options,
      isRequired: q.isRequired,
      sortOrder: q.sortOrder,
    }));

    res.json(formatted);
  } catch (error: any) {
    console.error("[TasksCompat] GET /tasks/:taskId error:", error);
    res.status(500).json({ message: error.message });
  }
});

const completeTaskSchema = z.object({
  photoUrls: z.array(z.string()).optional(),
  responses: z.array(z.object({
    questionId: z.string(),
    answer: z.union([z.string(), z.boolean()]),
  })).optional(),
});

router.post("/tasks/:taskId/complete", requireAuth, async (req: Request, res: Response) => {
  try {
    const { taskId } = req.params;
    const body = completeTaskSchema.parse(req.body);
    const tenantId = req.userWithAccess?.tenantId;
    const userId = (req.user as any)?.id;

    if (!userId || !tenantId) {
      return res.status(401).json({ message: "User not authenticated" });
    }

    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)));

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (!req.userWithAccess || !canUserAccessBranch(req.userWithAccess, task.branchId)) {
      return res.status(404).json({ message: "Task not found" });
    }

    const photoUrls = await materializeTaskPhotos(taskId, tenantId, body.photoUrls || []);
    if (!photoUrls) return res.status(400).json({ message: "Photo evidence does not belong to this task" });

    if (task.requiresPhotoEvidence && photoUrls.length === 0) {
      return res.status(400).json({ message: "Photo evidence is required" });
    }

    const responsesObj: Record<string, unknown> = {};
    if (body.responses) {
      for (const r of body.responses) {
        responsesObj[r.questionId] = r.answer;
      }
    }

    const [completion] = await db
      .insert(taskCompletions)
      .values({
        tenantId,
        taskId,
        completedBy: userId,
        photoUrls: photoUrls.length ? photoUrls : null,
        responses: Object.keys(responsesObj).length > 0 ? responsesObj : null,
      })
      .returning();

    await db
      .update(tasks)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(tasks.id, taskId));

    try {
      const stakeholders = await getTaskStakeholderUserIds(taskId, tenantId);
      await createTaskStatusNotification({
        tenantId,
        taskId,
        taskTitle: task.title,
        newStatus: "completed",
        actorUserId: userId,
        recipientUserIds: stakeholders.filter(id => id !== userId),
      });
    } catch (notifErr) {
      console.error("[TasksCompat] Failed to create completion notification:", notifErr);
    }

    res.json({ success: true, completionId: completion.id });
  } catch (error: any) {
    console.error("[TasksCompat] POST /tasks/:taskId/complete error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    res.status(500).json({ message: error.message });
  }
});

router.get("/admin/tasks", requireAuth, async (req: Request, res: Response) => {
  try {
    const tenantId = await getDefaultTenantId();
    const dateStr = req.query.date as string;
    
    let dateStart: Date | undefined;
    let dateEnd: Date | undefined;
    
    if (dateStr) {
      dateStart = startOfDay(parseISO(dateStr));
      dateEnd = endOfDay(parseISO(dateStr));
    }

    let query = db
      .select()
      .from(tasks)
      .where(
        dateStr
          ? and(
              eq(tasks.tenantId, tenantId),
              gte(tasks.dueAt, dateStart!),
              lt(tasks.dueAt, dateEnd!)
            )
          : eq(tasks.tenantId, tenantId)
      )
      .orderBy(tasks.dueAt);

    const result = await query;
    res.json(result.map(formatTaskForUI));
  } catch (error: any) {
    console.error("[TasksCompat] GET /admin/tasks error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/admin/tasks/:id", requireAuth, async (req: Request, res: Response) => {
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

    const questions = await db
      .select()
      .from(taskQuestions)
      .where(eq(taskQuestions.taskId, id))
      .orderBy(taskQuestions.sortOrder);

    const formatted = formatTaskForUI(task);
    (formatted as any).questions = questions.map(q => ({
      id: q.id,
      prompt: q.prompt,
      questionType: q.questionType === "single_choice" ? "choice" : q.questionType,
      options: q.options,
      isRequired: q.isRequired,
      sortOrder: q.sortOrder,
    }));

    res.json(formatted);
  } catch (error: any) {
    console.error("[TasksCompat] GET /admin/tasks/:id error:", error);
    res.status(500).json({ message: error.message });
  }
});

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  dueDate: z.string().min(1),
  dueTime: z.string().min(1),
  departmentId: z.string().optional().nullable(),
  branchId: z.string().optional().nullable(),
  isRecurring: z.boolean().optional(),
  requiresPhotoEvidence: z.boolean().optional(),
  requiresResponses: z.boolean().optional(),
  referencePhotoUrl: z.string().optional().nullable(),
});

router.post("/admin/tasks", requireAuth, async (req: Request, res: Response) => {
  try {
    const body = createTaskSchema.parse(req.body);
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ message: "Task access denied" });
    if (body.referencePhotoUrl) return res.status(400).json({ message: "Add the reference photo after creating the task" });
    if (body.branchId && !canUserAccessBranch(req.userWithAccess!, body.branchId)) {
      return res.status(403).json({ message: "Branch access denied" });
    }
    const userId = (req.user as any)?.id;

    const dueAt = parseDateTime(body.dueDate, body.dueTime);

    const [task] = await db
      .insert(tasks)
      .values({
        tenantId,
        branchId: body.branchId || null,
        departmentId: body.departmentId || null,
        title: body.title,
        description: body.description || null,
        status: "pending",
        priority: "medium",
        recurrence: body.isRecurring ? "daily" : "once",
        dueAt,
        requiresPhotoEvidence: body.requiresPhotoEvidence || false,
        requiresResponses: body.requiresResponses || false,
        referencePhotoUrl: body.referencePhotoUrl || null,
        createdBy: userId,
      })
      .returning();

    res.json(formatTaskForUI(task));
  } catch (error: any) {
    console.error("[TasksCompat] POST /admin/tasks error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    res.status(500).json({ message: error.message });
  }
});

router.patch("/admin/tasks/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = createTaskSchema.partial().parse(req.body);
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ message: "Task access denied" });
    const [existing] = await db.select({ branchId: tasks.branchId, referencePhotoUrl: tasks.referencePhotoUrl })
      .from(tasks).where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId))).limit(1);
    if (!existing || !req.userWithAccess || !canUserAccessBranch(req.userWithAccess, existing.branchId)) {
      return res.status(404).json({ message: "Task not found" });
    }
    if (body.branchId && !canUserAccessBranch(req.userWithAccess, body.branchId)) {
      return res.status(403).json({ message: "Branch access denied" });
    }
    if (body.referencePhotoUrl && body.referencePhotoUrl !== existing.referencePhotoUrl &&
        !await canAttachTaskPhoto(id, tenantId, body.referencePhotoUrl)) {
      return res.status(400).json({ message: "Reference photo does not belong to this task" });
    }

    const updates: any = { updatedAt: new Date() };
    
    if (body.title) updates.title = body.title;
    if (body.description !== undefined) updates.description = body.description || null;
    if (body.departmentId !== undefined) updates.departmentId = body.departmentId || null;
    if (body.branchId !== undefined) updates.branchId = body.branchId || null;
    if (body.requiresPhotoEvidence !== undefined) updates.requiresPhotoEvidence = body.requiresPhotoEvidence;
    if (body.requiresResponses !== undefined) updates.requiresResponses = body.requiresResponses;
    if (body.referencePhotoUrl !== undefined) updates.referencePhotoUrl = body.referencePhotoUrl || null;
    if (body.isRecurring !== undefined) updates.recurrence = body.isRecurring ? "daily" : "once";
    
    if (body.dueDate && body.dueTime) {
      updates.dueAt = parseDateTime(body.dueDate, body.dueTime);
    }

    const [task] = await db
      .update(tasks)
      .set(updates)
      .where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId)))
      .returning();

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    res.json(formatTaskForUI(task));
  } catch (error: any) {
    console.error("[TasksCompat] PATCH /admin/tasks/:id error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    res.status(500).json({ message: error.message });
  }
});

router.delete("/admin/tasks/:id", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = await getDefaultTenantId();

    const [deleted] = await db
      .delete(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId)))
      .returning();

    if (!deleted) {
      return res.status(404).json({ message: "Task not found" });
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error("[TasksCompat] DELETE /admin/tasks/:id error:", error);
    res.status(500).json({ message: error.message });
  }
});

const questionsSchema = z.object({
  questions: z.array(z.object({
    prompt: z.string(),
    questionType: z.enum(["text", "choice", "boolean"]),
    options: z.array(z.string()).nullable().optional(),
    isRequired: z.boolean(),
    sortOrder: z.number(),
  })),
});

router.put("/admin/tasks/:id/questions", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const body = questionsSchema.parse(req.body);
    const tenantId = await getDefaultTenantId();

    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId)));

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    await db.delete(taskQuestions).where(eq(taskQuestions.taskId, id));

    if (body.questions.length > 0) {
      await db.insert(taskQuestions).values(
        body.questions.map((q, i) => ({
          tenantId,
          taskId: id,
          prompt: q.prompt,
          questionType: q.questionType === "choice" ? "single_choice" as const : q.questionType as any,
          options: q.options || null,
          isRequired: q.isRequired,
          sortOrder: q.sortOrder ?? i,
        }))
      );
    }

    res.json({ success: true });
  } catch (error: any) {
    console.error("[TasksCompat] PUT /admin/tasks/:id/questions error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    res.status(500).json({ message: error.message });
  }
});

// Configure multer for memory storage (for object storage upload)
import multer from "multer";
import * as fs from "fs";
import * as path from "path";

const taskPhotoPath = (url: string): string | null => {
  const match = /^\/(?:api\/files\/|uploads\/)?task-photos\/([a-zA-Z0-9._-]+)$/.exec(url);
  return match?.[1] || null;
};

async function canAttachTaskPhoto(taskId: string, tenantId: string, url: string): Promise<boolean> {
  const filename = taskPhotoPath(url);
  if (!filename) return false;
  const namedOwner = /^task_([0-9a-f-]{36})_/i.exec(filename)?.[1];
  if (namedOwner && namedOwner !== taskId) return false;
  if (filename.startsWith(`task_${taskId}_`) && await fileExistsInObjectStorage("task-photos", filename)) return true;
  const [previous] = await db.select({ id: tasks.id }).from(tasks)
    .leftJoin(taskCompletions, and(eq(taskCompletions.taskId, tasks.id), eq(taskCompletions.tenantId, tenantId)))
    .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId), or(
      eq(tasks.referencePhotoUrl, url),
      sql`${taskCompletions.photoUrls} @> ${JSON.stringify([url])}::jsonb`,
    ))).limit(1);
  return !!previous;
}

async function materializeTaskPhotos(taskId: string, tenantId: string, urls: string[]): Promise<string[] | null> {
  const result: string[] = [];
  for (const [index, url] of urls.entries()) {
    if (url.startsWith("data:")) {
      const match = /^data:(image\/(?:jpeg|png|webp|heic));base64,([A-Za-z0-9+/=]+)$/.exec(url);
      if (!match) return null;
      const bytes = Buffer.from(match[2], "base64");
      if (!bytes.length || bytes.length > 10 * 1024 * 1024) return null;
      const extension = match[1].split("/")[1] === "jpeg" ? "jpg" : match[1].split("/")[1];
      result.push(await uploadToObjectStorage(bytes, "task-photos", `task_${taskId}_${randomUUID()}_${index}.${extension}`, match[1]));
    } else if (await canAttachTaskPhoto(taskId, tenantId, url)) {
      result.push(url);
    } else {
      return null;
    }
  }
  return result;
}

// Legacy: Ensure task-photos directory exists for fallback
const taskPhotosDir = path.join(process.cwd(), "uploads", "task-photos");
if (!fs.existsSync(taskPhotosDir)) {
  fs.mkdirSync(taskPhotosDir, { recursive: true });
}

const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024, // 10MB max
  },
  fileFilter: (req, file, cb) => {
    const allowedTypes = ["image/jpeg", "image/png", "image/webp", "image/heic"];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type. Only JPEG, PNG, WebP and HEIC are allowed."));
    }
  },
});

export const serveTaskPhoto = async (req: Request, res: Response) => {
  try {
    const filename = req.params.filename;
    const access = req.userWithAccess;
    const tenantId = access?.tenantId;
    if (!access || !tenantId || !/^[a-zA-Z0-9._-]+$/.test(filename) || filename === "." || filename === "..") {
      return res.status(404).json({ message: "Photo not found" });
    }
    const urls = [
      `/api/files/task-photos/${filename}`,
      `/uploads/task-photos/${filename}`,
      `/task-photos/${filename}`,
    ];
    const namedOwner = /^task_([0-9a-f-]{36})_/i.exec(filename)?.[1];
    const owners = await db.select({ branchId: tasks.branchId }).from(tasks)
      .leftJoin(taskCompletions, and(eq(taskCompletions.taskId, tasks.id), eq(taskCompletions.tenantId, tenantId)))
      .where(and(eq(tasks.tenantId, tenantId), namedOwner ? eq(tasks.id, namedOwner) : undefined, or(
        inArray(tasks.referencePhotoUrl, urls),
        ...urls.map(url => sql`${taskCompletions.photoUrls} @> ${JSON.stringify([url])}::jsonb`),
      )));
    if (!owners.some(owner => canUserAccessBranch(access, owner.branchId))) {
      return res.status(404).json({ message: "Photo not found" });
    }
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const file = await getFileFromObjectStorage("task-photos", filename);
    if (file) {
      res.type(file.contentType);
      file.stream.pipe(res);
      return;
    }
    const legacyPath = path.join(taskPhotosDir, filename);
    if (fs.existsSync(legacyPath)) return res.sendFile(legacyPath);
    const oldestPath = path.join(process.cwd(), "task-photos", filename);
    if (fs.existsSync(oldestPath)) return res.sendFile(oldestPath);
    return res.status(404).json({ message: "Photo not found" });
  } catch (error) {
    console.error("[TasksCompat] Task photo read failed:", error);
    return res.status(500).json({ message: "Photo unavailable" });
  }
};

router.get("/files/task-photos/:filename", requireAuth, serveTaskPhoto);
router.get("/uploads/task-photos/:filename", requireAuth, serveTaskPhoto);
router.get("/task-photos/:filename", requireAuth, serveTaskPhoto);

// Upload task photos to object storage
router.post("/upload/photos", requireAuth, photoUpload.array("photos", 10), async (req: Request, res: Response) => {
  try {
    const taskId = z.string().uuid().parse(req.body.taskId);
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ message: "Task access denied" });
    const [task] = await db.select({ branchId: tasks.branchId }).from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId))).limit(1);
    if (!task || !req.userWithAccess || !canUserAccessBranch(req.userWithAccess, task.branchId)) {
      return res.status(404).json({ message: "Task not found" });
    }
    const files = req.files as Express.Multer.File[];
    if (!files || files.length === 0) {
      return res.json({ urls: [] });
    }

    const uploadedUrls: string[] = [];
    for (const file of files) {
      const ext = file.mimetype === "image/jpeg" ? "jpg" : file.mimetype.split("/")[1];
      const filename = `task_${taskId}_${randomUUID()}.${ext}`;
      const url = await uploadToObjectStorage(file.buffer, "task-photos", filename, file.mimetype);
      uploadedUrls.push(url);
    }
    res.json({ urls: uploadedUrls });
  } catch (error: any) {
    console.error("Photo upload error:", error);
    if (error instanceof z.ZodError) return res.status(400).json({ message: "Task ID required" });
    res.status(500).json({ error: "Failed to upload photos", message: error.message });
  }
});

// ============================================
// CORE API ENDPOINTS (/api/core/*)
// Branch-scoped task operations for end users
// ============================================

import { userBranchAccess } from "../../../shared/schema";

router.get("/core/branches", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const tenantId = await getDefaultTenantId();

    if (user.role === "admin") {
      const allBranches = await db
        .select({
          id: branches.id,
          name: branches.name,
        })
        .from(branches)
        .where(eq(branches.tenantId, tenantId))
        .orderBy(branches.name);
      return res.json(allBranches);
    }

    const accessRows = await db
      .select({ branchId: userBranchAccess.branchId })
      .from(userBranchAccess)
      .where(and(
        eq(userBranchAccess.tenantId, tenantId),
        eq(userBranchAccess.userId, user.id)
      ));

    if (accessRows.length === 0) {
      return res.json([]);
    }

    const branchIds = accessRows.map(r => r.branchId).filter((id): id is string => id !== null);
    if (branchIds.length === 0) {
      return res.json([]);
    }
    
    const userBranches = await db
      .select({
        id: branches.id,
        name: branches.name,
      })
      .from(branches)
      .where(and(
        eq(branches.tenantId, tenantId),
        inArray(branches.id, branchIds)
      ))
      .orderBy(branches.name);

    res.json(userBranches);
  } catch (error: any) {
    console.error("[TasksCompat] GET /core/branches error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.get("/core/tasks", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const tenantId = await getDefaultTenantId();
    const branchId = req.query.branchId as string | undefined;
    const status = req.query.status as string | undefined;
    const myOnly = req.query.myOnly === "true";
    let userRole = (req as any).userWithAccess?.role;
    if (!userRole && user?.id) {
      const userResult = await db.execute(sql`SELECT role FROM users WHERE id = ${user.id}`);
      const userRows = Array.isArray(userResult) ? userResult : (userResult as any).rows || [];
      userRole = userRows[0]?.role;
    }
    const isAdminOrManager = ['global_admin', 'operator_admin', 'admin', 'manager'].includes(userRole || '');

    const actor = user?.id ? await getActorContext(user.id) : null;

    const conditions: any[] = [
      eq(tasks.tenantId, tenantId),
      eq(tasks.isRecurringDefinition, false),
    ];

    if (branchId && branchId !== "all") {
      conditions.push(eq(tasks.branchId, branchId));
    }

    if (status && status !== "all") {
      conditions.push(eq(tasks.status, status as any));
    }

    const taskCols4 = getTableColumns(tasks);
    const taskRows = await db
      .select({
        ...taskCols4,
        assignedUserDbId: users.id,
        assignedUserFullName: users.fullName,
        assignedUserEmail: users.email,
        assignedEmployeeNickname: employees.nickname,
        branchName: branches.name,
        assignedRoleName: sql<string>`(SELECT name FROM roles WHERE id = ${tasks.assignedRoleId})`.as('assignedRoleName'),
        assignedDeptName: sql<string>`(SELECT name FROM departments WHERE id = ${tasks.assignedDepartmentId})`.as('assignedDeptName'),
      })
      .from(tasks)
      .leftJoin(users, eq(tasks.assignedTo, users.id))
      .leftJoin(employees, eq(employees.userId, users.id))
      .leftJoin(branches, eq(tasks.branchId, branches.id))
      .where(and(...conditions))
      .orderBy(desc(tasks.dueAt));

    const directEmpIds = taskRows
      .map(row => row.assignedEmployeeId)
      .filter((id): id is string => !!id);
    const directEmpsMap = new Map<string, { nickname: string | null; fullName: string | null }>();
    if (directEmpIds.length > 0) {
      const directEmps = await db
        .select({ id: employees.id, nickname: employees.nickname, fullName: employees.fullName })
        .from(employees)
        .where(inArray(employees.id, directEmpIds));
      directEmps.forEach(e => directEmpsMap.set(e.id, { nickname: e.nickname, fullName: e.fullName }));
    }

    let result = taskRows.map(row => {
      const directEmp = row.assignedEmployeeId ? directEmpsMap.get(row.assignedEmployeeId) : null;
      const directName = directEmp?.nickname || directEmp?.fullName || null;
      const userLinkedName = row.assignedEmployeeNickname || row.assignedUserFullName || null;
      const assignedName = directName || userLinkedName || undefined;
      
      return {
        ...formatTaskForUI(row, {
          assignedUserName: assignedName,
          assignedRoleName: row.assignedRoleName || undefined,
          assignedDepartmentName: row.assignedDeptName || undefined,
        }, actor),
        assignedUser: row.assignedUserDbId ? {
          id: row.assignedUserDbId,
          fullName: row.assignedUserFullName,
          nickname: row.assignedEmployeeNickname || null,
          email: row.assignedUserEmail,
        } : null,
        branchName: row.branchName || null,
      };
    });

    const assignmentsMap2 = await batchResolveAssignmentsCompat(result.map((t: any) => t.id));
    let withAssignments2 = result.map((t: any) => {
      const taskAssigns = assignmentsMap2[t.id] || [];
      const mine = actor ? isTaskMine(t, actor, taskAssigns.length > 0 ? taskAssigns : undefined) : t.isMine;
      return { ...t, assignments: taskAssigns, isMine: mine };
    });

    if (myOnly || !isAdminOrManager) {
      withAssignments2 = withAssignments2.filter((t: any) => t.isMine === true);
    }

    res.json(withAssignments2);
  } catch (error: any) {
    console.error("[TasksCompat] GET /core/tasks error:", error);
    res.status(500).json({ message: error.message });
  }
});

const coreCreateTaskSchema = z.object({
  branchId: z.string().optional().nullable(),
  title: z.string().min(1),
  description: z.string().optional().nullable(),
  dueAt: z.string().optional().nullable(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
  recurrence: z.enum(["once", "daily", "weekly", "monthly"]).optional(),
  assignedTo: z.string().optional().nullable(),
  assignedDepartmentId: z.string().optional().nullable(),
  requiresPhotoEvidence: z.boolean().optional(),
  requiresResponses: z.boolean().optional(),
});

router.post("/core/tasks", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const tenantId = await getDefaultTenantId();
    const body = coreCreateTaskSchema.parse(req.body);

    // Parse dueAt as Bangkok time if provided without timezone
    let parsedDueAt: Date | null = null;
    if (body.dueAt) {
      // If no timezone specified, assume Bangkok (UTC+7)
      const dueAtStr = body.dueAt.includes('+') || body.dueAt.includes('Z') 
        ? body.dueAt 
        : `${body.dueAt}+07:00`;
      parsedDueAt = new Date(dueAtStr);
    }

    const [newTask] = await db
      .insert(tasks)
      .values({
        tenantId,
        branchId: body.branchId || null,
        title: body.title,
        description: body.description || null,
        dueAt: parsedDueAt,
        priority: body.priority || "medium",
        recurrence: body.recurrence || "once",
        assignedTo: body.assignedTo || null,
        assignedDepartmentId: body.assignedDepartmentId || null,
        requiresPhotoEvidence: body.requiresPhotoEvidence || false,
        requiresResponses: body.requiresResponses || false,
        createdBy: user.id,
      })
      .returning();

    if (body.assignedTo && body.assignedTo !== user.id) {
      try {
        await createTaskAssignedNotification({
          tenantId,
          taskId: newTask.id,
          taskTitle: body.title,
          assignedUserId: body.assignedTo,
          assignerUserId: user.id,
        });
      } catch (notifErr) {
        console.error("[TasksCompat] Failed to create assignment notification:", notifErr);
      }
    }

    res.status(201).json(formatTaskForUI(newTask));
  } catch (error: any) {
    console.error("[TasksCompat] POST /core/tasks error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    res.status(500).json({ message: error.message });
  }
});

const coreCompleteTaskSchema = z.object({
  note: z.string().optional(),
  responses: z.record(z.any()).optional(),
  photoKeys: z.array(z.string()).optional(),
  photoFileIds: z.array(z.string().uuid()).optional(),
});

router.post("/core/tasks/:id/complete", requireAuth, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const user = req.user as any;
    const tenantId = req.userWithAccess?.tenantId;
    if (!tenantId) return res.status(403).json({ message: "Task access denied" });
    const body = coreCompleteTaskSchema.parse(req.body);

    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), eq(tasks.tenantId, tenantId)));

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (!req.userWithAccess || !canUserAccessBranch(req.userWithAccess, task.branchId)) {
      return res.status(404).json({ message: "Task not found" });
    }

    if (body.photoKeys?.length && body.photoFileIds?.length) {
      return res.status(400).json({ message: "Choose one photo evidence format" });
    }
    let photoUrls: string[] = [];
    const fileIds = body.photoFileIds || [];
    if (fileIds.length) {
      if (new Set(fileIds).size !== fileIds.length) return res.status(400).json({ message: "Duplicate photo evidence" });
      const records = await db.select({ storageKey: files.storageKey }).from(files)
        .where(and(eq(files.tenantId, tenantId), eq(files.source, `core_task_evidence:${id}`), inArray(files.id, fileIds)));
      if (records.length !== fileIds.length || records.some(record =>
        !record.storageKey.startsWith(`${STORAGE_ENV_PREFIX}/tenants/${tenantId}/core/tasks/${id}/evidence/`))) {
        return res.status(400).json({ message: "Photo evidence does not belong to this task" });
      }
      photoUrls = records.map(record => record.storageKey);
    } else if (body.photoKeys?.length) {
      const records = await db.select({ storageKey: files.storageKey }).from(files)
        .where(and(eq(files.tenantId, tenantId), eq(files.source, `core_task_evidence:${id}`), inArray(files.storageKey, body.photoKeys)));
      if (records.length !== body.photoKeys.length) return res.status(400).json({ message: "Photo evidence does not belong to this task" });
      photoUrls = records.map(record => record.storageKey);
    }
    if (task.requiresPhotoEvidence && photoUrls.length === 0) {
      return res.status(400).json({ message: "Photo evidence is required for this task" });
    }

    const [completion] = await db
      .insert(taskCompletions)
      .values({
        tenantId,
        taskId: id,
        completedBy: user.id,
        photoUrls: photoUrls.length > 0 ? photoUrls : null,
        responses: body.responses || null,
        note: body.note || null,
      })
      .returning();

    await db
      .update(tasks)
      .set({ status: "completed", updatedAt: new Date() })
      .where(eq(tasks.id, id));

    try {
      const stakeholders = await getTaskStakeholderUserIds(id, tenantId);
      await createTaskStatusNotification({
        tenantId,
        taskId: id,
        taskTitle: task.title,
        newStatus: "completed",
        actorUserId: user.id,
        recipientUserIds: stakeholders.filter(sid => sid !== user.id),
      });
    } catch (notifErr) {
      console.error("[TasksCompat] Failed to create completion notification:", notifErr);
    }

    res.json({ success: true, completionId: completion.id });
  } catch (error: any) {
    console.error("[TasksCompat] POST /core/tasks/:id/complete error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    res.status(500).json({ message: error.message });
  }
});

router.get("/core/tasks/:id/comments", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const tenantId = user.tenantId || await getDefaultTenantId();
    const taskId = req.params.id;

    const comments = await db
      .select({
        id: taskComments.id,
        taskId: taskComments.taskId,
        authorId: taskComments.authorId,
        body: taskComments.body,
        createdAt: taskComments.createdAt,
        authorName: sql<string>`COALESCE(${users.fullName}, ${users.email})`.as("author_name"),
      })
      .from(taskComments)
      .leftJoin(users, eq(taskComments.authorId, users.id))
      .where(and(
        eq(taskComments.tenantId, tenantId),
        eq(taskComments.taskId, taskId)
      ))
      .orderBy(asc(taskComments.createdAt));

    const enriched = [];
    for (const c of comments) {
      const emp = await db
        .select({ nickname: employees.nickname, fullName: employees.fullName, profilePhotoPath: employees.profilePhotoPath })
        .from(employees)
        .where(and(eq(employees.userId, c.authorId), eq(employees.tenantId, tenantId), eq(employees.status, "active")))
        .limit(1);
      const authorName = emp.length > 0 ? (emp[0].nickname || emp[0].fullName || c.authorName) : c.authorName;
      const authorAvatar = emp.length > 0 ? emp[0].profilePhotoPath : null;
      enriched.push({ ...c, authorName, authorAvatar });
    }

    res.json(enriched);
  } catch (error: any) {
    console.error("[TasksCompat] GET comments error:", error);
    res.status(500).json({ message: error.message });
  }
});

router.post("/core/tasks/:id/comments", requireAuth, async (req: Request, res: Response) => {
  try {
    const user = req.user as any;
    const tenantId = user.tenantId || await getDefaultTenantId();
    const taskId = req.params.id;

    const schema = z.object({ body: z.string().min(1).max(2000) });
    const { body } = schema.parse(req.body);

    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, taskId), eq(tasks.tenantId, tenantId)));

    if (!task) {
      return res.status(404).json({ message: "Task not found" });
    }

    const [comment] = await db
      .insert(taskComments)
      .values({
        tenantId,
        taskId,
        authorId: user.id,
        body,
      })
      .returning();

    let authorName = user.fullName || user.email || "Unknown";
    let authorAvatar: string | null = null;
    const emp = await db
      .select({ nickname: employees.nickname, fullName: employees.fullName, profilePhotoPath: employees.profilePhotoPath })
      .from(employees)
      .where(and(eq(employees.userId, user.id), eq(employees.tenantId, tenantId), eq(employees.status, "active")))
      .limit(1);
    if (emp.length > 0) {
      authorName = emp[0].nickname || emp[0].fullName || authorName;
      authorAvatar = emp[0].profilePhotoPath;
    }

    const [taskInfo] = await db.select({ branchId: tasks.branchId }).from(tasks).where(eq(tasks.id, taskId));
    try {
      await db.insert(taskActivities).values({
        tenantId,
        taskId,
        branchId: taskInfo?.branchId ?? null,
        activityType: "comment_added" as any,
        description: `${authorName} added a comment`,
        userId: user.id,
        metadata: { commentId: comment.id },
      });
    } catch (err) {
      console.error("[TasksCompat] Failed to log comment activity:", err);
    }

    try {
      const [taskForNotif] = await db.select({ title: tasks.title }).from(tasks).where(eq(tasks.id, taskId));
      if (taskForNotif) {
        const stakeholders = await getTaskStakeholderUserIds(taskId, tenantId);
        await createTaskCommentNotification({
          tenantId,
          taskId,
          taskTitle: taskForNotif.title,
          commentAuthorUserId: user.id,
          recipientUserIds: stakeholders.filter(id => id !== user.id),
        });
      }
    } catch (notifErr) {
      console.error("[TasksCompat] Failed to create comment notification:", notifErr);
    }

    res.json({ ...comment, authorName, authorAvatar });
  } catch (error: any) {
    console.error("[TasksCompat] POST comment error:", error);
    if (error instanceof z.ZodError) {
      return res.status(400).json({ message: error.errors[0].message });
    }
    res.status(500).json({ message: error.message });
  }
});

export default router;
