import { ModelAdmin, deriveFormFields } from "../admin";
import { leavePolicies } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class LeavePolicyAdmin extends ModelAdmin {
  name = "Leave Policy";
  table = leavePolicies;
  priority = 3;
  description = "Configures how annual leave is accrued at a branch, defining how many days off are earned per days worked.";

  listDisplay = [
    { key: "name" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "daysWorkedRequired", type: "number" as const },
    { key: "daysOffEarned", type: "number" as const },
    { key: "isActive", type: "boolean" as const },
  ];

  searchFields = ["name"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new LeavePolicyAdmin();
