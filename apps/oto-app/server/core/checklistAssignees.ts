import { eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { checklistTemplateAssignees } from "../db/coreSchema";

/**
 * The employees a checklist template names (SCRUM-658).
 *
 * A template used to name one employee, in `checklist_templates.assigned_employee_id`.
 * It can now name several, in `checklist_template_assignees`. Both are kept:
 *
 *  - a write sets the join rows to the list and the column to its first entry,
 *    so anything that reads only the column still finds a named person;
 *  - a read is the union, the column's employee first, so a template written
 *    before the join table (or by a writer that sets only the column) still
 *    names its one person.
 */

/** The list a request names, or undefined when the request leaves it alone. */
export function requestedChecklistAssignees(body: {
  assignedEmployeeIds?: unknown;
  assignedEmployeeId?: unknown;
}): string[] | undefined {
  if (Array.isArray(body.assignedEmployeeIds)) {
    return [...new Set(body.assignedEmployeeIds.filter((id): id is string => typeof id === "string" && id.length > 0))];
  }
  if (body.assignedEmployeeId !== undefined) {
    return typeof body.assignedEmployeeId === "string" && body.assignedEmployeeId ? [body.assignedEmployeeId] : [];
  }
  return undefined;
}

/** Each template with `assignedEmployeeIds`: its column's employee first, then the join rows. */
export async function withChecklistAssignees<T extends { id: string; assignedEmployeeId?: string | null }>(
  templates: T[],
): Promise<Array<T & { assignedEmployeeIds: string[] }>> {
  const ids = templates.map((t) => t.id);
  const rows = ids.length
    ? await db
        .select({ templateId: checklistTemplateAssignees.templateId, employeeId: checklistTemplateAssignees.employeeId })
        .from(checklistTemplateAssignees)
        .where(inArray(checklistTemplateAssignees.templateId, ids))
        .orderBy(checklistTemplateAssignees.createdAt, checklistTemplateAssignees.id)
    : [];
  const byTemplate = new Map<string, string[]>();
  for (const row of rows) {
    const list = byTemplate.get(row.templateId) ?? [];
    list.push(row.employeeId);
    byTemplate.set(row.templateId, list);
  }
  return templates.map((t) => ({
    ...t,
    assignedEmployeeIds: [
      ...new Set([...(t.assignedEmployeeId ? [t.assignedEmployeeId] : []), ...(byTemplate.get(t.id) ?? [])]),
    ],
  }));
}

/** Replace the template's named employees with `employeeIds` (the caller sets the column to the first). */
export async function setChecklistAssignees(tenantId: string, templateId: string, employeeIds: string[]): Promise<void> {
  const now = Date.now();
  await db.transaction(async (tx) => {
    await tx.delete(checklistTemplateAssignees).where(eq(checklistTemplateAssignees.templateId, templateId));
    if (employeeIds.length > 0) {
      await tx
        .insert(checklistTemplateAssignees)
        // One millisecond apart, so a read returns them in the order they were named.
        .values(employeeIds.map((employeeId, i) => ({ tenantId, templateId, employeeId, createdAt: new Date(now + i) })))
        .onConflictDoNothing();
    }
  });
}

