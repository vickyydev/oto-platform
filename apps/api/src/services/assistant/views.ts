import { and, asc, desc, eq, gte, inArray, lte, sql, type SQL } from 'drizzle-orm';
import { ask, toolCall, type Db } from '@oto/db';
import {
  ASSISTANT_SYSTEM_LABEL,
  buildSuiteScreenPath,
  findSuiteScreen,
  type AssistantAskFeedback,
  type AssistantAskFeedbackResult,
  type AssistantAskLink,
  type AssistantAskList,
  type AssistantAskListQuery,
  type AssistantAskView,
  type AssistantReviewAsk,
  type AssistantReviewList,
  type AssistantReviewQuery,
} from '@oto/shared';
import { errors } from '../../lib/errors';
import { audit } from '../audit';
import type { Exec, Tx } from '../tx';

/**
 * THE ASK-LOG'S READS AND ITS ONE EDIT (SCRUM-591, round I2; plan §D.3).
 *
 *   - The asker reads their own rows, newest first (`listMyAsks`), with no
 *     permission beyond being signed in.
 *   - The only other reader holds `assistant:log:review` OPERATOR-WIDE
 *     (G3 default: operator admins). Every such read is audited as
 *     `assistant.ask.read`, naming the rows read (the `file.read` precedent);
 *     the audit row carries ids, never the text.
 *   - The asker marks an answer good or wrong, with a correction (spec §4).
 *
 * A view never carries a tool call's arguments: those are in the
 * `tool_call` row and go with it at the purge.
 */

export type AskRow = typeof ask.$inferSelect;
type ToolCallRow = typeof toolCall.$inferSelect;

interface Cursor {
  createdAt: string;
  id: string;
}

function encodeCursor(row: AskRow): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`, 'utf8').toString('base64url');
}

function decodeCursor(raw: string): Cursor {
  const [createdAt, id] = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (!createdAt || !id || Number.isNaN(Date.parse(createdAt)) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw errors.badRequest('Invalid cursor');
  }
  return { createdAt, id };
}

function linkView(link: { key: string; params: Record<string, string> }): AssistantAskLink | null {
  const screen = findSuiteScreen(link.key);
  const path = buildSuiteScreenPath(link.key, link.params);
  if (!screen || path === null) return null;
  return { key: link.key, app: screen.app, path, shows: screen.shows };
}

function viewOf(row: AskRow, calls: ToolCallRow[]): AssistantAskView {
  return {
    id: row.id,
    state: row.state,
    reason: row.reason,
    question: row.question,
    answer: row.answer,
    links: row.links.map(linkView).filter((l): l is AssistantAskLink => l !== null),
    refusals: row.refusals.map((r) => ({
      ...r,
      // §D.4: the system's name, then the route's own sentence. Rendered by the server, never the model.
      line: `${ASSISTANT_SYSTEM_LABEL[r.system]}: ${r.message}`,
    })),
    toolCalls: calls
      .sort((a, b) => a.seq - b.seq)
      .map((c) => ({
        seq: c.seq,
        tool: c.tool,
        system: c.system,
        status: c.status,
        code: c.code,
        rows: c.rows,
        truncated: c.truncated,
      })),
    feedback: row.feedback,
    correction: row.correction,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

async function callsOf(db: Exec, rows: AskRow[]): Promise<Map<string, ToolCallRow[]>> {
  const out = new Map<string, ToolCallRow[]>();
  if (rows.length === 0) return out;
  const operatorId = rows[0]!.operatorId;
  const calls = await db
    .select()
    .from(toolCall)
    .where(and(eq(toolCall.operatorId, operatorId), inArray(toolCall.askId, rows.map((r) => r.id))))
    .orderBy(asc(toolCall.seq));
  for (const c of calls) {
    const list = out.get(c.askId);
    if (list) list.push(c);
    else out.set(c.askId, [c]);
  }
  return out;
}

export async function loadAskView(db: Exec, row: AskRow): Promise<AssistantAskView> {
  const calls = await callsOf(db, [row]);
  return viewOf(row, calls.get(row.id) ?? []);
}

/** One ask inside the caller's operator, or 404. */
export async function loadAsk(db: Exec, operatorId: string, id: string): Promise<AskRow> {
  const [row] = await db
    .select()
    .from(ask)
    .where(and(eq(ask.operatorId, operatorId), eq(ask.id, id)))
    .limit(1);
  if (!row) throw errors.notFound('Question not found');
  return row;
}

/** "My questions": the asker's own, newest first, keyset-paged. */
export async function listMyAsks(
  db: Db,
  who: { operatorId: string; accountId: string },
  q: AssistantAskListQuery,
): Promise<AssistantAskList> {
  const clauses: SQL[] = [eq(ask.operatorId, who.operatorId), eq(ask.accountId, who.accountId)];
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    clauses.push(sql`(${ask.createdAt}, ${ask.id}) < (${c.createdAt}::timestamptz, ${c.id}::uuid)`);
  }
  const rows = await db
    .select()
    .from(ask)
    .where(and(...clauses))
    .orderBy(desc(ask.createdAt), desc(ask.id))
    .limit(q.limit);
  const calls = await callsOf(db, rows);
  return {
    asks: rows.map((r) => viewOf(r, calls.get(r.id) ?? [])),
    nextCursor: rows.length === q.limit ? encodeCursor(rows[rows.length - 1]!) : null,
  };
}

function reviewViewOf(row: AskRow, calls: ToolCallRow[]): AssistantReviewAsk {
  return {
    ...viewOf(row, calls),
    accountId: row.accountId,
    branchId: row.branchId,
    model: row.model,
    personaVersion: row.personaVersion,
  };
}

/**
 * The reviewer's list (§D.3), operator-wide, newest first. The read and its
 * audit row are one transaction: no rows leave without the record of who read
 * them.
 */
export async function reviewAsks(
  tx: Tx,
  reader: { operatorId: string; accountId: string; branchId: string | null; requestId: string },
  q: AssistantReviewQuery,
): Promise<AssistantReviewList> {
  const clauses: SQL[] = [eq(ask.operatorId, reader.operatorId)];
  if (q.feedback) clauses.push(eq(ask.feedback, q.feedback));
  if (q.state) clauses.push(eq(ask.state, q.state));
  if (q.accountId) clauses.push(eq(ask.accountId, q.accountId));
  if (q.from) clauses.push(gte(ask.createdAt, new Date(q.from)));
  if (q.to) clauses.push(lte(ask.createdAt, new Date(q.to)));
  if (q.cursor) {
    const c = decodeCursor(q.cursor);
    clauses.push(sql`(${ask.createdAt}, ${ask.id}) < (${c.createdAt}::timestamptz, ${c.id}::uuid)`);
  }
  const rows = await tx
    .select()
    .from(ask)
    .where(and(...clauses))
    .orderBy(desc(ask.createdAt), desc(ask.id))
    .limit(q.limit);
  const calls = await callsOf(tx, rows);
  await audit.record(tx, {
    actorAccountId: reader.accountId,
    action: 'assistant.ask.read',
    entityType: 'assistant.ask_review',
    entityId: reader.requestId,
    operatorId: reader.operatorId,
    branchId: reader.branchId,
    requestId: reader.requestId,
    // The rows read, by id; the filters as words. Never a question or an answer.
    after: {
      askIds: rows.map((r) => r.id),
      count: rows.length,
      filters: {
        feedback: q.feedback ?? null,
        state: q.state ?? null,
        accountId: q.accountId ?? null,
        from: q.from ?? null,
        to: q.to ?? null,
        cursor: q.cursor ? true : false,
      },
    },
  });
  return {
    asks: rows.map((r) => reviewViewOf(r, calls.get(r.id) ?? [])),
    nextCursor: rows.length === q.limit ? encodeCursor(rows[rows.length - 1]!) : null,
  };
}

/** A reviewer reading one other person's ask: the row and the record of the read, together. */
export async function reviewOneAsk(
  tx: Tx,
  reader: { operatorId: string; accountId: string; branchId: string | null; requestId: string },
  row: AskRow,
): Promise<AssistantAskView> {
  await audit.record(tx, {
    actorAccountId: reader.accountId,
    action: 'assistant.ask.read',
    entityType: 'assistant.ask',
    entityId: row.id,
    operatorId: reader.operatorId,
    branchId: reader.branchId,
    requestId: reader.requestId,
    after: { askIds: [row.id], count: 1, ownerAccountId: row.accountId },
  });
  return loadAskView(tx, row);
}

/** The asker's verdict (spec §4): own asks only, once the ask has ended. */
export async function setAskFeedback(
  tx: Tx,
  who: { operatorId: string; accountId: string; branchId: string | null; requestId: string },
  id: string,
  body: AssistantAskFeedback,
): Promise<AssistantAskFeedbackResult> {
  const [row] = await tx
    .select()
    .from(ask)
    .where(and(eq(ask.operatorId, who.operatorId), eq(ask.id, id)))
    .limit(1)
    .for('update');
  if (!row) throw errors.notFound('Question not found');
  if (row.accountId !== who.accountId) throw errors.forbidden('Only the person who asked can rate this answer');
  if (row.state === 'asking') {
    throw errors.conflict('ASK_IN_FLIGHT', 'This question is still being answered — rate it once it has an answer');
  }
  const correction = body.feedback === 'wrong' ? (body.correction ?? null) : null;
  const at = new Date();
  const [updated] = await tx
    .update(ask)
    .set({ feedback: body.feedback, correction, updatedAt: at })
    .where(and(eq(ask.operatorId, who.operatorId), eq(ask.id, id)))
    .returning();
  await audit.record(tx, {
    actorAccountId: who.accountId,
    action: 'assistant.ask.feedback',
    entityType: 'assistant.ask',
    entityId: id,
    operatorId: who.operatorId,
    branchId: who.branchId,
    requestId: who.requestId,
    // The verdict and the correction's length: the words stay on the row.
    before: { feedback: row.feedback, hasCorrection: row.correction !== null },
    after: { feedback: body.feedback, hasCorrection: correction !== null, correctionLength: correction?.length ?? 0 },
  });
  return {
    id,
    feedback: updated!.feedback!,
    hasCorrection: updated!.correction !== null,
    updatedAt: updated!.updatedAt.toISOString(),
  };
}

/** The asks a purge removes per statement, so one run never holds a long lock. */
const PURGE_BATCH = 1000;

export interface AssistantPurgeSummary extends Record<string, unknown> {
  purged: number;
  abandoned: number;
}

/**
 * `job:assistant.purge` (§D.3, G4): asks past `purge_after` are deleted, and
 * their tool calls go with them (`ON DELETE CASCADE`). The audit rows, which
 * hold no text, stay. An `asking` row older than an hour is an ask whose
 * process went away; it is closed as failed first, so it cannot sit in flight
 * for ever.
 */
export async function runAssistantPurge(
  db: Db,
  now: Date,
  closeAbandoned: (row: AskRow) => Promise<unknown>,
): Promise<AssistantPurgeSummary> {
  let abandoned = 0;
  const stale = await db
    .select()
    .from(ask)
    .where(and(eq(ask.state, 'asking'), lte(ask.updatedAt, new Date(now.getTime() - 3_600_000))))
    .limit(PURGE_BATCH);
  for (const row of stale) {
    if (await closeAbandoned(row)) abandoned += 1;
  }
  let purged = 0;
  for (;;) {
    const gone = await db.execute<{ id: string }>(sql`
      delete from assistant.ask
       where id in (select id from assistant.ask where purge_after <= ${now.toISOString()}::timestamptz limit ${PURGE_BATCH})
      returning id`);
    purged += gone.rows.length;
    if (gone.rows.length < PURGE_BATCH) break;
  }
  return { purged, abandoned };
}
