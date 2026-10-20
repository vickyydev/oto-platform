// The internal assistant's calls (SCRUM-591, round I3a; plan
// docs/progress/plans/internal-assistant-build/PLAN.md §D), every one typed
// from the api's own description (`@oto/api-types`): a route that changes its
// answer fails this app's typecheck, and the seam walker
// (packages/api-types/test/seam-walker.test.ts) checks each call below reaches
// the route its type names.
import type { ApiBody, ApiResponse } from '@oto/api-types';
import { api } from './client';

/** One ask as the api returns it: the question, the answer as shown, links, refusal lines, feedback. */
export type AskView = ApiResponse<'/assistant/asks', 'post'>;
export type AskList = ApiResponse<'/assistant/asks', 'get'>;
export type AskLink = AskView['links'][number];
export type AskRefusal = AskView['refusals'][number];
export type AskState = AskView['state'];
export type AskFeedbackBody = ApiBody<'/assistant/asks/{id}/feedback', 'patch'>;
export type AskFeedbackResult = ApiResponse<'/assistant/asks/{id}/feedback', 'patch'>;

/** What the api's resend answer says about itself (`REPLAY_HEADER` in apps/api/src/services/client-id.ts). */
export const REPLAY_HEADER = 'x-oto-replay';

export const assistantApi = {
  /**
   * Ask under a client-named id. A resend of the same id is answered from the
   * ask's own row (`replayed`), and one still running is 409 ASK_IN_FLIGHT.
   */
  ask: async (id: string, question: string): Promise<{ view: AskView; replayed: boolean }> => {
    let replayed = false;
    const view = await api.post<ApiResponse<'/assistant/asks', 'post'>>(
      '/assistant/asks',
      { id, question },
      { onResponse: (headers) => (replayed = headers.get(REPLAY_HEADER) === 'true') },
    );
    return { view, replayed };
  },
  /** One of mine, as it stands: how a 409 in flight is followed to its end. */
  one: (id: string) => api.get<ApiResponse<'/assistant/asks/{id}', 'get'>>(`/assistant/asks/${encodeURIComponent(id)}`),
  /** My questions, newest first, keyset-paged. */
  mine: (cursor: string | null, limit = 20) =>
    api.get<ApiResponse<'/assistant/asks', 'get'>>(
      `/assistant/asks?limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),
  /** Good or wrong (with an optional correction), once per ask. */
  feedback: (id: string, body: AskFeedbackBody, idempotencyKey: string) =>
    api.patch<ApiResponse<'/assistant/asks/{id}/feedback', 'patch'>>(
      `/assistant/asks/${encodeURIComponent(id)}/feedback`,
      { feedback: body.feedback, correction: body.correction },
      { idempotencyKey },
    ),
};
