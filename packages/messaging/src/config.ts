import type { TwilioConfig } from './twilio';
import type { WhatsAppCloudConfig } from './whatsapp-cloud';

/**
 * THE INBOX'S CHANNEL VARIABLES (plan §2.3) — names, and the one reading of
 * them.
 *
 * Like `@oto/payments-2c2p/src/config.ts`, this package never touches
 * `process.env`: the api passes its environment in as a plain record, and the
 * checks pass their own. What the api does with the answers — refuse to boot,
 * refuse the simulator in production through `assertProductionSafe` — is the
 * api's (I2b), mirroring `buildSmsSender` for Twilio (`sms.ts:427-544`).
 */

export const INBOX_ENV = {
  simulator: 'INBOX_SIMULATOR',
  simulatorSecret: 'INBOX_SIMULATOR_SECRET',
  whatsappEnabled: 'INBOX_WHATSAPP_ENABLED',
  metaAppSecret: 'INBOX_META_APP_SECRET',
  metaVerifyToken: 'INBOX_META_VERIFY_TOKEN',
  /** Suffixed with a channel account's `credential_ref`: `INBOX_WHATSAPP_TOKEN_<ref>`. */
  whatsappTokenPrefix: 'INBOX_WHATSAPP_TOKEN_',
  webhookPayloadRetentionDays: 'INBOX_WEBHOOK_PAYLOAD_RETENTION_DAYS',
  /**
   * SCRUM-908, the WhatsApp test line on Twilio's sandbox. The switch (`true`
   * or off), and the api's public origin exactly as Twilio calls it — the
   * signed URL is built from it, never from a request header.
   */
  twilioEnabled: 'INBOX_TWILIO_ENABLED',
  twilioPublicUrl: 'INBOX_TWILIO_PUBLIC_URL',
  /** Suffixed with a channel account's `credential_ref`, as the WhatsApp token is. */
  twilioAccountSidPrefix: 'INBOX_TWILIO_ACCOUNT_SID_',
  twilioAuthTokenPrefix: 'INBOX_TWILIO_AUTH_TOKEN_',
  /** The only customer numbers the line answers and writes to: E.164, comma-separated. */
  twilioAllowedNumbersPrefix: 'INBOX_TWILIO_ALLOWED_NUMBERS_',
} as const;

export type EnvRecord = Readonly<Record<string, string | undefined>>;

/**
 * Raised when a channel is switched on and something it needs is not set —
 * or (SCRUM-908) is set to something it cannot use. Names the variables,
 * never a value.
 */
export class ChannelConfigError extends Error {
  constructor(
    public readonly missing: readonly string[],
    public readonly invalid: readonly string[] = [],
  ) {
    const parts = [
      missing.length > 0 ? `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set` : null,
      invalid.length > 0 ? `${invalid.join(', ')} ${invalid.length === 1 ? 'is' : 'are'} not usable` : null,
    ].filter((p): p is string => p !== null);
    super(`the inbox channel is switched on but ${parts.join(' and ')}`);
    this.name = 'ChannelConfigError';
  }
}

function set(env: EnvRecord, name: string): string | null {
  const v = env[name]?.trim();
  return v ? v : null;
}

/** `credential_ref` is a secret's NAME, and it becomes part of a variable name. */
function assertCredentialRef(credentialRef: string): void {
  if (!/^[A-Z0-9_]{1,64}$/.test(credentialRef)) {
    throw new Error('a credential_ref is upper-case letters, digits and underscores');
  }
}

export function whatsappTokenVariable(credentialRef: string): string {
  assertCredentialRef(credentialRef);
  return `${INBOX_ENV.whatsappTokenPrefix}${credentialRef}`;
}

/** SCRUM-908: the three per-account variables of a Twilio line, by its `credential_ref`. */
export function twilioVariables(credentialRef: string): {
  accountSid: string;
  authToken: string;
  allowedNumbers: string;
} {
  assertCredentialRef(credentialRef);
  return {
    accountSid: `${INBOX_ENV.twilioAccountSidPrefix}${credentialRef}`,
    authToken: `${INBOX_ENV.twilioAuthTokenPrefix}${credentialRef}`,
    allowedNumbers: `${INBOX_ENV.twilioAllowedNumbersPrefix}${credentialRef}`,
  };
}

/**
 * The simulator's switch and secret. Off unless `INBOX_SIMULATOR=on`; on
 * without a secret is a configuration error, never a silent default.
 */
export function simulatorConfigFrom(
  env: EnvRecord,
): { enabled: false } | { enabled: true; secret: string } {
  if (set(env, INBOX_ENV.simulator) !== 'on') return { enabled: false };
  const secret = set(env, INBOX_ENV.simulatorSecret);
  if (!secret) throw new ChannelConfigError([INBOX_ENV.simulatorSecret]);
  return { enabled: true, secret };
}

/**
 * The WhatsApp Cloud adapter's configuration for one channel account, or null
 * when `INBOX_WHATSAPP_ENABLED` is not `true` — the default, and the only
 * state this story ships in. With the flag on, every missing variable is
 * named at once. The phone-number id is the channel account's `external_id`,
 * so it comes from the row, not the environment.
 */
export function whatsAppCloudConfigFrom(
  env: EnvRecord,
  account: { credentialRef: string; phoneNumberId: string; displayName?: string },
): WhatsAppCloudConfig | null {
  if (set(env, INBOX_ENV.whatsappEnabled) !== 'true') return null;
  const tokenVar = whatsappTokenVariable(account.credentialRef);
  const appSecret = set(env, INBOX_ENV.metaAppSecret);
  const verifyToken = set(env, INBOX_ENV.metaVerifyToken);
  const accessToken = set(env, tokenVar);
  const missing = [
    appSecret ? null : INBOX_ENV.metaAppSecret,
    verifyToken ? null : INBOX_ENV.metaVerifyToken,
    accessToken ? null : tokenVar,
    account.phoneNumberId ? null : 'channel_account.external_id',
  ].filter((m): m is string => m !== null);
  if (missing.length > 0) throw new ChannelConfigError(missing);
  return {
    appSecret: appSecret!,
    verifyToken: verifyToken!,
    accessToken: accessToken!,
    phoneNumberId: account.phoneNumberId,
    ...(account.displayName ? { displayName: account.displayName } : {}),
  };
}

/** E.164: a plus, a country code that does not start with 0, 7 to 15 digits in all. */
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * SCRUM-908: an allow-list as typed into the hosting dashboard — E.164
 * numbers separated by commas, semicolons or new lines; spaces, dots, dashes
 * and brackets inside a number ignored; a `whatsapp:` prefix taken off. Null
 * when the list is empty or any entry is not an international number: a list
 * that cannot be read allows nobody rather than everybody.
 */
export function parseAllowedNumbers(raw: string | undefined | null): string[] | null {
  if (!raw?.trim()) return null;
  const out: string[] = [];
  for (const entry of raw.split(/[,;\n]/)) {
    const cleaned = entry
      .trim()
      .replace(/^whatsapp:/i, '')
      .replace(/[\s().-]/g, '');
    if (cleaned === '') continue;
    if (!E164.test(cleaned)) return null;
    if (!out.includes(cleaned)) out.push(cleaned);
  }
  return out.length > 0 ? out : null;
}

/**
 * SCRUM-908: the api's public origin as Twilio calls it — `https://host`, no
 * path, query or credentials; a trailing slash is dropped. Plain `http` only
 * for a loopback host.
 */
export function parsePublicOrigin(raw: string | undefined | null): string | null {
  const value = raw?.trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '/' && url.pathname !== '') return null;
  return `${url.protocol}//${url.host}`;
}

/**
 * The Twilio adapter's configuration for one channel account (SCRUM-908), or
 * null when `INBOX_TWILIO_ENABLED` is not `true` — the default. With the
 * switch on, every missing variable is named at once, and so is every one set
 * to something unusable (an account SID that is not one, a public URL that is
 * not an https origin, an allow-list that is not E.164 numbers).
 *
 * THE ALLOW-LIST IS REQUIRED. The line is a test line: the assistant answers,
 * and the line writes, only to the numbers it names (the owner's safety rule,
 * 12 November 2026). A Twilio account without one is not connected.
 *
 * The sender is the channel account's `external_id` (E.164) and the webhook
 * path is the api's (`/webhooks/inbox/twilio/<account id>`), so both come
 * from the caller, not the environment.
 */
export function twilioConfigFrom(
  env: EnvRecord,
  account: { credentialRef: string; sender: string; webhookPath: string; displayName?: string },
): TwilioConfig | null {
  if (set(env, INBOX_ENV.twilioEnabled) !== 'true') return null;
  const names = twilioVariables(account.credentialRef);
  const rawOrigin = set(env, INBOX_ENV.twilioPublicUrl);
  const accountSid = set(env, names.accountSid);
  const authToken = set(env, names.authToken);
  const rawAllowed = set(env, names.allowedNumbers);
  const missing = [
    rawOrigin ? null : INBOX_ENV.twilioPublicUrl,
    accountSid ? null : names.accountSid,
    authToken ? null : names.authToken,
    rawAllowed ? null : names.allowedNumbers,
    account.sender ? null : 'channel_account.external_id',
  ].filter((m): m is string => m !== null);
  const publicUrl = parsePublicOrigin(rawOrigin);
  const allowedNumbers = parseAllowedNumbers(rawAllowed);
  const invalid = [
    rawOrigin && !publicUrl ? INBOX_ENV.twilioPublicUrl : null,
    accountSid && !/^AC[0-9a-fA-F]{32}$/.test(accountSid) ? names.accountSid : null,
    rawAllowed && !allowedNumbers ? names.allowedNumbers : null,
    account.sender && !E164.test(account.sender) ? 'channel_account.external_id' : null,
  ].filter((m): m is string => m !== null);
  if (missing.length > 0 || invalid.length > 0) throw new ChannelConfigError(missing, invalid);
  return {
    accountSid: accountSid!,
    authToken: authToken!,
    sender: account.sender,
    publicUrl: publicUrl!,
    webhookPath: account.webhookPath,
    allowedNumbers: allowedNumbers!,
    ...(account.displayName ? { displayName: account.displayName } : {}),
  };
}
