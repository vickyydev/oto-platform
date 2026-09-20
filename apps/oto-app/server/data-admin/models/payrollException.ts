import { ModelAdmin, deriveFormFields } from "../admin";
import { payrollExceptions } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class PayrollExceptionAdmin extends ModelAdmin {
  name = "Payroll Exception";
  table = payrollExceptions;
  priority = 3;
  description = "Payroll anomalies and warnings raised during a run (missing clock-out, negative pay, etc.) requiring review or approval before finalisation.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "exceptionType", type: "enum" as const },
    { key: "severity", type: "enum" as const },
    { key: "status", type: "enum" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["message"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new PayrollExceptionAdmin();
