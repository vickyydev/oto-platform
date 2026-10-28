/**
 * THE MESSAGING CHANNEL CONTRACT (S2-19, SCRUM-580 — Inbox round I2a).
 *
 * `docs/progress/plans/inbox-build/PLAN.md` §2.1 is the authority for every
 * shape here. The rule this file keeps is the one `@oto/payments-2c2p` keeps
 * for 2C2P: **nothing outside this package knows which provider is on the
 * other end.** The Inbox's ingest, router and send job ask a
 * `MessagingChannel` to verify, parse, send and fetch, and they never see a
 * `wamid`, an `X-Hub-Signature-256` header or a Graph API error code.
 *
 * WHERE IT WAS MEANT TO LIVE. The S2-19 block puts `MessagingChannel` in a
 * `packages/contracts` that does not exist (`SPRINT_2_PLAN.md:2734`). The plan
 * follows the 2C2P precedent (`packages/payments-2c2p/src/contract.ts`): the
 * contract, the simulator and the providers share one package, and moving the
 * contract later is an import path, not a redesign.
 *
 * NO DATABASE, NO ROUTES, NO ENVIRONMENT. The api (I2b) maps a
 * `channel_account` row to an instance (`services/inbox/channels.ts`), hands
 * in the secrets it read, and stores what comes back. This package is pure
 * Node: `node:crypto` and an injected `fetch`, nothing else.
 *
 * REFUSALS ARE VALUES. `send` never throws for a reason the provider gave:
 * the send job records the refusal word and moves on. What does throw is a
 * `ChannelError` — a call that makes no sense for this channel (a webhook to
 * the console), or a media fetch that could not complete, where there is no
 * value to return.
 */

/**
 * The channels a conversation can be on — `inbox.channel_account.channel`'s
 * CHECK (plan §1). `telegram` is a contact value with no adapter (owner Q22's
 * default); the check-in notice can name it.
 */
export const CHANNELS = [
  'whatsapp',
  'instagram',
  'facebook',
  'line',
  'telegram',
  'webform',
] as const;
export type Channel = (typeof CHANNELS)[number];

/** `inbox.channel_account.provider`'s CHECK (plan §1). Only three have adapters here. */
export const PROVIDERS = [
  'meta_cloud',
  'meta_graph',
  'line',
  'respond_io',
  'webform',
  'simulator',
  'console',
] as const;
export type Provider = (typeof PROVIDERS)[number];

/** The providers this package builds an adapter for. Anything else is `CHANNEL_NOT_CONNECTED` in the api. */
export const BUILT_PROVIDERS = [
  'console',
  'simulator',
  'meta_cloud',
] as const satisfies readonly Provider[];

/** `inbox.channel_account.status`'s vocabulary, which is what `health()` answers in. */
export type ChannelStatus = 'active' | 'paused' | 'error';

export interface ChannelCapabilities {
  /** False on the console: the check-in notice thread is read-only in the Inbox. */
  reply: boolean;
  /** Whether outbound media and `fetchMedia` exist on this channel. */
  media: boolean;
  /**
   * Hours after the customer's last message during which free text may be
   * sent; outside it only a template may (WhatsApp's 24-hour rule). Null is
   * "no window": the channel does not limit free text.
   */
  freeTextWindowHours: number | null;
}

/** Which account on which provider this instance speaks for — the Integrations card and the startup line. */
export interface ChannelIdentity {
  provider: Provider;
  channel: Channel;
  /** `channel_account.external_id`: the WhatsApp phone-number id, or the console's synthetic name. */
  externalId: string;
  displayName: string;
}

export interface ChannelHealth {
  status: ChannelStatus;
  checkedAt: Date;
  /** One plain line for the Console's Health page. Never a token, never a phone number. */
  detail: string | null;
}

/**
 * One HTTP delivery as the api's webhook route received it.
 *
 * `rawBody` is THE BYTES, not a re-serialised object: a provider signs what it
 * sent, and `JSON.stringify(JSON.parse(body))` is not what it sent. Fastify's
 * raw-body capture (as the 2C2P webhook already does) hands this over.
 */
export interface RawWebhook {
  method: 'GET' | 'POST';
  /** As received. Looked up case-insensitively. */
  headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  /** The query string, parsed. The GET verify-token challenge lives here. */
  query: Readonly<Record<string, string | undefined>>;
  rawBody: string | Uint8Array;
}

/**
 * What `verifyWebhook` decided. Two kinds of request reach a webhook URL:
 * the provider's GET subscription challenge, and a POST delivery.
 *
 * A refused delivery is still answered 200 by the route (plan §3.3, as the
 * 2C2P webhook does) and recorded as a `webhook_receipt` with
 * `signature_ok=false`. The verdict is what it records.
 */
export type WebhookVerdict =
  | { kind: 'challenge'; ok: true; respondWith: string }
  | { kind: 'challenge'; ok: false; reason: 'BAD_MODE' | 'BAD_VERIFY_TOKEN' | 'MISSING_CHALLENGE' }
  | { kind: 'delivery'; ok: true; deliveryId: string }
  | {
      kind: 'delivery';
      ok: false;
      reason: 'MISSING_SIGNATURE' | 'MALFORMED_SIGNATURE' | 'BAD_SIGNATURE';
      deliveryId: string;
    };

/**
 * A classification the channel itself supplies. Only the simulator does today
 * (plan §3.1 step 1): without the AI (owner Q24), routing takes this when
 * present and the channel account's defaults otherwise.
 */
export interface ClassificationHint {
  /** `gm`: the GM queue (SCRUM-220 playbook). */
  category?: 'birthdays' | 'general' | 'marketing' | 'gm';
  intent?: string;
  language?: string;
  branchId?: string;
}

export type MediaKind = 'image' | 'audio' | 'video' | 'document' | 'sticker';

/** A provider-held media object. `fetchMedia` turns it into bytes; the api stores them as a `core.file_object`. */
export interface MediaRef {
  kind: MediaKind;
  /** The provider's id for the object — what `fetchMedia` is called with. */
  providerMediaId: string;
  mimeType: string | null;
  /** The provider's own digest, when it sends one, so the stored bytes can be checked against it. */
  sha256: string | null;
  caption: string | null;
  filename: string | null;
  /** WhatsApp marks a recorded voice note apart from an attached audio file. */
  voice: boolean;
}

/**
 * What a customer message is, normalised. `text` carries the words where
 * there are any — a text body, a caption, a button's title — so the preview
 * and the reopen work on every type.
 */
export type InboundMessageType =
  | 'text'
  | 'image'
  | 'audio'
  | 'video'
  | 'document'
  | 'sticker'
  | 'location'
  | 'contacts'
  | 'interactive'
  | 'button'
  | 'reaction'
  | 'unsupported';

/**
 * THE DEDUPE KEY. `providerEventId` is unique within one channel account and
 * stable across the provider's retries, so the ingest's
 * `ON CONFLICT (channel_account_id, provider_event_id) DO NOTHING` (plan §3.4)
 * makes a replay a no-op. For WhatsApp it is derived from the `wamid` —
 * `msg:<wamid>` for a message and `status:<wamid>:<status>` for each status
 * step, since one message has several — because Meta's deliveries carry no
 * event id of their own.
 */
export interface InboundMessageEvent {
  kind: 'message';
  providerEventId: string;
  /** The receiving account's external id — which `channel_account` this is for. */
  channelExternalId: string;
  externalMessageId: string;
  /** The sender's per-channel identity: `inbox.contact.external_handle`. */
  handle: string;
  displayName: string | null;
  /** E.164 when the channel's handle is a phone number (WhatsApp); null otherwise. */
  phone: string | null;
  type: InboundMessageType;
  text: string | null;
  media: MediaRef[];
  /** The message this one replies to, when the customer quoted one. */
  replyToExternalId: string | null;
  timestamp: Date;
  hint: ClassificationHint | null;
}

export type DeliveryStatus = 'sent' | 'delivered' | 'read' | 'failed';

export interface InboundStatusEvent {
  kind: 'status';
  providerEventId: string;
  channelExternalId: string;
  /** The outbound message this reports on — `inbox.message.external_message_id`. */
  externalMessageId: string;
  status: DeliveryStatus;
  recipientHandle: string | null;
  timestamp: Date;
  /** The `clientRef` given to `send`, echoed back where the provider supports it. */
  clientRef: string | null;
  /** Set on `failed`. The refusal word, and the provider's code for the ops row. */
  error: { refusal: SendRefusal; providerCode: string; title: string | null } | null;
}

/**
 * A change the parser does not read — account updates, template reviews.
 * Kept so the receipt records that it arrived; nothing acts on it.
 */
export interface InboundUnknownEvent {
  kind: 'unknown';
  providerEventId: string;
  channelExternalId: string | null;
  field: string;
}

export type InboundEvent = InboundMessageEvent | InboundStatusEvent | InboundUnknownEvent;

export type OutboundContent =
  | { kind: 'text'; text: string; previewUrl?: boolean }
  | {
      kind: 'template';
      /** The provider-approved name (`template.provider_template_name`). */
      name: string;
      /** The provider's language code, e.g. `en`, `th`, `ru`. */
      language: string;
      /** Positional body parameters, in order. */
      bodyParameters?: readonly string[];
      /** The rendered words, for channels that send text rather than a template id (the console). */
      renderedText?: string;
    }
  | {
      kind: 'media';
      mediaType: Exclude<MediaKind, 'sticker'>;
      /** Either a provider media id already uploaded, or an https link the provider fetches. */
      providerMediaId?: string;
      link?: string;
      caption?: string;
      filename?: string;
    };

export interface OutboundMessage {
  /**
   * OUR message id (`inbox.message.id`, UUIDv7, caller-named). Carried to the
   * provider as its client reference where it has one, so a status callback
   * names our row (plan §3.5).
   */
  clientRef: string;
  to: {
    /** `inbox.contact.external_handle`. */
    handle: string;
    /** E.164, when known. The console needs it; WhatsApp falls back to it. */
    phone: string | null;
  };
  content: OutboundContent;
  /** The quoted message, when replying to one. */
  replyToExternalId?: string | null;
  /**
   * `conversation.last_customer_message_at`. The free-text window is measured
   * from it; null means the customer has never written, so only a template
   * may open the thread.
   */
  lastCustomerMessageAt: Date | null;
}

/**
 * The five refusals (plan §2.1). Each says what the send job does next:
 *
 *  - `TEMPLATE_REQUIRED` — free text outside the window, refused HERE before
 *    any network: the composer asks for a template.
 *  - `OUT_OF_WINDOW`     — the PROVIDER said the window had closed (WhatsApp
 *    `131047`): our clock and theirs disagreed. Same remedy, different source.
 *  - `RATE_LIMITED`      — try later; retryable.
 *  - `REJECTED`          — the provider refused this message for good: bad
 *    recipient, bad template, bad credentials. Not retryable.
 *  - `UNREACHABLE`       — no answer from the provider (network, timeout,
 *    5xx). Retryable; the sweeper picks it up.
 */
export const SEND_REFUSALS = [
  'OUT_OF_WINDOW',
  'TEMPLATE_REQUIRED',
  'RATE_LIMITED',
  'REJECTED',
  'UNREACHABLE',
] as const;
export type SendRefusal = (typeof SEND_REFUSALS)[number];

export type SendResult =
  | {
      ok: true;
      /** The provider's id — `inbox.message.external_message_id`. The api records `provider_status='sent'`. */
      externalMessageId: string;
      acceptedAt: Date;
    }
  | {
      ok: false;
      refusal: SendRefusal;
      retryable: boolean;
      /** The provider's code, for the `ops_run`. Never a message body. */
      providerCode: string | null;
      detail: string | null;
    };

export interface FetchedMedia {
  contentType: string;
  bytes: Uint8Array;
}

/**
 * THE SEAM (plan §2.1), plus the identity and health the Console's
 * Integrations and Health pages read.
 */
export interface MessagingChannel {
  readonly provider: Provider;
  readonly capabilities: ChannelCapabilities;
  readonly identity: ChannelIdentity;
  /** Signature, plus the verify-token challenge on a GET. Never parses the body. */
  verifyWebhook(req: RawWebhook): WebhookVerdict;
  /** Normalise a VERIFIED delivery. Throws `ChannelError('UNVERIFIED')` on one that does not verify. */
  parseWebhook(req: RawWebhook): InboundEvent[];
  /** The provider message id, or a typed refusal. */
  send(msg: OutboundMessage): Promise<SendResult>;
  fetchMedia(ref: Pick<MediaRef, 'providerMediaId'> & Partial<MediaRef>): Promise<FetchedMedia>;
  health(): Promise<ChannelHealth>;
}

export type ChannelErrorCode =
  | 'NOT_A_RECEIVING_CHANNEL'
  | 'UNVERIFIED'
  | 'MALFORMED_PAYLOAD'
  | 'MEDIA_NOT_FOUND'
  | 'MEDIA_FETCH_FAILED';

/** Thrown where there is no value to return. The message never quotes a body, a token or a phone. */
export class ChannelError extends Error {
  constructor(
    public readonly code: ChannelErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelError';
  }
}
