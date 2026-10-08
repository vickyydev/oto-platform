/**
 * Settings per park group (S2-17b round 4a; plan section 7, hazard H11).
 *
 * Before migration 0006 the app had ONE set of settings — `settings.key` is
 * unique across the whole table — and every park group (tenant) read and wrote
 * it: the employer's counter-signature on contracts, the default probation,
 * the leave entitlements, the Fix department, the kiosk code lifetime, the AI
 * prompts. 0006 gives each row a park group, and every row that existed went
 * to the default park group (slug `default`), whose set it was.
 *
 * READING. A park group reads its own row for a key; where it has none, the
 * default park group's — exactly what it read before 0006, when the one set
 * was everybody's (plan Q28: the app's behaviour is the default). A row with no
 * park group at all is one the previous release wrote during the hand-over,
 * and reads as the default park group's, as it would have.
 *
 * SAVING, IN THIS RELEASE. The baseline's `settings_key_unique` still stands
 * beside the new (tenant_id, key) index, so the release before this one keeps
 * working against the migrated table. While it stands a key can be held by one
 * park group only. A second park group saving a key the default holds would
 * hit it; a second park group saving a key first would stop the default park
 * group — the park the app runs today — ever saving that key. So in this
 * release only the default park group saves settings, and another park group
 * is refused in words (409), never with a 500 off the unique. The contraction
 * (round 4b, one release later) drops the old unique and opens saving to every
 * park group; nothing here assumes which shape the table has.
 *
 * Who "the default park group" is, for a save, is the app's strict placement
 * of the caller (`userManagementTenant` in routes.ts, the rule User Management
 * and the maintenance routes use): the session's park group, counted only when
 * the caller's own rows put them there. A read uses the session's park group,
 * as every other read in the app does.
 *
 * No Express or database import: the platform's tests read the words from here.
 */

/** Why a save was refused; the body a route answers with its 409. */
export interface SettingsRefusal {
  reason: "settings_shared" | "settings_key_held" | "settings_no_park_group";
  message: string;
}

/** Another park group saving while the old unique stands (this release). */
export const SETTINGS_SHARED_REFUSAL: SettingsRefusal = {
  reason: "settings_shared",
  message:
    "Settings are still shared between park groups, so only the default park group can change them. " +
    "This park group uses the default park group's settings until each park group keeps its own, from the next release.",
};

/** The key is held by another park group's row (only reachable around the old unique). */
export const SETTINGS_KEY_HELD_REFUSAL: SettingsRefusal = {
  reason: "settings_key_held",
  message:
    "Another park group already holds this setting, so it cannot be saved here until each park group keeps its own settings, from the next release.",
};

/** A caller the app cannot place in a park group by their own rows. */
export const SETTINGS_NO_PARK_GROUP_REFUSAL: SettingsRefusal = {
  reason: "settings_no_park_group",
  message: "Access denied: this account belongs to no park group, so it has no settings of its own to change.",
};

/** A refused save, carried out of the storage layer to the route that answers it. */
export class SettingsWriteRefusedError extends Error {
  readonly status: number;
  readonly refusal: SettingsRefusal;
  constructor(refusal: SettingsRefusal, status = 409) {
    super(refusal.message);
    this.name = "SettingsWriteRefusedError";
    this.refusal = refusal;
    this.status = status;
  }
}

/**
 * Which park group may save settings in this release: the default one only.
 * `owner` is the park group the save is for (null: the app knows no park group
 * at all, which in a database with no tenants is the old single set).
 */
export function settingsWritableBy(owner: string | null, defaultParkGroup: string | null): boolean {
  return owner === defaultParkGroup;
}

/**
 * The order a park group reads candidate rows for one key in: its own first,
 * then the default park group's, then a row with no park group (the previous
 * release's, which is the default's). Lower ranks first.
 */
export function settingsReadRank(
  rowTenant: string | null,
  reader: string | null,
  defaultParkGroup: string | null,
): number | null {
  if (rowTenant !== null && rowTenant === reader) return 0;
  if (rowTenant !== null && rowTenant === defaultParkGroup) return 1;
  if (rowTenant === null) return 2;
  return null; // another park group's row: never read
}
