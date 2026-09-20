import { ModelAdmin, deriveFormFields } from "../admin";
import { kioskCodes } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class KioskCodeAdmin extends ModelAdmin {
  name = "Kiosk Code";
  table = kioskCodes;
  priority = 2;
  description = "Short-lived hashed pairing codes (120s TTL) used to activate and register a new kiosk device at a branch.";

  listDisplay = [
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "expiresAt", type: "date" as const },
    { key: "usedAt", type: "date" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new KioskCodeAdmin();
