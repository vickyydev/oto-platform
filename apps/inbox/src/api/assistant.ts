// The assistant's calls (SCRUM-590, round A3; plan §C.2, §E, §A.3).
//
// THE A3a SEAM. The api half of this round (lane ai-a3a) builds these routes
// in parallel; when this lane was written they were not yet in
// `@oto/api-types` on main. So — and ONLY here — the shapes below are written
// by hand, matched to a3a's working-tree description of its routes (read, not
// imported, on 2026-10-20) and to the schema. Each is marked `A3A-SEAM` with
// the generated type that replaces it once a3a lands: the landing swaps every
// hand shape for its `ApiResponse` / `ApiBody`, and the seam walker
// (packages/api-types/test/seam-walker.test.ts) then checks each call below
// reaches its route. Until then a route that is not there answers 404 and
// every screen that uses one says so in plain words (`routeMissing`).
import type { InboxChannelKey } from '@oto/shared/inbox';
import type { ConversationDetail, InboxMe } from './inbox';
import { ApiError, api, idemKey, qs } from './client';

/** `channel_account.ai_mode` (§D.4 kill switch 2). */
export type AiMode = 'off' | 'shadow' | 'live';
export type KbStatus = 'draft' | 'approved' | 'archived';
export type KbLanguage = 'th' | 'en' | 'ru';
export type ExampleVerdict = 'should_answer' | 'should_handover' | 'should_stay_silent';
export type ExampleStatus = 'proposed' | 'approved' | 'rejected';

/** A3A-SEAM: ApiResponse<'/inbox/kb', 'get'>['entries'][number]. */
export interface KbEntry {
  id: string;
  branchId: string | null;
  topic: string;
  key: string;
  language: KbLanguage;
  question: string;
  body: string;
  status: KbStatus;
  needsTranslation: boolean;
  sourceExampleId: string | null;
  updatedByAccountId: string | null;
  approvedByAccountId: string | null;
  approvedAt: string | null;
  /** inbox:kb:manage at its park (or operator-wide for a both-parks entry). */
  canManage: boolean;
  createdAt: string;
  updatedAt: string;
}

/** A3A-SEAM: ApiBody<'/inbox/kb', 'post'>. The id is caller-named (id-conformance). */
export interface KbEntryCreate {
  id: string;
  branchId: string | null;
  topic: string;
  key: string;
  language: KbLanguage;
  question: string;
  body: string;
  needsTranslation: boolean;
}
/** A3A-SEAM: ApiBody<'/inbox/kb/{id}', 'patch'> — a DRAFT only (409 KB_NOT_DRAFT otherwise). */
export type KbEntryPatch = Partial<Omit<KbEntryCreate, 'id'>>;

/** A3A-SEAM: ApiResponse<'/inbox/ai/examples', 'get'>['examples'][number]. */
export interface AiExample {
  id: string;
  intent: string;
  language: KbLanguage;
  customerText: string;
  goodReply: string | null;
  verdict: ExampleVerdict;
  status: ExampleStatus;
  /** Present while proposed; nulled on approval (the de-identification rule). */
  sourceMessageId: string | null;
  sourceConversationId: string | null;
  proposedByAccountId: string;
  approvedByAccountId: string | null;
  approvedAt: string | null;
  deidentifiedConfirmed: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A3A-SEAM: ApiBody<'/inbox/ai/examples', 'post'> — "create from message".
 * `intent` and `language` left out are taken by the server from the
 * assistant's turn for that message, else the thread.
 */
export interface AiExampleCreate {
  id: string;
  /** The AI line being corrected, or the customer message an ai_silent pill stayed silent on. */
  messageId: string;
  customerText: string;
  goodReply: string | null;
  verdict: ExampleVerdict;
  intent?: string;
  language?: KbLanguage;
}
/** A3A-SEAM: ApiBody<'/inbox/ai/examples/{id}', 'patch'> — a PROPOSED example only. */
export type AiExamplePatch = Partial<Pick<AiExampleCreate, 'customerText' | 'goodReply' | 'verdict' | 'intent' | 'language'>>;

/** A3A-SEAM: ApiResponse<'/inbox/ai/channel-accounts', 'get'>['channelAccounts'][number]. */
export interface AiChannelAccount {
  id: string;
  channel: InboxChannelKey;
  provider: string;
  displayName: string;
  branchId: string | null;
  canReply: boolean;
  aiMode: AiMode;
}

/** A3A-SEAM: ApiResponse<'/inbox/conversations/{id}/ai-pause', 'post'> (and ai-resume). */
export interface AiPauseResult {
  conversationId: string;
  aiPaused: boolean;
  aiPausedAt: string | null;
  aiPausedByAccountId: string | null;
  turnsCancelled: number;
  messagesWithdrawn: number;
}

/**
 * A3A-SEAM: the two `/inbox/me` capabilities this round reads —
 * `kb` (inbox:kb:manage: the knowledge base and the examples queue) and `ai`
 * (inbox:ai:manage: the per-number mode switch). Absent until a3a lands, so
 * read as optional: absent is "no".
 */
export function assistantCapabilities(me: Pick<InboxMe, 'capabilities'>): { kb: boolean; ai: boolean } {
  const caps = me.capabilities as InboxMe['capabilities'] & { kb?: boolean; ai?: boolean };
  return { kb: caps.kb === true, ai: caps.ai === true };
}

/** A3A-SEAM: the additive `aiPaused` on the thread (conversation.ai_paused_at). Absent reads as running. */
export function threadAiPaused(detail: ConversationDetail | null): boolean {
  return (detail as (ConversationDetail & { aiPaused?: boolean }) | null)?.aiPaused === true;
}

/**
 * A route that is not there yet: the api's framework answers an unknown path
 * 404 with no error envelope (so no code), unlike a route's own 404 refusals,
 * which always carry one.
 */
export function routeMissing(err: unknown): boolean {
  return err instanceof ApiError && err.status === 404 && err.code === 'UNKNOWN';
}

/** What every assistant screen says while its route is not there yet. */
export const NOT_YET_SWITCHED_ON = 'Not switched on yet: this arrives with the assistant’s knowledge-base build.';

const kbAt = (id: string) => `/inbox/kb/${encodeURIComponent(id)}`;
const exampleAt = (id: string) => `/inbox/ai/examples/${encodeURIComponent(id)}`;
const convAt = (id: string) => `/inbox/conversations/${encodeURIComponent(id)}`;

export const assistantApi = {
  // --- The knowledge base (inbox:kb:manage) -----------------------------------------
  /** Drafts and approved entries; with `archived`, the archived ones instead. */
  kb: (archived: boolean) =>
    api.get<{ entries: KbEntry[] }>(`/inbox/kb${qs({ status: archived ? 'archived' : undefined })}`),
  createKb: (body: KbEntryCreate) =>
    api.post<KbEntry>(
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
  updateKb: (id: string, patch: KbEntryPatch) =>
    api.patch<KbEntry>(
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
  approveKb: (id: string) => api.post<KbEntry>(`${kbAt(id)}/approve`, undefined, { idempotencyKey: idemKey() }),
  archiveKb: (id: string) => api.post<KbEntry>(`${kbAt(id)}/archive`, undefined, { idempotencyKey: idemKey() }),

  // --- The examples queue (§E; inbox:kb:manage with operator reach) -------------------
  examples: (status: ExampleStatus) =>
    api.get<{ examples: AiExample[]; intents: string[] }>(`/inbox/ai/examples${qs({ status })}`),
  /** "Correct the assistant" (needs inbox:conversation:reply on the thread). */
  createExample: (body: AiExampleCreate) =>
    api.post<AiExample>(
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
  updateExample: (id: string, patch: AiExamplePatch) =>
    api.patch<AiExample>(
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
    api.post<AiExample>(`${exampleAt(id)}/approve`, { deidentifiedConfirmed: true }, { idempotencyKey: idemKey() }),
  rejectExample: (id: string) => api.post<AiExample>(`${exampleAt(id)}/reject`, undefined, { idempotencyKey: idemKey() }),
  /** A proposed example only: it may still hold a thread's words. */
  deleteExample: (id: string) => api.delete<unknown>(exampleAt(id), { idempotencyKey: idemKey() }),

  // --- The per-number switch (inbox:ai:manage) ---------------------------------------
  channelAccounts: () => api.get<{ channelAccounts: AiChannelAccount[] }>('/inbox/ai/channel-accounts'),
  setAiMode: (id: string, aiMode: AiMode) =>
    api.patch<AiChannelAccount>(
      `/inbox/channel-accounts/${encodeURIComponent(id)}/ai-mode`,
      { aiMode },
      { idempotencyKey: idemKey() },
    ),

  // --- The per-thread pause (§A.3; the reply rule, or inbox:ai:manage) ------------------
  pause: (conversationId: string) =>
    api.post<AiPauseResult>(`${convAt(conversationId)}/ai-pause`, undefined, { idempotencyKey: idemKey() }),
  resume: (conversationId: string) =>
    api.post<AiPauseResult>(`${convAt(conversationId)}/ai-resume`, undefined, { idempotencyKey: idemKey() }),

  // --- The birthday brochure (§C.5): a file on a handover_birthday template row --------
  /**
   * NOT IN a3a: no route takes a template attachment yet (`/files/` owner
   * types stop at the POS's; the template create/patch bodies carry no
   * `attachmentFileIds`). The shell sends the PDF's bytes to this path; until
   * a route answers it, the upload says it is not switched on yet. The path
   * and method are this lane's proposal for whoever builds the route.
   */
  uploadBrochure: (templateId: string, file: File) =>
    api.put<unknown>(`/inbox/templates/${encodeURIComponent(templateId)}/brochure`, file, { idempotencyKey: idemKey() }),
};
