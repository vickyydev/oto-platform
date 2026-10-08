/**
 * Settings per park group (S2-17b round 4a, opened in round 4b; plan section 7,
 * hazard H11).
 *
 * Before migration 0006 the app had ONE set of settings — `settings.key` was
 * unique across the whole table — and every park group (tenant) read and wrote
 * it: the employer's counter-signature on contracts, the default probation,
 * the leave entitlements, the Fix department, the kiosk code lifetime, the AI
 * prompts, the Attention rules. 0006 gave each row a park group, and every row
 * that existed went to the default park group (slug `default`, else the only
 * park group the database holds — the app's own rule, `getDefaultTenantId`),
 * whose set it was.
 *
 * READING. A park group reads its own row for a key; where it has none, the
 * default park group's — exactly what it read before 0006, when the one set
 * was everybody's (plan Q28: the app's behaviour is the default). A row with no
 * park group at all could only be one a release before 4a wrote; migration
 * 0007 placed every such row and made `tenant_id` NOT NULL, so none is left,
 * and one would read as the default park group's, as it would have.
 *
 * SAVING (round 4b). Migration 0007 dropped the baseline's
 * `settings_key_unique`, so the (tenant_id, key) unique carries uniqueness
 * alone: every park group saves its OWN row for a key, and the default park
 * group's row for that key is left as it is (the other park groups that have
 * no row of their own go on reading it). In 4a only the default park group
 * could save (Q29); that refusal is gone with the constraint that made it
 * necessary.
 *
 * Who a save is for is the app's strict placement of the caller
 * (`userManagementTenant` in routes.ts, the rule User Management and the
 * maintenance routes use): the session's park group, counted only when the
 * caller's own rows put them there. A caller it cannot place is refused (403):
 * they have no settings of their own. A read uses the session's park group, as
 * every other read in the app does.
 *
 * A save of several keys is one transaction (`storage.upsertSettings`): either
 * every key is saved or none is (the round 4a review's note).
 *
 * No Express or database import: the platform's tests read the words from here.
 */

/** Why a save was refused; the body a route answers with. */
export interface SettingsRefusal {
  reason: "settings_key_held" | "settings_no_park_group" | "settings_moved";
  message: string;
}

/**
 * The key is held by another park group's row under the old one-row-per-key
 * unique. Reachable only on a database migration 0007 has not reached yet: the
 * code that saves per park group meeting the table as 0006 left it.
 */
export const SETTINGS_KEY_HELD_REFUSAL: SettingsRefusal = {
  reason: "settings_key_held",
  message:
    "Another park group already holds this setting, and this database still keeps one row per setting for every park group, so it was not saved here. It can be saved once the OTO App's migration 0007 has run.",
};

/**
 * A Data Admin edit trying to move a settings row to a different park group.
 * A move silently takes the key out from under the park group reading it
 * (round 4b review, finding 3); the value may be edited, the owner may not.
 */
export const SETTINGS_MOVE_REFUSAL: SettingsRefusal = {
  reason: "settings_moved",
  message:
    "A setting stays with the park group it belongs to. To give another park group its own value, save that key as that park group instead of moving this row.",
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
 * Who may save settings (round 4b): any park group, its own rows. `owner` is
 * the park group the save is for; null means the caller belongs to none, and a
 * setting cannot be saved for nobody (`tenant_id` is NOT NULL).
 */
export function settingsWritableBy(owner: string | null): owner is string {
  return typeof owner === "string" && owner.length > 0;
}

/**
 * The order a park group reads candidate rows for one key in: its own first,
 * then the default park group's, then a row with no park group (a release
 * before 4a wrote it; none is left after 0007). Lower ranks first.
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
