import { auditLog } from '@oto/db';
import { newId } from '@oto/shared';
import { auditContextForActor, impersonationForActor } from './audit-context';

/**
 * Audit log service (SCRUM-14, CLAUDE.md §3): one helper, called from every
 * mutating service call — no exceptions. Runs inside the caller's transaction
 * so the audit row commits atomically with the change.
 */
export interface AuditEntry {
  actorAccountId: string | null;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  operatorId?: string | null;
  branchId?: string | null;
  requestId?: string | null;
  /**
   * `x-oto-action-id`, minted where the person tapped and carried PWA → box →
   * cloud (S2-05). A request id identifies one HTTP call; this identifies one
   * ACTION, which may have crossed a box, waited in an outbox overnight and
   * arrived in a batch of two hundred. It is what makes the till line, the Box
   * log drawer and this row findable from one another.
   */
  actionId?: string | null;
  /**
   * The `edge.sync_event` this change came out of, for a record written by
   * applying a box's fact rather than by somebody pressing a button here.
   *
   * No foreign key, deliberately: `sync_event` is swept on a dated policy and
   * `audit_log` is never swept, so a long-lived row must not hold a key into a
   * shorter-lived one. The pointer has to outlive what it points at.
   */
  sourceEventId?: string | null;
  /** SCRUM-643: the suite app a Console action reached into (S2-23). */
  targetApp?: string | null;
  /** SCRUM-643: the reason an action demanded, where it demanded one. */
  reason?: string | null;
  /** SCRUM-643: where the action came from — `console`, `job`. */
  origin?: string | null;
  /**
   * SCRUM-648: `impersonated` with `onBehalfOf` the subject, for a row
   * written inside a view-as window. Derived from the verified session when
   * the row is written as the subject; explicit only where no request
   * context exists (the per-request window record).
   */
  actorType?: 'impersonated' | null;
  onBehalfOf?: string | null;
}

/** Minimal insert surface shared by Db and its transaction handle. */
interface InsertCapable {
  insert: (table: typeof auditLog) => { values: (v: Record<string, unknown>) => Promise<unknown> };
}

export const audit = {
  async record(tx: unknown, entry: AuditEntry): Promise<void> {
    const context = auditContextForActor(entry.actorAccountId);
    // A row written as the subject of a view-as window names the person who was really there.
    const impersonated = entry.actorType ? null : impersonationForActor(entry.actorAccountId);
    await (tx as InsertCapable).insert(auditLog).values({
      id: newId(),
      operatorId: entry.operatorId ?? null,
      branchId: entry.branchId ?? null,
      actorAccountId: impersonated ? impersonated.actorAccountId : entry.actorAccountId,
      actorType: entry.actorType ?? (impersonated ? 'impersonated' : null),
      onBehalfOf: entry.onBehalfOf ?? impersonated?.subjectAccountId ?? null,
      homeOperatorId: context?.homeOperatorId ?? null,
      effectiveOperatorId: context?.effectiveOperatorId ?? null,
      requestId: entry.requestId ?? null,
      actionId: entry.actionId ?? null,
      sourceEventId: entry.sourceEventId ?? null,
      targetApp: entry.targetApp ?? null,
      reason: entry.reason ?? null,
      origin: entry.origin ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });
  },
};
