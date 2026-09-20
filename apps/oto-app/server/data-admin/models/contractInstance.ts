import { ModelAdmin, deriveFormFields } from "../admin";
import { contractInstances } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class ContractInstanceAdmin extends ModelAdmin {
  name = "Contract Instance";
  table = contractInstances;
  priority = 3;
  description = "A generated employment contract for an employee, holding the rendered HTML snapshot, merge data, signing status, and PDF path.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "templateId", label: "Template", relatedModel: "templates", relatedLabelField: "name" },
    { key: "status", type: "enum" as const },
    { key: "signingStatus", type: "enum" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["sentToEmail"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "templateId") return { ...f, label: "Template", relatedModel: "templates", relatedLabelField: "name" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new ContractInstanceAdmin();
