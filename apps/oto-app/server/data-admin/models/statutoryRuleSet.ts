import { ModelAdmin, deriveFormFields } from "../admin";
import { statutoryRuleSets } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class StatutoryRuleSetAdmin extends ModelAdmin {
  name = "Statutory Rule Set";
  table = statutoryRuleSets;
  priority = 3;
  description = "Country-specific statutory payroll rules (SSO, income tax brackets, etc.) stored as versioned JSON configurations with effective date ranges.";

  listDisplay = [
    { key: "name" },
    { key: "countryCode" },
    { key: "status", type: "enum" as const },
    { key: "effectiveFrom", type: "date" as const },
    { key: "effectiveTo", type: "date" as const },
  ];

  searchFields = ["name", "countryCode"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new StatutoryRuleSetAdmin();
