import { ModelAdmin } from "../admin";
import { operators, operatorStatuses } from "../../../shared/schema";

class OperatorAdmin extends ModelAdmin {
  name = "Operator";
  description = "An organisation or business entity within a tenant that groups branches and scopes operator_admin users.";
  priority = 24;
  table = operators;

  listDisplay = [
    { key: "name" },
    { key: "status", type: "enum" as const },
    { key: "tenantId", label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["name"];

  filters = [
    {
      key: "status",
      label: "Status",
      type: "select" as const,
      options: operatorStatuses.map((s) => ({ label: s, value: s })),
    },
  ];

  protected formFieldOverrides = [
    { key: "name", required: true },
    {
      key: "status",
      type: "enum" as const,
      required: true,
      defaultValue: "active",
      options: operatorStatuses.map((s) => ({ label: s, value: s })),
    },
    { key: "tenantId", required: true, relatedModel: "tenants", relatedLabelField: "name" },
  ];

  defaultOrderBy = "name";
}

export default new OperatorAdmin();
