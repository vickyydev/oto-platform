import { ModelAdmin, deriveFormFields } from "../admin";
import { authResetTokens } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class AuthResetTokenAdmin extends ModelAdmin {
  name = "Auth Reset Token";
  table = authResetTokens;
  priority = 2;
  description = "HMAC-signed one-time password reset tokens tied to a user or person, with expiry and used-flag to prevent replay.";

  listDisplay = [
    { key: "userId", label: "User", relatedModel: "users", relatedLabelField: "email" },
    { key: "phoneE164" },
    { key: "tokenType" },
    { key: "used", type: "boolean" as const },
    { key: "expiresAt", type: "date" as const },
  ];

  searchFields = ["phoneE164", "tokenType"];
  defaultOrderBy = "createdAt";

  // authResetTokens uses id as PK but it is the HMAC-signed token, not a uuid — keep base impl
  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "userId") return { ...f, label: "User", relatedModel: "users", relatedLabelField: "email" };
      return f;
    });
  }
}

export default new AuthResetTokenAdmin();
