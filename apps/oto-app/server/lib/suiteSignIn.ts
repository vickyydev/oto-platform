import { log } from "./logger";
import { normalizeThaiPhone, validatePhoneInput } from "../phone-utils";

/**
 * Giving somebody made in this app a suite sign-in (SCRUM-539).
 *
 * Advisors and users added on Setup > Users are email-and-password records
 * here, and this app's own login form is closed on the platform, so they had
 * no way in. The platform makes them a phone account instead: this server asks
 * `POST /admin/apps/oto_app/suite-sign-ins` with a key of its own and shows the
 * one-time temporary password it answers with to the administrator, once.
 *
 * **The key.** `OTOAPP_PROVISION_KEY` is this app's alone; the platform holds
 * only its SHA-256 (`OTOAPP_PROVISION_KEYS` there, bound to one operator). It
 * is sent only to `PLATFORM_API_URL`, never logged and never sent to a
 * browser. No platform session is used or kept for this: the administrator is
 * named by their user id here, and the platform accepts only an administrator
 * it has already stamped onto a platform account.
 *
 * **What the platform will and will not do with it** is written at
 * `apps/api/src/services/otoapp-provision.ts`: a NEW account only, the OTO App
 * tile only, this operator's park groups only, never a password reset.
 */

const PROVISION_TIMEOUT_MS = 10_000;

export interface SuiteProvisionConfig {
  apiUrl: string;
  key: string;
}

/** Null when this deployment cannot provision: either half missing. */
export function suiteProvisionConfig(): SuiteProvisionConfig | null {
  const apiUrl = (process.env.PLATFORM_API_URL ?? "").trim().replace(/\/$/, "");
  const key = (process.env.OTOAPP_PROVISION_KEY ?? "").trim();
  if (!apiUrl || !key) return null;
  return { apiUrl, key };
}

export const SUITE_PROVISION_UNCONFIGURED =
  "This deployment cannot give suite sign-ins yet: PLATFORM_API_URL and OTOAPP_PROVISION_KEY are not both set.";

export type SuiteProvisionResult =
  | {
      ok: true;
      accountId: string;
      /** E.164, as the platform stored it: what they type at the launcher. */
      phone: string;
      /** Null on a replay of the same press: it is shown once and never kept. */
      temporaryPassword: string | null;
      replayed: boolean;
      /** The linked legal entity uses platform roles; local grants are not effective. */
      platformManaged: boolean;
    }
  | { ok: false; status: number; code: string; message: string };

interface PlatformError {
  error?: { code?: unknown; message?: unknown };
}

/** The platform's refusal, in its own words where it gave some. */
function refusal(status: number, body: unknown): SuiteProvisionResult {
  const e = (body as PlatformError | null)?.error;
  const code = typeof e?.code === "string" ? e.code : "PLATFORM_REFUSED";
  const message =
    typeof e?.message === "string" && e.message
      ? e.message
      : "The platform did not give this person a suite sign-in. Try again in a moment.";
  // A 401 here is this deployment's key, not the administrator's mistake.
  if (status === 401) {
    return {
      ok: false,
      status: 503,
      code,
      message: "The platform does not accept this app's provisioning key. Check OTOAPP_PROVISION_KEY here and OTOAPP_PROVISION_KEYS on the platform.",
    };
  }
  return { ok: false, status: status >= 500 ? 502 : status, code, message };
}

export async function provisionSuiteSignIn(
  config: SuiteProvisionConfig,
  input: { actionId: string; appUserId: string; phone: string; actorAppUserId: string },
  requestId?: string,
): Promise<SuiteProvisionResult> {
  let res: globalThis.Response;
  try {
    res = await fetch(`${config.apiUrl}/admin/apps/oto_app/suite-sign-ins`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.key}`,
        ...(requestId ? { "x-request-id": requestId } : {}),
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(PROVISION_TIMEOUT_MS),
    });
  } catch (err) {
    log().error({ err: err instanceof Error ? err.message : String(err) }, "could not reach the platform to provision a suite sign-in");
    return {
      ok: false,
      status: 502,
      code: "PLATFORM_UNREACHABLE",
      message: "The platform did not answer. Press the button again: the same press is never made twice.",
    };
  }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    log().warn({ status: res.status, code: (body as PlatformError | null)?.error?.code }, "the platform refused a suite sign-in");
    return refusal(res.status, body);
  }
  const accountId = typeof body?.accountId === "string" ? body.accountId : null;
  const phone = typeof body?.phone === "string" ? body.phone : null;
  if (!accountId || !phone) {
    return { ok: false, status: 502, code: "PLATFORM_UNREADABLE", message: "The platform's answer could not be read." };
  }
  return {
    ok: true,
    accountId,
    phone,
    temporaryPassword: typeof body?.temporaryPassword === "string" ? body.temporaryPassword : null,
    replayed: body?.replayed === true,
    platformManaged: body?.platformManaged === true,
  };
}

type PhoneRead = { ok: true; phoneNumber: string; phoneE164: string } | { ok: false; message: string };

/** Thai local formats accepted; stored the way the app stores every phone. */
export function readPhone(raw: unknown): PhoneRead | null {
  if (raw === undefined || raw === null || raw === "") return null;
  if (typeof raw !== "string") return { ok: false, message: "Invalid phone number" };
  const checked = validatePhoneInput(raw);
  if (!checked.valid) return { ok: false, message: checked.error ?? "Invalid phone number" };
  return { ok: true, phoneNumber: raw.trim(), phoneE164: normalizeThaiPhone(raw) };
}
