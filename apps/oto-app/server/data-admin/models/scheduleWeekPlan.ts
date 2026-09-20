import { ModelAdmin, deriveFormFields } from "../admin";
import { scheduleWeekPlans } from "../../../shared/schema";

class ScheduleWeekPlanAdmin extends ModelAdmin {
  name = "Schedule Week Plan";
  table = scheduleWeekPlans;
  priority = 6;
  description = "The container for a branch's weekly schedule, anchored to a Monday start date and holding shift rows and assignments.";

  listDisplay = [
    { key: "weekStartDate", label: "Week Starting", type: "date" as const },
    { key: "name" },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "createdBy", label: "Created By", relatedModel: "users", relatedLabelField: "fullName" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["name"];

  defaultOrderBy = "weekStartDate";

  get formFields() {
    return deriveFormFields(this.table).map(f => {
      if (f.key === "tenantId") return { ...f, label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      if (f.key === "createdBy") return { ...f, label: "Created By", relatedModel: "users", relatedLabelField: "fullName" };
      return f;
    });
  }
}

export default new ScheduleWeekPlanAdmin();
