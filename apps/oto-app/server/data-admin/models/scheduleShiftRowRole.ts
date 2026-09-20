import { ModelAdmin, deriveFormFields } from "../admin";
import { scheduleShiftRowRoles } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class ScheduleShiftRowRoleAdmin extends ModelAdmin {
  name = "Schedule Shift Row Role";
  table = scheduleShiftRowRoles;
  priority = 4;
  description = "Junction table specifying which job roles are required or eligible for a given schedule shift row.";

  listDisplay = [
    { key: "shiftRowId", label: "Shift Row" },
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

export default new ScheduleShiftRowRoleAdmin();
