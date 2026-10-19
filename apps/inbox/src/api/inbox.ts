// The Inbox's reads (S2-19 I3a, SCRUM-587), every one typed from the api's own
// description (`@oto/api-types`, SCRUM-272): a route that changes its answer
// fails this app's typecheck the day it changes, and the seam walker
// (packages/api-types/test/seam-walker.test.ts) checks each call below reaches
// the route its type names. No hand-written response shapes here.
//
// The sign-on calls (`/auth/*`) are in `auth/`, untyped on purpose: those
// routes declare no response body, and their callers read nothing from one.
import type { ApiBody, ApiQuery, ApiResponse } from '@oto/api-types';
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

export const inboxApi = {
  /** Who is reading, their tabs, the teams and people, and the write switch. */
  me: () => api.get<ApiResponse<'/inbox/me', 'get'>>('/inbox/me'),

  conversations: (q: ListQuery) =>
    api.get<ApiResponse<'/inbox/conversations', 'get'>>(`/inbox/conversations${qs(q)}`),

  conversation: (id: string) =>
    api.get<ApiResponse<'/inbox/conversations/{id}', 'get'>>(`/inbox/conversations/${encodeURIComponent(id)}`),

  /** The newest page, or with `before` the page older than that message. */
  messages: (id: string, before?: string) =>
    api.get<ApiResponse<'/inbox/conversations/{id}/messages', 'get'>>(
      `/inbox/conversations/${encodeURIComponent(id)}/messages${qs({ before })}`,
    ),

  /**
   * Mark read up to the newest message shown. A read route [A], not one of the
   * writes the switch holds back: it moves the viewer's own unread marker and
   * writes the day's sampled read audit (plan §3.6).
   */
  markRead: (id: string, body: ApiBody<'/inbox/conversations/{id}/read', 'post'>) =>
    api.post<ApiResponse<'/inbox/conversations/{id}/read', 'post'>>(
      `/inbox/conversations/${encodeURIComponent(id)}/read`,
      { messageId: body.messageId },
      { idempotencyKey: idemKey() },
    ),

  dashboard: () => api.get<ApiResponse<'/inbox/dashboard', 'get'>>('/inbox/dashboard'),

  /** The composer's standard lines, optionally in one language. */
  templates: (language?: string) =>
    api.get<ApiResponse<'/inbox/templates', 'get'>>(`/inbox/templates${qs({ language })}`),
};
