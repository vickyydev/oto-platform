import { newId } from '@oto/shared';
import type { Db } from '../index';
import { appRegistry, type SuiteAppKey } from '../schema/suite-controls';

/**
 * The suite registry's six apps (SCRUM-643, S2-23 "platform:sync seeds
 * core.app_registry"). Insert-if-absent and nothing else: a replay never
 * touches a row that exists, so a maintenance window, a tile state or any
 * other saved choice survives every deploy's sync. Feature flags and kill
 * switches are not seeded at all — their typed catalogue is code
 * (`FLAG_CATALOGUE`), and a stored row only ever means somebody set one.
 *
 * Every app starts `open`, which is how the launcher draws it today; the
 * required permission is the same `app:<key>:access` the hand-off checks.
 */
export const SUITE_REGISTRY_SEED: ReadonlyArray<{
  key: SuiteAppKey; name: string; purpose: string; schemaName: string; owningService: string; versionSource: string; sortOrder: number;
}> = [
  { key: 'pos', name: 'POS', purpose: 'The till — admissions, membership, the customer display and check-in.',
    schemaName: 'pos', owningService: 'oto-api', versionSource: 'build_id', sortOrder: 10 },
  { key: 'console', name: 'Admin', purpose: 'Accounts and access, branches, the catalogue, activity and health.',
    schemaName: 'core', owningService: 'oto-api', versionSource: 'build_id', sortOrder: 20 },
  { key: 'oto_app', name: 'OTO App', purpose: 'Staff operations — shifts, tasks, events, camps and drop-off.',
    schemaName: 'otoapp', owningService: 'oto-app', versionSource: 'APP_VERSION', sortOrder: 30 },
  { key: 'radar', name: 'Radar', purpose: 'Revenue and attendance across the branches, past and present.',
    schemaName: 'analytics', owningService: 'oto-api', versionSource: 'APP_VERSION', sortOrder: 40 },
  { key: 'booth', name: 'Lucky Wheel', purpose: 'The prize wheel at the sales booth — spins, prizes and vouchers.',
    schemaName: 'booth', owningService: 'oto-api', versionSource: 'build_id', sortOrder: 50 },
  { key: 'inbox', name: 'Inbox', purpose: 'Every message from a family in one place, routed to the right team.',
    schemaName: 'inbox', owningService: 'oto-api', versionSource: 'build_id', sortOrder: 60 },
];

/** Answers how many registry rows this run created (0 on every replay). */
export async function syncSuiteRegistry(db: Db): Promise<number> {
  const created = await db.insert(appRegistry).values(SUITE_REGISTRY_SEED.map(app => ({
    id: newId(), ...app, originUrls: {}, healthUrl: null, requiredPermission: `app:${app.key}:access`, tileState: 'open' as const,
  }))).onConflictDoNothing({ target: appRegistry.key }).returning({ key: appRegistry.key });
  return created.length;
}
