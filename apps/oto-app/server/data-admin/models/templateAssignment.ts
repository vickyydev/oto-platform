import { ModelAdmin, deriveFormFields } from "../admin";
import { templateAssignments } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class TemplateAssignmentAdmin extends ModelAdmin {
  name = "Template Assignment";
  table = templateAssignments;
  priority = 3;
  description = "Links document templates to specific branches, with an optional flag marking one as the branch default.";

  listDisplay = [
    { key: "templateId", label: "Template", relatedModel: "templates", relatedLabelField: "name" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "isDefaultForBranch", type: "boolean" as const },
    { key: "assignedAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "assignedAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "templateId") return { ...f, label: "Template", relatedModel: "templates", relatedLabelField: "name" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new TemplateAssignmentAdmin();
