import { ModelAdmin, deriveFormFields } from "../admin";
import { payrollRuns } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class PayrollRunAdmin extends ModelAdmin {
  name = "Payroll Run";
  table = payrollRuns;
  priority = 5;
  description = "A single payroll calculation run within a period, progressing through DRAFT to FINALIZED, containing all line items and summaries.";

  listDisplay = [
    { key: "runNumber", type: "number" as const },
    { key: "status", type: "enum" as const },
    { key: "finalizedAt", type: "date" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table);
  }
}

export default new PayrollRunAdmin();
