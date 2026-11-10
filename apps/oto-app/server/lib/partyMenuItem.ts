import { log } from "./logger";
import type { SuiteProvisionConfig } from "./suiteSignIn";

/**
 * A NEW MENU ITEM FROM THE BEO (SCRUM-828): the app's half of the call.
 *
 * From the BEO's food lines staff add an item the till's catalogue does not
 * have yet — a special cake, a dish one family asked for — with a name, the
 * station it is made at and either a price or "free / included / alternate
 * item". The platform makes it a till product, BEO-only (never on the till's
 * selling grids or its F&B menu), in its "Party menu" category, and answers
 * its code; `server/party-menu-routes.ts` writes that code onto the BEO's line
 * so the till's party plan and its kitchen and bar slips find the product.
 *
 * The call is made the way `suiteSignIn.ts` makes its own: to
 * `PLATFORM_API_URL` with this app's provisioning key as a Bearer
 * (`OTOAPP_PROVISION_KEY`), never a person's session and never from a
 * browser; the platform takes the operator from the key. The press's action
 * id travels as the Idempotency-Key, so a retry after a lost answer is the
 * same product, never a second one.
 */

const PARTY_MENU_TIMEOUT_MS = 10_000;

export const PARTY_MENU_STATIONS = ["kitchen", "bar"] as const;
export type PartyMenuStation = (typeof PARTY_MENU_STATIONS)[number];

export interface PartyMenuProductRequest {
  /** The press, minted by the form: sent as the Idempotency-Key. */
  actionId: string;
  /** The party's park on the platform (`branches.core_branch_id`). */
  branchId: string;
  name: string;
  station: PartyMenuStation;
  /** Satang; null for a free / included / alternate item. */
  priceSatang: number | null;
  free: boolean;
  /** The BEO line it was made for, for the platform's audit row. */
  source: { eventId: string; lineLabel: string };
  /** This app's user who pressed: the platform records the account stamped on them as the audit rows' actor. */
  actorAppUserId: string;
}

export type PartyMenuProductResult =
  | { ok: true; productId: string; code: string; categoryId: string; replayed: boolean }
  | { ok: false; status: number; code: string; message: string };

export const PARTY_MENU_UNCONFIGURED =
  "This deployment cannot add new items to the till yet: PLATFORM_API_URL and OTOAPP_PROVISION_KEY are not both set. The line was not added.";

interface PlatformError {
  error?: { code?: unknown; message?: unknown };
}

/** The platform's refusal, in its own words where it gave some. */
function refusal(status: number, body: unknown): PartyMenuProductResult {
  const e = (body as PlatformError | null)?.error;
  const code = typeof e?.code === "string" ? e.code : "PLATFORM_REFUSED";
  // A 401 here is this deployment's key, not the person's mistake.
  if (status === 401) {
    return {
      ok: false,
      status: 503,
      code,
      message:
        "The till does not accept this app's provisioning key, so the item was not added. Check OTOAPP_PROVISION_KEY here and OTOAPP_PROVISION_KEYS on the platform.",
    };
  }
  const said = typeof e?.message === "string" && e.message ? e.message : "The till did not make this item.";
  return { ok: false, status: status >= 500 ? 502 : status, code, message: `${said} The line was not added.` };
}

export async function createPartyMenuProduct(
  config: SuiteProvisionConfig,
  input: PartyMenuProductRequest,
  requestId?: string,
): Promise<PartyMenuProductResult> {
  const { actionId, ...body } = input;
  let res: globalThis.Response;
  try {
    res = await fetch(`${config.apiUrl}/otoapp/party-menu/products`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.key}`,
        "idempotency-key": actionId,
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PARTY_MENU_TIMEOUT_MS),
    });
  } catch (err) {
    log().error({ err: err instanceof Error ? err.message : String(err) }, "could not reach the platform to make a party menu item");
    return {
      ok: false,
      status: 502,
      code: "PLATFORM_UNREACHABLE",
      message: "The till did not answer, so the item was not added. Press Add again: the same press never makes a second item.",
    };
  }
  const answer = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    log().warn({ status: res.status, code: (answer as PlatformError | null)?.error?.code }, "the platform refused a party menu item");
    return refusal(res.status, answer);
  }
  const productId = typeof answer?.productId === "string" ? answer.productId : null;
  const code = typeof answer?.code === "string" && answer.code.trim() ? answer.code.trim() : null;
  const categoryId = typeof answer?.categoryId === "string" ? answer.categoryId : null;
  if (!productId || !code || !categoryId) {
    return { ok: false, status: 502, code: "PLATFORM_UNREADABLE", message: "The till's answer could not be read, so the item was not added." };
  }
  return { ok: true, productId, code, categoryId, replayed: answer?.replayed === true };
}
