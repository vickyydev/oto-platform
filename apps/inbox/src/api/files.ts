// The files api, as the Inbox needs it (customer-AI test night, W7: the
// birthday brochure showed staff "No text · 1 attachment" with nothing to
// open). The seam walker reads the call by its path, as it reads every
// other.
//
// `GET /files/{id}/url` declares no response schema (`apps/api/src/routes/
// files.ts`, "Presigned download URL"): the api describes no answer for
// it, so the call names none — a hand-typed one would regrow the migration
// list, and `ApiResponse` of an undescribed route is `unknown` by design.
// The route answers `{ url, contentType }`, and that is CHECKED here on the
// way in rather than asserted, until the api describes it.
import { api } from './client';

export interface FileUrl {
  url: string;
  contentType: string | null;
}

/** What the route answers, read off the undescribed body; a body without a url is a fault, not a file. */
export function readFileUrl(answer: unknown): FileUrl {
  const r = answer !== null && typeof answer === 'object' ? (answer as Record<string, unknown>) : {};
  if (typeof r.url !== 'string' || r.url === '') throw new Error('The files api answered without a download URL.');
  return { url: r.url, contentType: typeof r.contentType === 'string' ? r.contentType : null };
}

export const filesApi = {
  /**
   * A short-lived download URL, after the api's permission check on the
   * owner entity. A read of a thread's media is ACCESS-LOGGED by the api
   * (PDPA), so this is asked for on a press, never on render.
   */
  url: async (id: string): Promise<FileUrl> => readFileUrl(await api.get(`/files/${encodeURIComponent(id)}/url`)),
};
