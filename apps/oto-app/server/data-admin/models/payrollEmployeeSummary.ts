import { ModelAdmin, deriveFormFields } from "../admin";
import { payrollEmployeeSummaries } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class PayrollEmployeeSummaryAdmin extends ModelAdmin {
  name = "Payroll Employee Summary";
  table = payrollEmployeeSummaries;
  priority = 6;
  description = "Rolled-up payroll totals per employee per run: gross pay, deductions, net pay, and employer cost.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "status", type: "enum" as const },
    { key: "grossPay", type: "number" as const },
    { key: "netPay", type: "number" as const },
    { key: "createdAt", type: "date" as const },
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

export default new PayrollEmployeeSummaryAdmin();
