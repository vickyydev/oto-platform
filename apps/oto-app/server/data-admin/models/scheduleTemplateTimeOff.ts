import { ModelAdmin, deriveFormFields } from "../admin";
import { scheduleTemplateTimeOff } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class ScheduleTemplateTimeOffAdmin extends ModelAdmin {
  name = "Schedule Template Time Off";
  table = scheduleTemplateTimeOff;
  priority = 2;
  description = "Records an employee's regular day off within a schedule template, so they are automatically excluded when the template is applied.";

  listDisplay = [
    { key: "templateId", label: "Template" },
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "dayOfWeek", type: "number" as const },
  ];

  searchFields = [];
  defaultOrderBy = "id";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      return f;
    });
  }
}

export default new ScheduleTemplateTimeOffAdmin();
