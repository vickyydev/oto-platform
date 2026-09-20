import { z } from 'zod';
import { and, desc, eq, gte, lte, not, sql, type SQL } from 'drizzle-orm';
import { auditLog } from '@oto/db';
import type { App } from '../app';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import { hasPermission } from '../services/permissions';
import { opCtx, withTx, type Exec } from '../services/tx';

/**
 * SCRUM-14, extended in S2-03 — the audit read surface.
 *
 * Three things changed from Sprint 1's straight `order by … limit`:
 *
 *  - **Keyset pagination, not an offset.** `offset 10000` makes Postgres walk
 *    and discard ten thousand rows, so the last page of a growing table is
 *    the slowest — and because rows arrive while someone is paging, an offset
 *    also skips rows and repeats others. A cursor on `(created_at, id)` reads
 *    the same index entry either way and cannot lose a row.
 *  - **A cap.** 200, enforced by the schema. The console asks for a page;
 *    nothing asks for the table.
 *  - **Masking.** A `child.create` row carries the allergies and the medical
 *    note that were written, which is the most sensitive text the park holds.
 *    A caller without `admin:audit:read_sensitive` sees the shape of the
 *    change and not its contents — and a caller WITH it leaves a row of their
 *    own, because reading a child's medical note is itself an event.
 */

/**
 * What a refusal looks like in the action vocabulary. Every failure row is
 * either `<op>.failed` (written by `withTx` after a rollback) or a named
 * refusal — `access.denied`, `auth.permission_denied`, `auth.sign_in_failed`,
 * `auth.handoff_rejected`. Derived rather than stored: the column that would
 * hold it is part of the audit classification work, and until that lands the
 * name IS the outcome.
 */
const FAILURE = sql`(${auditLog.action} ~ '[._](failed|denied|rejected)$' or ${auditLog.action} = 'auth.locked_out')`;

/**
 * Keys whose values are personal. Masked by name rather than by row type
 * because the payload is free-form jsonb: a new route that audits a phone
 * number is covered on the day it is written, without anyone remembering to
 * come back here.
 */
const SENSITIVE_KEY =
  /^(phone|phone_?number|mobile|email|name|nickname|first_?name|last_?name|full_?name|address|allergies|allergy|medical_?notes|medical_?alert|dietary|food_?restrictions|notes?|date_?of_?birth|dob|age_?years|guardian_?name|password|token|secret)$/i;

const MASK = '[redacted]';
const MAX_DEPTH = 8;

/** Replace the values of personal keys, keeping the shape of the change. */
function mask(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => mask(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SENSITIVE_KEY.test(key) ? (v === null ? null : MASK) : mask(v, depth + 1);
  }
  return out;
}

/**
 * The cursor is the sort key itself — the timestamp and the id of the last
 * row served — so a page always resumes exactly where the previous one
 * stopped. Base64url only to keep an opaque-looking token out of the hands of
 * anyone tempted to build a query out of it.
 */
interface Cursor {
  createdAt: string;
  id: string;
}

function encodeCursor(c: Cursor): string {
  return Buffer.from(`${c.createdAt}|${c.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  const [createdAt, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt))) {
    throw errors.badRequest('Invalid cursor');
  }
  return { createdAt, id };
}

export async function auditRoutes(app: App): Promise<void> {
  app.get(
    '/',
    {
      config: { permission: 'admin:audit:read' },
      schema: {
        description: 'Query the audit log (keyset paginated, masked without admin:audit:read_sensitive)',
        querystring: z.object({
          action: z.string().optional(),
          entityType: z.string().optional(),
          entityId: z.string().optional(),
          actorAccountId: z.string().uuid().optional(),
          branchId: z.string().uuid().optional(),
          outcome: z.enum(['success', 'failure']).optional(),
          from: z.string().datetime().optional(),
          to: z.string().datetime().optional(),
          /** From a previous page's `nextCursor`; supersedes `to`. */
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
        }),
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const q = req.query;

      const clauses: SQL[] = [eq(auditLog.operatorId, auth.operatorId)];
      if (q.action) clauses.push(eq(auditLog.action, q.action));
      if (q.entityType) clauses.push(eq(auditLog.entityType, q.entityType));
      if (q.entityId) clauses.push(eq(auditLog.entityId, q.entityId));
      if (q.actorAccountId) clauses.push(eq(auditLog.actorAccountId, q.actorAccountId));
      if (q.branchId) clauses.push(eq(auditLog.branchId, q.branchId));
      if (q.outcome === 'failure') clauses.push(FAILURE);
      if (q.outcome === 'success') clauses.push(not(FAILURE));
      if (q.from) clauses.push(gte(auditLog.createdAt, new Date(q.from)));
      if (q.to) clauses.push(lte(auditLog.createdAt, new Date(q.to)));
      if (q.cursor) {
        const c = decodeCursor(q.cursor);
        // Row-wise comparison, which is what makes the tie-break free: rows
        // sharing a timestamp to the microsecond still have a total order.
        clauses.push(
          sql`(${auditLog.createdAt}, ${auditLog.id}) < (${c.createdAt}::timestamptz, ${c.id}::uuid)`,
        );
      }

      const read = (exec: Exec) =>
        exec
          .select()
          .from(auditLog)
          .where(and(...clauses))
          .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
          .limit(q.limit);

      const effective = await req.effectivePermissions();
      const unmasked = hasPermission(effective, 'admin:audit:read_sensitive', {
        operatorId: auth.operatorId,
        branchId: auth.branchId ?? undefined,
      });

      type Row = Awaited<ReturnType<typeof read>>[number];
      const shape = (rows: Row[]) => ({
        entries: rows.map((r) => ({
          id: r.id,
          action: r.action,
          entityType: r.entityType,
          entityId: r.entityId,
          actorAccountId: r.actorAccountId,
          branchId: r.branchId,
          requestId: r.requestId,
          before: unmasked ? r.before : mask(r.before),
          after: unmasked ? r.after : mask(r.after),
          createdAt: r.createdAt.toISOString(),
        })),
        masked: !unmasked,
        // A short page is the last page; a full one may not be.
        nextCursor:
          rows.length === q.limit && rows.length > 0
            ? encodeCursor({
                createdAt: rows[rows.length - 1]!.createdAt.toISOString(),
                id: rows[rows.length - 1]!.id,
              })
            : null,
      });

      if (!unmasked) return shape(await read(app.db));

      /**
       * The read and the record of it commit together. If we cannot write
       * down that someone opened a child's medical note, we do not hand it
       * over — an unmasked read nobody can account for is the one thing this
       * whole surface exists to prevent.
       */
      return withTx(app.db, opCtx(req), 'audit.read_sensitive', async (tx) => {
        const rows = await read(tx);
        if (rows.length > 0) {
          await audit.record(tx, {
            actorAccountId: auth.accountId,
            operatorId: auth.operatorId,
            branchId: auth.branchId,
            action: 'audit.read_sensitive',
            entityType: 'audit_log',
            entityId: req.id,
            after: {
              rows: rows.length,
              // The filters, so "what were they looking for" is answerable.
              filters: {
                action: q.action,
                entityType: q.entityType,
                entityId: q.entityId,
                actorAccountId: q.actorAccountId,
                branchId: q.branchId,
                outcome: q.outcome,
                from: q.from,
                to: q.to,
              },
            },
            requestId: req.id,
          });
        }
        return shape(rows);
      });
    },
  );
}
