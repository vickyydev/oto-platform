import { ModelAdmin, deriveFormFields } from "../admin";
import { employeeTimeOff, timeOffTypes } from "../../../shared/schema";

class EmployeeTimeOffAdmin extends ModelAdmin {
  name = "Employee Time Off";
  table = employeeTimeOff;
  priority = 6;
  description = "Leave records for employees (annual, sick, unpaid, etc.) with full-day or half-day support, used in scheduling and payroll.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "type", type: "enum" as const },
    { key: "startDate", label: "Start", type: "date" as const },
    { key: "endDate", label: "End", type: "date" as const },
    { key: "isHalfDay", label: "Half Day", type: "boolean" as const },
    { key: "halfDayPeriod", label: "Period" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
  ];

  searchFields = ["note"];

  filters = [
    {
      key: "type",
      label: "Type",
      type: "select" as const,
      options: timeOffTypes.map(t => ({ label: t, value: t })),
    },
    { key: "isHalfDay", label: "Half Day", type: "boolean" as const },
  ];

  defaultOrderBy = "startDate";

  get formFields() {
    return deriveFormFields(this.table).map(f => {
      if (f.key === "tenantId") return { ...f, label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" };
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      if (f.key === "createdBy") return { ...f, label: "Created By", relatedModel: "users", relatedLabelField: "fullName" };
      return f;
    });
  }
}

export default new EmployeeTimeOffAdmin();
