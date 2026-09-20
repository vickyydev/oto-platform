import { ModelAdmin, deriveFormFields } from "../admin";
import { authRateLimits } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class AuthRateLimitAdmin extends ModelAdmin {
  name = "Auth Rate Limit";
  table = authRateLimits;
  priority = 2;
  description = "Sliding-window rate limit counters for authentication endpoints, keyed by phone number or IP address to prevent brute force attacks.";

  listDisplay = [
    { key: "key" },
    { key: "count", type: "number" as const },
    { key: "windowStart", type: "date" as const },
    { key: "expiresAt", type: "date" as const },
  ];

  searchFields = ["key"];
  defaultOrderBy = "expiresAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table);
  }
}

export default new AuthRateLimitAdmin();
