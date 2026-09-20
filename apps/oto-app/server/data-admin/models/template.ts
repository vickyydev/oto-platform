import { ModelAdmin, deriveFormFields } from "../admin";
import { templates, templateStatuses, templateTypes } from "../../../shared/schema";

class TemplateAdmin extends ModelAdmin {
  name = "Template";
  table = templates;
  priority = 45;
  description = "HTML document templates (employment contracts, letters, etc.) with merge field support, versioning, and bilingual body content.";

  listDisplay = [
    { key: "name" },
    { key: "templateType", label: "Type", type: "enum" as const },
    { key: "status", type: "enum" as const },
    { key: "version", type: "number" as const },
    { key: "createdBy", label: "Created By", relatedModel: "users", relatedLabelField: "fullName" },
    { key: "updatedAt", type: "date" as const },
  ];

  searchFields = ["name"];

  filters = [
    {
      key: "templateType",
      label: "Type",
      type: "select" as const,
      options: templateTypes.map(t => ({ label: t, value: t })),
    },
    {
      key: "status",
      label: "Status",
      type: "select" as const,
      options: templateStatuses.map(s => ({ label: s, value: s })),
    },
  ];

  defaultOrderBy = "name";

  get formFields() {
    return deriveFormFields(this.table).map(f => {
      if (f.key === "createdBy") return { ...f, label: "Created By", relatedModel: "users", relatedLabelField: "fullName" };
      if (f.key === "updatedBy") return { ...f, label: "Updated By", relatedModel: "users", relatedLabelField: "fullName" };
      if (f.key === "forkedFromTemplateId") return { ...f, label: "Forked From", relatedModel: "templates", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new TemplateAdmin();
