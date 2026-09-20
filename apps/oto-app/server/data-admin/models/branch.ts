import { ModelAdmin } from "../admin";
import { branches } from "../../../shared/schema";

// Common IANA timezones used in the system
const TIMEZONES = [
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Kuala_Lumpur",
  "Asia/Jakarta",
  "Asia/Ho_Chi_Minh",
  "Asia/Manila",
  "Asia/Tokyo",
  "Asia/Seoul",
  "Asia/Hong_Kong",
  "Asia/Shanghai",
  "Asia/Kolkata",
  "Asia/Dubai",
  "Europe/London",
  "Europe/Paris",
  "Europe/Berlin",
  "America/New_York",
  "America/Los_Angeles",
  "America/Chicago",
  "Australia/Sydney",
  "Pacific/Auckland",
  "UTC",
];

class BranchAdmin extends ModelAdmin {
  name = "Branch";
  description = "A physical location or site belonging to an operator, with its own timezone, address, and Google Drive integration.";
  priority = 101;
  table = branches;

  listDisplay = [
    { key: "name" },
    { key: "address" },
    { key: "timezone" },
    { key: "operatorId", label: "Operator", relatedModel: "operators", relatedLabelField: "name" },
    { key: "tenantId", label: "Tenant", relatedModel: "tenants", relatedLabelField: "name" },
    { key: "createdAt", type: "date" as const },
  ];

  searchFields = ["name", "address"];

  filters = [
    {
      key: "timezone",
      label: "Timezone",
      type: "select" as const,
      options: TIMEZONES.map((tz) => ({ label: tz, value: tz })),
    },
    {
      key: "operatorId",
      label: "Operator",
      type: "select" as const,
      // populated dynamically by client from /api/data-admin/operators/options
      options: [],
    },
  ];

  protected formFieldOverrides = [
    { key: "name", required: true },
    { key: "address", required: true },
    {
      key: "timezone",
      required: true,
      type: "enum" as const,
      defaultValue: "Asia/Bangkok",
      options: TIMEZONES.map((tz) => ({ label: tz, value: tz })),
    },
    { key: "tenantId", label: "Tenant", required: true, relatedModel: "tenants", relatedLabelField: "name" },
    { key: "operatorId", label: "Operator", relatedModel: "operators", relatedLabelField: "name" },
    { key: "logoUrl", label: "Logo URL", inputType: "text" as const },
    { key: "googleDriveFolder", label: "Google Drive Folder" },
  ];

  defaultOrderBy = "name";
}

export default new BranchAdmin();
