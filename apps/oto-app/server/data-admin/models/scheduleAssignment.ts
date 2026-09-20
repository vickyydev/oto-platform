import { ModelAdmin, deriveFormFields } from "../admin";
import { scheduleAssignments, scheduleAssigneeTypes } from "../../../shared/schema";

class ScheduleAssignmentAdmin extends ModelAdmin {
  name = "Schedule Assignment";
  table = scheduleAssignments;
  priority = 8;
  description = "Assigns an employee or casual worker to a specific shift row on a specific date within a weekly plan, supporting cross-branch borrowing.";

  listDisplay = [
    { key: "shiftDate", label: "Date", type: "date" as const },
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "assigneeType", label: "Type", type: "enum" as const },
    { key: "roleId", label: "Role", relatedModel: "roles", relatedLabelField: "name" },
    { key: "isBorrowed", label: "Borrowed", type: "boolean" as const },
    { key: "assignedAt", label: "Assigned", type: "date" as const },
  ];

  filters = [
    {
      key: "assigneeType",
      label: "Assignee Type",
      type: "select" as const,
      options: scheduleAssigneeTypes.map(t => ({ label: t, value: t })),
    },
    { key: "isBorrowed", label: "Borrowed", type: "boolean" as const },
  ];

  defaultOrderBy = "shiftDate";

  get formFields() {
    return deriveFormFields(this.table).map(f => {
      if (f.key === "tenantId") return { ...f, label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" };
      if (f.key === "weekPlanId") return { ...f, label: "Week Plan", relatedModel: "scheduleweekplans", relatedLabelField: "id" };
      if (f.key === "shiftRowId") return { ...f, label: "Shift Row", relatedModel: "scheduleshiftrows", relatedLabelField: "label" };
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "casualWorkerId") return { ...f, label: "Casual Worker", relatedModel: "casualworkers", relatedLabelField: "fullName" };
      if (f.key === "assignedBy") return { ...f, label: "Assigned By", relatedModel: "users", relatedLabelField: "fullName" };
      if (f.key === "borrowedFromBranchId") return { ...f, label: "Borrowed From", relatedModel: "branches", relatedLabelField: "name" };
      if (f.key === "roleId") return { ...f, label: "Role", relatedModel: "roles", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new ScheduleAssignmentAdmin();
