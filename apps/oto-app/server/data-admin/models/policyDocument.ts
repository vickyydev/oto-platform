import { ModelAdmin, deriveFormFields } from "../admin";
import { policyDocuments } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class PolicyDocumentAdmin extends ModelAdmin {
  name = "Policy Document";
  table = policyDocuments;
  priority = 2;
  description = "Company or branch-specific policy documents (HR policies, SOPs) in HTML or PDF, versioned and publishable to employees.";

  listDisplay = [
    { key: "title" },
    { key: "status", type: "enum" as const },
    { key: "isCompanyWide", type: "boolean" as const },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "publishedAt", type: "date" as const },
  ];

  searchFields = ["title"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new PolicyDocumentAdmin();
