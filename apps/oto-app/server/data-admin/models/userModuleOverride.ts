import { ModelAdmin, deriveFormFields } from "../admin";
import { userModuleOverrides } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class UserModuleOverrideAdmin extends ModelAdmin {
  name = "User Module Override";
  table = userModuleOverrides;
  priority = 2;
  description = "Per-user overrides for module access (core, hr, studio, etc.) that supersede the branch-level defaults.";

  listDisplay = [
    { key: "userId", label: "User", relatedModel: "users", relatedLabelField: "email" },
    { key: "moduleKey", type: "enum" as const },
    { key: "enabled", type: "boolean" as const },
    { key: "branchScopeType", type: "enum" as const },
    { key: "updatedAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "userId") return { ...f, label: "User", relatedModel: "users", relatedLabelField: "email" };
      return f;
    });
  }
}

export default new UserModuleOverrideAdmin();
