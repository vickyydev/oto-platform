import { ModelAdmin, deriveFormFields } from "../admin";
import { casualWorkers, casualWorkerStatuses } from "../../../shared/schema";

class CasualWorkerAdmin extends ModelAdmin {
  name = "Casual Worker";
  table = casualWorkers;
  priority = 6;
  description = "A temporary or contract worker with a fixed engagement period and daily rate, schedulable alongside regular employees.";

  listDisplay = [
    { key: "fullName", label: "Name" },
    { key: "nickname" },
    { key: "jobTitle", label: "Job Title" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "roleId", label: "Role", relatedModel: "roles", relatedLabelField: "name" },
    { key: "status", type: "enum" as const },
    { key: "startDate", label: "Start", type: "date" as const },
    { key: "endDate", label: "End", type: "date" as const },
    { key: "dailyRate", label: "Daily Rate", type: "number" as const },
  ];

  searchFields = ["fullName", "nickname", "jobTitle"];

  filters = [
    {
      key: "status",
      label: "Status",
      type: "select" as const,
      options: casualWorkerStatuses.map(s => ({ label: s, value: s })),
    },
  ];

  defaultOrderBy = "fullName";

  get formFields() {
    return deriveFormFields(this.table).map(f => {
      if (f.key === "tenantId") return { ...f, label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      if (f.key === "departmentId") return { ...f, label: "Department", relatedModel: "departments", relatedLabelField: "name" };
      if (f.key === "roleId") return { ...f, label: "Role", relatedModel: "roles", relatedLabelField: "name" };
      if (f.key === "createdBy") return { ...f, label: "Created By", relatedModel: "users", relatedLabelField: "fullName" };
      return f;
    });
  }
}

export default new CasualWorkerAdmin();
