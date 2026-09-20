import { ModelAdmin, deriveFormFields } from "../admin";
import { coverageRules } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class CoverageRuleAdmin extends ModelAdmin {
  name = "Coverage Rule";
  table = coverageRules;
  priority = 2;
  description = "Minimum staffing rules for a branch and department by day type (weekday, weekend, public holiday), used to validate scheduling.";

  listDisplay = [
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "departmentId", label: "Department", relatedModel: "departments", relatedLabelField: "name" },
    { key: "dayType", type: "enum" as const },
    { key: "minStaff", type: "number" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      if (f.key === "departmentId") return { ...f, label: "Department", relatedModel: "departments", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new CoverageRuleAdmin();
