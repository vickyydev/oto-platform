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
} as const;

export type EnvRecord = Readonly<Record<string, string | undefined>>;

/** Raised when a channel is switched on and something it needs is not set. Names the variables, never a value. */
export class ChannelConfigError extends Error {
  constructor(public readonly missing: readonly string[]) {
    super(
      `the inbox channel is switched on but ${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set`,
    );
    this.name = 'ChannelConfigError';
  }
}

function set(env: EnvRecord, name: string): string | null {
  const v = env[name]?.trim();
  return v ? v : null;
}

/** `credential_ref` is a secret's NAME, and it becomes part of a variable name. */
export function whatsappTokenVariable(credentialRef: string): string {
  if (!/^[A-Z0-9_]{1,64}$/.test(credentialRef)) {
    throw new Error('a credential_ref is upper-case letters, digits and underscores');
  }
  return `${INBOX_ENV.whatsappTokenPrefix}${credentialRef}`;
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
