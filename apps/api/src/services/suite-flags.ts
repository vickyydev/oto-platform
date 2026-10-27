import { and, asc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import {
  account, appRegistry, branch, featureFlag, FLAG_CATALOGUE, flagCatalogueEntry, isFlagValue, MESSAGING_PAUSE_KEY, operator,
  session, signInBlockKey, station, suiteControlApproval,
  type Db, type FlagCatalogueEntry, type FlagScopeType, type FlagValue, type SuiteAppKey,
} from '@oto/db';
import { newId } from '@oto/shared';
import type { FastifyBaseLogger } from 'fastify';
import { AppError, errors } from '../lib/errors';
import { audit } from './audit';
import { deliverAlert, raiseAlert, resolveAlert, type AlertChannel } from './ops';
import { expireSuiteControlApproval } from './suite-control-approvals';
import { withTx, type Exec, type OpContext, type Tx } from './tx';

/**
 * Suite flags and kill switches (SCRUM-643; S2-23 release controls, planner
 * ruling Q24).
 *
 * ONE RESOLVER. A typed key resolves station > branch > operator > platform >
 * catalogue default, choosing only unexpired overrides on the exact live,
 * owned station→branch→operator lineage. The blast-radius preview and every
 * enforcing consumer call `resolveFlag` — the preview cannot promise what
 * enforcement will not do. Resolution never grants a permission: it only
 * answers what a switch says at a place.
 *
 * EXPIRY IS ENFORCED AT READ TIME. An override whose `expires_at` has passed
 * resolves to the next level (ultimately the catalogue default, which is the
 * safe fallback) the moment it passes. The expiry sweep below is bookkeeping:
 * it removes the spent row, writes the audit row and raises the alert, and it
 * never touches a row that was edited after it looked.
 */

export interface Lineage {
  operatorId: string | null;
  branchId: string | null;
  stationId: string | null;
}
type OverrideRow = typeof featureFlag.$inferSelect;

export interface ResolvedFlag {
  key: string;
  value: FlagValue;
  /** The override that decided it; null means the catalogue default. */
  source: { id: string; scopeType: FlagScopeType; scopeId: string | null; revision: number; expiresAt: string | null } | null;
}

const SCOPE_ORDER: readonly FlagScopeType[] = ['station', 'branch', 'operator', 'platform'];

function scopeIdAt(lineage: Lineage, scope: FlagScopeType): string | null | undefined {
  if (scope === 'platform') return null;
  const id = scope === 'station' ? lineage.stationId : scope === 'branch' ? lineage.branchId : lineage.operatorId;
  return id ?? undefined;
}

/** Pure: the same answer for the preview and for every consumer. */
export function resolveFlag(entry: FlagCatalogueEntry, rows: readonly OverrideRow[], lineage: Lineage, now: Date): ResolvedFlag {
  for (const scope of SCOPE_ORDER) {
    const id = scopeIdAt(lineage, scope);
    if (id === undefined || !entry.scopes.includes(scope)) continue;
    const hit = rows.find(row => row.key === entry.key && row.scopeType === scope && row.scopeId === id
      && row.kind === entry.kind && row.targetApp === entry.targetApp
      // An owned row only: a scoped override names its operator, and it must be this lineage's.
      && (scope === 'platform' ? row.operatorId === null : row.operatorId === lineage.operatorId)
      && (row.expiresAt === null || row.expiresAt.getTime() > now.getTime())
      && isFlagValue(entry, row.value));
    if (hit) {
      return { key: entry.key, value: hit.value as FlagValue, source: { id: hit.id, scopeType: scope, scopeId: hit.scopeId,
        revision: hit.revision, expiresAt: hit.expiresAt?.toISOString() ?? null } };
    }
  }
  return { key: entry.key, value: entry.defaultValue, source: null };
}

function known(key: string): FlagCatalogueEntry {
  const entry = flagCatalogueEntry(key);
  if (!entry) throw new AppError(400, 'FLAG_UNKNOWN', 'That switch is not in the catalogue.');
  return entry;
}

async function overridesFor(exec: Exec, keys: readonly string[], lineage: Lineage): Promise<OverrideRow[]> {
  const ids = [lineage.operatorId, lineage.branchId, lineage.stationId].filter((id): id is string => Boolean(id));
  return exec.select().from(featureFlag).where(and(inArray(featureFlag.key, [...keys]),
    ids.length > 0 ? or(eq(featureFlag.scopeType, 'platform'), inArray(featureFlag.scopeId, ids)) : eq(featureFlag.scopeType, 'platform')));
}

export async function effectiveFlag(exec: Exec, key: string, lineage: Lineage, now = new Date()): Promise<ResolvedFlag> {
  const entry = known(key);
  return resolveFlag(entry, await overridesFor(exec, [key], lineage), lineage, now);
}

// --- Lineage -----------------------------------------------------------------

function scopeRefused(): AppError {
  return new AppError(400, 'SCOPE_TARGET_INVALID', 'The scope must name a live park group, park or station, and its own park group.');
}

/**
 * The exact live lineage a write or preview target names. A foreign,
 * archived or mismatched id is refused; authority is never derived from it.
 */
export async function targetLineage(exec: Exec, scopeType: FlagScopeType, scopeId: string | null, lock = false): Promise<Lineage> {
  if (scopeType === 'platform') {
    if (scopeId !== null) throw scopeRefused();
    return { operatorId: null, branchId: null, stationId: null };
  }
  if (!scopeId) throw scopeRefused();
  if (scopeType === 'operator') {
    const q = exec.select({ id: operator.id }).from(operator).where(and(eq(operator.id, scopeId), isNull(operator.archivedAt)));
    const [row] = lock ? await q.for('share') : await q;
    if (!row) throw scopeRefused();
    return { operatorId: row.id, branchId: null, stationId: null };
  }
  if (scopeType === 'branch') {
    const q = exec.select({ id: branch.id, operatorId: branch.operatorId }).from(branch)
      .innerJoin(operator, eq(operator.id, branch.operatorId))
      .where(and(eq(branch.id, scopeId), isNull(branch.archivedAt), isNull(operator.archivedAt)));
    const [row] = lock ? await q.for('share') : await q;
    if (!row) throw scopeRefused();
    return { operatorId: row.operatorId, branchId: row.id, stationId: null };
  }
  const q = exec.select({ id: station.id, branchId: branch.id, operatorId: branch.operatorId }).from(station)
    .innerJoin(branch, and(eq(branch.id, station.branchId), eq(branch.operatorId, station.operatorId)))
    .innerJoin(operator, eq(operator.id, branch.operatorId))
    .where(and(eq(station.id, scopeId), isNull(station.archivedAt), isNull(branch.archivedAt), isNull(operator.archivedAt)));
  const [row] = lock ? await q.for('share') : await q;
  if (!row) throw scopeRefused();
  return { operatorId: row.operatorId, branchId: row.branchId, stationId: row.id };
}

/**
 * A consumer's lineage from what its caller already verified (a session's
 * working operator, seat and station; a message's operator and branch). A
 * level that is not live and owned by the level above is dropped rather
 * than trusted: an override is never reached through someone else's park.
 */
export async function consumerLineage(exec: Exec, scope: Lineage): Promise<Lineage> {
  if (!scope.operatorId) return { operatorId: null, branchId: null, stationId: null };
  let branchId: string | null = null, stationId: string | null = null;
  if (scope.branchId) {
    const [row] = await exec.select({ id: branch.id }).from(branch)
      .where(and(eq(branch.id, scope.branchId), eq(branch.operatorId, scope.operatorId), isNull(branch.archivedAt)));
    branchId = row?.id ?? null;
  }
  if (branchId && scope.stationId) {
    const [row] = await exec.select({ id: station.id }).from(station)
      .where(and(eq(station.id, scope.stationId), eq(station.branchId, branchId), eq(station.operatorId, scope.operatorId),
        isNull(station.archivedAt)));
    stationId = row?.id ?? null;
  }
  return { operatorId: scope.operatorId, branchId, stationId };
}

// --- Consumers (Q24: exactly these two switches, plus maintenance) -----------

/** `services/inbox/send.ts`: is outbound messaging paused where this message would leave from? */
export async function outboundMessagingPaused(exec: Exec, scope: { operatorId: string; branchId: string | null }, now = new Date()) {
  const lineage = await consumerLineage(exec, { operatorId: scope.operatorId, branchId: scope.branchId, stationId: null });
  return (await effectiveFlag(exec, MESSAGING_PAUSE_KEY, lineage, now)).value === true;
}

export type SignOnRefusal = { reason: 'maintenance'; message: string } | { reason: 'sign_in_blocked'; message: string };

/** The registry's effective maintenance for one app; an expired window is already over. */
export async function appMaintenance(exec: Exec, app: SuiteAppKey, now = new Date()): Promise<{ message: string; expiresAt: Date } | null> {
  const [row] = await exec.select({ tileState: appRegistry.tileState, message: appRegistry.maintenanceMessage,
    expiresAt: appRegistry.maintenanceExpiresAt }).from(appRegistry)
    .where(and(eq(appRegistry.key, app), isNull(appRegistry.archivedAt)));
  if (!row || row.tileState !== 'maintenance' || !row.expiresAt || !row.message || row.expiresAt.getTime() <= now.getTime()) return null;
  return { message: row.message, expiresAt: row.expiresAt };
}

/**
 * `services/handoff.ts` at mint and at exchange: whether a NEW hand-off into
 * this exact app is refused. Existing sessions, platform sign-in and every
 * other app are untouched by design (Q24).
 */
export async function appSignOnRefusal(exec: Exec, app: SuiteAppKey, scope: Lineage, now = new Date()): Promise<SignOnRefusal | null> {
  const maintenance = await appMaintenance(exec, app, now);
  if (maintenance) return { reason: 'maintenance', message: maintenance.message };
  const lineage = await consumerLineage(exec, scope);
  if ((await effectiveFlag(exec, signInBlockKey(app), lineage, now)).value === true) {
    return { reason: 'sign_in_blocked', message: 'New sign-ins to this app are paused for now. Sessions already open keep working.' };
  }
  return null;
}

// --- Writes ------------------------------------------------------------------

export interface FlagSetInput {
  key: string;
  scopeType: FlagScopeType;
  scopeId: string | null;
  operatorId: string | null;
  expectedRevision: number;
  value: FlagValue;
  expiresAt: string | null;
  reason: string;
}
export interface FlagSettings { maxTtlMinutes: number }
export const KILL_SWITCH_DEFAULT_TTL_MIN = 60;

/** Everything a set must satisfy, checked identically at request, approval apply and direct set. */
export async function validateFlagSet(exec: Exec, input: FlagSetInput, settings: FlagSettings, now: Date, lock = false) {
  const entry = known(input.key);
  if (!entry.supported) {
    throw new AppError(409, 'FLAG_UNSUPPORTED', 'This switch is not connected to anything yet, so it cannot be turned on.');
  }
  if (!entry.scopes.includes(input.scopeType)) throw new AppError(400, 'FLAG_SCOPE_NOT_ALLOWED', 'This switch cannot be set at that scope.');
  if (!isFlagValue(entry, input.value) || input.value === entry.defaultValue) {
    throw new AppError(400, 'FLAG_VALUE_INVALID', 'That value is not one this switch takes; clear the switch to return it to normal.');
  }
  const lineage = await targetLineage(exec, input.scopeType, input.scopeId, lock);
  if (lineage.operatorId !== input.operatorId) throw scopeRefused();
  const reason = input.reason.trim();
  if (reason.length === 0 || reason.length > 1000) throw errors.badRequest('A reason is required.');
  const expiresAt = input.expiresAt === null ? null : new Date(input.expiresAt);
  if (expiresAt && !Number.isFinite(expiresAt.getTime())) throw new AppError(400, 'FLAG_EXPIRY_INVALID', 'The expiry is not a time.');
  if (entry.kind === 'kill_switch' && (!expiresAt || expiresAt.getTime() - now.getTime() > settings.maxTtlMinutes * 60_000)) {
    throw new AppError(400, 'FLAG_EXPIRY_INVALID', `A kill switch must expire within ${settings.maxTtlMinutes} minutes.`);
  }
  if (expiresAt && expiresAt.getTime() <= now.getTime()) throw new AppError(400, 'FLAG_EXPIRY_INVALID', 'The expiry has already passed.');
  return { entry, lineage, expiresAt, reason };
}

function flagView(row: OverrideRow) {
  return {
    // `flagKey`, not `key`: a bare `*key` field reads as a credential to the replay store's backstop.
    id: row.id, flagKey: row.key, kind: row.kind, targetApp: row.targetApp, scopeType: row.scopeType, scopeId: row.scopeId,
    operatorId: row.operatorId, value: row.value as FlagValue, expiresAt: row.expiresAt?.toISOString() ?? null,
    reason: row.reason, updatedBy: row.updatedBy, revision: row.revision, updatedAt: row.updatedAt.toISOString(),
  };
}
export type FlagView = ReturnType<typeof flagView>;

async function lockedOverride(tx: Tx, key: string, scopeType: FlagScopeType, scopeId: string | null) {
  const [row] = await tx.select().from(featureFlag).where(and(eq(featureFlag.key, key), eq(featureFlag.scopeType, scopeType),
    scopeId === null ? isNull(featureFlag.scopeId) : eq(featureFlag.scopeId, scopeId))).for('update');
  return row ?? null;
}

function revisionConflict() {
  return new AppError(409, 'FLAG_REVISION_CONFLICT', 'This switch changed since it was read; reload and review it again.');
}

/** The one writer: catalogue, lineage, value, expiry and revision re-checked inside the caller's transaction. */
export async function applyFlagSet(tx: Tx, ctx: OpContext, input: FlagSetInput, settings: FlagSettings, now = new Date()): Promise<FlagView> {
  const { entry, lineage, expiresAt, reason } = await validateFlagSet(tx, input, settings, now, true);
  const existing = await lockedOverride(tx, entry.key, input.scopeType, input.scopeId);
  if ((existing?.revision ?? 0) !== input.expectedRevision) throw revisionConflict();
  const values = { value: input.value, expiresAt, reason, updatedBy: ctx.actorAccountId ?? null, updatedAt: now };
  const [row] = existing
    ? await tx.update(featureFlag).set({ ...values, revision: existing.revision + 1 })
      .where(and(eq(featureFlag.id, existing.id), eq(featureFlag.revision, existing.revision))).returning()
    : await tx.insert(featureFlag).values({ id: newId(), key: entry.key, kind: entry.kind, targetApp: entry.targetApp,
      scopeType: input.scopeType, scopeId: input.scopeId, operatorId: lineage.operatorId, defaultValue: entry.defaultValue,
      createdAt: now, ...values }).returning();
  if (!row) throw revisionConflict();
  await audit.record(tx, {
    actorAccountId: ctx.actorAccountId ?? null, operatorId: lineage.operatorId, branchId: lineage.branchId,
    action: 'feature_flag.set', entityType: 'feature_flag', entityId: row.id, requestId: ctx.requestId ?? null,
    before: existing ? flagView(existing) : null, after: flagView(row),
    targetApp: entry.targetApp, reason, origin: 'console',
  });
  return flagView(row);
}

export interface FlagClearInput {
  key: string; scopeType: FlagScopeType; scopeId: string | null; operatorId: string | null;
  expectedRevision: number; reason: string;
}

/** Returning a switch to normal; the catalogue default applies again at once. */
export async function applyFlagClear(tx: Tx, ctx: OpContext, input: FlagClearInput): Promise<{ flagKey: string; cleared: FlagView }> {
  const entry = known(input.key);
  const lineage = await targetLineage(tx, input.scopeType, input.scopeId, true);
  if (lineage.operatorId !== input.operatorId) throw scopeRefused();
  const reason = input.reason.trim();
  if (reason.length === 0) throw errors.badRequest('A reason is required.');
  const existing = await lockedOverride(tx, entry.key, input.scopeType, input.scopeId);
  if (!existing) throw new AppError(404, 'FLAG_NOT_SET', 'This switch is not set at that scope.');
  if (existing.revision !== input.expectedRevision) throw revisionConflict();
  await tx.delete(featureFlag).where(and(eq(featureFlag.id, existing.id), eq(featureFlag.revision, existing.revision)));
  await audit.record(tx, {
    actorAccountId: ctx.actorAccountId ?? null, operatorId: lineage.operatorId, branchId: lineage.branchId,
    action: 'feature_flag.clear', entityType: 'feature_flag', entityId: existing.id, requestId: ctx.requestId ?? null,
    before: flagView(existing), after: null, targetApp: entry.targetApp, reason, origin: 'console',
  });
  return { flagKey: entry.key, cleared: flagView(existing) };
}

// --- Reads -------------------------------------------------------------------

/** The catalogue with every stored override, expired ones marked as such (they already resolve to the default). */
export async function suiteFlagsOf(db: Db, settings: FlagSettings & { dualControl: boolean }, now = new Date()) {
  const rows = await db.select().from(featureFlag).orderBy(asc(featureFlag.key), asc(featureFlag.scopeType), asc(featureFlag.id));
  const approvals = await db.select().from(suiteControlApproval)
    .where(and(inArray(suiteControlApproval.state, ['pending', 'approved']), sql`${suiteControlApproval.requestExpiresAt} > ${now}`))
    .orderBy(asc(suiteControlApproval.createdAt), asc(suiteControlApproval.id));
  return {
    generatedAt: now.toISOString(),
    maxTtlMinutes: settings.maxTtlMinutes,
    defaultTtlMinutes: KILL_SWITCH_DEFAULT_TTL_MIN,
    killSwitchDualControl: settings.dualControl,
    catalogue: FLAG_CATALOGUE.map(entry => ({
      flagKey: entry.key, kind: entry.kind, targetApp: entry.targetApp, label: entry.label, effect: entry.effect,
      valueType: entry.valueType, values: entry.valueType === 'enum' ? [...(entry.values ?? [])] : null,
      defaultValue: entry.defaultValue, scopes: [...entry.scopes], supported: entry.supported,
    })),
    overrides: rows.map(row => ({ ...flagView(row), expired: row.expiresAt !== null && row.expiresAt.getTime() <= now.getTime() })),
    approvals: approvals.map(row => ({
      id: row.id, state: row.state, payloadSha256: row.payloadSha256, requesterAccountId: row.requesterAccountId,
      approverAccountId: row.approverAccountId, operation: row.operation as Record<string, unknown>,
      createdAt: row.createdAt.toISOString(), requestExpiresAt: row.requestExpiresAt.toISOString(),
    })),
  };
}

/**
 * Blast radius: what the change would do at every live park and station it
 * reaches, worked out by `resolveFlag` with the proposed override in place,
 * and how many staff sessions are open there now. Writes nothing.
 */
export async function previewFlag(db: Db, input: Omit<FlagSetInput, 'expectedRevision' | 'expiresAt' | 'reason'>, now = new Date()) {
  const entry = known(input.key);
  if (!entry.supported) throw new AppError(409, 'FLAG_UNSUPPORTED', 'This switch is not connected to anything yet, so it has no effect to preview.');
  if (!entry.scopes.includes(input.scopeType)) throw new AppError(400, 'FLAG_SCOPE_NOT_ALLOWED', 'This switch cannot be set at that scope.');
  if (!isFlagValue(entry, input.value)) throw new AppError(400, 'FLAG_VALUE_INVALID', 'That value is not one this switch takes.');
  return db.transaction(async tx => {
    const lineage = await targetLineage(tx, input.scopeType, input.scopeId);
    if (lineage.operatorId !== input.operatorId) throw scopeRefused();
    const branchWhere = [isNull(branch.archivedAt), isNull(operator.archivedAt),
      ...(lineage.operatorId ? [eq(branch.operatorId, lineage.operatorId)] : []),
      ...(lineage.branchId ? [eq(branch.id, lineage.branchId)] : [])];
    const branches = await tx.select({ id: branch.id, name: branch.name, operatorId: branch.operatorId }).from(branch)
      .innerJoin(operator, eq(operator.id, branch.operatorId)).where(and(...branchWhere)).orderBy(asc(branch.name), asc(branch.id));
    const branchIds = branches.map(b => b.id);
    const stations = branchIds.length === 0 ? [] : await tx.select({ id: station.id, name: station.name, branchId: station.branchId,
      operatorId: station.operatorId }).from(station)
      .where(and(inArray(station.branchId, branchIds), isNull(station.archivedAt),
        ...(lineage.stationId ? [eq(station.id, lineage.stationId)] : [])))
      .orderBy(asc(station.name), asc(station.id));
    const rows = await tx.select().from(featureFlag).where(eq(featureFlag.key, entry.key));
    const proposed: OverrideRow = {
      id: '00000000-0000-7000-8000-000000000000', key: entry.key, kind: entry.kind, targetApp: entry.targetApp,
      scopeType: input.scopeType, scopeId: input.scopeId, operatorId: lineage.operatorId, value: input.value,
      defaultValue: entry.defaultValue, expiresAt: null, reason: null, updatedBy: null, revision: 1, createdAt: now, updatedAt: now,
    };
    const withProposal = [...rows.filter(r => !(r.scopeType === input.scopeType && r.scopeId === input.scopeId)), proposed];
    const at = (l: Lineage) => ({ current: resolveFlag(entry, rows, l, now).value, after: resolveFlag(entry, withProposal, l, now).value });
    const branchRows = branches.map(b => ({ branchId: b.id, name: b.name, operatorId: b.operatorId,
      ...at({ operatorId: b.operatorId, branchId: b.id, stationId: null }) }));
    const stationRows = stations.map(s => ({ stationId: s.id, name: s.name, branchId: s.branchId,
      ...at({ operatorId: s.operatorId, branchId: s.branchId, stationId: s.id }) }));
    const live = [isNull(session.revokedAt), sql`${session.expiresAt} > ${now}`, eq(session.sessionClass, 'staff')];
    const scoped = lineage.stationId ? [eq(session.stationId, lineage.stationId)]
      : lineage.branchId ? [eq(session.branchId, lineage.branchId)]
        : lineage.operatorId ? [sql`coalesce(${session.operatorOverride}, ${account.operatorId}) = ${lineage.operatorId}`] : [];
    const [sessions] = await tx.select({ n: sql<number>`count(*)::integer`.mapWith(Number) }).from(session)
      .innerJoin(account, eq(account.id, session.accountId)).where(and(...live, ...scoped));
    return {
      generatedAt: now.toISOString(), flagKey: entry.key, label: entry.label, effect: entry.effect, targetApp: entry.targetApp,
      scopeType: input.scopeType, scopeId: input.scopeId, operatorId: lineage.operatorId, value: input.value,
      branches: branchRows, stations: stationRows, openSessions: sessions!.n,
      changes: branchRows.filter(r => r.current !== r.after).length + stationRows.filter(r => r.current !== r.after).length,
    };
  }, { isolationLevel: 'repeatable read', accessMode: 'read only' });
}

// --- Alerts --------------------------------------------------------------------

export function flagAlertKey(key: string, scopeType: FlagScopeType, scopeId: string | null) {
  return `suite_control:flag:${key}:${scopeType}:${scopeId ?? 'platform'}`;
}
export function maintenanceAlertKey(app: SuiteAppKey) { return `suite_control:maintenance:${app}`; }

export interface AlertDeps { channels: AlertChannel[]; flapWindowSeconds: number; log?: FastifyBaseLogger }

/** A switch that is on is an open condition: raised on every channel when it begins. */
export async function raiseSuiteControlAlert(db: Db, deps: AlertDeps, input: {
  key: string; subject: string; summary: string; operatorId: string | null; branchId: string | null;
}) {
  const raised = await raiseAlert(db, { key: input.key, category: 'suite_control.active', severity: 'warning',
    subject: input.subject, summary: input.summary, operatorId: input.operatorId, branchId: input.branchId },
  { flapWindowSeconds: deps.flapWindowSeconds });
  if (raised.outcome === 'opened') {
    await deliverAlert(db, deps.channels, { alertId: raised.id, key: input.key, category: 'suite_control.active',
      severity: 'warning', subject: input.subject, summary: input.summary, event: 'opened' }, deps.log);
  }
}

/** And it ends with a second alert, whether a person cleared it or it reverted at its expiry. */
export async function endSuiteControlAlert(db: Db, deps: AlertDeps, input: {
  key: string; subject: string; summary: string; reason: 'cleared' | 'auto_reverted'; operatorId: string | null; branchId: string | null;
}) {
  const resolved = await resolveAlert(db, input.key, input.reason);
  if (resolved) {
    await deliverAlert(db, deps.channels, { alertId: resolved.id, key: input.key, category: 'suite_control.ended',
      severity: 'info', subject: input.subject, summary: input.summary, event: 'resolved' }, deps.log);
    return;
  }
  // No open condition to close (raised before alerts existed, or acknowledged away): still say it ended.
  const raised = await raiseAlert(db, { key: `${input.key}:ended:${Date.now()}`, category: 'suite_control.ended', severity: 'info',
    subject: input.subject, summary: input.summary, operatorId: input.operatorId, branchId: input.branchId },
  { flapWindowSeconds: deps.flapWindowSeconds });
  await deliverAlert(db, deps.channels, { alertId: raised.id, key: `${input.key}:ended`, category: 'suite_control.ended',
    severity: 'info', subject: input.subject, summary: input.summary, event: 'opened' }, deps.log);
}

// --- The expiry sweep (bookkeeping, not enforcement) ---------------------------

export const SUITE_CONTROL_EXPIRY_JOB = 'job:suite_control.expiry';

export interface SuiteExpirySweep extends Record<string, unknown> {
  flagsReverted: number;
  flagsSkipped: number;
  maintenanceEnded: number;
  maintenanceSkipped: number;
  approvalsExpired: number;
}

/** Remove one spent override, only if it is still exactly the row that was read. Null: a later edit won. */
export async function revertSpentFlag(db: Db, seen: OverrideRow, now: Date) {
  return withTx(db, { operatorId: seen.operatorId, actorAccountId: null }, 'feature_flag.auto_revert', async tx => {
    const [gone] = await tx.delete(featureFlag).where(and(eq(featureFlag.id, seen.id), eq(featureFlag.revision, seen.revision),
      lte(featureFlag.expiresAt, now))).returning();
    if (!gone) return null;
    await audit.record(tx, {
      actorAccountId: null, operatorId: gone.operatorId, branchId: gone.scopeType === 'branch' ? gone.scopeId : null,
      action: 'feature_flag.auto_revert', entityType: 'feature_flag', entityId: gone.id, before: flagView(gone), after: null,
      targetApp: gone.targetApp, reason: 'expired', origin: 'job',
    });
    return gone;
  });
}

/** Restore one spent maintenance window, only if the registry row is still the one that was read. */
export async function endSpentMaintenance(db: Db, seen: typeof appRegistry.$inferSelect, now: Date) {
  return withTx(db, { actorAccountId: null }, 'app_registry.maintenance_expire', async tx => {
    const [row] = await tx.update(appRegistry).set({ tileState: seen.maintenanceRestoreState!, maintenanceMessage: null,
      maintenanceExpiresAt: null, maintenanceRestoreState: null, revision: seen.revision + 1, updatedAt: now })
      .where(and(eq(appRegistry.id, seen.id), eq(appRegistry.revision, seen.revision), eq(appRegistry.tileState, 'maintenance'),
        lte(appRegistry.maintenanceExpiresAt, now))).returning();
    if (!row) return null;
    await audit.record(tx, {
      actorAccountId: null, operatorId: null, action: 'app_registry.maintenance_expire', entityType: 'app_registry',
      entityId: row.id, before: { tileState: seen.tileState, maintenanceMessage: seen.maintenanceMessage,
        maintenanceExpiresAt: seen.maintenanceExpiresAt?.toISOString() ?? null, revision: seen.revision },
      after: { tileState: row.tileState, revision: row.revision }, targetApp: row.key, reason: 'expired', origin: 'job',
    });
    return row;
  });
}

/**
 * Each spent row is removed (a flag) or restored (maintenance) only if it is
 * still exactly the row the sweep read — same revision, still expired — so a
 * person's later edit always survives a late sweep. Reads already resolved
 * these to their fallback; this records that it happened and alerts.
 */
export async function runSuiteExpirySweep(db: Db, deps: AlertDeps, now = new Date()): Promise<SuiteExpirySweep> {
  const summary: SuiteExpirySweep = { flagsReverted: 0, flagsSkipped: 0, maintenanceEnded: 0, maintenanceSkipped: 0, approvalsExpired: 0 };
  const expiredFlags = await db.select().from(featureFlag).where(lte(featureFlag.expiresAt, now))
    .orderBy(asc(featureFlag.expiresAt), asc(featureFlag.id));
  for (const seen of expiredFlags) {
    const entry = flagCatalogueEntry(seen.key);
    const reverted = await revertSpentFlag(db, seen, now);
    if (!reverted) { summary.flagsSkipped += 1; continue; }
    summary.flagsReverted += 1;
    const label = entry?.label ?? seen.key;
    await endSuiteControlAlert(db, deps, { key: flagAlertKey(seen.key, seen.scopeType, seen.scopeId), subject: label,
      summary: `${label} reverted at its expiry (${seen.scopeType}${seen.scopeId ? ` ${seen.scopeId}` : ''})`,
      reason: 'auto_reverted', operatorId: seen.operatorId, branchId: seen.scopeType === 'branch' ? seen.scopeId : null });
  }

  const expiredMaintenance = await db.select().from(appRegistry).where(and(eq(appRegistry.tileState, 'maintenance'),
    lte(appRegistry.maintenanceExpiresAt, now))).orderBy(asc(appRegistry.key));
  for (const seen of expiredMaintenance) {
    const ended = await endSpentMaintenance(db, seen, now);
    if (!ended) { summary.maintenanceSkipped += 1; continue; }
    summary.maintenanceEnded += 1;
    await endSuiteControlAlert(db, deps, { key: maintenanceAlertKey(seen.key), subject: `${seen.name} maintenance`,
      summary: `${seen.name} maintenance ended at its expiry`, reason: 'auto_reverted', operatorId: null, branchId: null });
  }

  const staleApprovals = await db.select({ id: suiteControlApproval.id }).from(suiteControlApproval)
    .where(and(inArray(suiteControlApproval.state, ['pending', 'approved']), lte(suiteControlApproval.requestExpiresAt, now)));
  for (const { id } of staleApprovals) {
    const out = await expireSuiteControlApproval(db, { actorAccountId: null }, { id });
    if (out.state === 'expired') summary.approvalsExpired += 1;
  }
  return summary;
}
