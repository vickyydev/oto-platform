import { ModelAdmin, deriveFormFields } from "../admin";
import { userBranchAccess, branchAccessScopes } from "../../../shared/schema";

class UserBranchAccessAdmin extends ModelAdmin {
  name = "User Branch Access";
  table = userBranchAccess;
  priority = 8;
  description = "Controls which branches a user can access, supporting either all-branches scope or a specific selected branch.";

  listDisplay = [
    { key: "userId", label: "User", relatedModel: "users", relatedLabelField: "fullName" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "accessScope", label: "Scope", type: "enum" as const },
    { key: "tenantId", label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" },
    { key: "createdAt", type: "date" as const },
  ];

  filters = [
    {
      key: "accessScope",
      label: "Scope",
      type: "select" as const,
      options: branchAccessScopes.map(s => ({ label: s, value: s })),
    },
  ];

  defaultOrderBy = "createdAt";

  get formFields() {
    return deriveFormFields(this.table).map(f => {
      if (f.key === "tenantId") return { ...f, label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" };
      if (f.key === "userId") return { ...f, label: "User", relatedModel: "users", relatedLabelField: "fullName" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new UserBranchAccessAdmin();
