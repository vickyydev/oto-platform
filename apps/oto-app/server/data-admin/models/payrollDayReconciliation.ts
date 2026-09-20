import { ModelAdmin, deriveFormFields } from "../admin";
import { payrollDayReconciliations } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class PayrollDayReconciliationAdmin extends ModelAdmin {
  name = "Payroll Day Reconciliation";
  table = payrollDayReconciliations;
  priority = 4;
  description = "Per-employee per-day reconciliation of scheduled vs actual worked minutes and pay within a payroll run, flagging variances.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "workDate", type: "date" as const },
    { key: "scheduledPay", type: "number" as const },
    { key: "actualPay", type: "number" as const },
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

export default new PayrollDayReconciliationAdmin();
