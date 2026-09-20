import { ModelAdmin, deriveFormFields } from "../admin";
import { employeeOffboarding } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class EmployeeOffboardingAdmin extends ModelAdmin {
  name = "Employee Offboarding";
  table = employeeOffboarding;
  priority = 2;
  description = "Records the offboarding details for a resigning or terminated employee, including reason, last working day, and outstanding leave balances.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "offboardingType", type: "enum" as const },
    { key: "reasonCode", type: "enum" as const },
    { key: "lastWorkingDay", type: "date" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new EmployeeOffboardingAdmin();
