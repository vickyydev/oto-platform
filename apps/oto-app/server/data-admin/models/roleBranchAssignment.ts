import { ModelAdmin, deriveFormFields } from "../admin";
import { roleBranchAssignments } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class RoleBranchAssignmentAdmin extends ModelAdmin {
  name = "Role Branch Assignment";
  table = roleBranchAssignments;
  priority = 2;
  description = "Junction table making a job role available at specific branches, controlling which roles appear in scheduling at each location.";

  listDisplay = [
    { key: "roleId", label: "Role", relatedModel: "roles", relatedLabelField: "name" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "assignedAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "assignedAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "roleId") return { ...f, label: "Role", relatedModel: "roles", relatedLabelField: "name" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new RoleBranchAssignmentAdmin();
