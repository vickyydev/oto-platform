import {
  ChannelError,
  type Channel,
  type ChannelCapabilities,
  type ChannelHealth,
  type ChannelIdentity,
  type FetchedMedia,
  type InboundEvent,
  type MediaRef,
  type MessagingChannel,
  type OutboundMessage,
  type RawWebhook,
  type SendResult,
  type WebhookVerdict,
} from './contract';

/**
 * THE CONSOLE CHANNEL — the Cut A / Cut B bridge (plan §2.1, §2.4).
 *
 * Today the check-in confirmation and the booking confirmation go out through
 * `buildSmsSender({ adapter: 'console' })` — a log line, delivered nowhere
 * (`apps/api/src/services/checkin.ts:2000-2027`). This adapter WRAPS THAT SAME
 * SENDER, injected by the api, so a notice sent through the Inbox writes
 * exactly the log line it writes now (recipient hashed by the sender, as
 * `sms.ts` does), and the Inbox gets a provider-shaped answer to store.
 *
 * It is a SEND-ONLY channel. Nothing arrives on it: `verifyWebhook`,
 * `parseWebhook` and `fetchMedia` throw `NOT_A_RECEIVING_CHANNEL`, and
 * `capabilities.reply` is false, which is what keeps a notice thread read-only
 * in the Inbox until a real channel exists (owner note 5).
 *
 * WHAT IT SENDS. Text, and a template only when the caller rendered it
 * (`renderedText`) — the console has no template store of its own. Media is
 * refused: there is nowhere to put it.
 *
 * THE ID. `console:<clientRef>`, deterministic, so a retried send of the same
 * message names the same row. The check-in mirror chooses its own synthetic
 * `external_message_id` (`checkin.contact:<regId>:<sentAt>`, plan §2.4) and
 * does not have to use this one.
 */

/** The shape of the api's `SmsSender` that this adapter needs — structural, so the package never imports the api. */
export interface ConsoleSender {
  send(phone: string, message: string): Promise<void>;
}

/** What one console send was, for a test or a demo panel that wants to see it. */
export interface ConsoleRecord {
  clientRef: string;
  externalMessageId: string;
  channel: Channel;
  phone: string;
  text: string;
  at: Date;
}

export interface ConsoleChannelDeps {
  sender: ConsoleSender;
  /** The notice's channel: the registration's `contactChannel` (whatsapp, line, telegram). */
  channel?: Channel;
  /** `channel_account.external_id`; defaults to `console:<channel>`. */
  externalId?: string;
  displayName?: string;
  now?: () => Date;
  /**
   * Called after each accepted send. The api leaves it unset (the log line is
   * the record); checks and a demo panel set it. It receives the text, so it
   * must never be pointed at a log or an audit row.
   */
  onSend?: (record: ConsoleRecord) => void;
}

export class ConsoleChannel implements MessagingChannel {
  readonly provider = 'console' as const;
  readonly capabilities: ChannelCapabilities = {
    reply: false,
    media: false,
    freeTextWindowHours: null,
  };
  readonly identity: ChannelIdentity;

  private readonly sender: ConsoleSender;
  private readonly channel: Channel;
  private readonly now: () => Date;
  private readonly onSend: ((record: ConsoleRecord) => void) | undefined;

  constructor(deps: ConsoleChannelDeps) {
    this.sender = deps.sender;
    this.channel = deps.channel ?? 'whatsapp';
    this.now = deps.now ?? (() => new Date());
    this.onSend = deps.onSend;
    this.identity = {
      provider: 'console',
      channel: this.channel,
      externalId: deps.externalId ?? `console:${this.channel}`,
      displayName: deps.displayName ?? `Console (${this.channel})`,
    };
  }

  verifyWebhook(_req: RawWebhook): WebhookVerdict {
    throw new ChannelError('NOT_A_RECEIVING_CHANNEL', 'the console channel receives no webhooks');
  }

  parseWebhook(_req: RawWebhook): InboundEvent[] {
    throw new ChannelError('NOT_A_RECEIVING_CHANNEL', 'the console channel receives no webhooks');
  }

  fetchMedia(_ref: Pick<MediaRef, 'providerMediaId'>): Promise<FetchedMedia> {
    return Promise.reject(
      new ChannelError('NOT_A_RECEIVING_CHANNEL', 'the console channel holds no media'),
    );
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const text = textOf(msg);
    if (text === null) {
      return {
        ok: false,
        refusal: 'REJECTED',
        retryable: false,
        providerCode: null,
        detail:
          msg.content.kind === 'media'
            ? 'the console channel sends no media'
            : 'the console channel sends a template only when it is rendered',
      };
    }
    const phone = msg.to.phone ?? msg.to.handle;
    try {
      await this.sender.send(phone, text);
    } catch {
      // The sender's own error is not quoted: it may carry the recipient.
      return {
        ok: false,
        refusal: 'UNREACHABLE',
        retryable: true,
        providerCode: null,
        detail: 'the console sender failed',
      };
    }
    const at = this.now();
    const externalMessageId = `console:${msg.clientRef}`;
    this.onSend?.({
      clientRef: msg.clientRef,
      externalMessageId,
      channel: this.channel,
      phone,
      text,
      at,
    });
    return { ok: true, externalMessageId, acceptedAt: at };
  }

  health(): Promise<ChannelHealth> {
    return Promise.resolve({
      status: 'active',
      checkedAt: this.now(),
      detail: 'writes to the api log; delivers nowhere',
    });
  }
}

function textOf(msg: OutboundMessage): string | null {
  switch (msg.content.kind) {
    case 'text':
      return msg.content.text;
    case 'template':
      return msg.content.renderedText ?? null;
    case 'media':
      return null;
  }
}
