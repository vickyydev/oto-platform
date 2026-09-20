import { ModelAdmin, deriveFormFields } from "../admin";
import { scheduleTemplateRows } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class ScheduleTemplateRowAdmin extends ModelAdmin {
  name = "Schedule Template Row";
  table = scheduleTemplateRows;
  priority = 3;
  description = "A shift row definition within a schedule template, mirroring scheduleShiftRows but not tied to a specific week.";

  listDisplay = [
    { key: "templateId", label: "Template" },
    { key: "label" },
    { key: "startTime" },
    { key: "endTime" },
    { key: "staffRequired", type: "number" as const },
  ];

  searchFields = ["label"];
  defaultOrderBy = "rowOrder";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "departmentId") return { ...f, label: "Department", relatedModel: "departments", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new ScheduleTemplateRowAdmin();
