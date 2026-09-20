import { ModelAdmin, deriveFormFields } from "../admin";
import { xeroReportsRaw } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class XeroReportRawAdmin extends ModelAdmin {
  name = "Xero Report Raw";
  table = xeroReportsRaw;
  priority = 2;
  description = "Raw P&L and other financial reports pulled from Xero and stored as JSON for local processing and analytics.";

  listDisplay = [
    { key: "reportType" },
    { key: "fromDate", type: "date" as const },
    { key: "toDate", type: "date" as const },
    { key: "tenantId" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["reportType"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table);
  }
}

export default new XeroReportRawAdmin();
