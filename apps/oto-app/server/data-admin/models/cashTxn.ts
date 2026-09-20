import { ModelAdmin, deriveFormFields } from "../admin";
import { cashTxns } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class CashTxnAdmin extends ModelAdmin {
  name = "Cash Transaction";
  table = cashTxns;
  priority = 2;
  description = "Individual bank transactions synced from Xero, stored with direction (in/out) and raw JSON for cash flow analysis.";

  listDisplay = [
    { key: "date", type: "date" as const },
    { key: "bankAccountName" },
    { key: "type" },
    { key: "total", type: "number" as const },
    { key: "direction" },
  ];

  searchFields = ["bankAccountName", "type"];
  defaultOrderBy = "date";

  // Composite PK (tenantId + xeroBankTransactionId) — list/search only
  async getById(_id: string): Promise<Record<string, unknown> | null> {
    return null;
  }
}

export default new CashTxnAdmin();
