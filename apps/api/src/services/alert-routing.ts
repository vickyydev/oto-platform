import { and, asc, desc, eq, gt, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyBaseLogger } from 'fastify';
import {
  ALERT_MUTE_DEFAULT_MINUTES,
  ALERT_MUTE_MAX_MINUTES,
  account,
  alert,
  alertDelivery,
  alertMute,
  alertRecipient,
  employee,
  opsRun,
  type AlertRecipientChannel,
  type Db,
} from '@oto/db';
import { newId } from '@oto/shared';
import { errors } from '../lib/errors';
import { deliverAlert, type AlertChannel, type AlertMessage } from './ops';
import type { Exec } from './tx';

/**
 * SCRUM-644, planner ruling Q25 — alert recipients and fingerprint mutes, and
 * what the watchdog does with them before it tells anybody.
 *
 * Kept out of `services/ops.ts` and `services/jobs.ts` on purpose: both files
 * are worked on by other lanes, and the only thing they need from here is one
 * function, `deliverRoutedAlert`, which the watchdog calls where it used to
 * call `deliverAlert`. Everything else — raising, deduping, flap suppression,
 * resolution — is unchanged.
 *
 * The rules, as ruled:
 *  - a mute is per FINGERPRINT, needs a reason, lasts one hour unless told
 *    otherwise and never more than 24 (a longer silence is re-decided daily);
 *  - a muted alert is still raised and still listed; its delivery is RECORDED
 *    as `muted` against the mute that held it back — never dropped;
 *  - a recipient maps a category to a channel and an address REFERENCE (an
 *    environment variable name, never its value). Only the console channel is
 *    delivered on this build; an email or webhook row is recorded as
 *    `unsupported` until a provider integration is its own ticket;
 *  - named-job `ops_expectation.muted_until` is a different thing and is not
 *    read or written here.
 */

export { ALERT_MUTE_DEFAULT_MINUTES, ALERT_MUTE_MAX_MINUTES };

/** The one sentence the API and the screen both say about delivery. */
export const ALERT_DELIVERY_NOTE =
  'Alerts are delivered to the console only. Email and webhook rows are kept, and recorded as not delivered, until a provider integration is built as its own ticket.';

/** Channels this build actually delivers to. */
export const DELIVERED_CHANNELS: readonly AlertRecipientChannel[] = ['console'];

/**
 * The fingerprints an alert answers to, most specific first: the `ops_run`
 * fingerprint a failing job's alert carries in its detail (the same one the
 * Failures page groups by), then the alert's own key.
 */
export function alertFingerprints(key: string, detail: unknown): string[] {
  const fingerprint = detail && typeof detail === 'object' ? (detail as Record<string, unknown>).fingerprint : undefined;
  return typeof fingerprint === 'string' && fingerprint.length > 0 && fingerprint !== key ? [fingerprint, key] : [key];
}

/** `operator_id = $1`, or `is null` for the platform's own records. */
function sameOwner(column: typeof alertMute.operatorId, operatorId: string | null): SQL {
  return operatorId === null ? isNull(column) : eq(column, operatorId);
}

// --- Mutes ------------------------------------------------------------------

export interface MuteView {
  id: string;
  fingerprint: string;
  scope: 'operator' | 'platform';
  reason: string;
  startsAt: string;
  mutedUntil: string;
  createdByAccountId: string;
  createdByName: string | null;
  /** Deliveries this mute has held back so far — each one recorded, none dropped. */
  heldBack: number;
}

/**
 * Where a fingerprint lives, for a caller of one operator: in their own
 * records (`operator`), only in the platform's own (`platform`), or nowhere
 * they can see (`null`). A failed run and an alert both count; another
 * operator's records never do.
 */
export async function fingerprintOwner(
  db: Exec,
  fingerprint: string,
  operatorId: string,
): Promise<'operator' | 'platform' | null> {
  const owners = async (column: 'run' | 'alert') => {
    const rows = column === 'run'
      ? await db.select({ operatorId: opsRun.operatorId }).from(opsRun)
        .where(and(eq(opsRun.fingerprint, fingerprint), or(isNull(opsRun.operatorId), eq(opsRun.operatorId, operatorId))))
        .limit(50)
      : await db.select({ operatorId: alert.operatorId }).from(alert)
        .where(and(eq(alert.key, fingerprint), or(isNull(alert.operatorId), eq(alert.operatorId, operatorId))))
        .limit(50);
    return rows.map((r) => r.operatorId);
  };
  const found = [...(await owners('run')), ...(await owners('alert'))];
  if (found.some((o) => o === operatorId)) return 'operator';
  if (found.some((o) => o === null)) return 'platform';
  return null;
}

export interface MuteInput {
  fingerprint: string;
  /** Null for a platform condition's mute. */
  operatorId: string | null;
  reason: string;
  minutes: number;
  actorAccountId: string;
  now?: Date;
}

/**
 * Mute one fingerprint. An active mute on the same fingerprint and owner is
 * lifted by this decision rather than left beside it, so "is this muted, and
 * why" always has one answer. Bounds are checked here as well as by the
 * route's schema and the table's CHECK.
 */
export async function muteFingerprint(tx: Exec, input: MuteInput) {
  const reason = input.reason.trim();
  if (!reason) throw errors.badRequest('A mute needs a reason');
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > ALERT_MUTE_MAX_MINUTES) {
    throw errors.badRequest(`A mute lasts at most 24 hours (${ALERT_MUTE_MAX_MINUTES} minutes); a longer silence is decided again each day`);
  }
  const now = input.now ?? new Date();
  const superseded = await tx
    .update(alertMute)
    .set({ liftedAt: now, liftedByAccountId: input.actorAccountId, updatedAt: now })
    .where(and(
      eq(alertMute.fingerprint, input.fingerprint),
      sameOwner(alertMute.operatorId, input.operatorId),
      isNull(alertMute.liftedAt),
      gt(alertMute.mutedUntil, now),
    ))
    .returning({ id: alertMute.id });
  const id = newId();
  const [row] = await tx
    .insert(alertMute)
    .values({
      id,
      fingerprint: input.fingerprint,
      operatorId: input.operatorId,
      reason,
      startsAt: now,
      mutedUntil: new Date(now.getTime() + input.minutes * 60_000),
      createdByAccountId: input.actorAccountId,
    })
    .returning();
  return { row: row!, superseded: superseded.map((s) => s.id) };
}

/** End a mute early. Null when it is not active, or not this caller's to end. */
export async function liftMute(
  tx: Exec,
  q: { id: string; operatorId: string; platformWide: boolean; actorAccountId: string; now?: Date },
) {
  const now = q.now ?? new Date();
  const [row] = await tx
    .update(alertMute)
    .set({ liftedAt: now, liftedByAccountId: q.actorAccountId, updatedAt: now })
    .where(and(
      eq(alertMute.id, q.id),
      q.platformWide ? or(isNull(alertMute.operatorId), eq(alertMute.operatorId, q.operatorId)) : eq(alertMute.operatorId, q.operatorId),
      isNull(alertMute.liftedAt),
      gt(alertMute.mutedUntil, now),
    ))
    .returning();
  return row ?? null;
}

/**
 * The mutes in force, for the Failures page: this operator's, and — for a
 * caller who reads the whole estate — the platform's own, which is the same
 * line the failure list itself draws (`failureGroups`).
 */
export async function activeMutes(
  db: Exec,
  q: { operatorId: string; includePlatform: boolean; fingerprint?: string; now?: Date },
): Promise<MuteView[]> {
  const now = q.now ?? new Date();
  const owner = q.includePlatform
    ? or(isNull(alertMute.operatorId), eq(alertMute.operatorId, q.operatorId))!
    : eq(alertMute.operatorId, q.operatorId);
  const rows = await db
    .select({
      id: alertMute.id,
      fingerprint: alertMute.fingerprint,
      operatorId: alertMute.operatorId,
      reason: alertMute.reason,
      startsAt: alertMute.startsAt,
      mutedUntil: alertMute.mutedUntil,
      createdByAccountId: alertMute.createdByAccountId,
      createdByName: employee.name,
      heldBack: sql<number>`(select count(*)::int from ${alertDelivery} where ${alertDelivery.muteId} = ${alertMute.id})`,
    })
    .from(alertMute)
    .leftJoin(account, eq(account.id, alertMute.createdByAccountId))
    .leftJoin(employee, eq(employee.id, account.employeeId))
    .where(and(
      owner,
      isNull(alertMute.liftedAt),
      gt(alertMute.mutedUntil, now),
      q.fingerprint ? eq(alertMute.fingerprint, q.fingerprint) : undefined,
    ))
    .orderBy(desc(alertMute.mutedUntil), asc(alertMute.id))
    .limit(200);
  return rows.map(muteView);
}

export function muteView(r: {
  id: string; fingerprint: string; operatorId: string | null; reason: string; startsAt: Date; mutedUntil: Date;
  createdByAccountId: string; createdByName?: string | null; heldBack?: number;
}): MuteView {
  return {
    id: r.id,
    fingerprint: r.fingerprint,
    scope: r.operatorId === null ? 'platform' : 'operator',
    reason: r.reason,
    startsAt: r.startsAt.toISOString(),
    mutedUntil: r.mutedUntil.toISOString(),
    createdByAccountId: r.createdByAccountId,
    createdByName: r.createdByName ?? null,
    heldBack: Number(r.heldBack ?? 0),
  };
}

/** The mute in force for an alert, if any: same owner, one of its fingerprints, not expired, not lifted. */
export async function muteFor(
  db: Exec,
  q: { fingerprints: string[]; operatorId: string | null; now?: Date },
): Promise<{ id: string } | null> {
  if (q.fingerprints.length === 0) return null;
  const now = q.now ?? new Date();
  const [row] = await db
    .select({ id: alertMute.id })
    .from(alertMute)
    .where(and(
      inArray(alertMute.fingerprint, q.fingerprints),
      sameOwner(alertMute.operatorId, q.operatorId),
      isNull(alertMute.liftedAt),
      gt(alertMute.mutedUntil, now),
    ))
    .orderBy(desc(alertMute.mutedUntil))
    .limit(1);
  return row ?? null;
}

// --- Recipients ---------------------------------------------------------------

/** Whether an environment variable is set. Presence only — its value never leaves this function. */
export function isEnvNameSet(name: string): boolean {
  const value = process.env[name];
  return typeof value === 'string' && value.trim().length > 0;
}

export interface RecipientView {
  id: string;
  scope: 'operator' | 'platform';
  branchId: string | null;
  category: string;
  channel: AlertRecipientChannel;
  /** The environment variable NAME. Never the address it holds. */
  addressRef: string | null;
  /** Whether that name is set on this deployment; null for the console, which needs none. */
  addressConfigured: boolean | null;
  /** Whether this build delivers to the row's channel at all. */
  delivered: boolean;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}

export function recipientView(r: typeof alertRecipient.$inferSelect): RecipientView {
  return {
    id: r.id,
    scope: r.operatorId === null ? 'platform' : 'operator',
    branchId: r.branchId,
    category: r.category,
    channel: r.channel,
    addressRef: r.addressRef,
    addressConfigured: r.addressRef === null ? null : isEnvNameSet(r.addressRef),
    delivered: DELIVERED_CHANNELS.includes(r.channel),
    label: r.label,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** The live recipient rows a caller manages: their operator's, and the platform's for a platform-wide caller. */
export async function listRecipients(db: Exec, q: { operatorId: string; includePlatform: boolean }) {
  return db
    .select()
    .from(alertRecipient)
    .where(and(
      isNull(alertRecipient.archivedAt),
      q.includePlatform
        ? or(isNull(alertRecipient.operatorId), eq(alertRecipient.operatorId, q.operatorId))
        : eq(alertRecipient.operatorId, q.operatorId),
    ))
    .orderBy(asc(alertRecipient.category), asc(alertRecipient.channel), asc(alertRecipient.id))
    .limit(500);
}

/** One recipient row a caller may change, or null. */
export async function findRecipient(db: Exec, q: { id: string; operatorId: string; platformWide: boolean }) {
  const [row] = await db
    .select()
    .from(alertRecipient)
    .where(and(
      eq(alertRecipient.id, q.id),
      isNull(alertRecipient.archivedAt),
      q.platformWide
        ? or(isNull(alertRecipient.operatorId), eq(alertRecipient.operatorId, q.operatorId))
        : eq(alertRecipient.operatorId, q.operatorId),
    ))
    .limit(1);
  return row ?? null;
}

/**
 * The live recipient rows an alert of this category, owner and branch
 * reaches: an exact or `*` category, a platform row or one of the alert's own
 * operator, and either no branch or the alert's branch.
 */
export async function recipientsFor(
  db: Exec,
  q: { category: string; operatorId: string | null; branchId: string | null },
) {
  return db
    .select()
    .from(alertRecipient)
    .where(and(
      isNull(alertRecipient.archivedAt),
      or(eq(alertRecipient.category, q.category), eq(alertRecipient.category, '*')),
      q.operatorId === null
        ? isNull(alertRecipient.operatorId)
        : or(isNull(alertRecipient.operatorId), eq(alertRecipient.operatorId, q.operatorId)),
      q.branchId === null
        ? isNull(alertRecipient.branchId)
        : or(isNull(alertRecipient.branchId), eq(alertRecipient.branchId, q.branchId)),
    ))
    .orderBy(asc(alertRecipient.id));
}

// --- Delivery -----------------------------------------------------------------

/**
 * What the watchdog calls instead of `deliverAlert`.
 *
 *  1. A mute in force on one of the alert's fingerprints, for the alert's own
 *     owner, holds the delivery back: one `muted` row per channel that would
 *     have been told, pointing at the mute. `last_notified_at` is not set, so
 *     a later resolution is not announced for a raise nobody heard.
 *  2. Otherwise the configured channels deliver exactly as before.
 *  3. Then every matching recipient row whose channel this build does not
 *     deliver to is recorded as `unsupported`, labelled `<channel>:<ENV NAME>`
 *     — never the address. A console row is the console channel above.
 *
 * Reading the alert row first means the caller passes nothing new: its owner,
 * branch and detail are whatever the raise stored.
 */
export async function deliverRoutedAlert(
  db: Db,
  channels: AlertChannel[],
  message: AlertMessage,
  log?: FastifyBaseLogger,
): Promise<void> {
  const [row] = await db
    .select({ operatorId: alert.operatorId, branchId: alert.branchId, detail: alert.detail })
    .from(alert)
    .where(eq(alert.id, message.alertId))
    .limit(1);
  if (!row) {
    await deliverAlert(db, channels, message, log);
    return;
  }
  const mute = await muteFor(db, { fingerprints: alertFingerprints(message.key, row.detail), operatorId: row.operatorId });
  if (mute) {
    // No channel configured is still a delivery that did not happen: say so as 'none'.
    const told = channels.length > 0 ? channels.map((c) => c.name) : ['none'];
    await db.insert(alertDelivery).values(told.map((channel) => ({
      id: newId(),
      alertId: message.alertId,
      channel,
      event: message.event,
      status: 'muted',
      target: channel,
      muteId: mute.id,
      durationMs: 0,
    })));
    log?.info({ alertKey: message.key, muteId: mute.id, event: message.event }, 'alert delivery held back by a fingerprint mute');
    return;
  }
  await deliverAlert(db, channels, message, log);
  const recipients = await recipientsFor(db, { category: message.category, operatorId: row.operatorId, branchId: row.branchId });
  const undelivered = recipients.filter((r) => !DELIVERED_CHANNELS.includes(r.channel));
  if (undelivered.length === 0) return;
  await db.insert(alertDelivery).values(undelivered.map((r) => ({
    id: newId(),
    alertId: message.alertId,
    channel: r.channel,
    event: message.event,
    status: 'unsupported',
    target: `${r.channel}:${r.addressRef ?? ''}`,
    error: 'No provider integration on this build: delivery is console-only',
    durationMs: 0,
  })));
}
