import { ModelAdmin } from "../admin";
import { settings } from "../../../shared/schema";
import { storage } from "../../storage";
import {
  SETTINGS_SHARED_REFUSAL,
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
   * Held to the rule `upsertSetting` keeps (S2-17b round 4a, Q29): while the
   * old unique on `settings.key` stands, only the default park group writes a
   * settings row, because another park group's row would hold its key against
   * the default park group until 4b. A row naming no park group is the
   * default's. Anything else is refused in the words the other doors use.
   */
  private async heldToDefault(parkGroup: string | null): Promise<string | null> {
    const defaultParkGroup = await storage.getDefaultParkGroupId();
    const owner = parkGroup ?? defaultParkGroup;
    if (!settingsWritableBy(owner, defaultParkGroup)) {
      throw new SettingsWriteRefusedError(SETTINGS_SHARED_REFUSAL);
    }
    return owner;
  }

  async create(data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const tenantId = await this.heldToDefault(namedParkGroup(data.tenantId));
    return super.create({ ...data, tenantId });
  }

  /** Neither another park group's row, nor the default's row moved to another park group. */
  async update(id: string, data: Record<string, unknown>): Promise<Record<string, unknown>> {
    const existing = await this.getById(id);
    if (!existing) return super.update(id, data);
    await this.heldToDefault(namedParkGroup(existing.tenantId));
    if (!("tenantId" in data)) return super.update(id, data);
    const tenantId = await this.heldToDefault(namedParkGroup(data.tenantId));
    return super.update(id, { ...data, tenantId });
  }
}

export default new SettingAdmin();
