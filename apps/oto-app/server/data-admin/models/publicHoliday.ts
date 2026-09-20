import { ModelAdmin, deriveFormFields } from "../admin";
import { publicHolidays } from "../../../shared/schema";

class PublicHolidayAdmin extends ModelAdmin {
  name = "Public Holiday";
  table = publicHolidays;
  priority = 8;
  description = "Tenant-specific public holiday calendar used in payroll calculations and scheduling to identify non-working days.";

  listDisplay = [
    { key: "name" },
    { key: "date", type: "date" as const },
    { key: "year", type: "number" as const },
    { key: "isActive", label: "Active", type: "boolean" as const },
    { key: "tenantId", label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" },
  ];

  searchFields = ["name"];

  filters = [
    { key: "isActive", label: "Active", type: "boolean" as const },
  ];

  defaultOrderBy = "date";

  get formFields() {
    return deriveFormFields(this.table).map(f => {
      if (f.key === "tenantId") return { ...f, label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new PublicHolidayAdmin();
