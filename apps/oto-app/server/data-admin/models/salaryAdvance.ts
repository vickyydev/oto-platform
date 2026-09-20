import { ModelAdmin, deriveFormFields } from "../admin";
import { salaryAdvances } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class SalaryAdvanceAdmin extends ModelAdmin {
  name = "Salary Advance";
  table = salaryAdvances;
  priority = 3;
  description = "Salary advance loans issued to employees, with repayment schedule configuration and outstanding balance tracking.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "principalAmount", type: "number" as const },
    { key: "remainingBalance", type: "number" as const },
    { key: "status", type: "enum" as const },
    { key: "issuedDate", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      return f;
    });
  }
}

export default new SalaryAdvanceAdmin();
