import { ModelAdmin, deriveFormFields } from "../admin";
import { cashDaily } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class CashDailyAdmin extends ModelAdmin {
  name = "Cash Daily";
  table = cashDaily;
  priority = 2;
  description = "Daily cash flow summary aggregated from bank transactions, showing total in, out, and net per day per tenant.";

  listDisplay = [
    { key: "date", type: "date" as const },
    { key: "cashIn", type: "number" as const },
    { key: "cashOut", type: "number" as const },
    { key: "net", type: "number" as const },
    { key: "tenantId" },
  ];

  searchFields = [];
  defaultOrderBy = "date";

  // Composite PK (tenantId + date) — list/search only
  async getById(_id: string): Promise<Record<string, unknown> | null> {
    return null;
  }
}

export default new CashDailyAdmin();
