import { ModelAdmin, deriveFormFields } from "../admin";
import { staffCostAllocations } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class StaffCostAllocationAdmin extends ModelAdmin {
  name = "Staff Cost Allocation";
  table = staffCostAllocations;
  priority = 3;
  description = "Splits an employee's salary cost across branches by percentage for multi-branch cost allocation reporting.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "allocationPercent", type: "number" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new StaffCostAllocationAdmin();
