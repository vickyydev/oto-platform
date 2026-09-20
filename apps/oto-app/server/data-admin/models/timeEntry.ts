import { ModelAdmin, deriveFormFields } from "../admin";
import { timeEntries } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class TimeEntryAdmin extends ModelAdmin {
  name = "Time Entry";
  table = timeEntries;
  priority = 3;
  description = "Derived daily timekeeping records pairing scheduled hours with actual clock-in/out times, pending manager approval.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "shiftDate" },
    { key: "status", type: "enum" as const },
    { key: "clockInAt", type: "date" as const },
  ];

  searchFields = ["shiftDate"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new TimeEntryAdmin();
