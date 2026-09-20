import { ModelAdmin, deriveFormFields, type FormFieldDef } from "../admin";
import {
  employees,
  employeeStatuses,
  employmentStates,
  employmentBasisTypes,
  offboardingTypes,
  faceEnrollmentStatuses,
} from "../../../shared/schema";

class EmployeeAdmin extends ModelAdmin {
  name = "Employee";
  description = "A staff member employed at a branch, tracking employment status, payroll basis, visa details, face enrollment, and timeclock data.";
  priority = 80;
  table = employees;

  listDisplay = [
    { key: "fullName", label: "Name" },
    { key: "nickname" },
    { key: "email" },
    { key: "status", type: "enum" as const },
    { key: "employmentState", label: "State", type: "enum" as const },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "primaryDepartmentId", label: "Department", relatedModel: "departments", relatedLabelField: "name" },
    { key: "startDate", type: "date" as const },
  ];

  searchFields = ["fullName", "email", "nickname"];

  filters = [
    {
      key: "status",
      label: "Status",
      type: "select" as const,
      options: employeeStatuses.map((s) => ({ label: s, value: s })),
    },
    {
      key: "employmentState",
      label: "State",
      type: "select" as const,
      options: employmentStates.map((s) => ({ label: s, value: s })),
    },
    {
      key: "employmentBasis",
      label: "Basis",
      type: "select" as const,
      options: employmentBasisTypes.map((s) => ({ label: s, value: s })),
    },
  ];

  defaultOrderBy = "fullName";

  // Auto-derive all fields, then patch in FK relations and a few hints.
  // The base class deriveFormFields handles types; we only need to annotate
  // the FK fields that point to registered models.
  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      switch (f.key) {
        case "tenantId":
          return { ...f, label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" };
        case "personId":
          return { ...f, label: "Person", relatedModel: "persons", relatedLabelField: "fullName" };
        case "branchId":
          return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
        case "primaryDepartmentId":
          return { ...f, label: "Department", relatedModel: "departments", relatedLabelField: "name" };
        case "userId":
          return { ...f, label: "Linked User", relatedModel: "users", relatedLabelField: "fullName" };
        case "updatedBy":
          return { ...f, label: "Updated By", relatedModel: "users", relatedLabelField: "fullName" };
        case "profilePhotoUpdatedBy":
          return { ...f, label: "Photo Updated By", relatedModel: "users", relatedLabelField: "fullName" };
        default:
          return f;
      }
    });
  }
}

export default new EmployeeAdmin();
