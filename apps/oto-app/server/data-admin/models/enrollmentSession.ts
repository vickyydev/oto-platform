import { ModelAdmin, deriveFormFields } from "../admin";
import { enrollmentSessions } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class EnrollmentSessionAdmin extends ModelAdmin {
  name = "Enrollment Session";
  table = enrollmentSessions;
  priority = 3;
  description = "One-time-use token sessions for employee face enrollment at a kiosk, with expiry and usage tracking.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "expiresAt", type: "date" as const },
    { key: "usedAt", type: "date" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      return f;
    });
  }
}

export default new EnrollmentSessionAdmin();
