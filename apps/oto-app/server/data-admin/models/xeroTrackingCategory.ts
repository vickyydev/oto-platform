import { ModelAdmin, deriveFormFields } from "../admin";
import { xeroTrackingCategories } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class XeroTrackingCategoryAdmin extends ModelAdmin {
  name = "Xero Tracking Category";
  table = xeroTrackingCategories;
  priority = 2;
  description = "Cached Xero tracking categories (cost centres, departments) synced from Xero for mapping payroll data.";

  listDisplay = [
    { key: "name" },
    { key: "trackingCategoryId" },
    { key: "status" },
    { key: "tenantId" },
  ];

  searchFields = ["name"];
  defaultOrderBy = "name";

  // Composite PK — list only, no getById/update/delete
  async getById(_id: string): Promise<Record<string, unknown> | null> {
    return null;
  }
}

export default new XeroTrackingCategoryAdmin();
