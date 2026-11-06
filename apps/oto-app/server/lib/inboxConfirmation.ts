import type { Request } from "express";
import { z } from "zod";
import { PLATFORM_SESSION_COOKIE } from "./platformSession";
import { platformCallerOf } from "../middleware/platformSignOn";

/**
 * THE INBOX'S CONFIRMATION MESSAGE, READ FOR A BEO (SCRUM-660).
 *
 * The inbox's Create BEO lands on a birthday's BEO form asking it to run its
 * AI Fill. The message to read is the platform's — the newest message a person
 * on the team sent the family that names the date, the time and the party
 * details — and the platform chooses it (`GET /inbox/conversations/{id}/
 * beo-confirmation`, apps/api/src/services/inbox/beo-confirmation.ts). This
 * app asks for it server to server, as the same person, with their platform
 * session: the inbox's own read permission decides, and the text never rides
 * a URL or the hand-off.
 */

/** The platform's answer (packages/shared `InboxBeoConfirmationSchema`), read again here. */
const ConfirmationSchema = z.object({
  conversationId: z.string().uuid(),
  eventId: z.string().uuid().nullable(),
  message: z
    .object({
      id: z.string().uuid(),
      body: z.string(),
      bodyLanguage: z.string().nullable(),
      authorName: z.string().nullable(),
      sentAt: z.string().nullable(),
      createdAt: z.string(),
    })
    .nullable(),
  scanned: z.number().int().min(0),
});
export type InboxConfirmation = z.infer<typeof ConfirmationSchema>;

export type InboxReadRefusal =
  | "no_platform_session"
  | "signed_out"
  | "inbox_not_visible"
  | "not_a_birthday"
  | "inbox_unreachable";

export type InboxRead = { ok: true; confirmation: InboxConfirmation } | { ok: false; reason: InboxReadRefusal };

const TIMEOUT_MS = 8_000;

/** The conversation's confirmation as the platform answers it to this person, or why it could not be read. */
export async function readInboxConfirmation(req: Request, conversationId: string): Promise<InboxRead> {
  const caller = platformCallerOf(req);
  if (!caller) return { ok: false, reason: "no_platform_session" };
  let res: globalThis.Response;
  try {
    res = await fetch(`${caller.apiUrl}/inbox/conversations/${encodeURIComponent(conversationId)}/beo-confirmation`, {
      headers: {
        cookie: `${PLATFORM_SESSION_COOKIE}=${caller.token}`,
        ...(req.requestId ? { "x-request-id": req.requestId } : {}),
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "inbox_unreachable" };
  }
  if (res.status === 401 || res.status === 423) return { ok: false, reason: "signed_out" };
  if (res.status === 403 || res.status === 404) return { ok: false, reason: "inbox_not_visible" };
  if (res.status === 409) return { ok: false, reason: "not_a_birthday" };
  if (!res.ok) return { ok: false, reason: "inbox_unreachable" };
  const parsed = ConfirmationSchema.safeParse(await res.json().catch(() => null));
  if (!parsed.success || parsed.data.conversationId !== conversationId) return { ok: false, reason: "inbox_unreachable" };
  return { ok: true, confirmation: parsed.data };
}
