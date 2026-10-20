// The Inbox's calls (S2-19 I3a reads, SCRUM-587; I3b writes, SCRUM-588),
// every one typed from the api's own description (`@oto/api-types`,
// SCRUM-272): a route that changes its answer fails this app's typecheck the
// day it changes, and the seam walker
// (packages/api-types/test/seam-walker.test.ts) checks each call below reaches
// the route its type names. No hand-written response shapes here.
//
// The sign-on calls (`/auth/*`) are in `auth/`, untyped on purpose: those
// routes declare no response body, and their callers read nothing from one.
import type { ApiBody, ApiQuery, ApiResponse, paths } from '@oto/api-types';
import { api, idemKey, qs } from './client';

export type InboxMe = ApiResponse<'/inbox/me', 'get'>;
export type ConversationList = ApiResponse<'/inbox/conversations', 'get'>;
export type ConversationRow = ConversationList['conversations'][number];
export type Assignee = ConversationRow['assignments'][number];
export type ConversationDetail = ApiResponse<'/inbox/conversations/{id}', 'get'>;
export type InboxEvent = ConversationDetail['events'][number];
export type MessagePage = ApiResponse<'/inbox/conversations/{id}/messages', 'get'>;
export type Message = MessagePage['messages'][number];
export type Dashboard = ApiResponse<'/inbox/dashboard', 'get'>;
export type TemplateList = ApiResponse<'/inbox/templates', 'get'>;
export type Template = TemplateList['templates'][number];
export type ListQuery = ApiQuery<'/inbox/conversations', 'get'>;
export type Team = InboxMe['teams'][number];
export type Person = InboxMe['people'][number];
export type SimulatorAccount = NonNullable<InboxMe['simulator']>['channelAccounts'][number];
export type ReplyBody = ApiBody<'/inbox/conversations/{id}/messages', 'post'>;
/** The reply's 409 body, as the route describes it: the window and the templates that qualify. */
export type ReplyRefusal =
  paths['/inbox/conversations/{id}/messages']['post']['responses'][409]['content']['application/json'];
export type ReplyRefusalDetails = NonNullable<ReplyRefusal['error']['details']>;
export type QualifyingTemplate = NonNullable<ReplyRefusalDetails['qualifyingTemplates']>[number];
export type ManagedTemplate = ApiResponse<'/inbox/templates/manage', 'get'>['templates'][number];
export type TemplateCreate = ApiBody<'/inbox/templates', 'post'>;
export type TemplatePatch = ApiBody<'/inbox/templates/{id}', 'patch'>;
export type MoveDest = ApiBody<'/inbox/conversations/{id}/move', 'post'>['dest'];
export type PrimaryAssignee = ApiBody<'/inbox/conversations/{id}/primary', 'put'>['assignee'];
export type SimulatedInbound = ApiBody<'/inbox/simulator/inbound', 'post'>;

const at = (id: string) => `/inbox/conversations/${encodeURIComponent(id)}`;

export const inboxApi = {
  /** Who is reading, their tabs, the teams and people, what they may do, and the simulator. */
  me: () => api.get<ApiResponse<'/inbox/me', 'get'>>('/inbox/me'),

  conversations: (q: ListQuery) =>
    api.get<ApiResponse<'/inbox/conversations', 'get'>>(`/inbox/conversations${qs(q)}`),

  conversation: (id: string) => api.get<ApiResponse<'/inbox/conversations/{id}', 'get'>>(at(id)),

  /** The newest page, or with `before` the page older than that message. */
  messages: (id: string, before?: string) =>
    api.get<ApiResponse<'/inbox/conversations/{id}/messages', 'get'>>(`${at(id)}/messages${qs({ before })}`),

  /**
   * Mark read up to the newest message shown. It moves the viewer's own
   * unread marker and writes the day's sampled read audit (plan §3.6).
   */
  markRead: (id: string, body: ApiBody<'/inbox/conversations/{id}/read', 'post'>) =>
    api.post<ApiResponse<'/inbox/conversations/{id}/read', 'post'>>(
      `${at(id)}/read`,
      { messageId: body.messageId },
      { idempotencyKey: idemKey() },
    ),

  dashboard: () => api.get<ApiResponse<'/inbox/dashboard', 'get'>>('/inbox/dashboard'),

  /** The composer's standard lines, optionally in one language. */
  templates: (language?: string) =>
    api.get<ApiResponse<'/inbox/templates', 'get'>>(`/inbox/templates${qs({ language })}`),

  // --- The actions (I2e) -------------------------------------------------------------
  // Each answers the conversation's state and slots after it; the shell then
  // re-reads the thread for the names and the timeline's new pills.

  /** Replace the primary. 409 CATEGORY_MOVE_UNCONFIRMED until `confirmMove` when the new primary's team is not this one. */
  setPrimary: (id: string, assignee: PrimaryAssignee, confirmMove?: boolean) =>
    api.put<ApiResponse<'/inbox/conversations/{id}/primary', 'put'>>(
      `${at(id)}/primary`,
      { assignee, confirmMove },
      { idempotencyKey: idemKey() },
    ),

  addSupport: (id: string, accountId: string) =>
    api.post<ApiResponse<'/inbox/conversations/{id}/support', 'post'>>(
      `${at(id)}/support`,
      { accountId },
      { idempotencyKey: idemKey() },
    ),

  removeSupport: (id: string, assignmentId: string) =>
    api.delete<ApiResponse<'/inbox/conversations/{id}/support/{assignmentId}', 'delete'>>(
      `${at(id)}/support/${encodeURIComponent(assignmentId)}`,
      { idempotencyKey: idemKey() },
    ),

  divert: (id: string) =>
    api.post<ApiResponse<'/inbox/conversations/{id}/divert', 'post'>>(`${at(id)}/divert`, undefined, {
      idempotencyKey: idemKey(),
    }),

  move: (id: string, dest: MoveDest) =>
    api.post<ApiResponse<'/inbox/conversations/{id}/move', 'post'>>(
      `${at(id)}/move`,
      { dest },
      { idempotencyKey: idemKey() },
    ),

  /** The branch select; on a birthday, the branch's hosting manager joins as support. */
  setBranch: (id: string, branchId: string | null) =>
    api.patch<ApiResponse<'/inbox/conversations/{id}/branch', 'patch'>>(
      `${at(id)}/branch`,
      { branchId },
      { idempotencyKey: idemKey() },
    ),

  handle: (id: string) =>
    api.post<ApiResponse<'/inbox/conversations/{id}/handle', 'post'>>(`${at(id)}/handle`, undefined, {
      idempotencyKey: idemKey(),
    }),

  reopen: (id: string) =>
    api.post<ApiResponse<'/inbox/conversations/{id}/reopen', 'post'>>(`${at(id)}/reopen`, undefined, {
      idempotencyKey: idemKey(),
    }),

  // --- The reply (I2f) ---------------------------------------------------------------

  /**
   * Send a reply. `body.id` names the message: a retry of the same draft
   * under the same id is the same message, never a second send. Outside the
   * channel's window the server refuses free text with a 409 whose details
   * carry the window and the templates that qualify (`ReplyRefusal`).
   */
  reply: (id: string, body: ReplyBody) =>
    api.post<ApiResponse<'/inbox/conversations/{id}/messages', 'post'>>(
      `${at(id)}/messages`,
      { id: body.id, text: body.text, templateId: body.templateId, variables: body.variables },
      { idempotencyKey: idemKey() },
    ),

  // --- Template settings (inbox:template:manage) --------------------------------------

  manageTemplates: (archived: boolean) =>
    api.get<ApiResponse<'/inbox/templates/manage', 'get'>>(
      `/inbox/templates/manage${qs({ archived: archived ? 'true' : undefined })}`,
    ),

  createTemplate: (body: TemplateCreate) =>
    api.post<ApiResponse<'/inbox/templates', 'post'>>(
      '/inbox/templates',
      {
        id: body.id,
        key: body.key,
        language: body.language,
        channel: body.channel,
        branchId: body.branchId,
        body: body.body,
        providerTemplateName: body.providerTemplateName,
        approvalStatus: body.approvalStatus,
        active: body.active,
        needsTranslation: body.needsTranslation,
      },
      { idempotencyKey: idemKey() },
    ),

  updateTemplate: (id: string, patch: TemplatePatch) =>
    api.patch<ApiResponse<'/inbox/templates/{id}', 'patch'>>(
      `/inbox/templates/${encodeURIComponent(id)}`,
      {
        language: patch.language,
        channel: patch.channel,
        branchId: patch.branchId,
        body: patch.body,
        providerTemplateName: patch.providerTemplateName,
        approvalStatus: patch.approvalStatus,
        active: patch.active,
        needsTranslation: patch.needsTranslation,
      },
      { idempotencyKey: idemKey() },
    ),

  archiveTemplate: (id: string) =>
    api.post<ApiResponse<'/inbox/templates/{id}/archive', 'post'>>(
      `/inbox/templates/${encodeURIComponent(id)}/archive`,
      undefined,
      { idempotencyKey: idemKey() },
    ),

  // --- The simulator (local and staging only; `me.simulator` says when) ----------------

  simulateInbound: (body: SimulatedInbound) =>
    api.post<ApiResponse<'/inbox/simulator/inbound', 'post'>>(
      '/inbox/simulator/inbound',
      { channelAccountId: body.channelAccountId, from: body.from, name: body.name, text: body.text, hint: body.hint },
      { idempotencyKey: idemKey() },
    ),

  /** Push every delivered and read receipt the simulator scheduled for the replies it accepted. */
  simulateReceipts: (channelAccountId: string) =>
    api.post<ApiResponse<'/inbox/simulator/status', 'post'>>(
      '/inbox/simulator/status',
      { channelAccountId },
      { idempotencyKey: idemKey() },
    ),

  playDemo: () =>
    api.post<ApiResponse<'/inbox/simulator/scenario', 'post'>>(
      '/inbox/simulator/scenario',
      { scenario: 'demo' },
      { idempotencyKey: idemKey() },
    ),
};
