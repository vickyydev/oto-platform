import { ModelAdmin, deriveFormFields } from "../admin";
import { employeePresence } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class EmployeePresenceAdmin extends ModelAdmin {
  name = "Employee Presence";
  table = employeePresence;
  priority = 5;
  description = "Live clock-in state per employee: whether currently clocked in, at which branch, and timestamps of last clock event.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "isClockedIn", type: "boolean" as const },
    { key: "currentWorkBranchId", label: "Current Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "lastEventAt", type: "date" as const },
    { key: "lastEventType" },
  ];

  searchFields = [];
  defaultOrderBy = "updatedAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "currentWorkBranchId") return { ...f, label: "Current Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }

  // employeePresence uses employeeId as PK, not id
  async getById(id: string): Promise<Record<string, unknown> | null> {
    const { db } = await import("../../db");
    const { eq } = await import("drizzle-orm");
    const rows = await db.select().from(this.table).where(eq(this.table.employeeId, id)).limit(1);
    return (rows[0] as Record<string, unknown>) ?? null;
  }
}

export default new EmployeePresenceAdmin();
