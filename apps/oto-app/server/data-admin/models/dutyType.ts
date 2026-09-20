import { ModelAdmin, deriveFormFields } from "../admin";
import { dutyTypes } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class DutyTypeAdmin extends ModelAdmin {
  name = "Duty Type";
  table = dutyTypes;
  priority = 3;
  description = "Named categories of duties (e.g. Reception, Pool Watch) that can be assigned as duty blocks within shifts.";

  listDisplay = [
    { key: "name" },
    { key: "defaultDurationMinutes", type: "number" as const },
    { key: "color" },
    { key: "isActive", type: "boolean" as const },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["name"];
  defaultOrderBy = "name";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table);
  }
}

export default new DutyTypeAdmin();
