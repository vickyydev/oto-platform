import { randomBytes } from 'node:crypto';
import {
  ChannelConfigError,
  ConsoleChannel,
  SimulatorChannel,
  WhatsAppCloudChannel,
  simulatorConfigFrom,
  whatsAppCloudConfigFrom,
  type Channel,
  type ConsoleSender,
  type EnvRecord,
  type MessagingChannel,
} from '@oto/messaging';
import type { Env } from '../../env';

/**
 * THE CHANNEL MAP (S2-19 I2d, SCRUM-583; plan
 * `docs/progress/plans/inbox-build/PLAN.md` §2.2).
 *
 * Where an `inbox.channel_account` row becomes a `MessagingChannel`. Nothing
 * else in the api constructs an adapter, and nothing outside `@oto/messaging`
 * knows which provider is on the other end:
 *
 *   provider    instance
 *   ---------   -------------------------------------------------------------
 *   console     `ConsoleChannel`, always — the console SMS sender the
 *               check-in notice already goes through (send-only, no reply)
 *   simulator   `SimulatorChannel`, only with `INBOX_SIMULATOR=on` (local, CI,
 *               staging; production refuses to boot with it on)
 *   meta_cloud  `WhatsAppCloudChannel`, only with `INBOX_WHATSAPP_ENABLED=true`
 *               and every variable it needs set — never in this story
 *   anything    `CHANNEL_NOT_CONNECTED`
 *
 * ONE INSTANCE PER CHANNEL ACCOUNT, PER PROCESS. The simulator keeps what it
 * minted (media ids, accepted sends, the delivered/read receipts it scheduled)
 * in memory, so the drive route that plays a message and the webhook that
 * verifies it must reach the same object. Instances are cached by account id.
 *
 * A RUN ID PER BOOT. The simulator's ids are counters under a run id
 * (`wamid.SIM.<runId>.IN.000001`); a restart starts the counters again, and
 * a fresh run id is what keeps the new boot from re-minting an id an earlier
 * boot already stored — which the per-message dedupe would otherwise swallow
 * as a replay.
 */

/** The columns of `inbox.channel_account` the map reads. */
export interface ChannelAccountRow {
  id: string;
  provider: string;
  channel: string;
  externalId: string;
  displayName: string;
  credentialRef: string | null;
}

export type ChannelLookup =
  | { ok: true; channel: MessagingChannel }
  | { ok: false; code: 'CHANNEL_NOT_CONNECTED'; reason: string };

export interface InboxChannels {
  /** The adapter for this account, or why there is none. Never throws for configuration. */
  forAccount(row: ChannelAccountRow): ChannelLookup;
  /** The simulator twin of this account, when the simulator is on and the account is one. */
  simulatorFor(row: ChannelAccountRow): SimulatorChannel | null;
  /** Whether `INBOX_SIMULATOR=on`. */
  readonly simulatorEnabled: boolean;
  /** This boot's run id: part of every id the simulator mints. */
  readonly runId: string;
}

export interface InboxChannelDeps {
  env: Pick<
    Env,
    | 'INBOX_SIMULATOR'
    | 'INBOX_SIMULATOR_SECRET'
    | 'INBOX_WHATSAPP_ENABLED'
    | 'INBOX_META_APP_SECRET'
    | 'INBOX_META_VERIFY_TOKEN'
  >;
  /**
   * The console sender, read at send time — the api's `app.sms`, which a
   * test swaps after the app is built.
   */
  consoleSender: () => ConsoleSender;
  /**
   * Where `INBOX_WHATSAPP_TOKEN_<credential_ref>` is read from. Its name is
   * per account, so it cannot be declared in the env schema. Default:
   * `process.env`.
   */
  rawEnv?: EnvRecord;
  /** Fixed in the checks; a fresh one per boot otherwise. */
  runId?: string;
  now?: () => Date;
}

/** Short, sortable and unique enough per boot: base-36 time plus four random bytes. */
export function newRunId(): string {
  return `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`.toUpperCase();
}

export function buildInboxChannels(deps: InboxChannelDeps): InboxChannels {
  const runId = deps.runId ?? newRunId();
  const envRecord: EnvRecord = {
    ...(deps.rawEnv ?? process.env),
    INBOX_SIMULATOR: deps.env.INBOX_SIMULATOR,
    INBOX_SIMULATOR_SECRET: deps.env.INBOX_SIMULATOR_SECRET,
    INBOX_WHATSAPP_ENABLED: deps.env.INBOX_WHATSAPP_ENABLED,
    INBOX_META_APP_SECRET: deps.env.INBOX_META_APP_SECRET,
    INBOX_META_VERIFY_TOKEN: deps.env.INBOX_META_VERIFY_TOKEN,
  };
  // Read once. On without a secret is refused at boot (`assertProductionSafe`);
  // this is the second line, for a caller that built an env by hand.
  let simulator: { enabled: false } | { enabled: true; secret: string };
  try {
    simulator = simulatorConfigFrom(envRecord);
  } catch {
    simulator = { enabled: false };
  }
  const cache = new Map<string, MessagingChannel>();
  const now = deps.now;

  const build = (row: ChannelAccountRow): ChannelLookup => {
    switch (row.provider) {
      case 'console':
        return {
          ok: true,
          channel: new ConsoleChannel({
            sender: { send: (phone, message) => deps.consoleSender().send(phone, message) },
            channel: row.channel as Channel,
            externalId: row.externalId,
            displayName: row.displayName,
            ...(now ? { now } : {}),
          }),
        };
      case 'simulator':
        if (!simulator.enabled) {
          return {
            ok: false,
            code: 'CHANNEL_NOT_CONNECTED',
            reason: 'the inbox simulator is off on this deployment (INBOX_SIMULATOR)',
          };
        }
        return {
          ok: true,
          channel: new SimulatorChannel({
            secret: simulator.secret,
            phoneNumberId: row.externalId,
            displayName: row.displayName,
            channel: row.channel as Channel,
            runId,
            ...(now ? { now } : {}),
          }),
        };
      case 'meta_cloud': {
        let cfg;
        try {
          cfg = whatsAppCloudConfigFrom(envRecord, {
            credentialRef: row.credentialRef ?? '',
            phoneNumberId: row.externalId,
            displayName: row.displayName,
          });
        } catch (err) {
          return {
            ok: false,
            code: 'CHANNEL_NOT_CONNECTED',
            reason:
              err instanceof ChannelConfigError
                ? `WhatsApp is on but ${err.missing.join(', ')} ${err.missing.length === 1 ? 'is' : 'are'} not set`
                : 'the account has no usable credential_ref',
          };
        }
        if (!cfg) {
          return {
            ok: false,
            code: 'CHANNEL_NOT_CONNECTED',
            reason: 'WhatsApp is off on this deployment (INBOX_WHATSAPP_ENABLED)',
          };
        }
        return { ok: true, channel: new WhatsAppCloudChannel(cfg, now ? { now } : {}) };
      }
      default:
        return {
          ok: false,
          code: 'CHANNEL_NOT_CONNECTED',
          reason: `no adapter is built for the ${row.provider} provider`,
        };
    }
  };

  const forAccount = (row: ChannelAccountRow): ChannelLookup => {
    const hit = cache.get(row.id);
    // A cached adapter is reused only while the row still names the same
    // provider and external id — an edited account gets a fresh one.
    if (hit && hit.provider === row.provider && hit.identity.externalId === row.externalId) {
      return { ok: true, channel: hit };
    }
    const made = build(row);
    if (made.ok) cache.set(row.id, made.channel);
    else cache.delete(row.id);
    return made;
  };

  return {
    forAccount,
    simulatorFor(row) {
      if (row.provider !== 'simulator') return null;
      const found = forAccount(row);
      return found.ok && found.channel instanceof SimulatorChannel ? found.channel : null;
    },
    simulatorEnabled: simulator.enabled,
    runId,
  };
}
