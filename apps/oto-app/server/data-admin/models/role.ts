import { ModelAdmin, deriveFormFields } from "../admin";
import { roles } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class RoleAdmin extends ModelAdmin {
  name = "Role";
  description = "A job role or position title (e.g. Receptionist, Nanny) used for scheduling, staffing requirements, and employee assignments.";
  priority = 47;
  table = roles;

  listDisplay = [
    { key: "name" },
    { key: "description" },
    { key: "isActive", type: "boolean" as const },
  ];

  searchFields = ["name", "description"];

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "tenantId") return { ...f, label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" };
      return f;
    });
  }

  defaultOrderBy = "name";
}

export default new RoleAdmin();
