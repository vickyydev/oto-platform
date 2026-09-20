import { ModelAdmin, deriveFormFields } from "../admin";
import { sickLeavePolicies } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class SickLeavePolicyAdmin extends ModelAdmin {
  name = "Sick Leave Policy";
  table = sickLeavePolicies;
  priority = 2;
  description = "Configures the annual sick leave entitlement per branch, with optional pro-rating by employee start date.";

  listDisplay = [
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "annualSickLeaveDays", type: "number" as const },
    { key: "proRateByStartDate", type: "boolean" as const },
    { key: "isActive", type: "boolean" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new SickLeavePolicyAdmin();
