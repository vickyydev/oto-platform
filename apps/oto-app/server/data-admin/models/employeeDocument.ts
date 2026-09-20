import { ModelAdmin, deriveFormFields } from "../admin";
import { employeeDocuments } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class EmployeeDocumentAdmin extends ModelAdmin {
  name = "Employee Document";
  table = employeeDocuments;
  priority = 2;
  description = "Uploaded files attached to an employee record (ID card, passport, resignation form, etc.) with type classification.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "documentType", type: "enum" as const },
    { key: "fileName" },
    { key: "uploadedAt", type: "date" as const },
  ];

  searchFields = ["fileName"];
  defaultOrderBy = "uploadedAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new EmployeeDocumentAdmin();
