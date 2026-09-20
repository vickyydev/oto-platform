import { ModelAdmin } from "../admin";
import { session } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class SessionAdmin extends ModelAdmin {
  name = "Session";
  table = session;
  priority = 30;
  description = "Express session store table managed by connect-pg-simple, holding serialised session data and expiry timestamps.";

  listDisplay = [
    { key: "sid" },
    { key: "expire", type: "date" as const },
  ];

  searchFields = ["sid"];
  defaultOrderBy = "expire";

  get formFields(): FormFieldDef[] {
    return [
      { key: "sid", readOnly: true },
      { key: "sess", readOnly: true, inputType: "textarea" as const },
      { key: "expire", readOnly: true, type: "date" as const },
    ];
  }
}

export default new SessionAdmin();
