import { PlatformTillMenuSchema, type TillMenuItem } from "@shared/tillMenu";
import { log } from "./logger";
import type { SuiteProvisionConfig } from "./suiteSignIn";

/**
 * THE TILL'S MENU, FOR THE BEO (SCRUM-905): the app's half of the read.
 *
 * The platform answers a park's live food and drink (`GET
 * /otoapp/party-menu/catalogue?branchId=`): each menu item not archived, on
 * sale, coded and made at the kitchen or the bar, with its code, name,
 * category, station, prices in satang and whether the BEO made it. Asked the
 * way SCRUM-822's `tillBilling.ts` asks: to `PLATFORM_API_URL` with this app's
 * provisioning key as a Bearer (`OTOAPP_PROVISION_KEY`), never a person's
 * session and never from a browser; the platform takes the operator from the
 * key.
 *
 * **A minute in memory, nothing in the database.** The kitchen plan's pickers
 * and its "No longer on the till" marks read it each time a BEO opens, so one
 * park's answer is held for 60 seconds (`TILL_MENU_CACHE_MS`) and asked once
 * by however many screens want it at the same moment. Only an answer is held:
 * a refusal or a silence is asked again next time. The till's menu is never
 * written to this app's tables; it is the till's.
 */

const TILL_MENU_TIMEOUT_MS = 10_000;
export const TILL_MENU_CACHE_MS = 60_000;

export type TillMenuResult =
  | { ok: true; items: TillMenuItem[]; readAt: string }
  | { ok: false; status: number; code: string; message: string };

interface PlatformError {
  error?: { code?: unknown; message?: unknown };
}

type Held = { at: number; result: Promise<TillMenuResult> };
/** By platform branch: the answer, or the ask in flight. */
const held = new Map<string, Held>();

/** For the checks: forget every held answer. */
export function forgetTillMenus(): void {
  held.clear();
}

async function askTill(config: SuiteProvisionConfig, branchId: string, requestId?: string): Promise<TillMenuResult> {
  let res: globalThis.Response;
  try {
    res = await fetch(`${config.apiUrl}/otoapp/party-menu/catalogue?branchId=${encodeURIComponent(branchId)}`, {
      method: "GET",
      headers: {
        authorization: `Bearer ${config.key}`,
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
      signal: AbortSignal.timeout(TILL_MENU_TIMEOUT_MS),
    });
  } catch (err) {
    log().warn({ err: err instanceof Error ? err.message : String(err), branchId }, "could not reach the platform to read the till's menu");
    return { ok: false, status: 502, code: "PLATFORM_UNREACHABLE", message: "The till did not answer, so its menu cannot be offered. Type the item, or try again in a moment." };
  }
  const answer = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) {
    const e = (answer as PlatformError | null)?.error;
    const code = typeof e?.code === "string" ? e.code : "PLATFORM_REFUSED";
    log().warn({ status: res.status, code, branchId }, "the platform refused the till's menu");
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
      return { ok: false, status: 404, code, message: "The till does not know this park: is it linked to the right till branch?" };
    }
    const said = typeof e?.message === "string" && e.message ? e.message : "The till did not answer with its menu.";
    return { ok: false, status: 502, code, message: said };
  }
  const parsed = PlatformTillMenuSchema.safeParse(answer);
  if (!parsed.success) {
    log().warn({ branchId, issues: parsed.error.issues.slice(0, 3) }, "the platform's answer for the till's menu could not be read");
    return { ok: false, status: 502, code: "PLATFORM_UNREADABLE", message: "The till's menu could not be read." };
  }
  return { ok: true, items: parsed.data.items, readAt: new Date().toISOString() };
}

/**
 * One park's till menu (`branchId` the platform branch, `branches.core_branch_id`):
 * held for a minute once answered, asked once while an ask is in flight.
 */
export async function readTillMenu(
  config: SuiteProvisionConfig,
  branchId: string,
  requestId?: string,
  now: () => number = Date.now,
): Promise<TillMenuResult> {
  const key = branchId.trim().toLowerCase();
  const was = held.get(key);
  if (was && now() - was.at < TILL_MENU_CACHE_MS) return was.result;
  const result = askTill(config, key, requestId);
  const entry: Held = { at: now(), result };
  held.set(key, entry);
  const settled = await result;
  // Only an answer is held; a refusal is asked again next time.
  if (!settled.ok && held.get(key) === entry) held.delete(key);
  return settled;
}
