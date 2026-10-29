import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  InboxAiChannelAccountListSchema,
  InboxAiChannelAccountSchema,
  InboxAiExampleApproveBodySchema,
  InboxAiExampleCreateSchema,
  InboxAiExampleDeletedSchema,
  InboxAiExampleImportResultSchema,
  InboxAiExampleImportSchema,
  InboxAiExampleListQuerySchema,
  InboxAiExampleListSchema,
  InboxAiExamplePatchSchema,
  InboxAiExampleSchema,
  InboxAiModeBodySchema,
  InboxAiPauseSchema,
  InboxAiRuleCreateSchema,
  InboxAiRuleListQuerySchema,
  InboxAiRuleListSchema,
  InboxAiRulePatchSchema,
  InboxAiRuleSchema,
  InboxAiTeachRequestSchema,
  InboxAiTeachResponseSchema,
  InboxKbCreateSchema,
  InboxKbEntrySchema,
  InboxKbListQuerySchema,
  InboxKbListSchema,
  InboxKbPatchSchema,
  type Permission,
} from '@oto/shared';
import type { App } from '../app';
import { AppError } from '../lib/errors';
import { PermissionDeniedError } from '../plugins/session';
import { REPLAY_HEADER, wasReplay } from '../services/client-id';
import { opCtx, withTx } from '../services/tx';
import { holdsAnywhere, viewerScopeOf } from '../services/inbox/read-visibility';
import { replyViewerOf } from '../services/inbox/reply';
import { approveRule, archiveRule, createRule, listRules, updateRule } from '../services/inbox/ai-rules';
import { teach, TEACH_LINES, toolOpCtx } from '../services/inbox/ai-teach';
import {
  AI_MANAGE,
  KB_MANAGE,
  approveExample,
  approveKb,
  archiveKb,
  createExample,
  createKb,
  deleteExample,
  importExamples,
  listAiChannelAccounts,
  listExamples,
  listKb,
  reachOf,
  rejectExample,
  setAiMode,
  setAiPaused,
  updateExample,
  updateKb,
  type CorrectViewers,
  type SettingsCtx,
} from '../services/inbox/ai-settings';

/**
 * THE CUSTOMER ASSISTANT'S SETTINGS ROUTES (SCRUM-590, round A3 lane a; plan
 * `docs/progress/plans/inbox-ai-build/PLAN.md` §C, §E, §D.4). The rules are in
 * `services/inbox/ai-settings.ts`.
 *
 *   GET   /inbox/kb                               the knowledge base         inbox:kb:manage
 *   POST  /inbox/kb                               draft an entry             inbox:kb:manage at its park
 *   PATCH /inbox/kb/{id}                          edit a draft               "
 *   POST  /inbox/kb/{id}/approve                  approve                    "
 *   POST  /inbox/kb/{id}/archive                  archive                    "
 *   GET   /inbox/ai/examples                      the examples queue         inbox:kb:manage, operator reach
 *   POST  /inbox/ai/examples                      "Correct the assistant"    reply on the message's thread
 *   POST  /inbox/ai/examples/import               load from chat history     inbox:kb:manage, operator reach
 *   PATCH /inbox/ai/examples/{id}                 edit a proposed one        inbox:kb:manage, operator reach
 *   POST  /inbox/ai/examples/{id}/approve         approve (de-identified)    "
 *   POST  /inbox/ai/examples/{id}/reject          reject                     "
 *   DELETE /inbox/ai/examples/{id}                delete a proposed one      "
 *   GET   /inbox/ai/rules                         the behaviour rules        inbox:kb:manage
 *   POST  /inbox/ai/rules                         draft a rule               inbox:kb:manage at its park
 *   PATCH /inbox/ai/rules/{id}                    edit (revise if approved)  "
 *   POST  /inbox/ai/rules/{id}/approve            approve                    "
 *   POST  /inbox/ai/rules/{id}/archive            archive                    "
 *   POST  /inbox/ai/teach                         the teach chat             inbox:kb:manage, operator reach
 *   GET   /inbox/ai/channel-accounts              the numbers' switches      inbox:ai:manage
 *   PATCH /inbox/channel-accounts/{id}/ai-mode    off / shadow / live        inbox:ai:manage at the number
 *   POST  /inbox/conversations/{id}/ai-pause      pause on a thread          reply there, or inbox:ai:manage at it
 *   POST  /inbox/conversations/{id}/ai-resume     resume                     "
 *
 * Every route declares `dynamicPermission`, as the other inbox routes do: the
 * grants sit at a department, a branch or the operator, and the row decides
 * which scope it needs. Each handler refuses a caller who holds the route's
 * permission nowhere in their operator, and the service checks the row.
 */

const IdParams = z.object({ id: z.string().uuid() });

export async function inboxAiRoutes(app: App): Promise<void> {
  async function callerHolding(req: FastifyRequest, permission: Permission) {
    const auth = req.requireAuth();
    const effective = await req.effectivePermissions();
    if (!holdsAnywhere(effective, permission, auth.operatorId)) throw new PermissionDeniedError(permission);
    return { auth, effective };
  }

  const ctxOf = (req: FastifyRequest, auth: { operatorId: string; accountId: string }): SettingsCtx => ({
    operatorId: auth.operatorId,
    accountId: auth.accountId,
    requestId: req.id,
    now: new Date(),
  });

  /** The KB's reach: `inbox:kb:manage` held somewhere, then resolved to parks. */
  async function kbCaller(req: FastifyRequest) {
    const { auth, effective } = await callerHolding(req, KB_MANAGE);
    return { auth, reach: await reachOf(app.db, effective, KB_MANAGE, auth.operatorId) };
  }

  /** The examples queue belongs to no park: operator reach of `inbox:kb:manage`. */
  async function queueCaller(req: FastifyRequest) {
    const { auth, reach } = await kbCaller(req);
    if (!reach.operatorWide) throw new PermissionDeniedError(KB_MANAGE);
    return { auth };
  }

  function viewersOf(
    auth: { operatorId: string; accountId: string },
    effective: Awaited<ReturnType<FastifyRequest['effectivePermissions']>>,
  ): CorrectViewers {
    return {
      read: { accountId: auth.accountId, operatorId: auth.operatorId, scope: viewerScopeOf(effective, auth.accountId, auth.operatorId) },
      reply: replyViewerOf(effective, auth.accountId, auth.operatorId),
    };
  }

  // --- The knowledge base -------------------------------------------------------------------

  app.get(
    '/kb',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The assistant’s knowledge base for the Assistant settings page: every entry of the operator (draft and ' +
          'approved; archived only with `status=archived`), filtered by language, topic or status, each saying ' +
          'whether the viewer may manage it (`canManage`: inbox:kb:manage at its park, or operator-wide for a ' +
          'both-parks entry). Only approved entries reach the assistant. Needs inbox:kb:manage somewhere in the operator.',
        querystring: InboxKbListQuerySchema,
        response: { 200: InboxKbListSchema },
      },
    },
    async (req) => {
      const { auth, reach } = await kbCaller(req);
      return listKb(app.db, auth.operatorId, reach, req.query);
    },
  );

  app.post(
    '/kb',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Draft a knowledge-base entry: a topic, a stable key (a slug such as faq.food-outside, the id the assistant ' +
          'cites), a language (th, en, ru), the question as a customer would ask it (1–200 characters) and the fact ' +
          '(1–1,200), for one park or both (`branchId` null). Always a draft until approved. One live entry per key, ' +
          'language and park (409 KB_KEY_TAKEN). `sourceExampleId` promotes an APPROVED example (409 ' +
          'EXAMPLE_NOT_APPROVED). The body id is caller-named. Needs inbox:kb:manage at the park, or operator-wide ' +
          'for a both-parks entry. Audited as inbox.kb.create (ids, key, lengths — never the words).',
        body: InboxKbCreateSchema,
        response: { 200: InboxKbEntrySchema },
      },
    },
    async (req, reply) => {
      const { auth, reach } = await kbCaller(req);
      const made = await withTx(app.db, opCtx(req), 'inbox.kb.create', (tx) =>
        createKb(tx, ctxOf(req, auth), reach, req.body),
      );
      if (wasReplay(made)) reply.header(REPLAY_HEADER, 'true');
      return made;
    },
  );

  app.patch(
    '/kb/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Edit an entry: its topic, key, language, park, question, fact or needsTranslation. A draft is changed in ' +
          'place. An approved entry is revised at once: the row the assistant cited is archived with its words kept, ' +
          'and the answer is a new row, already approved by the editor, under a new id. An archived entry answers ' +
          '409 KB_ARCHIVED. Needs inbox:kb:manage over the entry as it stands and as it will be.',
        params: IdParams,
        body: InboxKbPatchSchema,
        response: { 200: InboxKbEntrySchema },
      },
    },
    async (req) => {
      const { auth, reach } = await kbCaller(req);
      return withTx(app.db, opCtx(req), 'inbox.kb.update', (tx) =>
        updateKb(tx, ctxOf(req, auth), reach, req.params.id, req.body),
      );
    },
  );

  app.post(
    '/kb/:id/approve',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Approve a draft: the approver and the time are recorded and the entry reaches the assistant from its next ' +
          'turn (a row still marked needsTranslation is held back; its English row is used). An archived entry ' +
          'answers 409 KB_ARCHIVED; an approved one is answered as it stands. Needs inbox:kb:manage at its park.',
        params: IdParams,
        response: { 200: InboxKbEntrySchema },
      },
    },
    async (req) => {
      const { auth, reach } = await kbCaller(req);
      return withTx(app.db, opCtx(req), 'inbox.kb.approve', (tx) => approveKb(tx, ctxOf(req, auth), reach, req.params.id));
    },
  );

  app.post(
    '/kb/:id/archive',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Archive an entry: it leaves the assistant and frees its key for a new draft. Never deleted. Archiving ' +
          'twice is the same act. Needs inbox:kb:manage at its park.',
        params: IdParams,
        response: { 200: InboxKbEntrySchema },
      },
    },
    async (req) => {
      const { auth, reach } = await kbCaller(req);
      return withTx(app.db, opCtx(req), 'inbox.kb.archive', (tx) => archiveKb(tx, ctxOf(req, auth), reach, req.params.id));
    },
  );

  // --- The curated examples -----------------------------------------------------------------

  app.get(
    '/ai/examples',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The examples queue: corrected answers, newest first, filtered by status, intent or language, and the ' +
          'assistant’s intents for the editor’s picker. Approved examples reach the assistant (at most thirty). ' +
          'Needs inbox:kb:manage with operator reach (operator-wide, or an operator-wide department such as Marketing).',
        querystring: InboxAiExampleListQuerySchema,
        response: { 200: InboxAiExampleListSchema },
      },
    },
    async (req) => {
      const { auth } = await queueCaller(req);
      return listExamples(app.db, auth.operatorId, req.query);
    },
  );

  app.post(
    '/ai/examples',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          '"Correct the assistant": propose an example from a message — an AI line, or the customer message an ' +
          'ai_silent pill stayed silent on. The caller writes the customer text WITH PERSONAL DATA REMOVED (1–500 ' +
          'characters), the verdict, and for should_answer the good reply (1–800). Language and intent come from the ' +
          'assistant’s turn for that message, else the thread; `language` / `intent` override them (409 ' +
          'LANGUAGE_REQUIRED / INTENT_REQUIRED when neither names one). The thread is not changed. The example keeps ' +
          'its source links until it is approved. The body id is caller-named. 404 when the message is not in a ' +
          'thread the caller can see; needs inbox:conversation:reply on that thread.',
        body: InboxAiExampleCreateSchema,
        response: { 200: InboxAiExampleSchema },
      },
    },
    async (req, reply) => {
      const { auth, effective } = await callerHolding(req, 'inbox:conversation:reply');
      const made = await withTx(app.db, opCtx(req), 'inbox.ai_example.create', (tx) =>
        createExample(tx, ctxOf(req, auth), viewersOf(auth, effective), req.body),
      );
      if (wasReplay(made)) reply.header(REPLAY_HEADER, 'true');
      return made;
    },
  );

  app.post(
    '/ai/examples/import',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Import 1–50 examples from outside the inbox — the park’s own chat history, de-identified before it is ' +
          'sent. Each names its intent (one of the assistant’s, else 409 INTENT_UNKNOWN), its language (th, en, ru), ' +
          'its verdict, the customer text (1–500) and, for should_answer, the good reply (1–800; else 409 ' +
          'GOOD_REPLY_REQUIRED). Each lands PROPOSED with no source links and waits in the examples queue: nothing ' +
          'reaches the assistant until a person approves it. All or nothing: an item whose text still looks like ' +
          'personal data — a phone number or another long number, an e-mail, a web address with a query string, a ' +
          'messaging handle such as "line: @x" — is refused 400 PERSONAL_DATA_FOUND naming its index and field, ' +
          'and nothing is saved. Ids are caller-named: an id already naming one of the caller’s examples is a ' +
          'replay of it (counted in `replayed`, nothing written); one naming any other record is 409 ID_IN_USE. ' +
          'Needs inbox:kb:manage with operator reach. Audited as inbox.ai_example.create per example and ' +
          'inbox.ai_example.import for the request (counts and ids — never the words).',
        body: InboxAiExampleImportSchema,
        response: { 200: InboxAiExampleImportResultSchema },
      },
    },
    async (req, reply) => {
      const { auth } = await queueCaller(req);
      const made = await withTx(app.db, opCtx(req), 'inbox.ai_example.import', (tx) =>
        importExamples(tx, ctxOf(req, auth), req.body),
      );
      if (wasReplay(made)) reply.header(REPLAY_HEADER, 'true');
      return made;
    },
  );

  app.patch(
    '/ai/examples/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Edit a PROPOSED example: the customer text, the good reply, the verdict, the intent or the language. ' +
          'Otherwise 409 EXAMPLE_NOT_PROPOSED. A should_answer verdict needs a good reply (409 GOOD_REPLY_REQUIRED). ' +
          'Needs inbox:kb:manage with operator reach.',
        params: IdParams,
        body: InboxAiExamplePatchSchema,
        response: { 200: InboxAiExampleSchema },
      },
    },
    async (req) => {
      const { auth } = await queueCaller(req);
      return withTx(app.db, opCtx(req), 'inbox.ai_example.update', (tx) =>
        updateExample(tx, ctxOf(req, auth), req.params.id, req.body),
      );
    },
  );

  app.post(
    '/ai/examples/:id/approve',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Approve a proposed example. REQUIRES `deidentifiedConfirmed: true` — the approver’s confirmation that it ' +
          'contains no personal data — else 409 DEIDENTIFICATION_REQUIRED. Approval severs it from its thread: both ' +
          'source links are nulled, the approver and time recorded, and it reaches the assistant from its next turn. ' +
          'A rejected one answers 409 EXAMPLE_REJECTED; an approved one is answered as it stands. Needs ' +
          'inbox:kb:manage with operator reach.',
        params: IdParams,
        body: InboxAiExampleApproveBodySchema,
        response: { 200: InboxAiExampleSchema },
      },
    },
    async (req) => {
      const { auth } = await queueCaller(req);
      return withTx(app.db, opCtx(req), 'inbox.ai_example.approve', (tx) =>
        approveExample(tx, ctxOf(req, auth), req.params.id, req.body),
      );
    },
  );

  app.post(
    '/ai/examples/:id/reject',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Reject an example (its archive): out of the queue, and out of the assistant if it was approved. ' +
          'Rejecting twice is the same act. Needs inbox:kb:manage with operator reach.',
        params: IdParams,
        response: { 200: InboxAiExampleSchema },
      },
    },
    async (req) => {
      const { auth } = await queueCaller(req);
      return withTx(app.db, opCtx(req), 'inbox.ai_example.reject', (tx) => rejectExample(tx, ctxOf(req, auth), req.params.id));
    },
  );

  app.delete(
    '/ai/examples/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Delete a PROPOSED example (a draft that may hold a thread’s words). An approved or rejected one answers ' +
          '409 EXAMPLE_NOT_DELETABLE — reject it instead. Needs inbox:kb:manage with operator reach.',
        params: IdParams,
        response: { 200: InboxAiExampleDeletedSchema },
      },
    },
    async (req) => {
      const { auth } = await queueCaller(req);
      return withTx(app.db, opCtx(req), 'inbox.ai_example.delete', (tx) => deleteExample(tx, ctxOf(req, auth), req.params.id));
    },
  );

  // --- The behaviour rules (SCRUM-696) --------------------------------------------------------

  app.get(
    '/ai/rules',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The assistant’s behaviour rules for the Assistant page: every rule of the operator (draft and approved; ' +
          'archived only with `status=archived`), newest first, each saying whether the viewer may manage it ' +
          '(`canManage`: inbox:kb:manage at its park, or operator-wide for a both-parks rule). Only approved rules ' +
          'reach the assistant. Needs inbox:kb:manage somewhere in the operator.',
        querystring: InboxAiRuleListQuerySchema,
        response: { 200: InboxAiRuleListSchema },
      },
    },
    async (req) => {
      const { auth, reach } = await kbCaller(req);
      return listRules(app.db, auth.operatorId, reach, req.query);
    },
  );

  app.post(
    '/ai/rules',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Draft a behaviour rule: the intent it is about (one of the assistant’s, or `any`; else 409 INTENT_UNKNOWN), ' +
          'the instruction in plain words (1–600 characters), and optionally a question to ask first (`askFirst`: ' +
          '`branch_unknown` asks only while no park is known, `always` once per conversation), for one park or both ' +
          '(`branchId` null). A rule only adds a question or an instruction: one that carries numbers, a link, a date, ' +
          'or grants a price, a discount, free entry, a refund, compensation or a booking is refused 400 RULE_UNSAFE ' +
          'with a sentence. The question is never asked before a complaint, a refund, a request for a person, a ' +
          'greeting, a goodbye or an identity question. Always a draft until approved. The body id is caller-named. ' +
          'Needs inbox:kb:manage at the park, or operator-wide for a both-parks rule. Audited as inbox.ai_rule.create ' +
          '(ids, intent, lengths — never the words).',
        body: InboxAiRuleCreateSchema,
        response: { 200: InboxAiRuleSchema },
      },
    },
    async (req, reply) => {
      const { auth, reach } = await kbCaller(req);
      const made = await withTx(app.db, opCtx(req), 'inbox.ai_rule.create', (tx) =>
        createRule(tx, ctxOf(req, auth), reach, req.body),
      );
      if (wasReplay(made)) reply.header(REPLAY_HEADER, 'true');
      return made;
    },
  );

  app.patch(
    '/ai/rules/:id',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Edit a rule: its intent, park, instruction or ask-first question, under the same checks as a new one ' +
          '(400 RULE_UNSAFE, 409 INTENT_UNKNOWN). A draft is changed in place. An approved rule is revised at once: ' +
          'the row the assistant followed is archived with its words kept, and the answer is a new row, already ' +
          'approved by the editor, under a new id. An archived rule answers 409 RULE_ARCHIVED. Needs inbox:kb:manage ' +
          'over the rule as it stands and as it will be.',
        params: IdParams,
        body: InboxAiRulePatchSchema,
        response: { 200: InboxAiRuleSchema },
      },
    },
    async (req) => {
      const { auth, reach } = await kbCaller(req);
      return withTx(app.db, opCtx(req), 'inbox.ai_rule.update', (tx) =>
        updateRule(tx, ctxOf(req, auth), reach, req.params.id, req.body),
      );
    },
  );

  app.post(
    '/ai/rules/:id/approve',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Approve a draft rule: the approver and the time are recorded and the assistant follows it from its next ' +
          'turn. An archived rule answers 409 RULE_ARCHIVED; an approved one is answered as it stands. Needs ' +
          'inbox:kb:manage at its park.',
        params: IdParams,
        response: { 200: InboxAiRuleSchema },
      },
    },
    async (req) => {
      const { auth, reach } = await kbCaller(req);
      return withTx(app.db, opCtx(req), 'inbox.ai_rule.approve', (tx) => approveRule(tx, ctxOf(req, auth), reach, req.params.id));
    },
  );

  app.post(
    '/ai/rules/:id/archive',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Archive a rule: the assistant stops following it. Never deleted. Archiving twice is the same act. Needs ' +
          'inbox:kb:manage at its park.',
        params: IdParams,
        response: { 200: InboxAiRuleSchema },
      },
    },
    async (req) => {
      const { auth, reach } = await kbCaller(req);
      return withTx(app.db, opCtx(req), 'inbox.ai_rule.archive', (tx) => archiveRule(tx, ctxOf(req, auth), reach, req.params.id));
    },
  );

  app.post(
    '/ai/teach',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The teach chat on the Assistant page: the conversation so far (at most the last 20 messages, the last one ' +
          'the staff member’s) goes to a curator that reads the same knowledge as the customer assistant. It answers ' +
          '“what do you say today when…”, saves what it is taught as DRAFT knowledge-base entries and rules (a card ' +
          'for each, to approve under Assistant → Knowledge or Rules), refuses anything that would loosen the ' +
          'assistant’s safety rules, and may show a dry run: what the assistant would do now with one customer ' +
          'message (the decision, the checks and any ask-first rule; no closing line, routing or silence policy). ' +
          'Nothing is sent to a customer and no conversation is read or written. 503 TEACH_UNAVAILABLE when the ' +
          'assistant is not switched on for this deployment. Needs inbox:kb:manage with operator reach.',
        body: InboxAiTeachRequestSchema,
        response: { 200: InboxAiTeachResponseSchema },
      },
    },
    async (req) => {
      const { auth, reach } = await kbCaller(req);
      if (!reach.operatorWide) throw new PermissionDeniedError(KB_MANAGE);
      const teacher = app.inboxAi.teacher ?? null;
      if (teacher === null) throw new AppError(503, 'TEACH_UNAVAILABLE', TEACH_LINES.unavailable);
      return teach({ db: app.db, runtime: app.inboxAi, op: toolOpCtx(opCtx(req)) }, ctxOf(req, auth), reach, req.body);
    },
  );

  // --- The controls -------------------------------------------------------------------------

  app.get(
    '/ai/channel-accounts',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'The numbers whose assistant the caller may switch, with each one’s `aiMode`: live accounts that can reply ' +
          '(a check-in notice sender carries no assistant), at the branches the caller holds inbox:ai:manage at, and ' +
          'the operator-wide ones when they hold it operator-wide. Needs inbox:ai:manage somewhere in the operator.',
        response: { 200: InboxAiChannelAccountListSchema },
      },
    },
    async (req) => {
      const { auth, effective } = await callerHolding(req, AI_MANAGE);
      return listAiChannelAccounts(app.db, auth.operatorId, await reachOf(app.db, effective, AI_MANAGE, auth.operatorId));
    },
  );

  app.patch(
    '/channel-accounts/:id/ai-mode',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Switch a number’s assistant: `off` (no turn is written), `shadow` (decides and writes nothing to the ' +
          'thread) or `live` (answers). Every number starts off. A notice sender cannot be switched on (409 ' +
          'CHANNEL_CANNOT_REPLY). The same mode again writes nothing. Needs inbox:ai:manage at the number’s branch, ' +
          'or operator-wide for an operator-wide number. Audited as inbox.ai.mode.',
        params: IdParams,
        body: InboxAiModeBodySchema,
        response: { 200: InboxAiChannelAccountSchema },
      },
    },
    async (req) => {
      const { auth, effective } = await callerHolding(req, AI_MANAGE);
      const reach = await reachOf(app.db, effective, AI_MANAGE, auth.operatorId);
      return withTx(app.db, opCtx(req), 'inbox.ai.mode', (tx) =>
        setAiMode(tx, ctxOf(req, auth), reach, req.params.id, req.body.aiMode),
      );
    },
  );

  /** The pause routes' first gate: reply, or the assistant permission, held somewhere in the operator. */
  async function pauseCaller(req: FastifyRequest) {
    const auth = req.requireAuth();
    const effective = await req.effectivePermissions();
    if (
      !holdsAnywhere(effective, 'inbox:conversation:reply', auth.operatorId) &&
      !holdsAnywhere(effective, AI_MANAGE, auth.operatorId)
    ) {
      throw new PermissionDeniedError('inbox:conversation:reply');
    }
    return { auth, effective };
  }

  app.post(
    '/conversations/:id/ai-pause',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Pause the assistant on this thread: it writes no turn here until resumed. In the same transaction every ' +
          'pending or deciding turn is cancelled (PAUSED) and every unsent AI line withdrawn; the answer counts them. ' +
          'Pausing a paused thread is the same act. 404 when the caller cannot see the thread; needs ' +
          'inbox:conversation:reply on it (the reply route’s rule), or inbox:ai:manage at it. Audited as inbox.ai.pause.',
        params: IdParams,
        response: { 200: InboxAiPauseSchema },
      },
    },
    async (req) => {
      const { auth, effective } = await pauseCaller(req);
      return withTx(app.db, opCtx(req), 'inbox.ai.pause', (tx) =>
        setAiPaused(tx, ctxOf(req, auth), viewersOf(auth, effective), effective, req.params.id, true),
      );
    },
  );

  app.post(
    '/conversations/:id/ai-resume',
    {
      config: { dynamicPermission: true },
      schema: {
        description:
          'Resume the assistant on this thread: the pause (who and when) is cleared. No turn is written now; the next ' +
          'customer message writes one if the thread is then eligible. Resuming an unpaused thread is the same act. ' +
          'Same rule as the pause; audited as inbox.ai.pause with `paused: false`.',
        params: IdParams,
        response: { 200: InboxAiPauseSchema },
      },
    },
    async (req) => {
      const { auth, effective } = await pauseCaller(req);
      return withTx(app.db, opCtx(req), 'inbox.ai.resume', (tx) =>
        setAiPaused(tx, ctxOf(req, auth), viewersOf(auth, effective), effective, req.params.id, false),
      );
    },
  );
}
