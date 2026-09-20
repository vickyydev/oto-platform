import { ModelAdmin, deriveFormFields } from "../admin";
import { scheduleTemplateAssignments } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class ScheduleTemplateAssignmentAdmin extends ModelAdmin {
  name = "Schedule Template Assignment";
  table = scheduleTemplateAssignments;
  priority = 2;
  description = "Pre-assigns an employee to a specific day-of-week within a schedule template row, so they are auto-filled when the template is applied.";

  listDisplay = [
    { key: "templateRowId", label: "Template Row" },
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

export default new ScheduleTemplateAssignmentAdmin();
