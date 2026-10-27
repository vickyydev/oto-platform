/**
 * THE SETTINGS CATALOGUE (SCRUM-646, S2-23 Configuration).
 *
 * `core.setting_registry` is an index of which settings exist and which app
 * owns each one. It is metadata only, the same for every operator: no value of
 * any setting lives here, and the values stay in their native stores.
 *
 * The rows are written by ONE function, `convergeSettingRegistry`, from the
 * code-owned list below. Reading the index never writes it, and the index
 * route never trusts what the stored row says about a page address or a
 * permission: it resolves a known key against code and treats an unknown key
 * as unsupported. Calling the convergence from `platform:sync` is still open
 * planner integration (Q27, coordinated with Q24's seed work), so nothing here
 * runs on deploy yet and a freshly migrated registry is honestly empty.
 *
 * Coverage is deliberately partial. Every entry below was checked against the
 * Console page that edits it and the native API door behind that page; the
 * other settings S2-23 names are not listed until each is verified the same
 * way.
 */
import { eq, inArray } from 'drizzle-orm';
import { newId, type Permission } from '@oto/shared';
import type { Db } from './index';
import { settingRegistry } from './schema/index';

export const SETTING_APP_OWNERS = ['platform', 'pos', 'oto_app', 'radar', 'inbox', 'booth'] as const;
export type SettingAppOwner = (typeof SETTING_APP_OWNERS)[number];

export interface SettingCatalogueEntry {
  key: string;
  label: string;
  appOwner: SettingAppOwner;
  /** A fixed Console path for a setting edited here; null for an app-owned one. Informational only. */
  owningPageUrl: string | null;
  editableHere: boolean;
  /** The permission the owning page itself requires. */
  requiredPermission: Permission;
}

export const SETTING_CATALOGUE = [
  {
    key: 'assistant_settings', label: 'Assistant settings', appOwner: 'platform',
    owningPageUrl: '/channels/assistant-settings', editableHere: true, requiredPermission: 'inbox:ai:manage',
  },
  {
    key: 'tenders', label: 'Tenders', appOwner: 'platform',
    owningPageUrl: '/catalogue/tenders', editableHere: true, requiredPermission: 'catalog:menu:manage',
  },
  {
    key: 'branch_tax', label: 'Tax', appOwner: 'platform',
    owningPageUrl: '/catalogue/tax', editableHere: true, requiredPermission: 'catalog:tax:manage',
  },
  {
    key: 'branch_holidays', label: 'Holidays', appOwner: 'platform',
    owningPageUrl: '/organisation/holidays', editableHere: true, requiredPermission: 'catalog:holiday:manage',
  },
  {
    key: 'print_templates', label: 'Print templates', appOwner: 'platform',
    owningPageUrl: '/catalogue/print-templates', editableHere: true, requiredPermission: 'pos:print:read',
  },
  {
    key: 'event_pricing', label: 'Event pricing', appOwner: 'platform',
    owningPageUrl: '/catalogue/event-pricing', editableHere: true, requiredPermission: 'admin:event_pricing:manage',
  },
  {
    key: 'care_pricing', label: 'Drop-off & supervision', appOwner: 'platform',
    owningPageUrl: '/catalogue/care', editableHere: true, requiredPermission: 'pos:checkin:read',
  },
  {
    key: 'inbox_templates', label: 'Message templates', appOwner: 'inbox',
    owningPageUrl: null, editableHere: false, requiredPermission: 'inbox:template:manage',
  },
] as const satisfies readonly SettingCatalogueEntry[];

export type SettingCatalogueKey = (typeof SETTING_CATALOGUE)[number]['key'];

export interface SettingRegistryConvergence {
  inserted: string[];
  updated: string[];
  unchanged: string[];
}

const metadataOf = (entry: SettingCatalogueEntry) => ({
  label: entry.label,
  appOwner: entry.appOwner,
  owningPageUrl: entry.owningPageUrl,
  editableHere: entry.editableHere,
  requiredPermission: entry.requiredPermission,
});

/**
 * Make the registry carry the catalogue, idempotently.
 *
 * - A missing key is inserted with a new identity.
 * - A present key keeps its identity; only metadata that actually differs is
 *   rewritten, and only then does `updated_at` move.
 * - An unchanged row is not written at all.
 * - `last_changed_at` is never written: a catalogue run is not a setting edit.
 * - A stored key the catalogue no longer lists is left in place; the index
 *   reads it as unsupported. Nothing is deleted.
 */
export async function convergeSettingRegistry(
  db: Db,
  catalogue: readonly SettingCatalogueEntry[] = SETTING_CATALOGUE,
  now: Date = new Date(),
): Promise<SettingRegistryConvergence> {
  const keys = catalogue.map((entry) => entry.key);
  if (new Set(keys).size !== keys.length) throw new Error('The settings catalogue repeats a key.');
  const result: SettingRegistryConvergence = { inserted: [], updated: [], unchanged: [] };
  if (!keys.length) return result;
  return db.transaction(async (tx) => {
    const existing = await tx.select().from(settingRegistry).where(inArray(settingRegistry.key, keys));
    for (const entry of catalogue) {
      const wanted = metadataOf(entry);
      const row = existing.find((stored) => stored.key === entry.key);
      if (!row) {
        const inserted = await tx.insert(settingRegistry)
          .values({ id: newId(), key: entry.key, ...wanted, createdAt: now, updatedAt: now })
          .onConflictDoNothing({ target: settingRegistry.key })
          .returning({ id: settingRegistry.id });
        // A concurrent run inserted it first: that identity stands, and the next run compares it.
        (inserted.length ? result.inserted : result.unchanged).push(entry.key);
        continue;
      }
      const changed = (Object.keys(wanted) as (keyof typeof wanted)[]).some((field) => row[field] !== wanted[field]);
      if (!changed) {
        result.unchanged.push(entry.key);
        continue;
      }
      await tx.update(settingRegistry).set({ ...wanted, updatedAt: now })
        .where(eq(settingRegistry.id, row.id));
      result.updated.push(entry.key);
    }
    return result;
  });
}
