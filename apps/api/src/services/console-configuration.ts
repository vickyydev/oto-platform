import { and, asc, eq } from 'drizzle-orm';
import {
  branch, setting, settingRegistry, SETTING_CATALOGUE, type Db, type SettingCatalogueKey,
} from '@oto/db';
import { PERMISSIONS, type Permission } from '@oto/shared';
import { errors } from '../lib/errors';
import { PermissionDeniedError } from '../plugins/session';
import { ASSISTANT_SETTINGS_KEY } from './assistant-settings';
import { holdsAnywhere } from './inbox/read-visibility';
import { hasPermission, type EffectivePermission } from './permissions';

/**
 * SCRUM-646 Configuration index: which settings exist, who owns each and
 * where the caller may open it. Metadata only — no setting value is read,
 * except one real change time for an explicitly known operator document.
 *
 * Every navigation target comes from this file, never from the stored row,
 * and every entry is filtered by the authority of the page it opens. This
 * read never seeds or writes the catalogue.
 */

const INDEX_READ: Permission = 'console:config:read';
type IndexApp = 'oto_app' | 'radar' | 'inbox';

/** How the owning page decides where a caller holds it. */
type Authority =
  /** Only an operator-scoped grant covers it (`operatorOnly` at the native door). */
  | 'operator'
  /** Held at any scope within the operator, as the owning app's own door accepts it. */
  | 'operator-anywhere'
  /** A branch-targeted native door: held per park. */
  | 'branch';

interface Door {
  authority: Authority;
  url: string | null;
  openInApp: { app: IndexApp; path: string } | null;
  /** Only an explicit known document has a real change time. */
  lastChanged: 'assistant-settings' | null;
}

/** Native doors for each code-owned catalogue key; the compiler keeps this in step with the catalogue. */
const DOORS = {
  assistant_settings: { authority: 'operator', url: '/channels/assistant-settings', openInApp: null, lastChanged: 'assistant-settings' },
  tenders: { authority: 'operator', url: '/catalogue/tenders', openInApp: null, lastChanged: null },
  branch_tax: { authority: 'branch', url: '/catalogue/tax', openInApp: null, lastChanged: null },
  branch_holidays: { authority: 'branch', url: '/organisation/holidays', openInApp: null, lastChanged: null },
  print_templates: { authority: 'branch', url: '/catalogue/print-templates', openInApp: null, lastChanged: null },
  event_pricing: { authority: 'branch', url: '/catalogue/event-pricing', openInApp: null, lastChanged: null },
  care_pricing: { authority: 'branch', url: '/catalogue/care', openInApp: null, lastChanged: null },
  inbox_templates: { authority: 'operator-anywhere', url: null, openInApp: { app: 'inbox', path: '/?settings=templates' }, lastChanged: null },
} as const satisfies Record<SettingCatalogueKey, Door>;

/** The code-owned catalogue metadata, keyed: one source shared with the convergence. */
const CATALOGUE = new Map<string, (typeof SETTING_CATALOGUE)[number]>(SETTING_CATALOGUE.map(entry => [entry.key, entry]));
const isPermission = (value: string): value is Permission => (PERMISSIONS as readonly string[]).includes(value);

export interface ConfigurationEntry {
  id: string;
  key: string;
  label: string;
  appOwner: string;
  editableHere: boolean;
  requiredPermission: string;
  url: string | null;
  openInApp: { app: IndexApp; path: string } | null;
  supported: boolean;
  scope: 'operator' | 'branch';
  branchIds: string[];
  lastChangedAt: string | null;
  lastChangedAvailability: 'available' | 'not-recorded' | 'unsupported';
}

export interface ConfigurationIndex {
  generatedAt: string;
  operatorId: string;
  branches: { id: string; name: string }[];
  selectedBranchId: string | null;
  entries: ConfigurationEntry[];
}

export async function consoleConfigurationOf(db: Db, input: {
  operatorId: string;
  effective: EffectivePermission[];
  branchId?: string;
  now?: Date;
}): Promise<ConfigurationIndex> {
  const { operatorId, effective } = input;
  const now = input.now ?? new Date();
  return db.transaction(async tx => {
    const own = await tx.select({ id: branch.id, name: branch.name, archivedAt: branch.archivedAt })
      .from(branch).where(eq(branch.operatorId, operatorId)).orderBy(asc(branch.name), asc(branch.id));
    const live = own.filter(park => park.archivedAt === null);
    const indexAt = (branchId: string) => hasPermission(effective, INDEX_READ, { operatorId, branchId });
    const reachable = live.filter(park => indexAt(park.id));

    let selected: (typeof own)[number] | null = null;
    if (input.branchId !== undefined) {
      // The chosen park is the one named, never the session seat; foreign, unknown and archived are all 404.
      selected = live.find(park => park.id === input.branchId) ?? null;
      if (!selected) throw errors.notFound('Branch not found');
      if (!indexAt(selected.id)) throw new PermissionDeniedError(INDEX_READ);
    } else if (!hasPermission(effective, INDEX_READ, { operatorId, operatorOnly: true }) && !reachable.length) {
      throw new PermissionDeniedError(INDEX_READ);
    }
    const parks = selected ? [selected] : reachable;

    const stored = await tx.select({
      id: settingRegistry.id, key: settingRegistry.key, label: settingRegistry.label,
      appOwner: settingRegistry.appOwner, requiredPermission: settingRegistry.requiredPermission,
    }).from(settingRegistry).orderBy(asc(settingRegistry.key), asc(settingRegistry.id));

    let assistantChangedAt: Date | null | undefined;
    const assistantChange = async () => {
      if (assistantChangedAt === undefined) {
        const [row] = await tx.select({ updatedAt: setting.updatedAt }).from(setting)
          .where(and(eq(setting.operatorId, operatorId), eq(setting.key, ASSISTANT_SETTINGS_KEY))).limit(1);
        assistantChangedAt = row?.updatedAt ?? null;
      }
      return assistantChangedAt;
    };

    const entries: ConfigurationEntry[] = [];
    for (const row of stored) {
      const known = CATALOGUE.get(row.key);
      if (!known) {
        // Unsupported: shown only to an operator-wide holder of a real permission it names; no door, no edit.
        if (!isPermission(row.requiredPermission)
          || !hasPermission(effective, row.requiredPermission, { operatorId, operatorOnly: true })) continue;
        entries.push({
          id: row.id, key: row.key, label: row.label, appOwner: row.appOwner,
          editableHere: false, requiredPermission: row.requiredPermission, url: null, openInApp: null,
          supported: false, scope: 'operator', branchIds: [], lastChangedAt: null, lastChangedAvailability: 'unsupported',
        });
        continue;
      }
      const door: Door = DOORS[known.key as SettingCatalogueKey];
      const permission: Permission = known.requiredPermission;
      let scope: ConfigurationEntry['scope'] = 'operator';
      let branchIds: string[] = [];
      if (door.authority === 'operator') {
        if (!hasPermission(effective, permission, { operatorId, operatorOnly: true })) continue;
      } else if (door.authority === 'operator-anywhere') {
        if (!holdsAnywhere(effective, permission, operatorId)) continue;
      } else {
        scope = 'branch';
        branchIds = parks.filter(park => hasPermission(effective, permission, { operatorId, branchId: park.id })).map(park => park.id);
        if (!branchIds.length) continue;
      }
      let lastChangedAt: string | null = null;
      let lastChangedAvailability: ConfigurationEntry['lastChangedAvailability'] = 'unsupported';
      if (door.lastChanged === 'assistant-settings') {
        const changed = await assistantChange();
        lastChangedAt = changed?.toISOString() ?? null;
        lastChangedAvailability = changed ? 'available' : 'not-recorded';
      }
      entries.push({
        id: row.id, key: known.key, label: known.label, appOwner: known.appOwner, editableHere: known.editableHere,
        requiredPermission: permission, url: door.url, openInApp: door.openInApp, supported: true,
        scope, branchIds, lastChangedAt, lastChangedAvailability,
      });
    }
    return {
      generatedAt: now.toISOString(), operatorId,
      branches: reachable.map(park => ({ id: park.id, name: park.name })),
      selectedBranchId: selected?.id ?? null,
      entries,
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}
