import { ModelAdmin, deriveFormFields } from "../admin";
import { payrollExceptionApprovals } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class PayrollExceptionApprovalAdmin extends ModelAdmin {
  name = "Payroll Exception Approval";
  table = payrollExceptionApprovals;
  priority = 2;
  description = "Approval or rejection decisions recorded against a payroll exception by the required approver role.";

  listDisplay = [
    { key: "approverId", label: "Approver", relatedModel: "users", relatedLabelField: "email" },
    { key: "role" },
    { key: "decision", type: "enum" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "approverId") return { ...f, label: "Approver", relatedModel: "users", relatedLabelField: "email" };
      return f;
    });
  }
}

export default new PayrollExceptionApprovalAdmin();
