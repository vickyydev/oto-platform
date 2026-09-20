import { ModelAdmin, deriveFormFields } from "../admin";
import { branchEvents } from "../../../shared/schema";
import type { FormFieldDef } from "../admin";

class BranchEventAdmin extends ModelAdmin {
  name = "Branch Event";
  table = branchEvents;
  priority = 4;
  description = "Calendar events for a branch such as closures, special openings, or internal events, shown in scheduling views.";

  listDisplay = [
    { key: "title" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "startTime", type: "date" as const },
    { key: "endTime", type: "date" as const },
    { key: "isAllDay", type: "boolean" as const },
  ];

  searchFields = ["title", "location"];
  defaultOrderBy = "startTime";

  get formFields(): FormFieldDef[] {
    return deriveFormFields(this.table).map((f) => {
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      return f;
    });
  }
}

export default new BranchEventAdmin();
