import { ModelAdmin, deriveFormFields } from "../admin";
import { scheduleTemplates } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class ScheduleTemplateAdmin extends ModelAdmin {
  name = "Schedule Template";
  table = scheduleTemplates;
  priority = 3;
  description = "A saved schedule template for a branch that can be applied to future weeks, optionally sourced from an existing week plan.";

  listDisplay = [
    { key: "name" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "departmentId", label: "Department", relatedModel: "departments", relatedLabelField: "name" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["name"];
  defaultOrderBy = "createdAt";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      if (f.key === "departmentId") return { ...f, label: "Department", relatedModel: "departments", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new ScheduleTemplateAdmin();
