import { ModelAdmin, deriveFormFields } from "../admin";
import { authOtpEvents } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class AuthOtpEventAdmin extends ModelAdmin {
  name = "Auth OTP Event";
  table = authOtpEvents;
  priority = 3;
  description = "Audit log of SMS OTP authentication events (sent, verified, failed) for password reset and phone verification flows.";

  listDisplay = [
    { key: "userId", label: "User", relatedModel: "users", relatedLabelField: "email" },
    { key: "phoneE164" },
    { key: "eventType", type: "enum" as const },
    { key: "success", type: "boolean" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["phoneE164"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "userId") return { ...f, label: "User", relatedModel: "users", relatedLabelField: "email" };
      return f;
    });
  }
}

export default new AuthOtpEventAdmin();
