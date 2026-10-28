import { and, asc, desc, eq, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { AI_INTENTS } from '@oto/assistant';
import { aiExample, aiTurn, branch, channelAccount, conversation, department, inboxEvent, kbEntry, message } from '@oto/db';
import {
  INBOX_CATEGORY_KEYS,
  newId,
  type InboxAiChannelAccount,
  type InboxAiExample,
  type InboxAiExampleCreate,
  type InboxAiExampleImport,
  type InboxAiExampleImportResult,
  type InboxAiExamplePatch,
  type InboxAiMode,
  type InboxAiPause,
  type InboxCategoryKey,
  type InboxKbCreate,
  type InboxKbEntry,
  type InboxKbPatch,
  type Permission,
} from '@oto/shared';
import { AppError, errors } from '../../lib/errors';
import { pgErrorOf } from '../../lib/scrub';
import { PermissionDeniedError } from '../../plugins/session';
import { audit } from '../audit';
import { claimClientId, markReplay } from '../client-id';
import { hasPermission, type EffectivePermission } from '../permissions';
import type { Exec, Tx } from '../tx';
import { aiEligibility, cancelAiForThread } from './ai-turns';
import { personalDataIn } from './personal-data';
import { loadVisibleConversation, type InboxViewer } from './read-visibility';

/**
 * THE ASSISTANT'S SETTINGS: THE KNOWLEDGE BASE, THE CURATED EXAMPLES AND THE
 * CONTROLS (SCRUM-590, round A3 lane a; plan
 * `docs/progress/plans/inbox-ai-build/PLAN.md` §C, §E, §D.2, §D.4).
 *
 * WHO. `inbox:kb:manage` (marketing; plan §C.2, §E "Marketing approves")
 * drafts, edits, approves and archives KB entries and reviews the examples
 * queue. `inbox:ai:manage` switches a number's assistant (§C.2: "a decision,
 * not an edit"). "Correct the assistant" is open to whoever may REPLY on the
 * thread (§E: "a staff member with `reply`"), and so is the per-thread pause
 * (§A.3: "a staff toggle"), which `inbox:ai:manage` held at the thread also
 * opens.
 *
 * REACH. A KB entry is checked at its park — a branch's entry at that branch,
 * a both-parks entry operator-wide. The permission is "assignable to the
 * marketing team's department" (§C.2), and a department grant names no branch,
 * so it reaches as far as its department does: an operator-wide department
 * (Marketing) reaches operator-wide, a branch's department that branch. An
 * example belongs to no park and needs operator reach.
 *
 * WHAT IS RECORDED. Every write is one transaction with its audit row
 * (`inbox.kb.*`, `inbox.ai_example.*`, `inbox.ai.mode`, `inbox.ai.pause`),
 * and the row holds ids, keys, statuses and LENGTHS — never a question, a
 * fact, a customer's words or a reply (§D.1, §D.2).
 */

type KbRow = typeof kbEntry.$inferSelect;
type ExampleRow = typeof aiExample.$inferSelect;

export const KB_MANAGE: Permission = 'inbox:kb:manage';
export const AI_MANAGE: Permission = 'inbox:ai:manage';

const len = (v: string | null | undefined): number | null => (v == null ? null : [...v].length);

// --- Reach -----------------------------------------------------------------------------------

export interface Reach {
  operatorWide: boolean;
  branchIds: ReadonlySet<string>;
}

/** How far `permission` reaches inside the operator, a department grant resolved to its department's park. */
export async function reachOf(
  db: Exec,
  effective: EffectivePermission[],
  permission: Permission,
  operatorId: string,
): Promise<Reach> {
  const grants = effective.filter(
    (g) => g.permission === permission && (g.scopeType !== 'operator' || g.scopeId === null || g.scopeId === operatorId),
  );
  let operatorWide = grants.some((g) => g.scopeType === 'operator');
  const branchIds = new Set(grants.filter((g) => g.scopeType === 'branch' && g.scopeId).map((g) => g.scopeId!));
  const deptIds = [...new Set(grants.filter((g) => g.scopeType === 'department' && g.scopeId).map((g) => g.scopeId!))];
  if (!operatorWide && deptIds.length > 0) {
    const depts = await db
      .select({ branchId: department.branchId })
      .from(department)
      .where(and(eq(department.operatorId, operatorId), inArray(department.id, deptIds)));
    for (const d of depts) {
      if (d.branchId === null) operatorWide = true;
      else branchIds.add(d.branchId);
    }
  }
  return { operatorWide, branchIds };
}

export function reaches(reach: Reach, branchId: string | null): boolean {
  return reach.operatorWide || (branchId !== null && reach.branchIds.has(branchId));
}

function requireReach(reach: Reach, branchId: string | null, permission: Permission): void {
  if (!reaches(reach, branchId)) throw new PermissionDeniedError(permission);
}

async function assertBranchInOperator(db: Exec, operatorId: string, branchId: string | null): Promise<void> {
  if (!branchId) return;
  const [row] = await db
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.id, branchId), eq(branch.operatorId, operatorId)))
    .limit(1);
  if (!row) throw errors.notFound('No such branch');
}

export interface SettingsCtx {
  operatorId: string;
  accountId: string;
  requestId: string | null;
  now: Date;
}

// --- The knowledge base ----------------------------------------------------------------------

export const KB_MESSAGES = {
  keyTaken:
    'A live entry already stands for this key, language and park — edit that one, or archive it first.',
  notDraft: 'Only a draft can be edited. Archive this entry and draft a new one with the same key.',
  archived: 'This entry is archived. Draft a new one with the same key instead.',
  exampleNotApproved: 'Only an approved example can be promoted to the knowledge base.',
} as const;

function kbView(r: KbRow, reach: Reach): InboxKbEntry {
  return {
    id: r.id,
    branchId: r.branchId,
    topic: r.topic,
    key: r.key,
    language: r.language,
    question: r.question,
    body: r.body,
    status: r.status,
    needsTranslation: r.needsTranslation,
    sourceExampleId: r.sourceExampleId,
    updatedByAccountId: r.updatedByAccountId,
    approvedByAccountId: r.approvedByAccountId,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    canManage: reaches(reach, r.branchId),
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** What an audit row may say about an entry: never its words. */
function kbAudit(r: KbRow) {
  return {
    key: r.key,
    language: r.language,
    topic: r.topic,
    branchId: r.branchId,
    status: r.status,
    needsTranslation: r.needsTranslation,
    sourceExampleId: r.sourceExampleId,
    questionLength: len(r.question),
    bodyLength: len(r.body),
  };
}

export async function listKb(
  db: Exec,
  operatorId: string,
  reach: Reach,
  query: { language?: string; topic?: string; status?: string },
): Promise<{ entries: InboxKbEntry[] }> {
  const where: SQL[] = [eq(kbEntry.operatorId, operatorId)];
  if (query.status) where.push(eq(kbEntry.status, query.status as KbRow['status']));
  else where.push(ne(kbEntry.status, 'archived'));
  if (query.language) where.push(eq(kbEntry.language, query.language as KbRow['language']));
  if (query.topic) where.push(eq(kbEntry.topic, query.topic as KbRow['topic']));
  const rows = await db
    .select()
    .from(kbEntry)
    .where(and(...where))
    .orderBy(asc(kbEntry.topic), asc(kbEntry.key), asc(kbEntry.language), asc(kbEntry.id));
  return { entries: rows.map((r) => kbView(r, reach)) };
}

/** An entry of this operator by id; 404 for anyone else's. */
export async function loadKb(db: Exec, operatorId: string, id: string, lock = false): Promise<KbRow> {
  const q = db
    .select()
    .from(kbEntry)
    .where(and(eq(kbEntry.operatorId, operatorId), eq(kbEntry.id, id)))
    .limit(1);
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw errors.notFound('Knowledge-base entry not found');
  return row;
}

async function kbKeyTaken(
  tx: Tx,
  operatorId: string,
  v: { key: string; language: string; branchId: string | null },
  exceptId?: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: kbEntry.id })
    .from(kbEntry)
    .where(
      and(
        eq(kbEntry.operatorId, operatorId),
        eq(kbEntry.key, v.key),
        eq(kbEntry.language, v.language as KbRow['language']),
        sql`coalesce(${kbEntry.branchId}, '00000000-0000-0000-0000-000000000000'::uuid) = coalesce(${v.branchId}::uuid, '00000000-0000-0000-0000-000000000000'::uuid)`,
        ne(kbEntry.status, 'archived'),
        ...(exceptId ? [ne(kbEntry.id, exceptId)] : []),
      ),
    )
    .limit(1);
  return Boolean(row);
}

/** The database's own refusals, said as the sentences above (a race past the pre-check). */
async function kbWrite<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof AppError) throw err;
    const pg = pgErrorOf(err);
    if (pg?.code === '23505' && pg.constraint === 'kb_entry_key_unique') {
      throw errors.conflict('KB_KEY_TAKEN', KB_MESSAGES.keyTaken);
    }
    throw err;
  }
}

export async function createKb(tx: Tx, ctx: SettingsCtx, reach: Reach, input: InboxKbCreate): Promise<InboxKbEntry> {
  const branchId = input.branchId ?? null;
  const claim = await claimClientId(
    input.id,
    async (id) => (await tx.select().from(kbEntry).where(eq(kbEntry.id, id)).limit(1))[0],
    (row) => row.operatorId === ctx.operatorId && row.key === input.key && row.language === input.language,
  );
  if (claim.replay) return markReplay(kbView(claim.row, reach));
  requireReach(reach, branchId, KB_MANAGE);
  await assertBranchInOperator(tx, ctx.operatorId, branchId);
  if (input.sourceExampleId) {
    const [ex] = await tx
      .select({ status: aiExample.status })
      .from(aiExample)
      .where(and(eq(aiExample.operatorId, ctx.operatorId), eq(aiExample.id, input.sourceExampleId)))
      .limit(1);
    if (!ex) throw errors.notFound('Example not found');
    if (ex.status !== 'approved') throw errors.conflict('EXAMPLE_NOT_APPROVED', KB_MESSAGES.exampleNotApproved);
  }
  if (await kbKeyTaken(tx, ctx.operatorId, { key: input.key, language: input.language, branchId })) {
    throw errors.conflict('KB_KEY_TAKEN', KB_MESSAGES.keyTaken);
  }
  const [made] = await kbWrite(() =>
    tx
      .insert(kbEntry)
      .values({
        id: claim.id,
        operatorId: ctx.operatorId,
        branchId,
        topic: input.topic,
        key: input.key,
        language: input.language,
        question: input.question,
        body: input.body,
        status: 'draft',
        needsTranslation: input.needsTranslation ?? false,
        sourceExampleId: input.sourceExampleId ?? null,
        updatedByAccountId: ctx.accountId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning(),
  );
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.kb.create',
    entityType: 'inbox.kb_entry',
    entityId: made!.id,
    operatorId: ctx.operatorId,
    branchId,
    requestId: ctx.requestId,
    after: kbAudit(made!),
  });
  return kbView(made!, reach);
}

export async function updateKb(
  tx: Tx,
  ctx: SettingsCtx,
  reach: Reach,
  id: string,
  patch: InboxKbPatch,
): Promise<InboxKbEntry> {
  const before = await loadKb(tx, ctx.operatorId, id, true);
  requireReach(reach, before.branchId, KB_MANAGE);
  if (before.status !== 'draft') throw errors.conflict('KB_NOT_DRAFT', KB_MESSAGES.notDraft);
  const next = {
    branchId: patch.branchId === undefined ? before.branchId : patch.branchId,
    key: patch.key ?? before.key,
    language: patch.language ?? before.language,
  };
  requireReach(reach, next.branchId, KB_MANAGE);
  await assertBranchInOperator(tx, ctx.operatorId, next.branchId);
  if (await kbKeyTaken(tx, ctx.operatorId, next, before.id)) throw errors.conflict('KB_KEY_TAKEN', KB_MESSAGES.keyTaken);
  const [after] = await kbWrite(() =>
    tx
      .update(kbEntry)
      .set({
        ...next,
        ...(patch.topic !== undefined ? { topic: patch.topic } : {}),
        ...(patch.question !== undefined ? { question: patch.question } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.needsTranslation !== undefined ? { needsTranslation: patch.needsTranslation } : {}),
        updatedByAccountId: ctx.accountId,
        updatedAt: ctx.now,
      })
      .where(and(eq(kbEntry.operatorId, ctx.operatorId), eq(kbEntry.id, before.id)))
      .returning(),
  );
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.kb.update',
    entityType: 'inbox.kb_entry',
    entityId: before.id,
    operatorId: ctx.operatorId,
    branchId: after!.branchId,
    requestId: ctx.requestId,
    before: kbAudit(before),
    after: {
      ...kbAudit(after!),
      questionChanged: patch.question !== undefined && patch.question !== before.question,
      bodyChanged: patch.body !== undefined && patch.body !== before.body,
    },
  });
  return kbView(after!, reach);
}

/** Draft → approved: the approver and the time recorded (`kb_entry_approved_check`). Approving twice is the same act. */
export async function approveKb(tx: Tx, ctx: SettingsCtx, reach: Reach, id: string): Promise<InboxKbEntry> {
  const before = await loadKb(tx, ctx.operatorId, id, true);
  requireReach(reach, before.branchId, KB_MANAGE);
  if (before.status === 'archived') throw errors.conflict('KB_ARCHIVED', KB_MESSAGES.archived);
  if (before.status === 'approved') return kbView(before, reach);
  const [after] = await tx
    .update(kbEntry)
    .set({ status: 'approved', approvedByAccountId: ctx.accountId, approvedAt: ctx.now, updatedAt: ctx.now })
    .where(and(eq(kbEntry.operatorId, ctx.operatorId), eq(kbEntry.id, before.id)))
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.kb.approve',
    entityType: 'inbox.kb_entry',
    entityId: before.id,
    operatorId: ctx.operatorId,
    branchId: before.branchId,
    requestId: ctx.requestId,
    before: { status: before.status },
    after: { ...kbAudit(after!), approvedByAccountId: ctx.accountId },
  });
  return kbView(after!, reach);
}

/** Retire an entry: it leaves the assistant and frees its key. Never deleted. Archiving twice is the same act. */
export async function archiveKb(tx: Tx, ctx: SettingsCtx, reach: Reach, id: string): Promise<InboxKbEntry> {
  const before = await loadKb(tx, ctx.operatorId, id, true);
  requireReach(reach, before.branchId, KB_MANAGE);
  if (before.status === 'archived') return kbView(before, reach);
  const [after] = await tx
    .update(kbEntry)
    .set({ status: 'archived', updatedByAccountId: ctx.accountId, updatedAt: ctx.now })
    .where(and(eq(kbEntry.operatorId, ctx.operatorId), eq(kbEntry.id, before.id)))
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.kb.archive',
    entityType: 'inbox.kb_entry',
    entityId: before.id,
    operatorId: ctx.operatorId,
    branchId: before.branchId,
    requestId: ctx.requestId,
    before: { status: before.status },
    after: kbAudit(after!),
  });
  return kbView(after!, reach);
}

// --- The curated examples --------------------------------------------------------------------

export const EXAMPLE_MESSAGES = {
  deidentification:
    'Confirm that this example contains no personal data — no name, phone number, booking or child detail — before approving it.',
  goodReplyRequired: 'An example whose verdict is "should answer" needs the reply as it should have been written.',
  notProposed: 'Only a proposed example can be edited. Propose a new one instead.',
  notDeletable: 'Only a proposed example can be deleted. An approved one is rejected instead, which takes it out of the assistant.',
  rejectedCannotApprove: 'A rejected example cannot be approved. Propose it again.',
  languageUnknown: 'The thread’s language is not one the assistant writes in — choose Thai, English or Russian.',
  intentUnknown: 'Choose the intent this example teaches: the assistant has not classified this thread.',
  intentNotKnown: 'That is not one of the assistant’s intents.',
} as const;

const CONTENT_LANGUAGES = new Set(['th', 'en', 'ru']);
const INTENTS = new Set<string>(AI_INTENTS);

function exampleView(r: ExampleRow): InboxAiExample {
  return {
    id: r.id,
    intent: r.intent,
    language: r.language,
    customerText: r.customerText,
    goodReply: r.goodReply,
    verdict: r.verdict,
    status: r.status,
    sourceMessageId: r.sourceMessageId,
    sourceConversationId: r.sourceConversationId,
    proposedByAccountId: r.proposedByAccountId,
    approvedByAccountId: r.approvedByAccountId,
    approvedAt: r.approvedAt?.toISOString() ?? null,
    deidentifiedConfirmed: r.deidentifiedConfirmed,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** Ids, enums and lengths: never the customer's words or the reply. */
function exampleAudit(r: ExampleRow) {
  return {
    intent: r.intent,
    language: r.language,
    verdict: r.verdict,
    status: r.status,
    sourceMessageId: r.sourceMessageId,
    sourceConversationId: r.sourceConversationId,
    deidentifiedConfirmed: r.deidentifiedConfirmed,
    customerTextLength: len(r.customerText),
    goodReplyLength: len(r.goodReply),
  };
}

export async function listExamples(
  db: Exec,
  operatorId: string,
  query: { status?: string; intent?: string; language?: string },
): Promise<{ examples: InboxAiExample[]; intents: string[] }> {
  const where: SQL[] = [eq(aiExample.operatorId, operatorId)];
  if (query.status) where.push(eq(aiExample.status, query.status as ExampleRow['status']));
  if (query.intent) where.push(eq(aiExample.intent, query.intent));
  if (query.language) where.push(eq(aiExample.language, query.language as ExampleRow['language']));
  const rows = await db
    .select()
    .from(aiExample)
    .where(and(...where))
    .orderBy(desc(aiExample.createdAt), desc(aiExample.id));
  return { examples: rows.map(exampleView), intents: [...AI_INTENTS] };
}

export async function loadExample(db: Exec, operatorId: string, id: string, lock = false): Promise<ExampleRow> {
  const q = db
    .select()
    .from(aiExample)
    .where(and(eq(aiExample.operatorId, operatorId), eq(aiExample.id, id)))
    .limit(1);
  const [row] = lock ? await q.for('update') : await q;
  if (!row) throw errors.notFound('Example not found');
  return row;
}

function checkIntent(intent: string): void {
  if (!INTENTS.has(intent)) throw errors.conflict('INTENT_UNKNOWN', EXAMPLE_MESSAGES.intentNotKnown, { intents: [...AI_INTENTS] });
}

const CATEGORY_KEYS = new Set<string>(INBOX_CATEGORY_KEYS);
const isCategoryKey = (v: string): v is InboxCategoryKey => CATEGORY_KEYS.has(v);

/**
 * The intent a thread's category stands for when the assistant never
 * classified the thread (SCRUM-220 test night, R7): the assistant's own
 * table (`@oto/assistant` INTENT_TABLE) routes `birthday_party` to the
 * birthdays team and `influencer_marketing` to marketing; a general thread's
 * correction is a factual one, `faq`. A gm thread (SCRUM-220 playbook, the GM
 * queue) starts on `complaint_online`, the GM's most common matter. A default
 * for the editor's picker, not a classification: the example queue may change
 * it before approval.
 */
export const CATEGORY_DEFAULT_INTENT: Readonly<Record<InboxCategoryKey, (typeof AI_INTENTS)[number]>> = {
  birthdays: 'birthday_party',
  general: 'faq',
  marketing: 'influencer_marketing',
  gm: 'complaint_online',
};

function checkReply(verdict: ExampleRow['verdict'], goodReply: string | null): void {
  if (verdict === 'should_answer' && !goodReply) {
    throw errors.conflict('GOOD_REPLY_REQUIRED', EXAMPLE_MESSAGES.goodReplyRequired);
  }
}

/** Who is correcting the assistant, and where they may reply (the reply route's own rule). */
export interface CorrectViewers {
  read: InboxViewer;
  reply: InboxViewer;
}

/**
 * Visible to read (else 404), and the caller may reply there (else 403): the
 * thread rules every person action is held to.
 */
async function threadForPerson(
  tx: Tx,
  viewers: CorrectViewers,
  conversationId: string,
  alsoAllowed: (conv: typeof conversation.$inferSelect) => boolean,
): Promise<typeof conversation.$inferSelect> {
  const seen = await loadVisibleConversation(tx, viewers.read, conversationId);
  if (alsoAllowed(seen)) return seen;
  try {
    await loadVisibleConversation(tx, viewers.reply, seen.id);
  } catch (err) {
    if (err instanceof AppError && err.statusCode === 404) throw new PermissionDeniedError('inbox:conversation:reply');
    throw err;
  }
  return seen;
}

/**
 * "Correct the assistant" (§E): a proposed example from a message the caller
 * can see and may reply on. The thread is not changed. The language and the
 * intent come from the assistant's turn for that message (its line, or the
 * customer message it answered or stayed silent on), else from the thread;
 * the body's own override both.
 */
export async function createExample(
  tx: Tx,
  ctx: SettingsCtx,
  viewers: CorrectViewers,
  input: InboxAiExampleCreate,
): Promise<InboxAiExample> {
  const claim = await claimClientId(
    input.id,
    async (id) => (await tx.select().from(aiExample).where(eq(aiExample.id, id)).limit(1))[0],
    (row) => row.operatorId === ctx.operatorId && row.proposedByAccountId === ctx.accountId,
  );
  if (claim.replay) return markReplay(exampleView(claim.row));

  const [msg] = await tx
    .select({ id: message.id, conversationId: message.conversationId })
    .from(message)
    .where(and(eq(message.operatorId, ctx.operatorId), eq(message.id, input.messageId)))
    .limit(1);
  if (!msg) throw errors.notFound('Message not found');
  let conv: typeof conversation.$inferSelect;
  try {
    conv = await threadForPerson(tx, viewers, msg.conversationId, () => false);
  } catch (err) {
    // A message in a thread the caller cannot see is one that does not exist.
    if (err instanceof AppError && err.statusCode === 404) throw errors.notFound('Message not found');
    throw err;
  }

  const [turn] = await tx
    .select({ intent: aiTurn.intent, language: aiTurn.language })
    .from(aiTurn)
    .where(
      and(
        eq(aiTurn.operatorId, ctx.operatorId),
        eq(aiTurn.conversationId, conv.id),
        or(eq(aiTurn.triggerMessageId, msg.id), sql`${msg.id}::uuid = any(${aiTurn.messageIds})`),
      ),
    )
    .orderBy(desc(aiTurn.createdAt))
    .limit(1);

  const language =
    input.language ??
    [turn?.language, conv.language?.toLowerCase()].find((l): l is ExampleRow['language'] => !!l && CONTENT_LANGUAGES.has(l));
  if (!language) throw errors.conflict('LANGUAGE_REQUIRED', EXAMPLE_MESSAGES.languageUnknown);
  const classified = [turn?.intent, conv.intent].find((i): i is string => !!i && INTENTS.has(i));
  let intent = input.intent;
  if (intent !== undefined && isCategoryKey(intent)) {
    // The correction dialog's default topic is the thread's CATEGORY (its
    // header shows one even when the assistant never classified the thread;
    // SCRUM-220 test night, R7). A category is not an intent: the assistant's
    // own classification stands in for it when there is one, else the
    // category's default intent (`CATEGORY_DEFAULT_INTENT`), which the editor
    // may change before approval.
    intent = classified ?? CATEGORY_DEFAULT_INTENT[intent];
  }
  intent ??= classified;
  if (!intent) throw errors.conflict('INTENT_REQUIRED', EXAMPLE_MESSAGES.intentUnknown, { intents: [...AI_INTENTS] });
  checkIntent(intent);
  const goodReply = input.goodReply ?? null;
  checkReply(input.verdict, goodReply);

  const [made] = await tx
    .insert(aiExample)
    .values({
      id: claim.id,
      operatorId: ctx.operatorId,
      intent,
      language,
      customerText: input.customerText,
      goodReply,
      verdict: input.verdict,
      sourceMessageId: msg.id,
      sourceConversationId: conv.id,
      status: 'proposed',
      proposedByAccountId: ctx.accountId,
      createdAt: ctx.now,
      updatedAt: ctx.now,
    })
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.ai_example.create',
    entityType: 'inbox.ai_example',
    entityId: made!.id,
    operatorId: ctx.operatorId,
    branchId: conv.branchId,
    requestId: ctx.requestId,
    after: exampleAudit(made!),
  });
  return exampleView(made!);
}

export async function updateExample(
  tx: Tx,
  ctx: SettingsCtx,
  id: string,
  patch: InboxAiExamplePatch,
): Promise<InboxAiExample> {
  const before = await loadExample(tx, ctx.operatorId, id, true);
  if (before.status !== 'proposed') throw errors.conflict('EXAMPLE_NOT_PROPOSED', EXAMPLE_MESSAGES.notProposed);
  const verdict = patch.verdict ?? before.verdict;
  const goodReply = patch.goodReply === undefined ? before.goodReply : patch.goodReply;
  if (patch.intent !== undefined) checkIntent(patch.intent);
  checkReply(verdict, goodReply);
  const [after] = await tx
    .update(aiExample)
    .set({
      ...(patch.customerText !== undefined ? { customerText: patch.customerText } : {}),
      ...(patch.intent !== undefined ? { intent: patch.intent } : {}),
      ...(patch.language !== undefined ? { language: patch.language } : {}),
      verdict,
      goodReply,
      updatedAt: ctx.now,
    })
    .where(and(eq(aiExample.operatorId, ctx.operatorId), eq(aiExample.id, before.id)))
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.ai_example.update',
    entityType: 'inbox.ai_example',
    entityId: before.id,
    operatorId: ctx.operatorId,
    branchId: null,
    requestId: ctx.requestId,
    before: exampleAudit(before),
    after: {
      ...exampleAudit(after!),
      customerTextChanged: patch.customerText !== undefined && patch.customerText !== before.customerText,
      goodReplyChanged: patch.goodReply !== undefined && patch.goodReply !== before.goodReply,
    },
  });
  return exampleView(after!);
}

/**
 * Approve (§E, §D.5): REQUIRES the approver's de-identification confirmation,
 * and severs the example from its thread — both source links nulled — so an
 * approved example points at no person. `ai_example_approved_check` holds the
 * same rule underneath. Approving twice is the same act.
 */
export async function approveExample(
  tx: Tx,
  ctx: SettingsCtx,
  id: string,
  body: { deidentifiedConfirmed?: boolean | undefined },
): Promise<InboxAiExample> {
  const before = await loadExample(tx, ctx.operatorId, id, true);
  if (before.status === 'approved') return exampleView(before);
  if (before.status === 'rejected') throw errors.conflict('EXAMPLE_REJECTED', EXAMPLE_MESSAGES.rejectedCannotApprove);
  if (body.deidentifiedConfirmed !== true) {
    throw errors.conflict('DEIDENTIFICATION_REQUIRED', EXAMPLE_MESSAGES.deidentification);
  }
  checkReply(before.verdict, before.goodReply);
  const [after] = await tx
    .update(aiExample)
    .set({
      status: 'approved',
      deidentifiedConfirmed: true,
      approvedByAccountId: ctx.accountId,
      approvedAt: ctx.now,
      sourceMessageId: null,
      sourceConversationId: null,
      updatedAt: ctx.now,
    })
    .where(and(eq(aiExample.operatorId, ctx.operatorId), eq(aiExample.id, before.id)))
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.ai_example.approve',
    entityType: 'inbox.ai_example',
    entityId: before.id,
    operatorId: ctx.operatorId,
    branchId: null,
    requestId: ctx.requestId,
    before: exampleAudit(before),
    after: { ...exampleAudit(after!), approvedByAccountId: ctx.accountId },
  });
  return exampleView(after!);
}

/** Reject (the archive of an example): out of the queue, and out of the assistant if it was approved. */
export async function rejectExample(tx: Tx, ctx: SettingsCtx, id: string): Promise<InboxAiExample> {
  const before = await loadExample(tx, ctx.operatorId, id, true);
  if (before.status === 'rejected') return exampleView(before);
  const [after] = await tx
    .update(aiExample)
    .set({ status: 'rejected', updatedAt: ctx.now })
    .where(and(eq(aiExample.operatorId, ctx.operatorId), eq(aiExample.id, before.id)))
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.ai_example.reject',
    entityType: 'inbox.ai_example',
    entityId: before.id,
    operatorId: ctx.operatorId,
    branchId: null,
    requestId: ctx.requestId,
    before: exampleAudit(before),
    after: exampleAudit(after!),
  });
  return exampleView(after!);
}

/** A proposed example withdrawn before review: deleted (it is a draft, and may hold a thread's words). */
export async function deleteExample(tx: Tx, ctx: SettingsCtx, id: string): Promise<{ id: string; deleted: true }> {
  const before = await loadExample(tx, ctx.operatorId, id, true);
  if (before.status !== 'proposed') throw errors.conflict('EXAMPLE_NOT_DELETABLE', EXAMPLE_MESSAGES.notDeletable);
  await tx.delete(aiExample).where(and(eq(aiExample.operatorId, ctx.operatorId), eq(aiExample.id, before.id)));
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.ai_example.delete',
    entityType: 'inbox.ai_example',
    entityId: before.id,
    operatorId: ctx.operatorId,
    branchId: null,
    requestId: ctx.requestId,
    before: exampleAudit(before),
    after: { deleted: true },
  });
  return { id: before.id, deleted: true };
}

/**
 * Import examples from outside the inbox (SCRUM-220: the park's own WhatsApp
 * history, de-identified by `scripts/inbox/whatsapp-history.mjs`). Each one
 * lands PROPOSED with no source links — there is no thread behind it — and
 * waits in the queue for a person to review and approve it; nothing here
 * reaches the assistant on its own.
 *
 * All or nothing: every item is checked before anything is written — its
 * intent is one of the assistant's, a should_answer carries its reply, and
 * neither text still looks like personal data (`personalDataIn`) — and the
 * first that fails names its index. A caller-named id that already names
 * this caller's example is a replay of that one (nothing written for it); one
 * naming any other record is 409 ID_IN_USE. Audited per example as
 * `inbox.ai_example.create` (enums and lengths) and once for the request as
 * `inbox.ai_example.import` (counts and ids) — never the words.
 */
export async function importExamples(tx: Tx, ctx: SettingsCtx, input: InboxAiExampleImport): Promise<InboxAiExampleImportResult> {
  const sentIds = input.examples.map((x) => x.id).filter((id): id is string => !!id);
  if (new Set(sentIds).size !== sentIds.length) {
    throw errors.badRequest('Two examples in this import carry the same id. Nothing was saved.');
  }
  input.examples.forEach((x, index) => {
    if (!INTENTS.has(x.intent)) {
      throw errors.conflict('INTENT_UNKNOWN', `Example ${index + 1}: ${EXAMPLE_MESSAGES.intentNotKnown} Nothing was saved.`, {
        index,
        intents: [...AI_INTENTS],
      });
    }
    if (x.verdict === 'should_answer' && !x.goodReply) {
      throw errors.conflict('GOOD_REPLY_REQUIRED', `Example ${index + 1}: ${EXAMPLE_MESSAGES.goodReplyRequired} Nothing was saved.`, { index });
    }
    for (const [field, label] of [['customerText', 'the customer text'], ['goodReply', 'the good reply']] as const) {
      const kind = personalDataIn(x[field]);
      if (kind) {
        throw new AppError(
          400,
          'PERSONAL_DATA_FOUND',
          `Example ${index + 1}: ${label} still looks like it holds ${kind}. Remove it and send the import again. Nothing was saved.`,
          { index, field, kind },
        );
      }
    }
  });

  const out: InboxAiExample[] = [];
  const createdIds: string[] = [];
  const replayedIds: string[] = [];
  for (const x of input.examples) {
    const claim = await claimClientId(
      x.id,
      async (id) => (await tx.select().from(aiExample).where(eq(aiExample.id, id)).limit(1))[0],
      (row) => row.operatorId === ctx.operatorId && row.proposedByAccountId === ctx.accountId,
    );
    if (claim.replay) {
      replayedIds.push(claim.id);
      out.push(exampleView(claim.row));
      continue;
    }
    const [made] = await tx
      .insert(aiExample)
      .values({
        id: claim.id,
        operatorId: ctx.operatorId,
        intent: x.intent,
        language: x.language,
        customerText: x.customerText,
        goodReply: x.goodReply ?? null,
        verdict: x.verdict,
        sourceMessageId: null,
        sourceConversationId: null,
        status: 'proposed',
        proposedByAccountId: ctx.accountId,
        deidentifiedConfirmed: false,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })
      .returning();
    await audit.record(tx, {
      actorAccountId: ctx.accountId,
      action: 'inbox.ai_example.create',
      entityType: 'inbox.ai_example',
      entityId: made!.id,
      operatorId: ctx.operatorId,
      branchId: null,
      requestId: ctx.requestId,
      after: { ...exampleAudit(made!), imported: true },
    });
    createdIds.push(made!.id);
    out.push(exampleView(made!));
  }

  if (createdIds.length > 0) {
    const tally = (key: 'language' | 'verdict') =>
      input.examples.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x[key]]: (acc[x[key]] ?? 0) + 1 }), {});
    // The request's own row, filed under its first new example's id (an
    // import has no id of its own): counts and ids, never the words.
    await audit.record(tx, {
      actorAccountId: ctx.accountId,
      action: 'inbox.ai_example.import',
      entityType: 'inbox.ai_example_import',
      entityId: createdIds[0]!,
      operatorId: ctx.operatorId,
      branchId: null,
      requestId: ctx.requestId,
      after: {
        received: input.examples.length,
        created: createdIds.length,
        replayed: replayedIds.length,
        createdIds,
        replayedIds,
        byLanguage: tally('language'),
        byVerdict: tally('verdict'),
      },
    });
  }
  const result: InboxAiExampleImportResult = { created: createdIds.length, replayed: replayedIds.length, examples: out };
  return createdIds.length === 0 ? markReplay(result) : result;
}

// --- The controls ----------------------------------------------------------------------------

function channelAccountView(r: typeof channelAccount.$inferSelect): InboxAiChannelAccount {
  return {
    id: r.id,
    channel: r.channel,
    provider: r.provider,
    displayName: r.displayName,
    branchId: r.branchId,
    status: r.status,
    canReply: r.canReply,
    aiMode: r.aiMode,
  };
}

/**
 * The numbers the caller may switch: live (not archived) accounts that can
 * reply — a console notice sender never carries an assistant — inside their
 * reach of `inbox:ai:manage` (an operator-wide number needs operator reach).
 */
export async function listAiChannelAccounts(
  db: Exec,
  operatorId: string,
  reach: Reach,
): Promise<{ channelAccounts: InboxAiChannelAccount[] }> {
  const rows = await db
    .select()
    .from(channelAccount)
    .where(and(eq(channelAccount.operatorId, operatorId), sql`${channelAccount.archivedAt} is null`, eq(channelAccount.canReply, true)))
    .orderBy(asc(channelAccount.displayName), asc(channelAccount.id));
  return { channelAccounts: rows.filter((r) => reaches(reach, r.branchId)).map(channelAccountView) };
}

/** `off` / `shadow` / `live` on one number (§D.4). The same mode again writes nothing. */
export async function setAiMode(
  tx: Tx,
  ctx: SettingsCtx,
  reach: Reach,
  channelAccountId: string,
  aiMode: InboxAiMode,
): Promise<InboxAiChannelAccount> {
  const [before] = await tx
    .select()
    .from(channelAccount)
    .where(and(eq(channelAccount.operatorId, ctx.operatorId), eq(channelAccount.id, channelAccountId)))
    .limit(1)
    .for('update');
  if (!before) throw errors.notFound('Channel account not found');
  requireReach(reach, before.branchId, AI_MANAGE);
  if (!before.canReply && aiMode !== 'off') {
    throw errors.conflict('CHANNEL_CANNOT_REPLY', 'This number only sends notices and cannot carry the assistant.');
  }
  if (before.aiMode === aiMode) return channelAccountView(before);
  const [after] = await tx
    .update(channelAccount)
    .set({ aiMode, updatedAt: ctx.now })
    .where(and(eq(channelAccount.operatorId, ctx.operatorId), eq(channelAccount.id, before.id)))
    .returning();
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.ai.mode',
    entityType: 'inbox.channel_account',
    entityId: before.id,
    operatorId: ctx.operatorId,
    branchId: before.branchId,
    requestId: ctx.requestId,
    before: { aiMode: before.aiMode },
    after: { aiMode: after!.aiMode, channel: after!.channel },
  });
  return channelAccountView(after!);
}

/**
 * Pause or resume the assistant on one thread (§A.3, §D.4). Pausing stands
 * the assistant down in this transaction — every pending or deciding turn
 * cancelled (`PAUSED`), every unsent AI line withdrawn — under the thread's
 * lock; resuming clears the pause and writes no turn (the next customer
 * message does, if the thread is then eligible). The same state again is the
 * same act, written once. Open to whoever may reply on the thread, or who
 * holds `inbox:ai:manage` at it.
 */
export async function setAiPaused(
  tx: Tx,
  ctx: SettingsCtx,
  viewers: CorrectViewers,
  effective: EffectivePermission[],
  conversationId: string,
  paused: boolean,
): Promise<InboxAiPause> {
  const [locked] = await tx
    .select({ id: conversation.id })
    .from(conversation)
    .where(and(eq(conversation.operatorId, ctx.operatorId), eq(conversation.id, conversationId)))
    .limit(1)
    .for('update');
  if (!locked) throw errors.notFound('Conversation not found');
  const conv = await threadForPerson(tx, viewers, conversationId, (c) =>
    hasPermission(effective, AI_MANAGE, { operatorId: ctx.operatorId, ...(c.branchId ? { branchId: c.branchId } : {}), recordId: c.id }),
  );
  const answer = (c: { aiPausedAt: Date | null; aiPausedByAccountId: string | null }, turns = 0, withdrawn = 0): InboxAiPause => ({
    conversationId: conv.id,
    aiPaused: c.aiPausedAt !== null,
    aiPausedAt: c.aiPausedAt?.toISOString() ?? null,
    aiPausedByAccountId: c.aiPausedByAccountId,
    turnsCancelled: turns,
    messagesWithdrawn: withdrawn,
  });
  // The same state again is the same act, written once — except a Resume on
  // a thread the assistant is held off for another reason, a person's reply
  // or its own hand-over (test night 2026-10-21, W4b): Resume clears EVERY
  // hold, so its `ai_resumed` pill is written even when the thread was never
  // paused; `aiEligibility` reads that pill as the episode's new floor.
  if ((conv.aiPausedAt !== null) === paused && (paused || (await aiEligibility(tx, conv)).ok)) return answer(conv);

  const [after] = await tx
    .update(conversation)
    .set(
      paused
        ? { aiPausedAt: ctx.now, aiPausedByAccountId: ctx.accountId, updatedAt: ctx.now }
        : { aiPausedAt: null, aiPausedByAccountId: null, updatedAt: ctx.now },
    )
    .where(and(eq(conversation.operatorId, ctx.operatorId), eq(conversation.id, conv.id)))
    .returning({ aiPausedAt: conversation.aiPausedAt, aiPausedByAccountId: conversation.aiPausedByAccountId });
  const stood = paused
    ? await cancelAiForThread(tx, ctx.operatorId, conv.id, 'PAUSED', ctx.accountId, { requestId: ctx.requestId, now: ctx.now })
    : { turnsCancelled: [], messagesWithdrawn: [] };
  // The timeline's pill (SCRUM-220 test night, R5): the person who stood the
  // assistant down, or let it back, in the same event table every other
  // action's pill reads from. Counts only — never a line's words.
  await tx.insert(inboxEvent).values({
    id: newId(),
    operatorId: ctx.operatorId,
    conversationId: conv.id,
    kind: paused ? 'ai_paused' : 'ai_resumed',
    actorKind: 'account',
    actorAccountId: ctx.accountId,
    payload: paused ? { turnsCancelled: stood.turnsCancelled.length, messagesWithdrawn: stood.messagesWithdrawn.length } : {},
    createdAt: ctx.now,
  });
  await audit.record(tx, {
    actorAccountId: ctx.accountId,
    action: 'inbox.ai.pause',
    entityType: 'inbox.conversation',
    entityId: conv.id,
    operatorId: ctx.operatorId,
    branchId: conv.branchId,
    requestId: ctx.requestId,
    before: { paused: conv.aiPausedAt !== null },
    after: {
      paused,
      turnsCancelled: stood.turnsCancelled,
      messagesWithdrawn: stood.messagesWithdrawn,
    },
  });
  return answer(after!, stood.turnsCancelled.length, stood.messagesWithdrawn.length);
}
