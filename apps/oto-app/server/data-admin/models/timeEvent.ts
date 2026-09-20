import { ModelAdmin, deriveFormFields } from "../admin";
import { timeEvents, timeEventTypes, authMethods } from "../../../shared/schema";

class TimeEventAdmin extends ModelAdmin {
  name = "Time Event";
  table = timeEvents;
  priority = 8;
  description = "Raw clock-in/clock-out events captured at kiosk devices via face recognition or PIN, with confidence scores and photo evidence.";

  listDisplay = [
    { key: "employeeId", label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" },
    { key: "eventType", label: "Type", type: "enum" as const },
    { key: "authMethod", label: "Auth", type: "enum" as const },
    { key: "eventTime", label: "Time", type: "date" as const },
    { key: "branchId", label: "Branch", relatedModel: "branches", relatedLabelField: "name" },
    { key: "confidenceScore", label: "Confidence", type: "number" as const },
  ];

  searchFields = ["notes", "reasonNotes"];

  filters = [
    {
      key: "eventType",
      label: "Type",
      type: "select" as const,
      options: timeEventTypes.map(t => ({ label: t, value: t })),
    },
    {
      key: "authMethod",
      label: "Auth Method",
      type: "select" as const,
      options: authMethods.map(a => ({ label: a, value: a })),
    },
  ];

  defaultOrderBy = "eventTime";

  get formFields() {
    return deriveFormFields(this.table).map(f => {
      if (f.key === "tenantId") return { ...f, label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" };
      if (f.key === "employeeId") return { ...f, label: "Employee", relatedModel: "employees", relatedLabelField: "fullName" };
      if (f.key === "branchId") return { ...f, label: "Branch", relatedModel: "branches", relatedLabelField: "name" };
      if (f.key === "kioskDeviceId") return { ...f, label: "Kiosk Device", relatedModel: "kioskdevices", relatedLabelField: "id" };
      if (f.key === "createdBy") return { ...f, label: "Created By", relatedModel: "users", relatedLabelField: "fullName" };
      return f;
    });
  }
}

export default new TimeEventAdmin();
