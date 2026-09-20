import { ModelAdmin, deriveFormFields } from "../admin";
import { payrollLineItems } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class PayrollLineItemAdmin extends ModelAdmin {
  name = "Payroll Line Item";
  table = payrollLineItems;
  priority = 6;
  description = "Individual earnings, deductions, and statutory contribution line items for an employee within a payroll run.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "lineType", type: "enum" as const },
    { key: "code" },
    { key: "amount", type: "number" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["code", "description"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      return f;
    });
  }
}

export default new PayrollLineItemAdmin();
