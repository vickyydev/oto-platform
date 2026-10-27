import { z } from 'zod';
import { and, desc, eq, gte, inArray, lte, not, sql, type SQL } from 'drizzle-orm';
import { account, auditLog, employee } from '@oto/db';
import type { FastifyRequest } from 'fastify';
import type { App } from '../app';
import { PermissionDeniedError } from '../plugins/session';
import { errors } from '../lib/errors';
import { audit } from '../services/audit';
import { branchReach } from '../services/access-control';
import { opCtx, withTx, type Exec } from '../services/tx';
import { maskPersonal as mask } from '../services/audit-mask';

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
 *
 * Since the internal assistant's re-check (SCRUM-591, test night 2026-10-21):
 *
 *  - **The actor's name.** Each entry carries `actorName`, the employee's
 *    name behind the actor account (null for an account with no employee, and
 *    for the system). The Activity screen already shows this name, resolved
 *    from the accounts list; the assistant reads the trail as the asker and
 *    names people, never ids.
 *  - **A total, on request.** `count=true` answers `total`, the rows matching
 *    the filters with the cursor ignored, so a reader of one page can say
 *    "the latest 20 of 38". Opt-in: a count over an unfiltered trail is a
 *    walk of the operator's whole log, which no page of the console needs.
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

/** Audit changes retain any native JSON value, including scalars and arrays. */
const AuditJsonValue: z.ZodType<unknown> = z.union([
  z.null(), z.string(), z.number(), z.boolean(), z.array(z.unknown()), z.record(z.unknown()),
]);

/**
 * SCRUM-644 (Q25) — the two activity categories the server can answer for
 * EVERY row, labelled or not.
 *
 * A producer may label its write (`audit_log.category`); a row nobody labelled
 * is classified from its action name, the same way the outcome above is. Only
 * these two are derived, and each from a closed list: `denial` is the named
 * refusals and never "every failure" (a rolled-back `<op>.failed` is not
 * somebody being refused), and `data_access` is the reads that are themselves
 * events — an unmasked read and an export.
 */
const ACTIVITY_CATEGORIES = ['data_access', 'denial'] as const;
const DENIAL_ACTIONS = [
  'access.denied',
  'auth.permission_denied',
  'auth.sign_in_failed',
  'auth.locked_out',
  'auth.handoff_rejected',
] as const;
const DATA_ACCESS_ACTIONS = ['audit.read_sensitive', 'audit.export'] as const;

const listOf = (values: readonly string[]) => sql.join(values.map((v) => sql`${v}`), sql`, `);
const EFFECTIVE_CATEGORY = sql`coalesce(${auditLog.category}, case
  when ${auditLog.action} in (${listOf(DATA_ACCESS_ACTIONS)}) then 'data_access'
  when ${auditLog.action} in (${listOf(DENIAL_ACTIONS)}) then 'denial' end)`;

/** The same classification, for a row already read. */
function categoryOf(row: { category: string | null; action: string }): string | null {
  if (row.category) return row.category;
  if ((DATA_ACCESS_ACTIONS as readonly string[]).includes(row.action)) return 'data_access';
  if ((DENIAL_ACTIONS as readonly string[]).includes(row.action)) return 'denial';
  return null;
}

/** An app key as the suite names them: `pos`, `console`, `oto_app`, `inbox`. */
const AppKey = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,39}$/, 'An app is named by its lower-case key, such as inbox or oto_app');

/** Every filter the trail takes, shared by the read and the export so the two can never select differently. */
const AuditFilterQuery = z.object({
  action: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  actorAccountId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  outcome: z.enum(['success', 'failure']).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  /** SCRUM-644: the app a producer labelled its write with. */
  app: AppKey.optional(),
  /** SCRUM-644: the suite app a Console action reached into (SCRUM-643's column). */
  targetApp: AppKey.optional(),
  /** SCRUM-644: `data_access` or `denial` — labelled, or derived from the action name. */
  category: z.enum(ACTIVITY_CATEGORIES).optional(),
});
type AuditFilters = z.infer<typeof AuditFilterQuery>;

/** The filters a row of the trail records about a read of it: only the ones given survive into jsonb. */
function filtersOf(q: AuditFilters) {
  return {
    action: q.action,
    entityType: q.entityType,
    entityId: q.entityId,
    actorAccountId: q.actorAccountId,
    branchId: q.branchId,
    outcome: q.outcome,
    from: q.from,
    to: q.to,
    app: q.app,
    targetApp: q.targetApp,
    category: q.category,
  };
}

const AuditEntrySchema = z.object({
  id: z.string().uuid(),
  action: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  actorAccountId: z.string().uuid().nullable(),
  actorName: z.string().nullable(),
  branchId: z.string().uuid().nullable(),
  requestId: z.string().nullable(),
  before: AuditJsonValue,
  after: AuditJsonValue,
  createdAt: z.string().datetime(),
  /** SCRUM-644: the producer's app label; null where the producer did not label. */
  app: z.string().nullable(),
  /** SCRUM-644: the suite app a Console action reached into; null otherwise. */
  targetApp: z.string().nullable(),
  /** SCRUM-644: `data_access`, `denial`, a producer's own label, or null. */
  category: z.string().nullable(),
});
type ShapedEntry = z.infer<typeof AuditEntrySchema>;

/** One bounded export page. Past this the export refuses and says how to page. */
export const AUDIT_EXPORT_MAX_ROWS = 5000;
const AUDIT_EXPORT_DEFAULT_ROWS = 1000;

/** A CSV cell, guarded against formula injection as the settlement export is. */
function csvCell(value: string | null): string {
  let text = value ?? '';
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

const CSV_COLUMNS = [
  'id', 'createdAt', 'action', 'category', 'app', 'targetApp', 'entityType', 'entityId',
  'actorAccountId', 'actorName', 'branchId', 'requestId', 'before', 'after',
] as const;

/** The CSV of exactly the entries the read would answer: before/after as their (masked) JSON. */
function csvOf(entries: ShapedEntry[]): string {
  const json = (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v));
  const lines = [CSV_COLUMNS.map(csvCell).join(',')];
  for (const e of entries) {
    lines.push(
      [
        e.id, e.createdAt, e.action, e.category, e.app, e.targetApp, e.entityType, e.entityId,
        e.actorAccountId, e.actorName, e.branchId, e.requestId, json(e.before), json(e.after),
      ]
        .map(csvCell)
        .join(','),
    );
  }
  return `${lines.join('\n')}\n`;
}

export async function auditRoutes(app: App): Promise<void> {
  /**
   * WHICH ROWS, AND WHETHER THEY ARE MASKED — one function for the read and
   * the export (SCRUM-644), so an export can never select a row the read would
   * not, or carry a value the read would mask. Its body is the read's own,
   * moved here unchanged; the three SCRUM-644 filters are additions to the
   * clause list and touch nothing else.
   */
  const selectionFor = async (req: FastifyRequest, q: AuditFilters) => {
    const auth = req.requireAuth();
    const effective = await req.effectivePermissions();

    /**
     * SCRUM-249 — WHOSE TRAIL THIS IS.
     *
     * The filter used to be the operator alone, so a manager of one branch
     * read the other branch's trail: who sold what, who was refused, who
     * opened whose record. The reach comes from the caller's grants, and a
     * branch-scoped reader sees rows carrying one of their branch ids.
     *
     * Rows with NO branch — an account created, a role granted, a sign-in
     * refused before any session existed — are operator-level events and
     * are not rows "for their branch", so they are not in a branch-scoped
     * answer. `inArray` excludes a NULL column on its own; saying it here
     * because it is a decision, not a side effect.
     *
     * An explicit `branchId` is answered explicitly: asking for a branch you
     * do not hold is refused rather than silently returning nothing, which
     * is how the sale list already answers the same question.
     */
    const reach = branchReach(effective, 'admin:audit:read', auth.operatorId);
    if (q.branchId) await req.requirePermission('admin:audit:read', { branchId: q.branchId });

    const clauses: SQL[] = [eq(auditLog.operatorId, auth.operatorId)];
    if (!q.branchId && reach.kind === 'branches') {
      if (reach.branchIds.length === 0) return { empty: true as const };
      clauses.push(inArray(auditLog.branchId, reach.branchIds));
    }
    if (q.action) clauses.push(eq(auditLog.action, q.action));
    if (q.entityType) clauses.push(eq(auditLog.entityType, q.entityType));
    if (q.entityId) clauses.push(eq(auditLog.entityId, q.entityId));
    if (q.actorAccountId) clauses.push(eq(auditLog.actorAccountId, q.actorAccountId));
    if (q.branchId) clauses.push(eq(auditLog.branchId, q.branchId));
    if (q.outcome === 'failure') clauses.push(FAILURE);
    if (q.outcome === 'success') clauses.push(not(FAILURE));
    if (q.from) clauses.push(gte(auditLog.createdAt, new Date(q.from)));
    if (q.to) clauses.push(lte(auditLog.createdAt, new Date(q.to)));
    if (q.app) clauses.push(eq(auditLog.sourceApp, q.app));
    if (q.targetApp) clauses.push(eq(auditLog.targetApp, q.targetApp));
    if (q.category) clauses.push(sql`${EFFECTIVE_CATEGORY} = ${q.category}`);

    /**
     * Unmasking is judged against the rows actually being read, not against
     * the branch on the caller's session: `PUT /me/session/branch` moves
     * that branch to anywhere in the operator, so a check on `auth.branchId`
     * is a check the reader sets for themselves. Every branch in the answer
     * has to be one they hold `admin:audit:read_sensitive` at; an unbounded
     * read needs it operator-wide.
     */
    const sensitive = branchReach(effective, 'admin:audit:read_sensitive', auth.operatorId);
    const reading: string[] | 'all' = q.branchId
      ? [q.branchId]
      : reach.kind === 'branches'
        ? reach.branchIds
        : 'all';
    const unmasked =
      sensitive.kind === 'operator' ||
      (reading !== 'all' && reading.every((b) => sensitive.branchIds.includes(b)));
    return { empty: false as const, clauses, unmasked };
  };

  /** The rows of one page: the filters, then the cursor, newest first. */
  const readPage = (exec: Exec, clauses: SQL[], cursor: string | undefined, limit: number) => {
    const pageClauses: SQL[] = [...clauses];
    if (cursor) {
      const c = decodeCursor(cursor);
      // Row-wise comparison, which is what makes the tie-break free: rows
      // sharing a timestamp to the microsecond still have a total order.
      pageClauses.push(
        sql`(${auditLog.createdAt}, ${auditLog.id}) < (${c.createdAt}::timestamptz, ${c.id}::uuid)`,
      );
    }
    return exec
      .select()
      .from(auditLog)
      .where(and(...pageClauses))
      .orderBy(desc(auditLog.createdAt), desc(auditLog.id))
      .limit(limit);
  };
  type Row = Awaited<ReturnType<typeof readPage>>[number];

  /** The employee's name behind each actor account on the page: what the Activity screen shows for the actor. */
  const actorNames = async (
    exec: Exec,
    operatorId: string,
    actorIds: Array<string | null>,
  ): Promise<Map<string, string | null>> => {
    const ids = [...new Set(actorIds.filter((id): id is string => id !== null))];
    const names = new Map<string, string | null>();
    if (ids.length === 0) return names;
    const rows = await exec
      .select({ id: account.id, name: employee.name })
      .from(account)
      .leftJoin(employee, eq(employee.id, account.employeeId))
      .where(and(eq(account.operatorId, operatorId), inArray(account.id, ids)));
    for (const r of rows) names.set(r.id, r.name ?? null);
    return names;
  };

  /** One entry as both the read and the export hand it out — masked here, or not at all. */
  const shapeEntry = (r: Row, names: Map<string, string | null>, unmasked: boolean): ShapedEntry => ({
    id: r.id,
    action: r.action,
    entityType: r.entityType,
    entityId: r.entityId,
    actorAccountId: r.actorAccountId,
    actorName: r.actorAccountId === null ? null : (names.get(r.actorAccountId) ?? null),
    branchId: r.branchId,
    requestId: r.requestId,
    before: unmasked ? r.before : mask(r.before),
    after: unmasked ? r.after : mask(r.after),
    createdAt: r.createdAt.toISOString(),
    app: r.sourceApp,
    targetApp: r.targetApp,
    category: categoryOf(r),
  });

  /** A short page is the last page; a full one may not be. */
  const nextCursorOf = (rows: Row[], limit: number) =>
    rows.length === limit && rows.length > 0
      ? encodeCursor({
          createdAt: rows[rows.length - 1]!.createdAt.toISOString(),
          id: rows[rows.length - 1]!.id,
        })
      : null;

  app.get(
    '/',
    {
      config: { permission: 'admin:audit:read' },
      schema: {
        description:
          'Query the audit log (keyset paginated, masked without admin:audit:read_sensitive). Also filters by app, target app and the data_access or denial category on the server',
        querystring: AuditFilterQuery.extend({
          /** From a previous page's `nextCursor`; supersedes `to`. */
          cursor: z.string().max(200).optional(),
          limit: z.coerce.number().int().min(1).max(200).default(50),
          /** `true` also answers `total`: the rows matching the filters, the cursor ignored. */
          count: z.literal('true').optional(),
        }),
        response: {
          200: z.object({
            entries: z.array(AuditEntrySchema),
            masked: z.boolean(),
            nextCursor: z.string().nullable(),
            total: z.number().int().nonnegative().optional(),
          }),
        },
      },
    },
    async (req) => {
      const auth = req.requireAuth();
      const q = req.query;
      const counting = q.count === 'true';
      const selection = await selectionFor(req, q);
      if (selection.empty) {
        return { entries: [], masked: true, nextCursor: null, ...(counting ? { total: 0 } : {}) };
      }
      const { clauses, unmasked } = selection;

      /** The rows matching the filters, the cursor ignored: only when asked for (`count=true`). */
      const total = async (exec: Exec): Promise<number | null> => {
        if (!counting) return null;
        const [row] = await exec
          .select({ n: sql<number>`count(*)::int` })
          .from(auditLog)
          .where(and(...clauses));
        return Number(row?.n ?? 0);
      };

      const shape = (rows: Row[], names: Map<string, string | null>, count: number | null) => ({
        entries: rows.map((r) => shapeEntry(r, names, unmasked)),
        masked: !unmasked,
        nextCursor: nextCursorOf(rows, q.limit),
        ...(count === null ? {} : { total: count }),
      });

      /** The page, the names behind its actors, and the total when asked: one reader, either path. */
      const page = async (exec: Exec) => {
        const rows = await readPage(exec, clauses, q.cursor, q.limit);
        const names = await actorNames(exec, auth.operatorId, rows.map((r) => r.actorAccountId));
        return { rows, shaped: shape(rows, names, await total(exec)) };
      };

      if (!unmasked) return (await page(app.db)).shaped;

      /**
       * The read and the record of it commit together. If we cannot write
       * down that someone opened a child's medical note, we do not hand it
       * over — an unmasked read nobody can account for is the one thing this
       * whole surface exists to prevent.
       */
      return withTx(app.db, opCtx(req), 'audit.read_sensitive', async (tx) => {
        const { rows, shaped } = await page(tx);
        if (rows.length > 0) {
          await audit.record(tx, {
            actorAccountId: auth.accountId,
            operatorId: auth.operatorId,
            branchId: auth.branchId,
            action: 'audit.read_sensitive',
            entityType: 'audit_log',
            entityId: req.id,
            // SCRUM-644: labelled additively; the row's scope and payload are as before.
            category: 'data_access',
            after: {
              rows: rows.length,
              // The filters, so "what were they looking for" is answerable.
              filters: filtersOf(q),
            },
            requestId: req.id,
          });
        }
        return shaped;
      });
    },
  );

  /**
   * SCRUM-644 (Q25) — THE EXPORT: one bounded page of the trail as CSV or
   * NDJSON.
   *
   * Never the whole log in one response: at most 5000 rows, newest first, and
   * a full page answers `x-oto-next-cursor` so the next page is a second,
   * separately recorded export. The selection, the reach and the masking are
   * the read's own (`selectionFor`, `shapeEntry`), so a masked reader exports
   * masked rows and an unmasked one exports what they could already read.
   *
   * Every export — masked or not, empty or not — writes one `audit.export`
   * row, category `data_access`, naming the format, the filters, the row count
   * and whether it was masked, in the same transaction as the read: an export
   * that cannot be recorded is not handed over. A caller who holds the export
   * permission but cannot read the trail anywhere is refused rather than
   * handed an empty file with a record of it.
   */
  app.get(
    '/export',
    {
      config: { permission: 'console:activity:export', target: { operator: true } },
      schema: {
        description:
          'Download one bounded page (at most 5000 rows) of the audit log as CSV or NDJSON, with the same selection, reach and masking as GET /audit. Each export is recorded as an audit.export data_access row naming its filters and row count; a full page answers x-oto-next-cursor',
        querystring: AuditFilterQuery.extend({
          format: z.enum(['csv', 'ndjson']).default('csv'),
          cursor: z.string().max(200).optional(),
          limit: z.coerce
            .number()
            .int()
            .min(1)
            .max(
              AUDIT_EXPORT_MAX_ROWS,
              `An export holds at most ${AUDIT_EXPORT_MAX_ROWS} rows: narrow the filters, or export the next page with its cursor`,
            )
            .default(AUDIT_EXPORT_DEFAULT_ROWS),
        }),
      },
    },
    async (req, reply) => {
      const auth = req.requireAuth();
      const q = req.query;
      const selection = await selectionFor(req, q);
      if (selection.empty) throw new PermissionDeniedError('admin:audit:read');
      const { clauses, unmasked } = selection;

      const { entries, nextCursor } = await withTx(app.db, opCtx(req), 'audit.export', async (tx) => {
        const rows = await readPage(tx, clauses, q.cursor, q.limit);
        const names = await actorNames(tx, auth.operatorId, rows.map((r) => r.actorAccountId));
        const shaped = rows.map((r) => shapeEntry(r, names, unmasked));
        const next = nextCursorOf(rows, q.limit);
        await audit.record(tx, {
          actorAccountId: auth.accountId,
          operatorId: auth.operatorId,
          branchId: auth.branchId,
          action: 'audit.export',
          entityType: 'audit_log',
          entityId: req.id,
          sourceApp: 'console',
          category: 'data_access',
          after: {
            format: q.format,
            rows: shaped.length,
            masked: !unmasked,
            more: next !== null,
            filters: { ...filtersOf(q), cursor: q.cursor, limit: q.limit },
          },
          requestId: req.id,
        });
        return { entries: shaped, nextCursor: next };
      });

      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const body =
        q.format === 'csv'
          ? csvOf(entries)
          : entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length > 0 ? '\n' : '');
      reply
        .header('content-type', q.format === 'csv' ? 'text/csv; charset=utf-8' : 'application/x-ndjson; charset=utf-8')
        .header('content-disposition', `attachment; filename="activity-${stamp}.${q.format}"`)
        .header('cache-control', 'no-store')
        .header('x-oto-export-rows', String(entries.length))
        .header('x-oto-export-masked', String(!unmasked));
      if (nextCursor) reply.header('x-oto-next-cursor', nextCursor);
      return reply.send(body);
    },
  );
}
