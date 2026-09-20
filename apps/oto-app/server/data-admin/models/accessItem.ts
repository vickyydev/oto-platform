import { ModelAdmin, deriveFormFields } from "../admin";
import { accessItems } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class AccessItemAdmin extends ModelAdmin {
  name = "Access Item";
  table = accessItems;
  priority = 4;
  description = "Encrypted credential vault entries (passwords, PINs, accounts) with branch-level visibility and access controls.";

  listDisplay = [
    { key: "title" },
    { key: "category", type: "enum" as const },
    { key: "visibilityLevel", type: "enum" as const },
    { key: "status", type: "enum" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["title", "username"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table);
  }
}

export default new AccessItemAdmin();
