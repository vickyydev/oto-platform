import { createHash } from 'node:crypto';
import {
  ChannelError,
  type ChannelCapabilities,
  type ChannelHealth,
  type ChannelIdentity,
  type ClassificationHint,
  type DeliveryStatus,
  type FetchedMedia,
  type InboundEvent,
  type InboundMessageEvent,
  type InboundMessageType,
  type InboundStatusEvent,
  type MediaKind,
  type MediaRef,
  type MessagingChannel,
  type OutboundMessage,
  type RawWebhook,
  type SendRefusal,
  type SendResult,
  type WebhookVerdict,
} from './contract';
import { bodyBytes, verifyMetaDelivery, verifyMetaWebhook } from './webhook';
import { windowRefusal } from './window';

/**
 * THE WHATSAPP CLOUD API ADAPTER — A SKELETON (plan §2.1, [B]).
 *
 * Implements the contract against the WhatsApp Cloud API's documented shapes:
 *  - the GET verify-token challenge and the `X-Hub-Signature-256` HMAC
 *    (`webhook.ts`, shared with the simulator);
 *  - parsing of the `messages` change: inbound `messages[]` and `statuses[]`;
 *  - the send body for text, template and media messages;
 *  - the two-step media download (the media id's metadata, then its URL).
 *
 * IT IS NEVER LIVE IN THIS STORY. It is tested only against recorded fixture
 * payloads (`test/fixtures/whatsapp/`) and an injected `fetch`; no test and no
 * code path in this package makes a network call. The api constructs it only
 * when `INBOX_WHATSAPP_ENABLED=true` and its variables are set
 * (`config.ts`), and no Meta account exists yet (owner Q22).
 *
 * WHAT STAYS UNBUILT until a Meta account exists, on purpose:
 *  - uploading outbound media (`POST /<phone-number-id>/media`): outbound media
 *    is sent by an existing provider media id or an https link only;
 *  - template management and approval sync (`approval_status` is set by hand);
 *  - interactive and location SENDS, reactions and read receipts we send;
 *  - token refresh: a system-user token is long-lived, and expiry shows as
 *    `health()` answering `error`;
 *  - the confirmed behaviour of `biz_opaque_callback_data` on our account
 *    (documented, never observed here) — see `buildSendRequest`.
 */

export const GRAPH_BASE_URL = 'https://graph.facebook.com';
/** A dated Graph version. Bumped on purpose, never `latest`. */
export const GRAPH_API_VERSION = 'v21.0';
/** Where Meta serves media bytes. The bearer token is sent to nothing else. */
export const DEFAULT_MEDIA_HOST_SUFFIXES = [
  '.fbsbx.com',
  '.facebook.com',
  '.whatsapp.net',
] as const;

const SEND_TIMEOUT_MS = 10_000;

export interface WhatsAppCloudConfig {
  /** `INBOX_META_APP_SECRET`: signs every webhook delivery. */
  appSecret: string;
  /** `INBOX_META_VERIFY_TOKEN`: what the GET challenge must present. */
  verifyToken: string;
  /** `INBOX_WHATSAPP_TOKEN_<credential_ref>`: the system-user access token for this number. */
  accessToken: string;
  /** `channel_account.external_id`: the Cloud API's phone-number id (not the phone number). */
  phoneNumberId: string;
  displayName?: string;
  /** Overridden only to point at a mock. */
  graphBaseUrl?: string;
  graphVersion?: string;
  mediaHostSuffixes?: readonly string[];
}

/** The subset of `fetch` the adapter uses — injected, so tests answer it from fixtures. */
export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface WhatsAppCloudDeps {
  fetch?: FetchLike;
  now?: () => Date;
}

/** One HTTP request the adapter would make — what the send-request checks assert. */
export interface GraphRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  body: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** Meta's `timestamp` is unix SECONDS as a string. An unreadable one is the receive time, never NaN. */
function dateOf(v: unknown, fallback: Date): Date {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000) : fallback;
}

/** A WhatsApp id (`wa_id`, `from`) is the phone number in digits, country code first. */
export function phoneFromWaId(waId: string | null): string | null {
  return waId && /^\d{6,15}$/.test(waId) ? `+${waId}` : null;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

const MEDIA_TYPES: readonly MediaKind[] = ['image', 'audio', 'video', 'document', 'sticker'];
const KNOWN_TYPES: readonly InboundMessageType[] = [
  'text',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
  'contacts',
  'interactive',
  'button',
  'reaction',
  'unsupported',
];

function mediaOf(kind: MediaKind, body: unknown): MediaRef | null {
  if (!isObject(body)) return null;
  const id = str(body['id']);
  if (!id) return null;
  return {
    kind,
    providerMediaId: id,
    mimeType: str(body['mime_type']),
    sha256: str(body['sha256']),
    caption: str(body['caption']),
    filename: str(body['filename']),
    voice: body['voice'] === true,
  };
}

/** The words a message carries, whatever its type — for the preview and the thread. */
function textOf(type: InboundMessageType, m: Json, media: MediaRef | null): string | null {
  switch (type) {
    case 'text':
      return isObject(m['text']) ? str(m['text']['body']) : null;
    case 'button':
      return isObject(m['button']) ? str(m['button']['text']) : null;
    case 'interactive': {
      const i = m['interactive'];
      if (!isObject(i)) return null;
      const reply = isObject(i['button_reply'])
        ? i['button_reply']
        : isObject(i['list_reply'])
          ? i['list_reply']
          : null;
      return reply ? str(reply['title']) : null;
    }
    case 'reaction':
      return isObject(m['reaction']) ? str(m['reaction']['emoji']) : null;
    case 'location': {
      const l = m['location'];
      if (!isObject(l)) return null;
      return str(l['name']) ?? str(l['address']) ?? null;
    }
    default:
      return media?.caption ?? null;
  }
}

function hintOf(v: unknown): ClassificationHint | null {
  if (!isObject(v)) return null;
  const hint: ClassificationHint = {};
  const category = v['category'];
  if (category === 'birthdays' || category === 'general' || category === 'marketing' || category === 'gm')
    hint.category = category;
  const intent = str(v['intent']);
  if (intent) hint.intent = intent;
  const language = str(v['language']);
  if (language) hint.language = language;
  const branchId = str(v['branchId']);
  if (branchId) hint.branchId = branchId;
  return Object.keys(hint).length > 0 ? hint : null;
}

export interface ParseOptions {
  /** Used when a timestamp is unreadable. */
  receivedAt?: Date;
  /**
   * Read the simulator's `oto_hint` on a message. OFF for the live adapter:
   * a classification is never taken from a field a customer's provider sends.
   */
  acceptHints?: boolean;
}

/**
 * Normalise one WhatsApp Cloud API webhook body into `InboundEvent[]`.
 *
 * Call it only on a VERIFIED body (`WhatsAppCloudChannel.parseWebhook` does
 * both). A body that is not a WhatsApp Business Account delivery at all
 * throws `MALFORMED_PAYLOAD`; inside a valid delivery, a change this parser
 * does not read becomes an `unknown` event rather than an error, so the
 * receipt still records it arrived.
 */
export function parseWhatsAppPayload(body: unknown, opts: ParseOptions = {}): InboundEvent[] {
  const receivedAt = opts.receivedAt ?? new Date();
  if (
    !isObject(body) ||
    body['object'] !== 'whatsapp_business_account' ||
    !Array.isArray(body['entry'])
  ) {
    throw new ChannelError('MALFORMED_PAYLOAD', 'not a WhatsApp Business Account webhook delivery');
  }
  const events: InboundEvent[] = [];
  for (const entry of arr(body['entry'])) {
    if (!isObject(entry)) continue;
    for (const change of arr(entry['changes'])) {
      if (!isObject(change)) continue;
      const field = str(change['field']) ?? 'unknown';
      const value = change['value'];
      const metadata = isObject(value) && isObject(value['metadata']) ? value['metadata'] : null;
      const channelExternalId = metadata ? str(metadata['phone_number_id']) : null;
      if (field !== 'messages' || !isObject(value) || !channelExternalId) {
        events.push({
          kind: 'unknown',
          providerEventId: `unknown:${field}:${digest(change)}`,
          channelExternalId,
          field,
        });
        continue;
      }
      const contacts = arr(value['contacts']).filter(isObject);
      for (const raw of arr(value['messages'])) {
        const parsed = isObject(raw)
          ? parseMessage(raw, contacts, channelExternalId, receivedAt, opts)
          : null;
        events.push(
          parsed ?? {
            kind: 'unknown',
            providerEventId: `unknown:messages.malformed:${digest(raw)}`,
            channelExternalId,
            field: 'messages.malformed',
          },
        );
      }
      for (const raw of arr(value['statuses'])) {
        const parsed = isObject(raw) ? parseStatus(raw, channelExternalId, receivedAt) : null;
        events.push(
          parsed ?? {
            kind: 'unknown',
            providerEventId: `unknown:statuses.unread:${digest(raw)}`,
            channelExternalId,
            field: 'statuses.unread',
          },
        );
      }
    }
  }
  return events;
}

function parseMessage(
  m: Json,
  contacts: Json[],
  channelExternalId: string,
  receivedAt: Date,
  opts: ParseOptions,
): InboundMessageEvent | null {
  const id = str(m['id']);
  const from = str(m['from']);
  if (!id || !from) return null;
  const rawType = str(m['type']) ?? 'unsupported';
  const type: InboundMessageType = (KNOWN_TYPES as readonly string[]).includes(rawType)
    ? (rawType as InboundMessageType)
    : 'unsupported';
  const contact = contacts.find((c) => c['wa_id'] === from) ?? contacts[0];
  const profile = contact && isObject(contact['profile']) ? contact['profile'] : null;
  const mediaKind = (MEDIA_TYPES as readonly string[]).includes(type) ? (type as MediaKind) : null;
  const media = mediaKind ? mediaOf(mediaKind, m[mediaKind]) : null;
  const context = isObject(m['context']) ? m['context'] : null;
  return {
    kind: 'message',
    providerEventId: `msg:${id}`,
    channelExternalId,
    externalMessageId: id,
    handle: from,
    displayName: profile ? str(profile['name']) : null,
    phone: phoneFromWaId(from),
    type,
    text: textOf(type, m, media),
    media: media ? [media] : [],
    replyToExternalId: context ? str(context['id']) : null,
    timestamp: dateOf(m['timestamp'], receivedAt),
    hint: opts.acceptHints ? hintOf(m['oto_hint']) : null,
  };
}

const STATUSES: readonly DeliveryStatus[] = ['sent', 'delivered', 'read', 'failed'];

function parseStatus(
  s: Json,
  channelExternalId: string,
  receivedAt: Date,
): InboundStatusEvent | null {
  const id = str(s['id']);
  const status = str(s['status']);
  if (!id || !status || !(STATUSES as readonly string[]).includes(status)) return null;
  const firstError = arr(s['errors']).find(isObject);
  const code = firstError ? firstError['code'] : undefined;
  return {
    kind: 'status',
    providerEventId: `status:${id}:${status}`,
    channelExternalId,
    externalMessageId: id,
    status: status as DeliveryStatus,
    recipientHandle: str(s['recipient_id']),
    timestamp: dateOf(s['timestamp'], receivedAt),
    clientRef: str(s['biz_opaque_callback_data']),
    error:
      status === 'failed'
        ? {
            refusal: refusalForGraphError(typeof code === 'number' ? code : Number(code), 200)
              .refusal,
            providerCode: code === undefined ? 'unknown' : String(code),
            title: firstError ? str(firstError['title']) : null,
          }
        : null,
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048, 131056, 613]);
const TRANSIENT_CODES = new Set([1, 2, 131000, 131016]);

/**
 * A Graph API error code (or a failed status's code) read as one of the five
 * refusals. `131047` is the re-engagement error — the window closed on Meta's
 * clock. Rate limits and Meta's own transient faults are retryable; every
 * other code (a bad recipient, a template problem, a refused token) is a
 * refusal for good. With no code, the HTTP status decides.
 */
export function refusalForGraphError(
  code: number,
  httpStatus: number,
): { refusal: SendRefusal; retryable: boolean } {
  if (code === 131047) return { refusal: 'OUT_OF_WINDOW', retryable: false };
  if (RATE_LIMIT_CODES.has(code) || httpStatus === 429)
    return { refusal: 'RATE_LIMITED', retryable: true };
  if (TRANSIENT_CODES.has(code) || (!Number.isFinite(code) && httpStatus >= 500)) {
    return { refusal: 'UNREACHABLE', retryable: true };
  }
  return { refusal: 'REJECTED', retryable: false };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/** The `to` the Cloud API takes: the WhatsApp id in digits. Null when the message has no usable recipient. */
export function recipientOf(msg: OutboundMessage): string | null {
  if (/^\d{6,15}$/.test(msg.to.handle)) return msg.to.handle;
  const phone = msg.to.phone?.replace(/^\+/, '') ?? '';
  return /^\d{6,15}$/.test(phone) ? phone : null;
}

function graphRoot(cfg: WhatsAppCloudConfig): string {
  return `${(cfg.graphBaseUrl ?? GRAPH_BASE_URL).replace(/\/+$/, '')}/${cfg.graphVersion ?? GRAPH_API_VERSION}`;
}

function authHeaders(cfg: WhatsAppCloudConfig): Record<string, string> {
  return { authorization: `Bearer ${cfg.accessToken}` };
}

/**
 * The `POST /<phone-number-id>/messages` request for one outbound message.
 *
 * `biz_opaque_callback_data` carries our `clientRef`: Meta documents it as an
 * opaque string echoed on every status webhook for the message, which is how
 * a status names our row without a lookup by `wamid`. It is NOT an
 * idempotency key — the Cloud API has none — so a retried POST after a lost
 * answer is a second message. The send job therefore retries only on a
 * refusal that proves Meta did not accept (plan §3.5's sweeper resends
 * `queued`, never `sent`).
 */
export function buildSendRequest(msg: OutboundMessage, cfg: WhatsAppCloudConfig): GraphRequest {
  const to = recipientOf(msg);
  if (!to) throw new ChannelError('MALFORMED_PAYLOAD', 'the message has no WhatsApp recipient');
  const body: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    biz_opaque_callback_data: msg.clientRef,
  };
  if (msg.replyToExternalId) body['context'] = { message_id: msg.replyToExternalId };
  const c = msg.content;
  switch (c.kind) {
    case 'text':
      body['type'] = 'text';
      body['text'] = { body: c.text, preview_url: c.previewUrl ?? false };
      break;
    case 'template': {
      const template: Record<string, unknown> = { name: c.name, language: { code: c.language } };
      if (c.bodyParameters && c.bodyParameters.length > 0) {
        template['components'] = [
          { type: 'body', parameters: c.bodyParameters.map((text) => ({ type: 'text', text })) },
        ];
      }
      body['type'] = 'template';
      body['template'] = template;
      break;
    }
    case 'media': {
      if (Boolean(c.providerMediaId) === Boolean(c.link)) {
        throw new ChannelError(
          'MALFORMED_PAYLOAD',
          'a media message names exactly one of a media id or a link',
        );
      }
      const media: Record<string, unknown> = c.providerMediaId
        ? { id: c.providerMediaId }
        : { link: c.link };
      // Audio takes no caption; only a document takes a filename.
      if (c.caption && c.mediaType !== 'audio') media['caption'] = c.caption;
      if (c.filename && c.mediaType === 'document') media['filename'] = c.filename;
      body['type'] = c.mediaType;
      body[c.mediaType] = media;
      break;
    }
  }
  return {
    url: `${graphRoot(cfg)}/${encodeURIComponent(cfg.phoneNumberId)}/messages`,
    method: 'POST',
    headers: { ...authHeaders(cfg), 'content-type': 'application/json' },
    body,
  };
}

/** Step one of a media download: the media id's metadata, which holds a short-lived URL. */
export function buildMediaMetadataRequest(mediaId: string, cfg: WhatsAppCloudConfig): GraphRequest {
  return {
    url: `${graphRoot(cfg)}/${encodeURIComponent(mediaId)}?phone_number_id=${encodeURIComponent(cfg.phoneNumberId)}`,
    method: 'GET',
    headers: authHeaders(cfg),
    body: null,
  };
}

function mediaHostAllowed(url: string, suffixes: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.protocol === 'https:' && suffixes.some((s) => parsed.hostname.endsWith(s));
}

function graphErrorOf(body: unknown): { code: number; title: string | null } | null {
  if (!isObject(body) || !isObject(body['error'])) return null;
  const e = body['error'];
  return {
    code: typeof e['code'] === 'number' ? e['code'] : Number(e['code']),
    title: str(e['type']),
  };
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class WhatsAppCloudChannel implements MessagingChannel {
  readonly provider = 'meta_cloud' as const;
  readonly capabilities: ChannelCapabilities = {
    reply: true,
    media: true,
    freeTextWindowHours: 24,
  };
  readonly identity: ChannelIdentity;

  private readonly cfg: WhatsAppCloudConfig;
  private readonly fetch: FetchLike;
  private readonly now: () => Date;

  constructor(cfg: WhatsAppCloudConfig, deps: WhatsAppCloudDeps = {}) {
    const missing = (['appSecret', 'verifyToken', 'accessToken', 'phoneNumberId'] as const).filter(
      (k) => !cfg[k],
    );
    if (missing.length > 0) {
      throw new Error(`the WhatsApp Cloud adapter is missing ${missing.join(', ')}`);
    }
    this.cfg = cfg;
    this.fetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = deps.now ?? (() => new Date());
    this.identity = {
      provider: 'meta_cloud',
      channel: 'whatsapp',
      externalId: cfg.phoneNumberId,
      displayName: cfg.displayName ?? 'WhatsApp',
    };
  }

  verifyWebhook(req: RawWebhook): WebhookVerdict {
    return verifyMetaWebhook(req, {
      appSecret: this.cfg.appSecret,
      verifyToken: this.cfg.verifyToken,
    });
  }

  /** VERIFY, THEN READ: an unverified body is refused before it is parsed. */
  parseWebhook(req: RawWebhook): InboundEvent[] {
    if (!verifyMetaDelivery(req, this.cfg.appSecret).ok) {
      throw new ChannelError('UNVERIFIED', 'the delivery does not carry a valid signature');
    }
    let body: unknown;
    try {
      body = JSON.parse(bodyBytes(req.rawBody).toString('utf8'));
    } catch {
      throw new ChannelError('MALFORMED_PAYLOAD', 'the delivery is not JSON');
    }
    return parseWhatsAppPayload(body, { receivedAt: this.now() });
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const now = this.now();
    const early = windowRefusal(
      msg.content,
      msg.lastCustomerMessageAt,
      now,
      this.capabilities.freeTextWindowHours,
    );
    if (early) {
      return {
        ok: false,
        refusal: early,
        retryable: false,
        providerCode: null,
        detail: 'outside the 24-hour window',
      };
    }
    let request: GraphRequest;
    try {
      request = buildSendRequest(msg, this.cfg);
    } catch (err) {
      const detail = err instanceof ChannelError ? err.message : 'the message could not be built';
      return { ok: false, refusal: 'REJECTED', retryable: false, providerCode: null, detail };
    }
    let status: number;
    let answer: unknown;
    try {
      const res = await this.fetch(request.url, {
        method: request.method,
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      status = res.status;
      answer = await res.json().catch(() => null);
    } catch {
      return {
        ok: false,
        refusal: 'UNREACHABLE',
        retryable: true,
        providerCode: null,
        detail: 'no answer from the Graph API',
      };
    }
    const messages = isObject(answer) ? arr(answer['messages']) : [];
    const first = messages.find(isObject);
    const id = first ? str(first['id']) : null;
    if (status >= 200 && status < 300 && id) {
      return { ok: true, externalMessageId: id, acceptedAt: now };
    }
    const err = graphErrorOf(answer);
    const { refusal, retryable } = refusalForGraphError(err?.code ?? NaN, status);
    return {
      ok: false,
      refusal,
      retryable,
      providerCode: err && Number.isFinite(err.code) ? String(err.code) : `http_${status}`,
      detail: err?.title ?? null,
    };
  }

  async fetchMedia(
    ref: Pick<MediaRef, 'providerMediaId'> & Partial<MediaRef>,
  ): Promise<FetchedMedia> {
    const meta = buildMediaMetadataRequest(ref.providerMediaId, this.cfg);
    let info: unknown;
    try {
      const res = await this.fetch(meta.url, {
        method: 'GET',
        headers: meta.headers,
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (res.status === 404)
        throw new ChannelError('MEDIA_NOT_FOUND', 'the provider has no such media');
      if (!res.ok)
        throw new ChannelError('MEDIA_FETCH_FAILED', `the media lookup answered ${res.status}`);
      info = await res.json();
    } catch (err) {
      if (err instanceof ChannelError) throw err;
      throw new ChannelError('MEDIA_FETCH_FAILED', 'the media lookup did not answer');
    }
    const url = isObject(info) ? str(info['url']) : null;
    const contentType =
      (isObject(info) ? str(info['mime_type']) : null) ??
      ref.mimeType ??
      'application/octet-stream';
    if (!url || !mediaHostAllowed(url, this.cfg.mediaHostSuffixes ?? DEFAULT_MEDIA_HOST_SUFFIXES)) {
      // The bearer token goes to Meta's media hosts and nowhere else.
      throw new ChannelError('MEDIA_FETCH_FAILED', 'the media URL is not on a Meta media host');
    }
    try {
      const res = await this.fetch(url, {
        method: 'GET',
        headers: authHeaders(this.cfg),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      if (!res.ok)
        throw new ChannelError('MEDIA_FETCH_FAILED', `the media download answered ${res.status}`);
      return { contentType, bytes: new Uint8Array(await res.arrayBuffer()) };
    } catch (err) {
      if (err instanceof ChannelError) throw err;
      throw new ChannelError('MEDIA_FETCH_FAILED', 'the media download did not answer');
    }
  }

  /** The phone number's own record: a refused token or an unknown number shows here before a send fails. */
  async health(): Promise<ChannelHealth> {
    const checkedAt = this.now();
    const url = `${graphRoot(this.cfg)}/${encodeURIComponent(this.cfg.phoneNumberId)}?fields=verified_name,quality_rating`;
    try {
      const res = await this.fetch(url, {
        method: 'GET',
        headers: authHeaders(this.cfg),
        signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const err = graphErrorOf(body);
        const detail =
          err?.code === 190 || res.status === 401
            ? 'the access token was refused'
            : `the Graph API answered ${res.status}`;
        return { status: 'error', checkedAt, detail };
      }
      const quality = isObject(body) ? str(body['quality_rating']) : null;
      return { status: 'active', checkedAt, detail: quality ? `quality rating ${quality}` : null };
    } catch {
      return { status: 'error', checkedAt, detail: 'the Graph API did not answer' };
    }
  }
}
