import { ModelAdmin, deriveFormFields } from "../admin";
import { kioskAuthAttempts } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class KioskAuthAttemptAdmin extends ModelAdmin {
  name = "Kiosk Auth Attempt";
  table = kioskAuthAttempts;
  priority = 2;
  description = "Log of all clock-in authentication attempts at kiosks (face or PIN), recording outcomes, confidence scores, and failure reasons for security auditing.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "method", type: "enum" as const },
    { key: "outcome", type: "enum" as const },
    { key: "attemptTime", type: "date" as const },
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

export default new KioskAuthAttemptAdmin();
