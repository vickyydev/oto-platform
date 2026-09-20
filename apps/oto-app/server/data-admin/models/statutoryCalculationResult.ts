import { ModelAdmin, deriveFormFields } from "../admin";
import { statutoryCalculationResults } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class StatutoryCalculationResultAdmin extends ModelAdmin {
  name = "Statutory Calculation Result";
  table = statutoryCalculationResults;
  priority = 3;
  description = "Computed statutory contribution results (SSO, tax) per employee per payroll run, stored as a JSON breakdown for auditing.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "countryCode" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["countryCode"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      return f;
    });
  }
}

export default new StatutoryCalculationResultAdmin();
