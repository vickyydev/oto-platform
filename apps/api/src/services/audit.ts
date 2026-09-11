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
      action: entry.action,
      entityType: entry.entityType,
      entityId: entry.entityId,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });
  },
};
