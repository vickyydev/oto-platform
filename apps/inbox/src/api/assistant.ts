// The assistant's calls (SCRUM-590, round A3; plan §C.2, §E, §A.3, §C.5),
// every one typed from the api's own description (`@oto/api-types`), as
// `inbox.ts` is: a route that changes its answer fails this app's typecheck,
// and the seam walker (packages/api-types/test/seam-walker.test.ts) checks
// each call below reaches the route its type names.
import type { ApiBody, ApiQuery, ApiResponse } from '@oto/api-types';
import type { InboxMe } from './inbox';
import { ApiError, api, idemKey, qs } from './client';

export type KbList = ApiResponse<'/inbox/kb', 'get'>;
export type KbEntry = KbList['entries'][number];
export type KbEntryCreate = ApiBody<'/inbox/kb', 'post'>;
export type KbEntryPatch = ApiBody<'/inbox/kb/{id}', 'patch'>;
export type KbStatus = KbEntry['status'];
export type KbLanguage = KbEntry['language'];
export type KbTopic = KbEntry['topic'];

export type ExampleList = ApiResponse<'/inbox/ai/examples', 'get'>;
export type AiExample = ExampleList['examples'][number];
export type ExampleStatus = NonNullable<NonNullable<ApiQuery<'/inbox/ai/examples', 'get'>>['status']>;
export type ExampleVerdict = AiExample['verdict'];
export type AiExampleCreate = ApiBody<'/inbox/ai/examples', 'post'>;
export type AiExamplePatch = ApiBody<'/inbox/ai/examples/{id}', 'patch'>;

// --- Behaviour rules and the teach chat (SCRUM-696) -------------------------------------
export type RuleList = ApiResponse<'/inbox/ai/rules', 'get'>;
export type AiRule = RuleList['rules'][number];
export type RuleStatus = NonNullable<NonNullable<ApiQuery<'/inbox/ai/rules', 'get'>>['status']>;
export type RuleAskFirst = NonNullable<AiRule['askFirst']>;
export type RuleCondition = RuleAskFirst['condition'];
export type RuleSource = AiRule['source'];
export type AiRuleCreate = ApiBody<'/inbox/ai/rules', 'post'>;
export type AiRulePatch = ApiBody<'/inbox/ai/rules/{id}', 'patch'>;
export type TeachRequest = ApiBody<'/inbox/ai/teach', 'post'>;
export type TeachMessage = TeachRequest['messages'][number];
export type TeachReply = ApiResponse<'/inbox/ai/teach', 'post'>;
export type TeachCard = TeachReply['cards'][number];
export type TeachDryRun = NonNullable<TeachReply['dryRun']>;
export type TeachOutcome = TeachDryRun['outcome'];

export type AiChannelAccount = ApiResponse<'/inbox/ai/channel-accounts', 'get'>['channelAccounts'][number];
export type AiMode = AiChannelAccount['aiMode'];
export type AiPauseResult = ApiResponse<'/inbox/conversations/{id}/ai-pause', 'post'>;

/**
 * The two `/inbox/me` capabilities this round reads: `kb` (inbox:kb:manage:
 * the knowledge base and the examples queue) and `ai` (inbox:ai:manage: the
 * per-number mode switch).
 */
export function assistantCapabilities(me: Pick<InboxMe, 'capabilities'>): { kb: boolean; ai: boolean } {
  return { kb: me.capabilities.kb, ai: me.capabilities.ai };
}

/**
 * A refusal that means "not on your access" rather than a fault: a 403, or a
 * route this deployment does not have (the framework's bare 404, no code).
 * The examples queue needs inbox:kb:manage with OPERATOR reach, so a holder
 * whose grant is branch-scoped sees `kb: true` and is refused there.
 */
export function notOnAccess(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 403 || (err.status === 404 && err.code === 'UNKNOWN'));
}

/** What a screen says when `notOnAccess`. */
export const NOT_ON_YOUR_ACCESS = 'This is not on your access. Ask an Inbox administrator if you need it.';

const kbAt = (id: string) => `/inbox/kb/${encodeURIComponent(id)}`;
const exampleAt = (id: string) => `/inbox/ai/examples/${encodeURIComponent(id)}`;
const convAt = (id: string) => `/inbox/conversations/${encodeURIComponent(id)}`;
const ruleAt = (id: string) => `/inbox/ai/rules/${encodeURIComponent(id)}`;

export const assistantApi = {
  // --- The knowledge base (inbox:kb:manage) -----------------------------------------
  /** Drafts and approved entries; with `archived`, the archived ones instead. */
  kb: (archived: boolean) =>
    api.get<ApiResponse<'/inbox/kb', 'get'>>(`/inbox/kb${qs({ status: archived ? 'archived' : undefined })}`),
  /** The drafts only: what a Teach card shows before it is approved. */
  kbDrafts: () => api.get<ApiResponse<'/inbox/kb', 'get'>>(`/inbox/kb${qs({ status: 'draft' })}`),
  createKb: (body: KbEntryCreate) =>
    api.post<ApiResponse<'/inbox/kb', 'post'>>(
      '/inbox/kb',
      {
        id: body.id,
        branchId: body.branchId,
        topic: body.topic,
        key: body.key,
        language: body.language,
        question: body.question,
        body: body.body,
        needsTranslation: body.needsTranslation,
      },
      { idempotencyKey: idemKey() },
    ),
  /** A draft is changed in place; an approved entry is replaced at once (the answer carries the new id); archived: 409 KB_ARCHIVED. */
  updateKb: (id: string, patch: KbEntryPatch) =>
    api.patch<ApiResponse<'/inbox/kb/{id}', 'patch'>>(
      kbAt(id),
      {
        branchId: patch.branchId,
        topic: patch.topic,
        key: patch.key,
        language: patch.language,
        question: patch.question,
        body: patch.body,
        needsTranslation: patch.needsTranslation,
      },
      { idempotencyKey: idemKey() },
    ),
  approveKb: (id: string) =>
    api.post<ApiResponse<'/inbox/kb/{id}/approve', 'post'>>(`${kbAt(id)}/approve`, undefined, { idempotencyKey: idemKey() }),
  archiveKb: (id: string) =>
    api.post<ApiResponse<'/inbox/kb/{id}/archive', 'post'>>(`${kbAt(id)}/archive`, undefined, { idempotencyKey: idemKey() }),

  // --- The examples queue (§E; inbox:kb:manage with operator reach) -------------------
  examples: (status: ExampleStatus) =>
    api.get<ApiResponse<'/inbox/ai/examples', 'get'>>(`/inbox/ai/examples${qs({ status })}`),
  /** "Correct the assistant" (needs inbox:conversation:reply on the thread). */
  createExample: (body: AiExampleCreate) =>
    api.post<ApiResponse<'/inbox/ai/examples', 'post'>>(
      '/inbox/ai/examples',
      {
        id: body.id,
        messageId: body.messageId,
        customerText: body.customerText,
        goodReply: body.goodReply,
        verdict: body.verdict,
        intent: body.intent,
        language: body.language,
      },
      { idempotencyKey: idemKey() },
    ),
  /** A PROPOSED example only. */
  updateExample: (id: string, patch: AiExamplePatch) =>
    api.patch<ApiResponse<'/inbox/ai/examples/{id}', 'patch'>>(
      exampleAt(id),
      {
        customerText: patch.customerText,
        goodReply: patch.goodReply,
        verdict: patch.verdict,
        intent: patch.intent,
        language: patch.language,
      },
      { idempotencyKey: idemKey() },
    ),
  /** The approver's "contains no personal data" confirmation travels with the approval (§D.5). */
  approveExample: (id: string) =>
    api.post<ApiResponse<'/inbox/ai/examples/{id}/approve', 'post'>>(
      `${exampleAt(id)}/approve`,
      { deidentifiedConfirmed: true },
      { idempotencyKey: idemKey() },
    ),
  /** An example's archive: out of the queue, and out of the assistant if approved. */
  rejectExample: (id: string) =>
    api.post<ApiResponse<'/inbox/ai/examples/{id}/reject', 'post'>>(`${exampleAt(id)}/reject`, undefined, {
      idempotencyKey: idemKey(),
    }),
  /** A proposed example only: it may still hold a thread's words. */
  deleteExample: (id: string) =>
    api.delete<ApiResponse<'/inbox/ai/examples/{id}', 'delete'>>(exampleAt(id), { idempotencyKey: idemKey() }),

  // --- Behaviour rules (SCRUM-696; inbox:kb:manage, reach as the knowledge base) ----------
  rules: (status: RuleStatus) => api.get<ApiResponse<'/inbox/ai/rules', 'get'>>(`/inbox/ai/rules${qs({ status })}`),
  /** Always saved as a draft. */
  createRule: (body: AiRuleCreate) =>
    api.post<ApiResponse<'/inbox/ai/rules', 'post'>>(
      '/inbox/ai/rules',
      { id: body.id, branchId: body.branchId, intent: body.intent, instruction: body.instruction, askFirst: body.askFirst },
      { idempotencyKey: idemKey() },
    ),
  /** A draft is changed in place; an approved rule is replaced at once (the answer carries the new id); archived: 409 RULE_ARCHIVED. */
  updateRule: (id: string, patch: AiRulePatch) =>
    api.patch<ApiResponse<'/inbox/ai/rules/{id}', 'patch'>>(
      ruleAt(id),
      { branchId: patch.branchId, intent: patch.intent, instruction: patch.instruction, askFirst: patch.askFirst },
      { idempotencyKey: idemKey() },
    ),
  approveRule: (id: string) =>
    api.post<ApiResponse<'/inbox/ai/rules/{id}/approve', 'post'>>(`${ruleAt(id)}/approve`, undefined, { idempotencyKey: idemKey() }),
  archiveRule: (id: string) =>
    api.post<ApiResponse<'/inbox/ai/rules/{id}/archive', 'post'>>(`${ruleAt(id)}/archive`, undefined, { idempotencyKey: idemKey() }),

  // --- The teach chat (SCRUM-696; inbox:kb:manage with operator reach) ---------------------
  /** The last messages of the chat, newest last, the last one the staff member's; nothing reaches a customer. */
  teach: (body: TeachRequest) =>
    api.post<ApiResponse<'/inbox/ai/teach', 'post'>>(
      '/inbox/ai/teach',
      { sessionId: body.sessionId, messages: body.messages },
      { idempotencyKey: idemKey() },
    ),

  // --- The per-number switch (inbox:ai:manage) ---------------------------------------
  channelAccounts: () => api.get<ApiResponse<'/inbox/ai/channel-accounts', 'get'>>('/inbox/ai/channel-accounts'),
  setAiMode: (id: string, aiMode: AiMode) =>
    api.patch<ApiResponse<'/inbox/channel-accounts/{id}/ai-mode', 'patch'>>(
      `/inbox/channel-accounts/${encodeURIComponent(id)}/ai-mode`,
      { aiMode },
      { idempotencyKey: idemKey() },
    ),

  // --- The per-thread pause (§A.3; the reply rule, or inbox:ai:manage) ------------------
  pause: (conversationId: string) =>
    api.post<ApiResponse<'/inbox/conversations/{id}/ai-pause', 'post'>>(`${convAt(conversationId)}/ai-pause`, undefined, {
      idempotencyKey: idemKey(),
    }),
  resume: (conversationId: string) =>
    api.post<ApiResponse<'/inbox/conversations/{id}/ai-resume', 'post'>>(`${convAt(conversationId)}/ai-resume`, undefined, {
      idempotencyKey: idemKey(),
    }),

  // --- The birthday brochure (§C.5): the file on a handover_birthday template row --------
  /** The file's raw bytes under its own type; answers the template with its attachment. */
  uploadBrochure: (templateId: string, file: File) =>
    api.put<ApiResponse<'/inbox/templates/{id}/brochure', 'put'>>(
      `/inbox/templates/${encodeURIComponent(templateId)}/brochure`,
      file,
      { idempotencyKey: idemKey() },
    ),
};

/** The brochure route's own limits (415 BROCHURE_WRONG_TYPE, 413 BROCHURE_TOO_LARGE). */
export const BROCHURE_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const;
export const BROCHURE_MAX_BYTES = 10 * 1024 * 1024;
