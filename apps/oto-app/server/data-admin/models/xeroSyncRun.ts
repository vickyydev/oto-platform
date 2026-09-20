import { ModelAdmin, deriveFormFields } from "../admin";
import { xeroSyncRuns } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class XeroSyncRunAdmin extends ModelAdmin {
  name = "Xero Sync Run";
  table = xeroSyncRuns;
  priority = 2;
  description = "Log of each Xero data synchronisation run, recording type, date range, and success or error status.";

  listDisplay = [
    { key: "syncType" },
    { key: "status" },
    { key: "fromDate", type: "date" as const },
    { key: "toDate", type: "date" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["syncType", "status"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table);
  }
}

export default new XeroSyncRunAdmin();
