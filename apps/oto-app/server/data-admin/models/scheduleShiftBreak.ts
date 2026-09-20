import { ModelAdmin, deriveFormFields } from "../admin";
import { scheduleShiftBreaks } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class ScheduleShiftBreakAdmin extends ModelAdmin {
  name = "Schedule Shift Break";
  table = scheduleShiftBreaks;
  priority = 4;
  description = "Auto-generated or manual break slots for each employee assignment within a shift, with staggered timing to avoid coverage gaps.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "shiftDate", type: "date" as const },
    { key: "breakStartTime" },
    { key: "source", type: "enum" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new ScheduleShiftBreakAdmin();
