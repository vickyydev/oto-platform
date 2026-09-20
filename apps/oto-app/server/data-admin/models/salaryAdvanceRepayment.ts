import { ModelAdmin, deriveFormFields } from "../admin";
import { salaryAdvanceRepayments } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class SalaryAdvanceRepaymentAdmin extends ModelAdmin {
  name = "Salary Advance Repayment";
  table = salaryAdvanceRepayments;
  priority = 3;
  description = "Individual repayment instalments deducted from payroll runs against a salary advance, tracking the balance after each deduction.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "amount", type: "number" as const },
    { key: "remainingBalanceAfter", type: "number" as const },
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

export default new SalaryAdvanceRepaymentAdmin();
