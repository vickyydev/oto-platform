import {
  PartyDepositActionAnswerSchema,
  PartyDepositAnswerSchema,
  PartyMessageAnswerSchema,
  type PartyDepositActionAnswer,
  type PartyDepositAnswer,
  type PartyMessageAnswer,
} from "@shared/partyDeposit";
import { log } from "./logger";
import type { SuiteProvisionConfig } from "./suiteSignIn";

/**
 * A PARTY'S DEPOSIT ASKED FROM THE BEO (SCRUM-825): the app's half of the calls.
 *
 * The platform holds the whole of it — the gateway link, the assistant's
 * lines, the payment, the write-back, the reminders — behind its doors
 * `/otoapp/parties/:eventId/deposit-request` (and `/menu-link`,
 * `/menu-received`). This app asks the way SCRUM-822's `tillBilling.ts` and
 * SCRUM-828's `partyMenuItem.ts` ask: to `PLATFORM_API_URL` with this app's
 * provisioning key as a Bearer (`OTOAPP_PROVISION_KEY`), never a person's
 * session and never from a browser; the platform takes the operator from the
 * key. Every press travels with its action id as the Idempotency-Key, so a
 * retry after a lost answer is the same request and the same line, never a
 * second. (`partyDeposit.ts` beside this file is SCRUM-813's one-deposit
 * writer, which the platform's write-back reaches through the directory.)
 */

const PARTY_DEPOSIT_TIMEOUT_MS = 15_000;

export type PlatformRefusal = { ok: false; status: number; code: string; message: string };
export type PartyDepositReadResult = { ok: true; answer: PartyDepositAnswer } | PlatformRefusal;
export type PartyDepositActionResult = { ok: true; answer: PartyDepositActionAnswer } | PlatformRefusal;
export type PartyMessageResult = { ok: true; answer: PartyMessageAnswer } | PlatformRefusal;

interface PlatformError {
  error?: { code?: unknown; message?: unknown; details?: unknown };
}

/** The platform's refusal, in its own words where it gave some. */
function refusal(status: number, body: unknown, what: string): PlatformRefusal {
  const e = (body as PlatformError | null)?.error;
  const code = typeof e?.code === "string" ? e.code : "PLATFORM_REFUSED";
  // A 401 here is this deployment's key, not the person's mistake.
  if (status === 401) {
    return {
      ok: false,
      status: 503,
      code,
      message: `The till does not accept this app's provisioning key, so ${what}. Check OTOAPP_PROVISION_KEY here and OTOAPP_PROVISION_KEYS on the platform.`,
    };
  }
  if (status === 404) {
    return { ok: false, status: 404, code, message: `The till does not know this party, so ${what}: is it a birthday at a park linked to the till?` };
  }
  const said = typeof e?.message === "string" && e.message ? e.message : `The till did not answer, so ${what}.`;
  return { ok: false, status: status >= 500 ? 502 : status, code, message: said };
}

async function callPlatform(
  config: SuiteProvisionConfig,
  method: "GET" | "POST",
  path: string,
  o: { body?: unknown; actionId?: string; requestId?: string; what: string },
): Promise<{ ok: true; body: unknown } | PlatformRefusal> {
  let res: globalThis.Response;
  try {
    res = await fetch(`${config.apiUrl}${path}`, {
      method,
      headers: {
        ...(o.body !== undefined ? { "content-type": "application/json" } : {}),
        authorization: `Bearer ${config.key}`,
        ...(o.actionId ? { "idempotency-key": o.actionId } : {}),
        ...(o.requestId ? { "x-request-id": o.requestId } : {}),
      },
      body: o.body !== undefined ? JSON.stringify(o.body) : undefined,
      signal: AbortSignal.timeout(PARTY_DEPOSIT_TIMEOUT_MS),
    });
  } catch (err) {
    log().warn({ err: err instanceof Error ? err.message : String(err), path }, "could not reach the platform for a party's deposit");
    return {
      ok: false,
      status: 502,
      code: "PLATFORM_UNREACHABLE",
      message: `The till did not answer, so ${o.what}. Try again in a moment: the same press never asks twice.`,
    };
  }
  const answer = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    log().warn({ status: res.status, code: (answer as PlatformError | null)?.error?.code, path }, "the platform refused a party deposit call");
    return refusal(res.status, answer, o.what);
  }
  return { ok: true, body: answer };
}

const unreadable = (what: string): PlatformRefusal => ({
  ok: false,
  status: 502,
  code: "PLATFORM_UNREADABLE",
  message: `The till's answer could not be read, so ${what}.`,
});

/** The party's requests as the platform holds them. A read: asking again is always safe. */
export async function readPartyDeposit(config: SuiteProvisionConfig, eventId: string, requestId?: string): Promise<PartyDepositReadResult> {
  const what = "the deposit's state could not be read";
  const got = await callPlatform(config, "GET", `/otoapp/parties/${encodeURIComponent(eventId)}/deposit-request`, { requestId, what });
  if (!got.ok) return got;
  const parsed = PartyDepositAnswerSchema.safeParse(got.body);
  if (!parsed.success) {
    log().warn({ eventId, issues: parsed.error.issues.slice(0, 3) }, "the platform's answer for a party's deposit could not be read");
    return unreadable(what);
  }
  return { ok: true, answer: parsed.data };
}

export interface PartyDepositRequestInput {
  /** The press, minted by the form: sent as the Idempotency-Key. */
  actionId: string;
  amountSatang: number;
  /** This app's user who pressed: the platform records the account stamped on them as the audit rows' actor. */
  actorAppUserId: string;
  /** The chat this app holds for the event (`core_events.inbox_conversation_id`), checked by the platform against its own link. */
  conversationId: string | null;
}

/** "Request deposit": the platform mints the link and has the assistant post it. */
export async function requestPartyDeposit(
  config: SuiteProvisionConfig,
  eventId: string,
  input: PartyDepositRequestInput,
  requestId?: string,
): Promise<PartyDepositActionResult> {
  const what = "the deposit was not requested";
  const { actionId, conversationId, ...rest } = input;
  const got = await callPlatform(config, "POST", `/otoapp/parties/${encodeURIComponent(eventId)}/deposit-request`, {
    body: { ...rest, ...(conversationId ? { conversationId } : {}) },
    actionId,
    requestId,
    what,
  });
  if (!got.ok) return got;
  const parsed = PartyDepositActionAnswerSchema.safeParse(got.body);
  return parsed.success ? { ok: true, answer: parsed.data } : unreadable(what);
}

/** "Resend" or "Cancel request" on an open request. */
export async function actOnPartyDeposit(
  config: SuiteProvisionConfig,
  eventId: string,
  depositRequestId: string,
  action: "resend" | "cancel",
  input: { actionId: string; actorAppUserId: string },
  requestId?: string,
): Promise<PartyDepositActionResult> {
  const what = action === "resend" ? "the link was not resent" : "the request was not cancelled";
  const got = await callPlatform(
    config,
    "POST",
    `/otoapp/parties/${encodeURIComponent(eventId)}/deposit-request/${encodeURIComponent(depositRequestId)}/${action}`,
    { body: { actorAppUserId: input.actorAppUserId }, actionId: input.actionId, requestId, what },
  );
  if (!got.ok) return got;
  const parsed = PartyDepositActionAnswerSchema.safeParse(got.body);
  return parsed.success ? { ok: true, answer: parsed.data } : unreadable(what);
}

/** "Send the menu choice link": the assistant posts the parent's selection link. */
export async function postPartyMenuLink(
  config: SuiteProvisionConfig,
  eventId: string,
  input: { actionId: string; link: string; actorAppUserId: string },
  requestId?: string,
): Promise<PartyMessageResult> {
  const what = "the menu link was not sent";
  const got = await callPlatform(config, "POST", `/otoapp/parties/${encodeURIComponent(eventId)}/menu-link`, {
    body: { link: input.link, actorAppUserId: input.actorAppUserId },
    actionId: input.actionId,
    requestId,
    what,
  });
  if (!got.ok) return got;
  const parsed = PartyMessageAnswerSchema.safeParse(got.body);
  return parsed.success ? { ok: true, answer: parsed.data } : unreadable(what);
}

/** The parent's choices landed: the assistant confirms them. Keyed by the submission, so a retry confirms once. */
export async function postPartyMenuReceived(
  config: SuiteProvisionConfig,
  eventId: string,
  input: { actionId: string; submittedAt: string | null },
  requestId?: string,
): Promise<PartyMessageResult> {
  const what = "the choices were not confirmed in the chat";
  const got = await callPlatform(config, "POST", `/otoapp/parties/${encodeURIComponent(eventId)}/menu-received`, {
    body: input.submittedAt ? { submittedAt: input.submittedAt } : {},
    actionId: input.actionId,
    requestId,
    what,
  });
  if (!got.ok) return got;
  const parsed = PartyMessageAnswerSchema.safeParse(got.body);
  return parsed.success ? { ok: true, answer: parsed.data } : unreadable(what);
}
