import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { appRegistry, box, branch, deployEvent, type Db, type SuiteAppKey } from '@oto/db';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { boxSettings } from './box';
import { versionBelow } from './ops';
import { KILL_SWITCH_DEFAULT_TTL_MIN } from './suite-flags';
import type { OpContext, Tx } from './tx';

/** Registry URLs are public locations, never credentials or signed links. */
function publicUrl(value: unknown, originOnly = false): string | null {
  if (typeof value !== 'string') return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) return null;
    if (originOnly && url.pathname !== '/') return null;
    return originOnly ? url.origin : url.href;
  } catch { return null; }
}

export async function suiteAppsOf(db: Db, now = new Date()) {
  const rows = await db.select().from(appRegistry).where(isNull(appRegistry.archivedAt))
    .orderBy(asc(appRegistry.sortOrder), asc(appRegistry.key));
  return {
    generatedAt: now.toISOString(),
    apps: rows.map(row => {
      const inMaintenance = row.tileState === 'maintenance' && row.maintenanceExpiresAt !== null
        && row.maintenanceExpiresAt.getTime() > now.getTime();
      const effectiveState = inMaintenance ? 'maintenance' as const
        : row.tileState === 'maintenance' ? row.maintenanceRestoreState! : row.tileState;
      const origins: Record<string, string> = {};
      for (const [environment, value] of Object.entries(row.originUrls)) {
        const origin = publicUrl(value, true);
        if (origin) origins[environment] = origin;
      }
      return {
        id: row.id, key: row.key, name: row.name, purpose: row.purpose, origins,
        schemaName: row.schemaName, owningService: row.owningService, healthUrl: publicUrl(row.healthUrl),
        versionSource: row.versionSource, requiredPermission: row.requiredPermission, sortOrder: row.sortOrder,
        storedState: row.tileState, effectiveState, revision: row.revision,
        maintenance: inMaintenance ? { message: row.maintenanceMessage!, expiresAt: row.maintenanceExpiresAt!.toISOString() } : null,
      };
    }),
  };
}

/** Missing deployment facts stay null; no build or API version implies a release. */
export async function suiteReleasesOf(db: Db, input: { app?: SuiteAppKey; limit: number; offset: number }, now = new Date()) {
  return db.transaction(async tx => {
    const where = and(isNull(appRegistry.archivedAt), ...(input.app ? [eq(deployEvent.app, input.app)] : []));
    const [count] = await tx.select({ total: sql<number>`count(*)::integer`.mapWith(Number) }).from(deployEvent)
      .innerJoin(appRegistry, eq(deployEvent.app, appRegistry.key)).where(where);
    const rows = await tx.select({ event: deployEvent, appName: appRegistry.name }).from(deployEvent)
      .innerJoin(appRegistry, eq(deployEvent.app, appRegistry.key)).where(where)
      .orderBy(desc(deployEvent.createdAt), desc(deployEvent.id)).limit(input.limit).offset(input.offset);
    return {
      generatedAt: now.toISOString(), total: count!.total, limit: input.limit, offset: input.offset,
      deployments: rows.map(({ event: row, appName }) => ({
        id: row.id, app: row.app, appName, version: row.version, commit: row.commit,
        actorAccountId: row.actorAccountId, status: row.status, ciGreen: row.ciGreen,
        deployedAt: row.deployedAt?.toISOString() ?? null, recordedAt: row.createdAt.toISOString(),
      })),
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

/** Use the fleet's existing minimum and comparison; a missing version stays unknown. */
export async function suiteAgentVersionsOf(db: Db, operatorId: string, input: { limit: number; offset: number }, now = new Date()) {
  const minimumSupportedVersion = boxSettings().minAgentVersion;
  return db.transaction(async tx => {
    const where = and(eq(box.operatorId, operatorId), eq(branch.operatorId, operatorId),
      isNull(box.archivedAt), isNull(branch.archivedAt));
    const [count] = await tx.select({ total: sql<number>`count(*)::integer`.mapWith(Number) }).from(box)
      .innerJoin(branch, eq(box.branchId, branch.id)).where(where);
    const rows = await tx.select({ id: box.id, name: box.name, slot: box.slot, branchId: branch.id,
      branchName: branch.name, agentVersion: box.agentVersion, lastStatus: box.lastStatus,
      lastHeartbeatAt: box.lastHeartbeatAt }).from(box).innerJoin(branch, eq(box.branchId, branch.id)).where(where)
      .orderBy(asc(branch.name), asc(box.name), asc(box.id)).limit(input.limit).offset(input.offset);
    return {
      generatedAt: now.toISOString(), operatorId, minimumSupportedVersion,
      total: count!.total, limit: input.limit, offset: input.offset,
      agents: rows.map(({ lastStatus, ...row }) => {
        const heartbeat = lastStatus && typeof lastStatus === 'object' && !Array.isArray(lastStatus)
          ? lastStatus as Record<string, unknown> : null;
        const agentVersion = row.agentVersion ?? (typeof heartbeat?.agentVersion === 'string' && heartbeat.agentVersion.length > 0
          ? heartbeat.agentVersion : null);
        return { ...row, agentVersion, lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
          belowMinimum: agentVersion === null ? null : versionBelow(agentVersion, minimumSupportedVersion) };
      }),
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

// --- SCRUM-643 writes: maintenance, the launcher's own read, deploy history ---

export interface MaintenanceSetInput {
  app: SuiteAppKey;
  message: string;
  expiresAt: string | null;
  reason: string;
  expectedRevision: number;
}

function registryRevisionConflict() {
  return new AppError(409, 'APP_REGISTRY_REVISION_CONFLICT', 'This app changed since it was read; reload and review it again.');
}
function registryView(row: typeof appRegistry.$inferSelect) {
  // `appKey`, not `key`: a bare `*key` field reads as a credential to the replay store's backstop.
  return { appKey: row.key, tileState: row.tileState, maintenanceMessage: row.maintenanceMessage,
    maintenanceExpiresAt: row.maintenanceExpiresAt?.toISOString() ?? null, maintenanceRestoreState: row.maintenanceRestoreState,
    revision: row.revision };
}
export type RegistryView = ReturnType<typeof registryView>;

/** The registry's display name, for an alert line after the change committed. */
export async function registryNameOf(db: Db, app: SuiteAppKey): Promise<string> {
  const [row] = await db.select({ name: appRegistry.name }).from(appRegistry).where(eq(appRegistry.key, app));
  return row?.name ?? app;
}

async function lockedRegistry(tx: Tx, app: SuiteAppKey) {
  const [row] = await tx.select().from(appRegistry).where(and(eq(appRegistry.key, app), isNull(appRegistry.archivedAt))).for('update');
  if (!row) throw errors.notFound('That app is not in the suite registry.');
  return row;
}

/**
 * Maintenance is the registry's own tile state (Q24): the tile shows the
 * message and new hand-offs into this one app are refused until it ends.
 * Always bounded by `KILL_SWITCH_MAX_TTL_MIN`; the state it replaces is kept
 * so the window ends by restoring it, whether cleared or expired.
 */
export async function applyMaintenanceSet(tx: Tx, ctx: OpContext, input: MaintenanceSetInput,
  settings: { maxTtlMinutes: number }, now = new Date()) {
  const row = await lockedRegistry(tx, input.app);
  if (row.revision !== input.expectedRevision) throw registryRevisionConflict();
  const message = input.message.trim(), reason = input.reason.trim();
  if (message.length === 0 || message.length > 500) throw errors.badRequest('A maintenance message of at most 500 characters is required.');
  if (reason.length === 0) throw errors.badRequest('A reason is required.');
  const expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(now.getTime() + KILL_SWITCH_DEFAULT_TTL_MIN * 60_000);
  if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= now.getTime()
    || expiresAt.getTime() - now.getTime() > settings.maxTtlMinutes * 60_000) {
    throw new AppError(400, 'MAINTENANCE_EXPIRY_INVALID', `Maintenance must end within ${settings.maxTtlMinutes} minutes.`);
  }
  // Re-setting an open window keeps what it will restore; a lapsed one restores its own saved state.
  const restore = row.tileState === 'maintenance' ? row.maintenanceRestoreState! : row.tileState;
  const [updated] = await tx.update(appRegistry).set({ tileState: 'maintenance', maintenanceMessage: message,
    maintenanceExpiresAt: expiresAt, maintenanceRestoreState: restore, revision: row.revision + 1, updatedAt: now })
    .where(and(eq(appRegistry.id, row.id), eq(appRegistry.revision, row.revision))).returning();
  if (!updated) throw registryRevisionConflict();
  await audit.record(tx, {
    actorAccountId: ctx.actorAccountId ?? null, operatorId: null, action: 'app_registry.maintenance_set',
    entityType: 'app_registry', entityId: row.id, requestId: ctx.requestId ?? null,
    before: registryView(row), after: registryView(updated), targetApp: row.key, reason, origin: 'console',
  });
  return { app: registryView(updated) };
}

export async function applyMaintenanceClear(tx: Tx, ctx: OpContext, input: { app: SuiteAppKey; reason: string; expectedRevision: number },
  now = new Date()) {
  const row = await lockedRegistry(tx, input.app);
  if (row.revision !== input.expectedRevision) throw registryRevisionConflict();
  if (row.tileState !== 'maintenance') throw new AppError(409, 'APP_NOT_IN_MAINTENANCE', 'This app is not in maintenance.');
  const reason = input.reason.trim();
  if (reason.length === 0) throw errors.badRequest('A reason is required.');
  const [updated] = await tx.update(appRegistry).set({ tileState: row.maintenanceRestoreState!, maintenanceMessage: null,
    maintenanceExpiresAt: null, maintenanceRestoreState: null, revision: row.revision + 1, updatedAt: now })
    .where(and(eq(appRegistry.id, row.id), eq(appRegistry.revision, row.revision))).returning();
  if (!updated) throw registryRevisionConflict();
  await audit.record(tx, {
    actorAccountId: ctx.actorAccountId ?? null, operatorId: null, action: 'app_registry.maintenance_clear',
    entityType: 'app_registry', entityId: row.id, requestId: ctx.requestId ?? null,
    before: registryView(row), after: registryView(updated), targetApp: row.key, reason, origin: 'console',
  });
  return { app: registryView(updated) };
}

/**
 * The launcher's read (Q24): the effective registry state of the apps this
 * person already holds `app:<key>:access` for — the same grant the hand-off
 * mint checks. No Console permission is needed to see one's own tiles, and no
 * origin, schema or owning service leaves through here.
 */
export async function launcherAppsOf(db: Db, held: ReadonlySet<string>, now = new Date()) {
  const directory = await suiteAppsOf(db, now);
  return {
    generatedAt: directory.generatedAt,
    apps: directory.apps.filter(app => held.has(`app:${app.key}:access`)).map(app => ({
      key: app.key, sortOrder: app.sortOrder, state: app.effectiveState, maintenance: app.maintenance,
    })),
  };
}

export interface DeployEventInput {
  id: string;
  app: SuiteAppKey;
  status: string;
  version: string | null;
  commit: string | null;
  ciGreen: boolean | null;
  deployedAt: string | null;
}

/**
 * The deploy history seam: records exactly the facts supplied by whoever
 * deployed, under the caller-minted id (a repeat is the same event). It starts
 * nothing, and an absent fact stays unknown — no "deployed" is ever inferred.
 */
export async function recordDeployEvent(tx: Tx, ctx: OpContext, input: DeployEventInput) {
  const [app] = await tx.select({ key: appRegistry.key }).from(appRegistry)
    .where(and(eq(appRegistry.key, input.app), isNull(appRegistry.archivedAt))).for('share');
  if (!app) throw errors.notFound('That app is not in the suite registry.');
  const [existing] = await tx.select().from(deployEvent).where(eq(deployEvent.id, input.id)).for('update');
  const values = { app: input.app, status: input.status, version: input.version, commit: input.commit,
    ciGreen: input.ciGreen, deployedAt: input.deployedAt ? new Date(input.deployedAt) : null };
  if (existing) {
    const same = existing.app === values.app && existing.status === values.status && existing.version === values.version
      && existing.commit === values.commit && existing.ciGreen === values.ciGreen
      && (existing.deployedAt?.getTime() ?? null) === (values.deployedAt?.getTime() ?? null);
    if (!same) throw new AppError(409, 'DEPLOY_EVENT_CONFLICT', 'A different deploy event already has this id.');
    return { id: existing.id, replay: true as const };
  }
  const [row] = await tx.insert(deployEvent).values({ id: input.id, actorAccountId: ctx.actorAccountId ?? null, ...values }).returning();
  await audit.record(tx, {
    actorAccountId: ctx.actorAccountId ?? null, operatorId: null, action: 'deploy_event.record', entityType: 'deploy_event',
    entityId: row!.id, requestId: ctx.requestId ?? null, after: { ...values, deployedAt: input.deployedAt },
    targetApp: input.app, origin: 'console',
  });
  return { id: row!.id, replay: false as const };
}
