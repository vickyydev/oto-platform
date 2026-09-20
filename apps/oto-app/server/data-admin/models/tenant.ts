import { ModelAdmin } from "../admin";
import { tenants } from "../../../shared/schema";

class TenantAdmin extends ModelAdmin {
  name = "Tenant";
  description = "Top-level multi-tenancy root; every other record in the system belongs to a tenant identified by a unique slug.";
  priority = 29;
  table = tenants;

  listDisplay = [
    { key: "name" },
    { key: "slug" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["name", "slug"];

  protected formFieldOverrides = [
    { key: "name", required: true },
    { key: "slug", required: true },
  ];

  defaultOrderBy = "name";
}

export default new TenantAdmin();
