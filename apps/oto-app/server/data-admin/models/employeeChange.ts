import { ModelAdmin, deriveFormFields } from "../admin";
import { employeeChanges } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class EmployeeChangeAdmin extends ModelAdmin {
  name = "Employee Change";
  table = employeeChanges;
  priority = 2;
  description = "Audit history of employee record changes (salary, branch, department, title) storing before and after values with effective dates.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "changeType", type: "enum" as const },
    { key: "effectiveDate", type: "date" as const },
    { key: "newTitle" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["newTitle", "oldTitle"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "oldBranchId") return { ...f, label: "Old Branch", relatedModel: "branches", relatedLabelField: "name" };
      if (f.key === "newBranchId") return { ...f, label: "New Branch", relatedModel: "branches", relatedLabelField: "name" };
      if (f.key === "oldDepartmentId") return { ...f, label: "Old Department", relatedModel: "departments", relatedLabelField: "name" };
      if (f.key === "newDepartmentId") return { ...f, label: "New Department", relatedModel: "departments", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new EmployeeChangeAdmin();
