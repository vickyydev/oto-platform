import { ModelAdmin, deriveFormFields } from "../admin";
import { scheduleShiftRows } from "../../../shared/schema";

class ScheduleShiftRowAdmin extends ModelAdmin {
  name = "Schedule Shift Row";
  table = scheduleShiftRows;
  priority = 8;
  description = "A named shift row in a weekly schedule (e.g. Morning Shift 09:00–17:00) with staffing requirements, break config, and optional department/group.";

  listDisplay = [
    { key: "label" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "departmentId", label: "Department", relatedModel: "departments", relatedLabelField: "name" },
    { key: "startTime", label: "Start" },
    { key: "endTime", label: "End" },
    { key: "staffRequired", label: "Staff Req.", type: "number" as const },
    { key: "breakEnabled", label: "Break", type: "boolean" as const },
  ];

  searchFields = ["label", "note"];

  filters = [
    { key: "breakEnabled", label: "Break Enabled", type: "boolean" as const },
  ];

  defaultOrderBy = "createdAt";

  get formFields() {
    return deriveFormFields(this.table).map(f => {
      if (f.key === "tenantId") return { ...f, label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      if (f.key === "departmentId") return { ...f, label: "Department", relatedModel: "departments", relatedLabelField: "name" };
      if (f.key === "shiftGroupId") return { ...f, label: "Shift Group", relatedModel: "shift-groups", relatedLabelField: "name" };
      if (f.key === "weekPlanId") return { ...f, label: "Week Plan", relatedModel: "scheduleweekplans", relatedLabelField: "id" };
      if (f.key === "createdBy") return { ...f, label: "Created By", relatedModel: "users", relatedLabelField: "fullName" };
      return f;
    });
  }
}

export default new ScheduleShiftRowAdmin();
