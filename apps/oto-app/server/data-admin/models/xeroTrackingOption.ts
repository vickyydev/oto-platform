import { ModelAdmin, deriveFormFields } from "../admin";
import { xeroTrackingOptions } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class XeroTrackingOptionAdmin extends ModelAdmin {
  name = "Xero Tracking Option";
  table = xeroTrackingOptions;
  priority = 2;
  description = "Cached Xero tracking options (individual values within a tracking category, e.g. specific branch names) synced from Xero.";

  listDisplay = [
    { key: "name" },
    { key: "trackingOptionId" },
    { key: "trackingCategoryId" },
    { key: "status" },
  ];

  searchFields = ["name"];
  defaultOrderBy = "name";

  // Composite PK — list only
  async getById(_id: string): Promise<Record<string, unknown> | null> {
    return null;
  }
}

export default new XeroTrackingOptionAdmin();
