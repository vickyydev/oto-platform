import { ModelAdmin, deriveFormFields } from "../admin";
import { payslips } from "../../../shared/schema";

class PayslipAdmin extends ModelAdmin {
  name = "Payslip";
  table = payslips;
  priority = 12;
  description = "Generated payslip records for each employee per payroll run, storing the full slip data as JSON and an optional PDF URL.";

  listDisplay = [
    { key: "slipNumber", label: "Slip #" },
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "issuedAt", label: "Issued", type: "date" as const },
    { key: "pdfUrl", label: "PDF" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["slipNumber"];

  defaultOrderBy = "issuedAt";

  get formFields() {
    return deriveFormFields(this.table).map(f => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "payrollRunId") return { ...f, label: "Payroll Run", relatedModel: "payrollruns", relatedLabelField: "id" };
      if (f.key === "payrollPeriodId") return { ...f, label: "Payroll Period", relatedModel: "payrollperiods", relatedLabelField: "id" };
      return f;
    });
  }
}

export default new PayslipAdmin();
