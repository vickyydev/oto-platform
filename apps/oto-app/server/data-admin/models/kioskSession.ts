import { ModelAdmin, deriveFormFields } from "../admin";
import { kioskSessions } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class KioskSessionAdmin extends ModelAdmin {
  name = "Kiosk Session";
  table = kioskSessions;
  priority = 2;
  description = "Authenticated session tokens for kiosk devices, allowing them to make API calls without re-pairing.";

  listDisplay = [
    { key: "kioskDeviceId", label: "Device" },
    { key: "expiresAt", type: "date" as const },
    { key: "lastSeenAt", type: "date" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = [];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table);
  }
}

export default new KioskSessionAdmin();
