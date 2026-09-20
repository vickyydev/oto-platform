import { ModelAdmin, deriveFormFields } from "../admin";
import { payrollPeriods } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class PayrollPeriodAdmin extends ModelAdmin {
  name = "Payroll Period";
  table = payrollPeriods;
  priority = 4;
  description = "A payroll period (monthly or otherwise) for an operator, defining the date range and status lifecycle from DRAFT to FINALIZED.";

  listDisplay = [
    { key: "operatorId", label: "Operator", relatedModel: "operators", relatedLabelField: "name" },
    { key: "periodType", type: "enum" as const },
    { key: "startDate", type: "date" as const },
    { key: "endDate", type: "date" as const },
    { key: "status", type: "enum" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "operatorId") return { ...f, label: "Operator", relatedModel: "operators", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new PayrollPeriodAdmin();
