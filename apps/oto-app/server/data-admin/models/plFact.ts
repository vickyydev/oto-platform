import { ModelAdmin, deriveFormFields } from "../admin";
import { plFacts } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class PlFactAdmin extends ModelAdmin {
  name = "PL Fact";
  table = plFacts;
  priority = 2;
  description = "Normalised P&L line-item facts derived from raw Xero reports, broken down by section, line name, and location for analytics.";

  listDisplay = [
    { key: "section" },
    { key: "lineName" },
    { key: "locationName" },
    { key: "value", type: "number" as const },
    { key: "fromDate", type: "date" as const },
  ];

  searchFields = ["section", "lineName", "locationName"];
  defaultOrderBy = "fromDate";

  // No id column — list/search only
  async getById(_id: string): Promise<Record<string, unknown> | null> {
    return null;
  }
}

export default new PlFactAdmin();
