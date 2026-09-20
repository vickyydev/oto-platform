import { ModelAdmin, deriveFormFields } from "../admin";
import { kioskDevices } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class KioskDeviceAdmin extends ModelAdmin {
  name = "Kiosk Device";
  table = kioskDevices;
  priority = 4;
  description = "A registered tablet or kiosk device at a branch used for face-recognition clock-in or reception check-ins.";

  listDisplay = [
    { key: "name" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "kioskType", type: "enum" as const },
    { key: "isActive", type: "boolean" as const },
    { key: "lastSeenAt", type: "date" as const },
  ];

  searchFields = ["name"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new KioskDeviceAdmin();
