import { ModelAdmin, deriveFormFields } from "../admin";
import { accessViewLogs } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class AccessViewLogAdmin extends ModelAdmin {
  name = "Access View Log";
  table = accessViewLogs;
  priority = 2;
  description = "Audit log recording every time a user views a decrypted credential in the access vault.";

  listDisplay = [
    { key: "viewedBy", label: "Viewed By", relatedModel: "users", relatedLabelField: "email" },
    { key: "accessItemId", label: "Access Item" },
    { key: "viewedAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "viewedAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "viewedBy") return { ...f, label: "Viewed By", relatedModel: "users", relatedLabelField: "email" };
      return f;
    });
  }
}

export default new AccessViewLogAdmin();
