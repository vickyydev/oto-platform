import { ModelAdmin, deriveFormFields } from "../admin";
import { shiftRequiredRoles } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class ShiftRequiredRoleAdmin extends ModelAdmin {
  name = "Shift Required Role";
  table = shiftRequiredRoles;
  priority = 3;
  description = "Specifies which job roles are required to fill an open shift slot.";

  listDisplay = [
    { key: "shiftId", label: "Shift" },
    { key: "roleId", label: "Role", relatedModel: "roles", relatedLabelField: "name" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "roleId") return { ...f, label: "Role", relatedModel: "roles", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new ShiftRequiredRoleAdmin();
