import { ModelAdmin, deriveFormFields } from "../admin";
import { shiftGroups } from "../../../shared/schema";

class ShiftGroupAdmin extends ModelAdmin {
  name = "Shift Group";
  table = shiftGroups;
  priority = 6;
  description = "A named grouping of shift rows within a branch schedule (e.g. Team A, Team B) for visual organisation in the scheduling UI.";

  listDisplay = [
    { key: "name" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "sortOrder", label: "Order", type: "number" as const },
    { key: "isActive", label: "Active", type: "boolean" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["name"];

  filters = [
    { key: "isActive", label: "Active", type: "boolean" as const },
  ];

  defaultOrderBy = "name";

  get formFields() {
    return deriveFormFields(this.table).map(f => {
      if (f.key === "tenantId") return { ...f, label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      if (f.key === "createdBy") return { ...f, label: "Created By", relatedModel: "users", relatedLabelField: "fullName" };
      return f;
    });
  }
}

export default new ShiftGroupAdmin();
