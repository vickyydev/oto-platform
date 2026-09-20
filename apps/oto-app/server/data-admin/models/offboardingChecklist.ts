import { ModelAdmin, deriveFormFields } from "../admin";
import { offboardingChecklist } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class OffboardingChecklistAdmin extends ModelAdmin {
  name = "Offboarding Checklist";
  table = offboardingChecklist;
  priority = 2;
  description = "Task checklist items for an employee offboarding process (return assets, revoke access, etc.) with completion tracking.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "checklistType", type: "enum" as const },
    { key: "title" },
    { key: "isCompleted", type: "boolean" as const },
    { key: "completedAt", type: "date" as const },
  ];

  searchFields = ["title"];
  defaultOrderBy = "sortOrder";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new OffboardingChecklistAdmin();
