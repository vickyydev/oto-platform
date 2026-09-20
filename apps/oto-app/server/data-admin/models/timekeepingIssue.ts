import { ModelAdmin, deriveFormFields } from "../admin";
import { timekeepingIssues } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class TimekeepingIssueAdmin extends ModelAdmin {
  name = "Timekeeping Issue";
  table = timekeepingIssues;
  priority = 3;
  description = "Flagged timekeeping anomalies (missed clock-out, late arrival, PIN usage) requiring manager review and resolution.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "issueType", type: "enum" as const },
    { key: "status", type: "enum" as const },
    { key: "issueDate" },
  ];

  searchFields = ["issueDate"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new TimekeepingIssueAdmin();
