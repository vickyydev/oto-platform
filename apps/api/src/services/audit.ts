import { auditLog } from '@oto/db';
import { newId } from '@oto/shared';

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
}

/** Minimal insert surface shared by Db and its transaction handle. */
interface InsertCapable {
  insert: (table: typeof auditLog) => { values: (v: Record<string, unknown>) => Promise<unknown> };
}

export const audit = {
  async record(tx: unknown, entry: AuditEntry): Promise<void> {
    await (tx as InsertCapable).insert(auditLog).values({
      id: newId(),
      operatorId: entry.operatorId ?? null,
      branchId: entry.branchId ?? null,
      actorAccountId: entry.actorAccountId,
      requestId: entry.requestId ?? null,
      actionId: entry.actionId ?? null,
      sourceEventId: entry.sourceEventId ?? null,
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });
  },
};
