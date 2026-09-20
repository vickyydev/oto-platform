import { ModelAdmin, deriveFormFields } from "../admin";
import { assetCatalog } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class AssetCatalogAdmin extends ModelAdmin {
  name = "Asset Catalog";
  table = assetCatalog;
  priority = 2;
  description = "Master catalogue of asset types (uniform, equipment, tools) that can be issued to employees.";

  listDisplay = [
    { key: "name" },
    { key: "category", type: "enum" as const },
    { key: "isActive", type: "boolean" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["name"];
  defaultOrderBy = "name";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table);
  }
}

export default new AssetCatalogAdmin();
