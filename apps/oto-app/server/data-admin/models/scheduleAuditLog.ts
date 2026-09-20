import { ModelAdmin, deriveFormFields } from "../admin";
import { scheduleAuditLog } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class ScheduleAuditLogAdmin extends ModelAdmin {
  name = "Schedule Audit Log";
  table = scheduleAuditLog;
  priority = 3;
  description = "Audit trail of bulk scheduling actions (template applied, week cleared, department overwritten) with before-state snapshots.";

  listDisplay = [
    { key: "action" },
    { key: "description" },
    { key: "performedBy", label: "Performed By" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["action", "description"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table);
  }
}

export default new ScheduleAuditLogAdmin();
