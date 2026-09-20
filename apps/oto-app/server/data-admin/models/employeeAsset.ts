import { ModelAdmin, deriveFormFields } from "../admin";
import { employeeAssets } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class EmployeeAssetAdmin extends ModelAdmin {
  name = "Employee Asset";
  table = employeeAssets;
  priority = 2;
  description = "Tracks assets issued to individual employees, including quantity, serial number, return requirements, and return status.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "assetNameSnapshot" },
    { key: "quantity", type: "number" as const },
    { key: "returnRequired", type: "boolean" as const },
    { key: "returnedAt", type: "date" as const },
  ];

  searchFields = ["assetNameSnapshot", "serialNumber"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new EmployeeAssetAdmin();
