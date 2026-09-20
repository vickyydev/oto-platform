import { ModelAdmin } from "../admin";
import { departments } from "../../../shared/schema";

class DepartmentAdmin extends ModelAdmin {
  name = "Department";
  description = "An organisational unit grouping employees within a tenant, assignable to one or more branches.";
  priority = 56;
  table = departments;

  listDisplay = [
    { key: "name" },
    { key: "description" },
    { key: "isActive", type: "boolean" as const, label: "Active" },
    { key: "displayOrder", type: "number" as const, label: "Order" },
    { key: "tenantId", label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["name", "description"];

  filters = [
    {
      key: "isActive",
      label: "Active",
      type: "boolean" as const,
    },
  ];

  protected formFieldOverrides = [
    { key: "name", required: true },
    { key: "description", inputType: "textarea" as const },
    { key: "isActive", type: "boolean" as const, label: "Active", defaultValue: true },
    { key: "displayOrder", type: "number" as const, label: "Display Order", defaultValue: 0 },
    { key: "tenantId", label: "Tenant", required: true, relatedModel: "tenants", relatedLabelField: "name" },
  ];

  defaultOrderBy = "name";
}

export default new DepartmentAdmin();
