import { ModelAdmin } from "../admin";
import { settings } from "../../../shared/schema";
import { storage } from "../../storage";
import {
  SETTINGS_NO_PARK_GROUP_REFUSAL,
  SettingsWriteRefusedError,
  settingsWritableBy,
} from "../../lib/parkGroupSettings";

/** A park group as Data Admin's form sends it: blank names none. */
const namedParkGroup = (value: unknown): string | null =>
  typeof value === "string" && value.trim() !== "" ? value : null;

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

  /**
   * Round 4a held this model to the default park group while the old unique on
   * `settings.key` stood, because another park group's row would have held its
   * key against the default park group (Q29, the 4a review's finding 2).
   * Migration 0007 (round 4b) dropped that unique, so the hold is lifted and
   * the model is as every other Data Admin model is: it reaches every park
   * group's rows, and its walkthrough is round 7's (Q31). What stays: a row
   * belongs to a park group (`tenant_id` NOT NULL), so a create naming none is
   * the default park group's, as in 4a, and is refused in words where the
   * database has no default park group to give it.
   */
  async create(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tenantId = namedParkGroup(data.tenantId) ?? (await storage.getDefaultParkGroupId());
    if (!settingsWritableBy(tenantId)) {
      throw new SettingsWriteRefusedError(SETTINGS_NO_PARK_GROUP_REFUSAL, 403);
    }
    return super.create({ ...data, tenantId });
  }

  /** A row cannot be moved to no park group: `tenant_id` is NOT NULL. */
  async update(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!("tenantId" in data)) return super.update(id, data);
    const tenantId = namedParkGroup(data.tenantId);
    if (!settingsWritableBy(tenantId)) {
      throw new SettingsWriteRefusedError(SETTINGS_NO_PARK_GROUP_REFUSAL, 403);
    }
    return super.update(id, { ...data, tenantId });
  }
}

export default new SettingAdmin();
