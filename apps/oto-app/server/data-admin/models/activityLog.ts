import { ModelAdmin, deriveFormFields } from "../admin";
import { activityLog } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class ActivityLogAdmin extends ModelAdmin {
  name = "Activity Log";
  table = activityLog;
  priority = 3;
  description = "Audit trail of system events (contract sent, employee onboarded, etc.) linked to branches, employees, and contracts.";

  listDisplay = [
    { key: "activityType", type: "enum" as const },
    { key: "summaryText" },
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["summaryText"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new ActivityLogAdmin();
