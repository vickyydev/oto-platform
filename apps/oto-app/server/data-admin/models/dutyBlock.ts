import { ModelAdmin, deriveFormFields } from "../admin";
import { dutyBlocks } from "../../../shared/schema";

class DutyBlockAdmin extends ModelAdmin {
  name = "Duty Block";
  table = dutyBlocks;
  priority = 7;
  description = "A named duty or task block assigned to an employee within a shift, specifying a sub-period time range and duty type.";

  listDisplay = [
    { key: "date", type: "date" as const },
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "dutyName", label: "Duty" },
    { key: "startTime", label: "Start" },
    { key: "endTime", label: "End" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
  ];

  searchFields = ["dutyName", "notes"];

  defaultOrderBy = "date";

  get formFields() {
    return deriveFormFields(this.table).map(f => {
      if (f.key === "tenantId") return { ...f, label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "assignmentId") return { ...f, label: "Assignment", relatedModel: "scheduleassignments", relatedLabelField: "id" };
      if (f.key === "dutyTypeId") return { ...f, label: "Duty Type", relatedModel: "dutytypes", relatedLabelField: "name" };
      if (f.key === "createdBy") return { ...f, label: "Created By", relatedModel: "users", relatedLabelField: "fullName" };
      return f;
    });
  }
}

export default new DutyBlockAdmin();
