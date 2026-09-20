import { ModelAdmin, deriveFormFields } from "../admin";
import { employeeRoles, proficiencyLevels } from "../../../shared/schema";

class EmployeeRoleAdmin extends ModelAdmin {
  name = "Employee Role";
  table = employeeRoles;
  priority = 8;
  description = "Junction table assigning job roles to employees, with a proficiency level and a flag for the primary role.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "roleId", label: "Role", relatedModel: "roles", relatedLabelField: "name" },
    { key: "proficiencyLevel", label: "Proficiency", type: "enum" as const },
    { key: "isPrimary", label: "Primary", type: "boolean" as const },
    { key: "createdAt", type: "date" as const },
  ];

  filters = [
    {
      key: "proficiencyLevel",
      label: "Proficiency",
      type: "select" as const,
      options: proficiencyLevels.map(p => ({ label: p, value: p })),
    },
    { key: "isPrimary", label: "Primary", type: "boolean" as const },
  ];

  defaultOrderBy = "createdAt";

  get formFields() {
    return deriveFormFields(this.table).map(f => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "roleId") return { ...f, label: "Role", relatedModel: "roles", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new EmployeeRoleAdmin();
