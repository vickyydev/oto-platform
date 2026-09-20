import { ModelAdmin, deriveFormFields } from "../admin";
import { employeeLetters } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class EmployeeLetterAdmin extends ModelAdmin {
  name = "Employee Letter";
  table = employeeLetters;
  priority = 2;
  description = "HR letters issued to employees (warning letters, confirmation of employment, etc.) with e-signature support and PDF generation.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "letterType", type: "enum" as const },
    { key: "status", type: "enum" as const },
    { key: "signedAt", type: "date" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      if (f.key === "templateId") return { ...f, label: "Template", relatedModel: "templates", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new EmployeeLetterAdmin();
