import { ModelAdmin, deriveFormFields } from "../admin";
import { xeroTokens } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class XeroTokenAdmin extends ModelAdmin {
  name = "Xero Token";
  table = xeroTokens;
  priority = 4;
  description = "OAuth tokens for the Xero accounting integration, storing access/refresh tokens and the connected Xero organisation.";

  listDisplay = [
    { key: "xeroTenantName" },
    { key: "xeroTenantId" },
    { key: "isActive", type: "boolean" as const },
    { key: "expiresAt", type: "date" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["xeroTenantName", "xeroTenantId"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table);
  }
}

export default new XeroTokenAdmin();
