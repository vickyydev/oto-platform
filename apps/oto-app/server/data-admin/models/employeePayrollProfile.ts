import { ModelAdmin, deriveFormFields } from "../admin";
import { employeePayrollProfiles } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class EmployeePayrollProfileAdmin extends ModelAdmin {
  name = "Employee Payroll Profile";
  table = employeePayrollProfiles;
  priority = 2;
  description = "Payroll configuration per employee: salary, bank account, tax ID, SSO number, and statutory deduction settings.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "employmentType", type: "enum" as const },
    { key: "baseSalaryMonthly", type: "number" as const },
    { key: "socialSecurityEnabled", type: "boolean" as const },
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

export default new EmployeePayrollProfileAdmin();
