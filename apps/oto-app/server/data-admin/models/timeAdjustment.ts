import { ModelAdmin, deriveFormFields } from "../admin";
import { timeAdjustments } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class TimeAdjustmentAdmin extends ModelAdmin {
  name = "Time Adjustment";
  table = timeAdjustments;
  priority = 2;
  description = "Manager-requested corrections to an employee's timekeeping for a given work date, with before/after snapshots and approval workflow.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "adjustmentType", type: "enum" as const },
    { key: "approvalStatus", type: "enum" as const },
    { key: "workDate", type: "date" as const },
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

export default new TimeAdjustmentAdmin();
