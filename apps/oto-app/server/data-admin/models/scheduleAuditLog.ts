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

  /**
   * SCRUM-673 — who really acted in a view-as window is written by the app
   * from the window's verified mark (storage.logScheduleAudit), and the write
   * path refuses any change to it (409). Shown read-only on edit and left off
   * the create form, so the form offers no input it would refuse; on edit the
   * form sends the unchanged values back, which the write path accepts.
   */
  get formFields(): FormFieldDef[] {
    const appWritten = new Set(["actorType", "actorAccountId", "onBehalfOf", "impersonationId"]);
    return deriveFormFields(this.table).map((f) =>
      appWritten.has(f.key) ? { ...f, readOnly: true, required: false } : f);
  }
}

export default new ScheduleAuditLogAdmin();
