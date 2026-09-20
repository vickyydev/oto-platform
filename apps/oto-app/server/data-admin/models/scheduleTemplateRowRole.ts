import { ModelAdmin, deriveFormFields } from "../admin";
import { scheduleTemplateRowRoles } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class ScheduleTemplateRowRoleAdmin extends ModelAdmin {
  name = "Schedule Template Row Role";
  table = scheduleTemplateRowRoles;
  priority = 3;
  description = "Junction table linking required job roles to a schedule template row.";

  listDisplay = [
    { key: "templateRowId", label: "Template Row" },
    { key: "roleId", label: "Role", relatedModel: "roles", relatedLabelField: "name" },
  ];

  searchFields = [];
  defaultOrderBy = "id";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "roleId") return { ...f, label: "Role", relatedModel: "roles", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new ScheduleTemplateRowRoleAdmin();
