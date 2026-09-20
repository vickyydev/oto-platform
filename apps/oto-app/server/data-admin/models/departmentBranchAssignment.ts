import { ModelAdmin, deriveFormFields } from "../admin";
import { departmentBranchAssignments } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class DepartmentBranchAssignmentAdmin extends ModelAdmin {
  name = "Department Branch Assignment";
  table = departmentBranchAssignments;
  priority = 4;
  description = "Many-to-many junction linking departments to the branches they operate within.";

  listDisplay = [
    { key: "departmentId", label: "Department", relatedModel: "departments", relatedLabelField: "name" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "assignedAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "assignedAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "departmentId") return { ...f, label: "Department", relatedModel: "departments", relatedLabelField: "name" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new DepartmentBranchAssignmentAdmin();
