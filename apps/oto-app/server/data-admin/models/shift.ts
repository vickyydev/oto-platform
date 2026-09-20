import { ModelAdmin, deriveFormFields } from "../admin";
import { shifts, shiftStatuses } from "../../../shared/schema";

class ShiftAdmin extends ModelAdmin {
  name = "Shift";
  table = shifts;
  priority = 11;
  description = "An individual shift slot at a branch and department with a start/end time, optionally assigned to an employee or left open for coverage.";

  listDisplay = [
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "departmentId", label: "Department", relatedModel: "departments", relatedLabelField: "name" },
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "status", type: "enum" as const },
    { key: "startAt", label: "Start", type: "date" as const },
    { key: "endAt", label: "End", type: "date" as const },
    { key: "needsCoverage", label: "Needs Coverage", type: "boolean" as const },
  ];

  searchFields = ["notes"];

  filters = [
    {
      key: "status",
      label: "Status",
      type: "select" as const,
      options: shiftStatuses.map(s => ({ label: s, value: s })),
    },
    { key: "needsCoverage", label: "Needs Coverage", type: "boolean" as const },
  ];

  defaultOrderBy = "startAt";

  get formFields() {
    return deriveFormFields(this.table).map(f => {
      if (f.key === "tenantId") return { ...f, label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      if (f.key === "departmentId") return { ...f, label: "Department", relatedModel: "departments", relatedLabelField: "name" };
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "createdBy") return { ...f, label: "Created By", relatedModel: "users", relatedLabelField: "fullName" };
      return f;
    });
  }
}

export default new ShiftAdmin();
