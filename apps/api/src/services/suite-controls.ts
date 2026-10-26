import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import { appRegistry, box, branch, deployEvent, type Db, type SuiteAppKey } from '@oto/db';
import { boxSettings } from './box';
import { versionBelow } from './ops';

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
