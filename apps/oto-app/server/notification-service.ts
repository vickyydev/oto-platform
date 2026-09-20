import { db } from "./db";
import { notifications } from "./db/coreSchema";
import { users, employees } from "../shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import type { InsertNotification } from "./db/coreSchema";

async function getActorName(userId: string, tenantId: string): Promise<string> {
  try {
    const emp = await db
      .select({ nickname: employees.nickname, fullName: employees.fullName })
      .from(employees)
      .where(and(eq(employees.userId, userId), eq(employees.tenantId, tenantId), eq(employees.status, "active")))
      .limit(1);
    if (emp.length > 0) return emp[0].nickname || emp[0].fullName || "Someone";

    const [user] = await db
      .select({ fullName: users.fullName })
      .from(users)
      .where(eq(users.id, userId));
    return user?.fullName || "Someone";
  } catch {
    return "Someone";
  }
}

export async function createNotification(data: InsertNotification): Promise<void> {
  try {
    if (data.recipientUserId === data.actorUserId) return;

    await db.insert(notifications).values(data);
  } catch (err) {
    console.error("[NotificationService] Failed to create notification:", err);
  }
}

export async function createTaskCommentNotification(params: {
  tenantId: string;
  taskId: string;
  taskTitle: string;
  commentAuthorUserId: string;
  recipientUserIds: string[];
}): Promise<void> {
  const actorName = await getActorName(params.commentAuthorUserId, params.tenantId);
  const truncatedTitle = params.taskTitle.length > 50 
    ? params.taskTitle.slice(0, 50) + "..." 
    : params.taskTitle;

  for (const recipientId of params.recipientUserIds) {
    await createNotification({
      tenantId: params.tenantId,
      recipientUserId: recipientId,
      type: "task_comment",
      title: `New comment on "${truncatedTitle}"`,
      body: `${actorName} commented on a task you're involved with`,
      referenceType: "task",
      referenceId: params.taskId,
      actorUserId: params.commentAuthorUserId,
      actorName,
    });
  }
}

export async function createTaskAssignedNotification(params: {
  tenantId: string;
  taskId: string;
  taskTitle: string;
  assignedUserId: string;
  assignerUserId: string;
}): Promise<void> {
  const actorName = await getActorName(params.assignerUserId, params.tenantId);
  const truncatedTitle = params.taskTitle.length > 50 
    ? params.taskTitle.slice(0, 50) + "..." 
    : params.taskTitle;

  await createNotification({
    tenantId: params.tenantId,
    recipientUserId: params.assignedUserId,
    type: "task_assigned",
    title: `Task assigned: "${truncatedTitle}"`,
    body: `${actorName} assigned you a task`,
    referenceType: "task",
    referenceId: params.taskId,
    actorUserId: params.assignerUserId,
    actorName,
  });
}

export async function createTaskStatusNotification(params: {
  tenantId: string;
  taskId: string;
  taskTitle: string;
  newStatus: string;
  actorUserId: string;
  recipientUserIds: string[];
}): Promise<void> {
  const actorName = await getActorName(params.actorUserId, params.tenantId);
  const truncatedTitle = params.taskTitle.length > 50 
    ? params.taskTitle.slice(0, 50) + "..." 
    : params.taskTitle;

  const type = params.newStatus === "completed" ? "task_completed" : "task_status_changed";
  const statusLabel = params.newStatus.replace(/_/g, " ");

  for (const recipientId of params.recipientUserIds) {
    await createNotification({
      tenantId: params.tenantId,
      recipientUserId: recipientId,
      type,
      title: type === "task_completed" 
        ? `Task completed: "${truncatedTitle}"`
        : `Task status updated: "${truncatedTitle}"`,
      body: `${actorName} changed status to ${statusLabel}`,
      referenceType: "task",
      referenceId: params.taskId,
      actorUserId: params.actorUserId,
      actorName,
    });
  }
}

export async function createTaskAttachmentNotification(params: {
  tenantId: string;
  taskId: string;
  taskTitle: string;
  fileName: string;
  actorUserId: string;
  recipientUserIds: string[];
}): Promise<void> {
  const actorName = await getActorName(params.actorUserId, params.tenantId);
  const truncatedTitle = params.taskTitle.length > 50 
    ? params.taskTitle.slice(0, 50) + "..." 
    : params.taskTitle;

  for (const recipientId of params.recipientUserIds) {
    await createNotification({
      tenantId: params.tenantId,
      recipientUserId: recipientId,
      type: "task_attachment",
      title: `Attachment added to "${truncatedTitle}"`,
      body: `${actorName} added "${params.fileName}"`,
      referenceType: "task",
      referenceId: params.taskId,
      actorUserId: params.actorUserId,
      actorName,
    });
  }
}

export async function createTaskChecklistNotification(params: {
  tenantId: string;
  taskId: string;
  taskTitle: string;
  itemTitle: string;
  action: "added" | "checked" | "unchecked" | "removed";
  actorUserId: string;
  recipientUserIds: string[];
}): Promise<void> {
  const actorName = await getActorName(params.actorUserId, params.tenantId);
  const truncatedTitle = params.taskTitle.length > 50 
    ? params.taskTitle.slice(0, 50) + "..." 
    : params.taskTitle;

  const actionLabels: Record<string, string> = {
    added: "added checklist item",
    checked: "checked off",
    unchecked: "unchecked",
    removed: "removed checklist item",
  };

  for (const recipientId of params.recipientUserIds) {
    await createNotification({
      tenantId: params.tenantId,
      recipientUserId: recipientId,
      type: "task_checklist_update",
      title: `Checklist updated on "${truncatedTitle}"`,
      body: `${actorName} ${actionLabels[params.action]} "${params.itemTitle}"`,
      referenceType: "task",
      referenceId: params.taskId,
      actorUserId: params.actorUserId,
      actorName,
    });
  }
}

export async function createTaskDueDateNotification(params: {
  tenantId: string;
  taskId: string;
  taskTitle: string;
  oldDueDate: string;
  newDueDate: string;
  actorUserId: string;
  recipientUserIds: string[];
}): Promise<void> {
  const actorName = await getActorName(params.actorUserId, params.tenantId);
  const truncatedTitle = params.taskTitle.length > 50 
    ? params.taskTitle.slice(0, 50) + "..." 
    : params.taskTitle;

  for (const recipientId of params.recipientUserIds) {
    await createNotification({
      tenantId: params.tenantId,
      recipientUserId: recipientId,
      type: "task_due_date_changed",
      title: `Due date changed on "${truncatedTitle}"`,
      body: `${actorName} changed due date from ${params.oldDueDate} to ${params.newDueDate}`,
      referenceType: "task",
      referenceId: params.taskId,
      actorUserId: params.actorUserId,
      actorName,
    });
  }
}

export async function createTaskPriorityNotification(params: {
  tenantId: string;
  taskId: string;
  taskTitle: string;
  oldPriority: string;
  newPriority: string;
  actorUserId: string;
  recipientUserIds: string[];
}): Promise<void> {
  const actorName = await getActorName(params.actorUserId, params.tenantId);
  const truncatedTitle = params.taskTitle.length > 50 
    ? params.taskTitle.slice(0, 50) + "..." 
    : params.taskTitle;

  for (const recipientId of params.recipientUserIds) {
    await createNotification({
      tenantId: params.tenantId,
      recipientUserId: recipientId,
      type: "task_priority_changed",
      title: `Priority changed on "${truncatedTitle}"`,
      body: `${actorName} changed priority from ${params.oldPriority} to ${params.newPriority}`,
      referenceType: "task",
      referenceId: params.taskId,
      actorUserId: params.actorUserId,
      actorName,
    });
  }
}

export async function createTaskEscalatedNotification(params: {
  tenantId: string;
  taskId: string;
  taskTitle: string;
  escalated: boolean;
  actorUserId: string;
  recipientUserIds: string[];
}): Promise<void> {
  const actorName = await getActorName(params.actorUserId, params.tenantId);
  const truncatedTitle = params.taskTitle.length > 50 
    ? params.taskTitle.slice(0, 50) + "..." 
    : params.taskTitle;

  for (const recipientId of params.recipientUserIds) {
    await createNotification({
      tenantId: params.tenantId,
      recipientUserId: recipientId,
      type: "task_escalated",
      title: params.escalated 
        ? `Task escalated: "${truncatedTitle}"`
        : `Task de-escalated: "${truncatedTitle}"`,
      body: params.escalated 
        ? `${actorName} escalated this task`
        : `${actorName} de-escalated this task`,
      referenceType: "task",
      referenceId: params.taskId,
      actorUserId: params.actorUserId,
      actorName,
    });
  }
}

export async function createTaskDescriptionNotification(params: {
  tenantId: string;
  taskId: string;
  taskTitle: string;
  action: "added" | "updated" | "removed";
  actorUserId: string;
  recipientUserIds: string[];
}): Promise<void> {
  const actorName = await getActorName(params.actorUserId, params.tenantId);
  const truncatedTitle = params.taskTitle.length > 50 
    ? params.taskTitle.slice(0, 50) + "..." 
    : params.taskTitle;

  for (const recipientId of params.recipientUserIds) {
    await createNotification({
      tenantId: params.tenantId,
      recipientUserId: recipientId,
      type: "task_description_changed",
      title: `Description ${params.action} on "${truncatedTitle}"`,
      body: `${actorName} ${params.action} the description`,
      referenceType: "task",
      referenceId: params.taskId,
      actorUserId: params.actorUserId,
      actorName,
    });
  }
}

export async function getTaskStakeholderUserIds(taskId: string, tenantId: string): Promise<string[]> {
  try {
    const result = await db.execute(sql`
      SELECT t.assigned_to, t.owner_user_id, t.created_by, t.assigned_employee_id, e.user_id AS employee_user_id
      FROM tasks t
      LEFT JOIN employees e ON e.id = t.assigned_employee_id AND e.tenant_id = t.tenant_id
      WHERE t.id = ${taskId} AND t.tenant_id = ${tenantId}
    `);
    const rows = Array.isArray(result) ? result : (result as any).rows || [];
    
    if (rows.length === 0) return [];

    const ids = new Set<string>();
    const row = rows[0] as any;
    if (row.assigned_to) ids.add(row.assigned_to);
    if (row.owner_user_id) ids.add(row.owner_user_id);
    if (row.created_by) ids.add(row.created_by);
    if (row.employee_user_id) ids.add(row.employee_user_id);

    const assignmentResult = await db.execute(sql`
      SELECT ta.assignment_type, ta.assignment_id
      FROM task_assignments ta
      WHERE ta.task_id = ${taskId}
    `);
    const assignmentRows = Array.isArray(assignmentResult) ? assignmentResult : (assignmentResult as any).rows || [];

    const empIdsToResolve: string[] = [];
    const advisorIdsToResolve: string[] = [];

    for (const ar of assignmentRows) {
      const a = ar as any;
      if (a.assignment_type === "employee") empIdsToResolve.push(a.assignment_id);
      else if (a.assignment_type === "advisor") advisorIdsToResolve.push(a.assignment_id);
    }

    if (empIdsToResolve.length > 0) {
      const empUsers = await db.execute(sql`
        SELECT user_id FROM employees WHERE id IN (${sql.join(empIdsToResolve.map(id => sql`${id}`), sql`, `)}) AND user_id IS NOT NULL
      `);
      const empUserRows = Array.isArray(empUsers) ? empUsers : (empUsers as any).rows || [];
      for (const eu of empUserRows) {
        if ((eu as any).user_id) ids.add((eu as any).user_id);
      }
    }

    for (const advId of advisorIdsToResolve) {
      ids.add(advId);
    }

    return Array.from(ids);
  } catch (err) {
    console.error("[NotificationService] Failed to get stakeholders:", err);
    return [];
  }
}
