import { ModelAdmin, deriveFormFields } from "../admin";
import { accessPolicies } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class AccessPolicyAdmin extends ModelAdmin {
  name = "Access Policy";
  table = accessPolicies;
  priority = 5;
  description = "Defines a person's access level, permitted modules, and branch scope, including Core system account provisioning status.";

  listDisplay = [
    { key: "personId", label: "Person", relatedModel: "people", relatedLabelField: "fullName" },
    { key: "accessLevel", type: "enum" as const },
    { key: "branchScope", type: "enum" as const },
    { key: "provisioningStatus", type: "enum" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "personId") return { ...f, label: "Person", relatedModel: "people", relatedLabelField: "fullName" };
      return f;
    });
  }
}

export default new AccessPolicyAdmin();
