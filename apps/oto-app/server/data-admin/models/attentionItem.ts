import { ModelAdmin, deriveFormFields } from "../admin";
import { attentionItems } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class AttentionItemAdmin extends ModelAdmin {
  name = "Attention Item";
  table = attentionItems;
  priority = 3;
  description = "Automatically detected issues requiring manager action (expiring visas, unsigned contracts, missing documents), with severity and resolution tracking.";

  listDisplay = [
    { key: "type", type: "enum" as const },
    { key: "severity", type: "enum" as const },
    { key: "status", type: "enum" as const },
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["title"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new AttentionItemAdmin();
