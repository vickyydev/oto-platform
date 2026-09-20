import { ModelAdmin } from "../admin";
import { settings } from "../../../shared/schema";

class SettingAdmin extends ModelAdmin {
  name = "Setting";
  table = settings;
  priority = 30;
  description = "Key-value store for global application configuration settings (e.g. feature flags, system-wide defaults).";

  listDisplay = [
    { key: "key" },
    { key: "value" },
    { key: "updatedAt", type: "date" as const },
  ];

  searchFields = ["key", "value"];
  defaultOrderBy = "key";
}

export default new SettingAdmin();
