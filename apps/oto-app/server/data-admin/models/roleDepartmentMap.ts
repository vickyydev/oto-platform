import { ModelAdmin, deriveFormFields } from "../admin";
import { roleDepartmentMap } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class RoleDepartmentMapAdmin extends ModelAdmin {
  name = "Role Department Map";
  table = roleDepartmentMap;
  priority = 2;
  description = "Junction table associating job roles with the departments they belong to.";

  listDisplay = [
    { key: "roleId", label: "Role", relatedModel: "roles", relatedLabelField: "name" },
    { key: "departmentId", label: "Department", relatedModel: "departments", relatedLabelField: "name" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "roleId") return { ...f, label: "Role", relatedModel: "roles", relatedLabelField: "name" };
      if (f.key === "departmentId") return { ...f, label: "Department", relatedModel: "departments", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new RoleDepartmentMapAdmin();
