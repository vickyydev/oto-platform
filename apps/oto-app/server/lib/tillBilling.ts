import { TillBillingSchema, type TillBilling } from "@shared/tillBilling";
import { log } from "./logger";
import type { SuiteProvisionConfig } from "./suiteSignIn";

/**
 * A PARTY'S MONEY, FROM THE TILL (SCRUM-822): the app's half of the read.
 *
 * The platform answers a party's figures from the code the till settles with
 * (`GET /otoapp/parties/:eventId/billing`): the quote before the party is
 * settled, the sale after it (shared/tillBilling.ts says what each holds).
 * Asked the way SCRUM-828's `partyMenuItem.ts` asks: to `PLATFORM_API_URL`
 * with this app's provisioning key as a Bearer (`OTOAPP_PROVISION_KEY`), never
 * a person's session and never from a browser; the platform takes the
 * operator from the key. A read: asking again is always safe.
 */

const TILL_BILLING_TIMEOUT_MS = 10_000;

export type TillBillingResult =
  | { ok: true; billing: TillBilling }
  | { ok: false; status: number; code: string; message: string };

interface PlatformError {
  error?: { code?: unknown; message?: unknown };
}

export async function readTillBilling(
  config: SuiteProvisionConfig,
  eventId: string,
  requestId?: string,
): Promise<TillBillingResult> {
  let res: globalThis.Response;
  try {
    res = await fetch(`${config.apiUrl}/otoapp/parties/${encodeURIComponent(eventId)}/billing`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${config.key}`,
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
      signal: AbortSignal.timeout(TILL_BILLING_TIMEOUT_MS),
    });
  } catch (err) {
    log().warn({ err: err instanceof Error ? err.message : String(err), eventId }, "could not reach the platform to read a party's money");
    return { ok: false, status: 502, code: "PLATFORM_UNREACHABLE", message: "The till did not answer. Press Refresh from the till to ask again." };
  }
  const answer = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const e = (answer as PlatformError | null)?.error;
    const code = typeof e?.code === "string" ? e.code : "PLATFORM_REFUSED";
    log().warn({ status: res.status, code, eventId }, "the platform refused a party's money");
    // A 401 is this deployment's key, never the person's mistake.
    if (res.status === 401) {
      return {
        ok: false,
        status: 503,
        code,
        message: "The till does not accept this app's provisioning key. Check OTOAPP_PROVISION_KEY here and OTOAPP_PROVISION_KEYS on the platform.",
      };
    }
    if (res.status === 404) {
      return { ok: false, status: 404, code, message: "The till does not know this party: is it a birthday at a park linked to the till?" };
    }
    const said = typeof e?.message === "string" && e.message ? e.message : "The till did not answer with this party's money.";
    return { ok: false, status: 502, code, message: said };
  }
  const parsed = TillBillingSchema.safeParse(answer);
  if (!parsed.success) {
    log().warn({ eventId, issues: parsed.error.issues.slice(0, 3) }, "the platform's answer for a party's money could not be read");
    return { ok: false, status: 502, code: "PLATFORM_UNREADABLE", message: "The till's answer could not be read." };
  }
  return { ok: true, billing: parsed.data };
}
