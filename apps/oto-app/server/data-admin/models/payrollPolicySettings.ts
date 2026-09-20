import { ModelAdmin, deriveFormFields } from "../admin";
import { payrollPolicySettings } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class PayrollPolicySettingsAdmin extends ModelAdmin {
  name = "Payroll Policy Settings";
  table = payrollPolicySettings;
  priority = 2;
  description = "Per-operator payroll policy configuration: variance thresholds, overtime approval requirements, rounding rules, and break deduction defaults.";

  listDisplay = [
    { key: "operatorId", label: "Operator", relatedModel: "operators", relatedLabelField: "name" },
    { key: "roundingRule", type: "enum" as const },
    { key: "otRequiresApproval", type: "boolean" as const },
    { key: "varianceMinutesThreshold", type: "number" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "operatorId") return { ...f, label: "Operator", relatedModel: "operators", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new PayrollPolicySettingsAdmin();
