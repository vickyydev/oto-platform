import { ModelAdmin, deriveFormFields, type FormFieldDef } from "../admin";
import { people, personTypes } from "../../../shared/schema";

class PersonAdmin extends ModelAdmin {
  name = "Person";
  description = "Identity anchor for both employees and advisors, holding contact info, timeclock PIN, phone verification, and access policy link.";
  priority = 24;
  table = people;

  listDisplay = [
    { key: "fullName", label: "Name" },
    { key: "email" },
    { key: "personType", label: "Type", type: "enum" as const },
    { key: "isActive", label: "Active", type: "boolean" as const },
    { key: "phoneNumber", label: "Phone" },
    { key: "departmentId", label: "Department", relatedModel: "departments", relatedLabelField: "name" },
  ];

  searchFields = ["fullName", "email", "phoneNumber"];

  filters = [
    {
      key: "personType",
      label: "Type",
      type: "select" as const,
      options: personTypes.map((t) => ({ label: t, value: t })),
    },
    { key: "isActive", label: "Active", type: "boolean" as const },
  ];

  defaultOrderBy = "fullName";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table)
      .map((f) => {
        if (f.key === "departmentId") {
          return { ...f, label: "Department", relatedModel: "departments", relatedLabelField: "name" };
        }
        return f;
      });
  }
}

export default new PersonAdmin();
