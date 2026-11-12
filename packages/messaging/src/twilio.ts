import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import {
  ChannelError,
  type ChannelCapabilities,
  type ChannelHealth,
  type ChannelIdentity,
  type DeliveryStatus,
  type FetchedMedia,
  type InboundEvent,
  type InboundMessageEvent,
  type InboundMessageType,
  type InboundStatusEvent,
  type InboundUnknownEvent,
  type MediaKind,
  type MediaRef,
  type MessagingChannel,
  type OutboundMessage,
  type RawWebhook,
  type SendRefusal,
  type SendResult,
  type WebhookVerdict,
} from './contract';
import { bodyBytes, deliveryIdOf, headerOf } from './webhook';
import { windowRefusal } from './window';

/**
 * THE TWILIO WHATSAPP ADAPTER — THE TEST LINE (SCRUM-908).
 *
 * One WhatsApp number on Twilio, today the shared SANDBOX number, put in
 * front of the Unified Inbox as a test line: one allowed customer number,
 * the assistant replying by itself, its own place in the inbox. The owner's
 * go of 12 November 2026: "connect tom number as customer and use any random
 * sandbox number assuming as Park operator and communicate 1:1 as live using
 * twilio APIs".
 *
 * WHAT TWILIO'S DOCUMENTATION SAYS, READ ON 12 NOVEMBER 2026 (the pages win
 * over this note; re-read them before changing anything here):
 *
 *  - SENDING — https://www.twilio.com/docs/messaging/api/message-resource:
 *    `POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json`,
 *    form-encoded, HTTP Basic auth. `From` is "your approved WhatsApp sender
 *    address (e.g., whatsapp:+15552221111)", `To` "a WhatsApp recipient
 *    address"; content is `Body`, `MediaUrl` or `ContentSid`
 *    (+`ContentVariables`, the Content API's templates); `StatusCallback` is
 *    where the status requests go. The answer carries `sid` and `status`; an
 *    error is `{ code, message, more_info, status }`
 *    (https://www.twilio.com/docs/usage/twilios-response).
 *  - STATUS CALLBACKS — https://www.twilio.com/docs/messaging/guides/track-outbound-message-status:
 *    POSTed `application/x-www-form-urlencoded`, carrying `MessageStatus` and
 *    `ErrorCode` beside `AccountSid`, `From`, `MessageSid`, `SmsSid`,
 *    `SmsStatus`; WhatsApp ones may carry `ChannelPrefix`,
 *    `ChannelInstallSid`, `ChannelStatusMessage` (on a failed delivery only)
 *    and `EventType=READ`. Without a Messaging Service "you need to provide
 *    your status callback URL in the StatusCallback parameter of each
 *    message" — so every send here names it. Statuses: queued, sending,
 *    sent, delivered, undelivered, failed, read (WhatsApp, read receipts on),
 *    and accepted, scheduled, canceled (Messaging Service only).
 *  - INCOMING — https://www.twilio.com/docs/messaging/guides/webhook-request:
 *    form-encoded; `MessageSid` (34 characters; `SmsSid` and `SmsMessageSid`
 *    the same value, deprecated), `AccountSid`, `From`, `To` (channel
 *    addresses, `whatsapp:+…`), `Body`, `NumMedia`, `MediaContentType{N}` and
 *    `MediaUrl{N}` (N from 0), `ProfileName`, `WaId`, `ButtonText`,
 *    `ButtonPayload`, `Latitude`, `Longitude`, `Address`, `Label`,
 *    `OriginalRepliedMessageSid`. "Twilio makes a synchronous request and
 *    expects TwiML in return": the route answers an empty `<Response/>`.
 *    Incoming messages carry no timestamp; the receive time stands in.
 *  - THE SIGNATURE — https://www.twilio.com/docs/usage/security and
 *    https://www.twilio.com/docs/usage/webhooks/webhooks-security: "Take the
 *    full URL of the request URL you specify", "sort all the POST parameters
 *    alphabetically (using Unix-style case-sensitive sorting order)",
 *    "append the variable name and value (with no delimiters)", "Sign the
 *    resulting string with HMAC-SHA1 using your AuthToken as the key",
 *    "Base64-encode", compare with `X-Twilio-Signature`. "If you decode or
 *    re-encode the URL, signature validation fails"; "your code must include
 *    all received parameters". For SMS callbacks over HTTPS "Twilio will keep
 *    the port (if any) in the URL", and drops any user and password.
 *  - THE SANDBOX — https://www.twilio.com/docs/whatsapp/sandbox: the shared
 *    number `+14155238886`; each user sends `join <your sandbox code>`; "The
 *    Sandbox session expires three days after joining"; "stop" leaves it;
 *    "Messaging other users will fail with Error 63015"; "The Sandbox number
 *    can only send one message every three seconds"; only three
 *    pre-approved templates and "You can't use custom message templates with
 *    the Sandbox"; the webhook and the status callback are set in the legacy
 *    Console, Sandbox settings > Sandbox configuration.
 *  - MEDIA — https://www.twilio.com/docs/messaging/api/media-resource:
 *    "Twilio enforces HTTP Basic Authentication for all media URLs";
 *    https://www.twilio.com/docs/whatsapp/guidance-whatsapp-media-messages:
 *    images JPG/PNG (WEBP for stickers), audio OGG (opus)/AMR/3GP/AAC/MPEG,
 *    PDF and office documents, MP4 video; "the maximum size limit is 20MB",
 *    images 5 MB; no caption or filename on a document sent as media.
 *  - ERRORS — https://www.twilio.com/docs/api/errors/63015 (sandbox: the
 *    recipient has not joined, or joined more than three days ago),
 *    /63016 ("Outside messaging window. For WhatsApp, use a Message Template
 *    instead"), /63018 ("Rate limit exceeded for Channel").
 *
 * WHAT THE DOCUMENTATION DID NOT SAY, AND WHAT THIS FILE DOES ABOUT IT:
 *  - whether the sandbox forwards `join <code>` and `stop` to the "When a
 *    message comes in" URL: on the sandbox number they are read as the
 *    sandbox's own chatter and never become a customer conversation;
 *  - how a parameter repeated under one name is signed: never seen in a
 *    messaging webhook; its values are sorted, as Twilio's own library does;
 *  - whether a media URL redirects to another host: the credentials go to
 *    `api.twilio.com` only, and a redirect is followed without them;
 *  - a voice note apart from an audio file: WhatsApp records voice notes as
 *    OGG/Opus, so an inbound `audio/ogg` is marked a voice note;
 *  - `MessageType` on an incoming message: read when it names a type this
 *    contract knows, else the type is taken from the fields.
 *
 * NO NETWORK IN ANY TEST: `fetch` and `sleep` are injected, and the checks
 * answer them from fixtures written from the shapes above.
 *
 * THE ALLOW-LIST (the owner's safety rule). An incoming message from a number
 * not on the list becomes an `unknown` event (`messages.not_allowed`): the
 * ingest records that a delivery arrived and nothing else — no contact, no
 * conversation, no message, no assistant turn, no reply. A send to a number
 * not on it is refused `NOT_ALLOWED` before any network.
 *
 * PACING. The sandbox sends one message every three seconds. A send takes
 * the next free three-second slot and waits for it when it is close (the
 * assistant's lines and a reply right after it); a send whose slot is
 * further away is answered `RATE_LIMITED` (retryable), which leaves it
 * queued for the send job's sweeper — queued, never dropped.
 */

export const TWILIO_API_BASE = 'https://api.twilio.com';
export const TWILIO_API_VERSION = '2010-04-01';
/** Twilio's shared WhatsApp sandbox number (its documentation's, not a person's). */
export const TWILIO_SANDBOX_NUMBER = '+14155238886';
export const TWILIO_SIGNATURE_HEADER = 'x-twilio-signature';
/** "The Sandbox number can only send one message every three seconds." */
export const TWILIO_SANDBOX_PACE_MS = 3_000;
/** The longest a send waits for its slot before it is left queued for the sweeper. */
export const TWILIO_MAX_PACE_WAIT_MS = 6_000;
/** Where the account's credentials may be sent: the REST API's own host, and nothing else. */
export const TWILIO_MEDIA_HOST = 'api.twilio.com';
/** WhatsApp's own ceiling for one message's media (Twilio's media guidance). */
export const TWILIO_MEDIA_MAX_BYTES = 20 * 1024 * 1024;
/** An empty TwiML document: "do nothing", the answer to every webhook. */
export const TWIML_EMPTY = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

const REQUEST_TIMEOUT_MS = 10_000;

export interface TwilioConfig {
  /** `INBOX_TWILIO_ACCOUNT_SID_<credential_ref>`: names the account in every URL. */
  accountSid: string;
  /** `INBOX_TWILIO_AUTH_TOKEN_<credential_ref>`: signs every webhook, and authenticates our calls. */
  authToken: string;
  /** `channel_account.external_id`: the WhatsApp sender, E.164 (the sandbox's shared number). */
  sender: string;
  /** `INBOX_TWILIO_PUBLIC_URL`: the api's public origin as Twilio calls it — what the signature covers. */
  publicUrl: string;
  /** The route's path for this account (`/webhooks/inbox/twilio/<id>`): every send's status callback. */
  webhookPath: string;
  /** `INBOX_TWILIO_ALLOWED_NUMBERS_<credential_ref>`, read by `normalizePhone`: the only customer numbers (E.164). Never empty. */
  allowedNumbers: readonly string[];
  displayName?: string;
  /** Overridden only to point at a mock. */
  apiBaseUrl?: string;
  /** The gap between two sends. Default: three seconds on the sandbox number, none elsewhere. */
  paceMs?: number;
  maxPaceWaitMs?: number;
}

/** The subset of `fetch` the adapter uses — injected, so the checks answer it from fixtures. */
export type TwilioFetch = (
  url: string,
  init: {
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    redirect?: 'manual' | 'follow';
    signal?: AbortSignal;
  },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
  arrayBuffer(): Promise<ArrayBuffer>;
}>;

export interface TwilioChannelDeps {
  fetch?: TwilioFetch;
  now?: () => Date;
  /** How a send waits for its slot. Real time by default; the checks pass their own. */
  sleep?: (ms: number) => Promise<void>;
}

/** One request the adapter would make — what the send checks assert. */
export interface TwilioRequest {
  url: string;
  method: 'POST' | 'GET';
  headers: Record<string, string>;
  /** The form fields, in order; repeated names allowed. */
  form: Array<[string, string]> | null;
}

// ---------------------------------------------------------------------------
// The signature
// ---------------------------------------------------------------------------

/** The form's fields, decoded, in arrival order — repeated names kept. */
export function formFieldsOf(raw: string | Uint8Array): Array<[string, string]> {
  return [...new URLSearchParams(bodyBytes(raw).toString('utf8')).entries()];
}

/**
 * `X-Twilio-Signature` for a URL and its POST fields: the URL, then every
 * field's name and value with no delimiters, names sorted case-sensitively
 * (a repeated name's values sorted too), HMAC-SHA1 under the auth token,
 * base64. Used to verify, and by the checks to sign their fixtures.
 */
export function twilioSignature(
  authToken: string,
  url: string,
  fields: ReadonlyArray<readonly [string, string]>,
): string {
  if (!authToken) throw new Error('no auth token is configured to sign with');
  const byName = new Map<string, string[]>();
  for (const [name, value] of fields) {
    const list = byName.get(name);
    if (list) list.push(value);
    else byName.set(name, [value]);
  }
  let data = url;
  for (const name of [...byName.keys()].sort()) {
    for (const value of [...byName.get(name)!].sort()) data += name + value;
  }
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

/**
 * The URLs a delivery may have been signed over: the configured origin and
 * the route's path, exactly; and, as Twilio's own validator allows, the same
 * with the scheme's default port written out.
 */
export function signedUrlCandidates(publicUrl: string, publicPath: string): string[] {
  const path = publicPath.startsWith('/') ? publicPath : `/${publicPath}`;
  const exact = `${publicUrl}${path}`;
  const out = [exact];
  try {
    const u = new URL(publicUrl);
    if (u.port === '') {
      out.push(`${u.protocol}//${u.hostname}:${u.protocol === 'https:' ? '443' : '80'}${path}`);
    }
  } catch {
    // A configured origin is parsed before it reaches here (`parsePublicOrigin`).
  }
  return out;
}

const SIGNATURE_SHAPE = /^[A-Za-z0-9+/]{27}=$/;

/** The POST half of `verifyWebhook`. Constant-time; the body is read only as the signed fields. */
export function verifyTwilioDelivery(
  req: RawWebhook,
  secrets: { authToken: string; publicUrl: string },
): WebhookVerdict {
  const deliveryId = deliveryIdOf(req.rawBody);
  const header = headerOf(req, TWILIO_SIGNATURE_HEADER)?.trim();
  if (!header) return { kind: 'delivery', ok: false, reason: 'MISSING_SIGNATURE', deliveryId };
  if (!SIGNATURE_SHAPE.test(header)) {
    return { kind: 'delivery', ok: false, reason: 'MALFORMED_SIGNATURE', deliveryId };
  }
  if (!secrets.authToken || !secrets.publicUrl || !req.publicPath) {
    return { kind: 'delivery', ok: false, reason: 'BAD_SIGNATURE', deliveryId };
  }
  const given = Buffer.from(header, 'base64');
  const fields = formFieldsOf(req.rawBody);
  let ok = false;
  for (const url of signedUrlCandidates(secrets.publicUrl, req.publicPath)) {
    const expected = Buffer.from(twilioSignature(secrets.authToken, url, fields), 'base64');
    // Every candidate is compared, so the time taken says nothing about which matched.
    if (expected.length === given.length && timingSafeEqual(expected, given)) ok = true;
  }
  return ok
    ? { kind: 'delivery', ok: true, deliveryId }
    : { kind: 'delivery', ok: false, reason: 'BAD_SIGNATURE', deliveryId };
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** `whatsapp:+66812345678` → `+66812345678`; anything that is not an E.164 address → null. */
export function addressToE164(address: string | null | undefined): string | null {
  if (!address) return null;
  const bare = address.trim().replace(/^whatsapp:/i, '');
  return /^\+[1-9]\d{6,14}$/.test(bare) ? bare : null;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 32);
}

function field(fields: ReadonlyMap<string, string>, name: string): string | null {
  const v = fields.get(name);
  return v !== undefined && v.length > 0 ? v : null;
}

const KNOWN_TYPES: ReadonlySet<string> = new Set<InboundMessageType>([
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
]);

/** What a WhatsApp media item is, by its content type. */
export function mediaKindOf(contentType: string | null): MediaKind {
  const type = (contentType ?? '').split(';', 1)[0]!.trim().toLowerCase();
  if (type === 'image/webp') return 'sticker';
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('audio/')) return 'audio';
  if (type.startsWith('video/')) return 'video';
  return 'document';
}

/**
 * The sandbox's own chatter — `join <code>` and `stop` — on the sandbox
 * number: read before anything else, and never a customer conversation.
 *
 * THE CODE'S FORM. The sandbox page names it only as `join <your sandbox
 * code>`; Twilio's own guide says the code begins with "join", "followed by a
 * randomly generated two-word phrase"
 * (https://www.twilio.com/en-us/blog/how-to-send-a-message-on-whatsapp-with-curl),
 * which the Console shows as two words joined by a hyphen. So only `join`
 * followed by exactly `<word>-<word>` is the sandbox's: "join us", "join the
 * party" and "Join us at 3" are a customer's words and reach the conversation.
 */
const SANDBOX_CONTROL = /^\s*(?:join\s+[a-z0-9]+-[a-z0-9]+|stop)\s*$/i;

export interface TwilioParseOptions {
  /** `TwilioConfig.accountSid`: a delivery for another account is never filed. */
  accountSid: string;
  /** `TwilioConfig.sender`: the number the line receives on. */
  sender: string;
  /** The allowed customer numbers; a message from anyone else is `messages.not_allowed`. */
  allowedNumbers: readonly string[];
  receivedAt: Date;
}

const STATUS_OF: Readonly<Record<string, DeliveryStatus>> = {
  sent: 'sent',
  delivered: 'delivered',
  read: 'read',
  undelivered: 'failed',
  failed: 'failed',
};

function unknown(field: string, providerEventId: string, channelExternalId: string | null): InboundUnknownEvent {
  return { kind: 'unknown', providerEventId, channelExternalId, field };
}

/**
 * Normalise one VERIFIED Twilio delivery — an incoming message or a status
 * callback, told apart by `MessageStatus` — into `InboundEvent[]`. Never
 * throws for an unknown shape inside a verified delivery: what it does not
 * read becomes an `unknown` event, so the receipt still records it arrived.
 */
export function parseTwilioForm(
  pairs: ReadonlyArray<readonly [string, string]>,
  opts: TwilioParseOptions,
): InboundEvent[] {
  const fields = new Map<string, string>();
  for (const [k, v] of pairs) if (!fields.has(k)) fields.set(k, v);
  const id = digest([...pairs]);

  const accountSid = field(fields, 'AccountSid');
  if (accountSid !== opts.accountSid) return [unknown('account.foreign', `unknown:account.foreign:${id}`, null)];

  const status = field(fields, 'MessageStatus')?.toLowerCase() ?? null;
  if (status !== null && status !== 'received' && status !== 'receiving') {
    const sid = field(fields, 'MessageSid') ?? field(fields, 'SmsSid');
    const channelExternalId = addressToE164(field(fields, 'From')) ?? opts.sender;
    if (!sid) return [unknown('status.malformed', `unknown:status.malformed:${id}`, channelExternalId)];
    const mapped = STATUS_OF[status];
    if (!mapped) return [unknown(`status.${status.replace(/[^a-z_]/g, '')}`, `unknown:status:${sid}:${status}`, channelExternalId)];
    const code = field(fields, 'ErrorCode');
    const event: InboundStatusEvent = {
      kind: 'status',
      providerEventId: `status:${sid}:${mapped}`,
      channelExternalId,
      externalMessageId: sid,
      status: mapped,
      recipientHandle: addressToE164(field(fields, 'To'))?.slice(1) ?? null,
      timestamp: opts.receivedAt,
      clientRef: null,
      error:
        mapped === 'failed'
          ? {
              refusal: refusalForTwilioError(code === null ? NaN : Number(code), 200).refusal,
              providerCode: code ?? 'unknown',
              // ChannelStatusMessage is the channel's own words: never kept.
              title: null,
            }
          : null,
    };
    return [event];
  }

  const sid = field(fields, 'MessageSid') ?? field(fields, 'SmsMessageSid') ?? field(fields, 'SmsSid');
  const channelExternalId = addressToE164(field(fields, 'To'));
  const waId = field(fields, 'WaId');
  const phone = addressToE164(field(fields, 'From')) ?? (waId && /^\d{6,15}$/.test(waId) ? `+${waId}` : null);
  if (!sid || !phone || !channelExternalId) {
    return [unknown('messages.malformed', `unknown:messages.malformed:${id}`, channelExternalId)];
  }
  // The owner's safety rule: a number not on the list is never a customer here.
  if (!opts.allowedNumbers.includes(phone)) {
    return [unknown('messages.not_allowed', `unknown:messages.not_allowed:${sid}`, channelExternalId)];
  }
  const body = field(fields, 'Body');
  const numMedia = Math.max(0, Math.min(10, Number(field(fields, 'NumMedia') ?? '0') || 0));
  if (opts.sender === TWILIO_SANDBOX_NUMBER && numMedia === 0 && body !== null && SANDBOX_CONTROL.test(body)) {
    return [unknown('sandbox.control', `unknown:sandbox.control:${sid}`, channelExternalId)];
  }

  const media: MediaRef[] = [];
  for (let n = 0; n < numMedia; n += 1) {
    const url = field(fields, `MediaUrl${n}`);
    if (!url) continue;
    const mimeType = field(fields, `MediaContentType${n}`);
    const kind = mediaKindOf(mimeType);
    media.push({
      kind,
      providerMediaId: url,
      mimeType,
      sha256: null,
      caption: null,
      filename: null,
      voice: kind === 'audio' && (mimeType ?? '').toLowerCase().startsWith('audio/ogg'),
    });
  }
  const latitude = field(fields, 'Latitude');
  const button = field(fields, 'ButtonText');
  const declared = field(fields, 'MessageType')?.toLowerCase() ?? null;
  let type: InboundMessageType;
  let text: string | null = body;
  if (latitude !== null && field(fields, 'Longitude') !== null) {
    type = 'location';
    text = field(fields, 'Label') ?? field(fields, 'Address') ?? body;
  } else if (button !== null) {
    type = 'button';
    text = button;
  } else if (media.length > 0) {
    type = media[0]!.kind;
  } else if (declared !== null && KNOWN_TYPES.has(declared) && declared !== 'text') {
    type = declared as InboundMessageType;
  } else {
    type = body !== null ? 'text' : 'unsupported';
  }
  const event: InboundMessageEvent = {
    kind: 'message',
    providerEventId: `msg:${sid}`,
    channelExternalId,
    externalMessageId: sid,
    handle: phone.slice(1),
    displayName: field(fields, 'ProfileName'),
    phone,
    type,
    text,
    media,
    replyToExternalId: field(fields, 'OriginalRepliedMessageSid'),
    timestamp: opts.receivedAt,
    // A classification is never taken from a field a live provider sends.
    hint: null,
  };
  return [event];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Twilio's own faults, worth another try. */
const TRANSIENT_CODES = new Set([20500, 20503]);
/** "Rate limit exceeded for Channel" and the REST API's concurrency limit. */
const RATE_LIMIT_CODES = new Set([63018, 20429]);

/**
 * A Twilio error code (or a failed status's `ErrorCode`) read as one of the
 * contract's refusals. `63016` is the closed 24-hour window on Twilio's
 * clock; `63015` (the recipient has not joined the sandbox, or joined more
 * than three days ago) and every other code is a refusal for good, the code
 * kept beside it. With no code, the HTTP status decides.
 */
export function refusalForTwilioError(
  code: number,
  httpStatus: number,
): { refusal: SendRefusal; retryable: boolean } {
  if (code === 63016) return { refusal: 'OUT_OF_WINDOW', retryable: false };
  if (RATE_LIMIT_CODES.has(code) || httpStatus === 429) return { refusal: 'RATE_LIMITED', retryable: true };
  if (TRANSIENT_CODES.has(code) || (!Number.isFinite(code) && httpStatus >= 500)) {
    return { refusal: 'UNREACHABLE', retryable: true };
  }
  return { refusal: 'REJECTED', retryable: false };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The recipient as E.164: the contact's phone, else its WhatsApp id. */
export function twilioRecipientOf(msg: OutboundMessage): string | null {
  const phone = addressToE164(msg.to.phone);
  if (phone) return phone;
  return /^\d{6,15}$/.test(msg.to.handle) ? `+${msg.to.handle}` : addressToE164(msg.to.handle);
}

function apiRoot(cfg: TwilioConfig): string {
  return `${(cfg.apiBaseUrl ?? TWILIO_API_BASE).replace(/\/+$/, '')}/${TWILIO_API_VERSION}/Accounts/${encodeURIComponent(cfg.accountSid)}`;
}

function authHeader(cfg: TwilioConfig): string {
  return `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`, 'utf8').toString('base64')}`;
}

function formBody(form: ReadonlyArray<readonly [string, string]>): string {
  const p = new URLSearchParams();
  for (const [k, v] of form) p.append(k, v);
  return p.toString();
}

/**
 * The `Messages.json` request for one outbound message — text, or one media
 * item by its https link (Twilio fetches the link; a provider media id has
 * no meaning here). A template is not built: the sandbox takes no custom
 * templates, and `send` refuses one before this.
 */
export function buildTwilioSendRequest(msg: OutboundMessage, cfg: TwilioConfig): TwilioRequest {
  const to = twilioRecipientOf(msg);
  if (!to) throw new ChannelError('MALFORMED_PAYLOAD', 'the message has no WhatsApp recipient');
  const form: Array<[string, string]> = [
    ['To', `whatsapp:${to}`],
    ['From', `whatsapp:${cfg.sender}`],
  ];
  const c = msg.content;
  if (c.kind === 'text') {
    form.push(['Body', c.text]);
  } else if (c.kind === 'media') {
    if (!c.link || !/^https:\/\//i.test(c.link)) {
      throw new ChannelError('MALFORMED_PAYLOAD', 'a Twilio media message is sent by an https link');
    }
    // "Twilio does not support setting a filename or caption for documents";
    // a caption goes with an image or a video only.
    if (c.caption && (c.mediaType === 'image' || c.mediaType === 'video')) form.push(['Body', c.caption]);
    form.push(['MediaUrl', c.link]);
  } else {
    throw new ChannelError('MALFORMED_PAYLOAD', 'this line sends no templates');
  }
  form.push(['StatusCallback', `${cfg.publicUrl}${cfg.webhookPath}`]);
  return {
    url: `${apiRoot(cfg)}/Messages.json`,
    method: 'POST',
    headers: { authorization: authHeader(cfg), 'content-type': 'application/x-www-form-urlencoded' },
    form,
  };
}

/** A media URL this account's credentials may be sent to: https, Twilio's API host, this account's path. */
export function isOwnMediaUrl(url: string, accountSid: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    u.hostname === TWILIO_MEDIA_HOST &&
    u.port === '' &&
    !u.username &&
    u.pathname.startsWith(`/${TWILIO_API_VERSION}/Accounts/${accountSid}/Messages/`) &&
    /\/Media\/[A-Za-z0-9]+$/.test(u.pathname)
  );
}

// ---------------------------------------------------------------------------
// The adapter
// ---------------------------------------------------------------------------

export class TwilioWhatsAppChannel implements MessagingChannel {
  readonly provider = 'twilio' as const;
  readonly capabilities: ChannelCapabilities = {
    reply: true,
    media: true,
    freeTextWindowHours: 24,
  };
  readonly identity: ChannelIdentity;
  /** The allowed customer numbers, E.164 — what makes this line a test line. */
  readonly allowedNumbers: readonly string[];

  private readonly cfg: TwilioConfig;
  private readonly fetch: TwilioFetch;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly paceMs: number;
  private readonly maxPaceWaitMs: number;
  /** When the next send may leave, in epoch milliseconds (the sandbox's pace). */
  private nextSlotAt = 0;

  constructor(cfg: TwilioConfig, deps: TwilioChannelDeps = {}) {
    const missing = (['accountSid', 'authToken', 'sender', 'publicUrl', 'webhookPath'] as const).filter((k) => !cfg[k]);
    if (missing.length > 0) throw new Error(`the Twilio adapter is missing ${missing.join(', ')}`);
    if (cfg.allowedNumbers.length === 0) throw new Error('the Twilio test line needs at least one allowed number');
    this.cfg = cfg;
    this.allowedNumbers = [...cfg.allowedNumbers];
    this.fetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.now = deps.now ?? (() => new Date());
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.paceMs = cfg.paceMs ?? (cfg.sender === TWILIO_SANDBOX_NUMBER ? TWILIO_SANDBOX_PACE_MS : 0);
    this.maxPaceWaitMs = cfg.maxPaceWaitMs ?? TWILIO_MAX_PACE_WAIT_MS;
    this.identity = {
      provider: 'twilio',
      channel: 'whatsapp',
      externalId: cfg.sender,
      displayName: cfg.displayName ?? 'WhatsApp test line',
    };
  }

  /** No GET challenge on Twilio: a GET is refused. A POST is verified on its signed URL and fields. */
  verifyWebhook(req: RawWebhook): WebhookVerdict {
    if (req.method === 'GET') return { kind: 'challenge', ok: false, reason: 'BAD_MODE' };
    return verifyTwilioDelivery(req, { authToken: this.cfg.authToken, publicUrl: this.cfg.publicUrl });
  }

  /** VERIFY, THEN READ. */
  parseWebhook(req: RawWebhook): InboundEvent[] {
    if (!verifyTwilioDelivery(req, { authToken: this.cfg.authToken, publicUrl: this.cfg.publicUrl }).ok) {
      throw new ChannelError('UNVERIFIED', 'the delivery does not carry a valid signature');
    }
    return parseTwilioForm(formFieldsOf(req.rawBody), {
      accountSid: this.cfg.accountSid,
      sender: this.cfg.sender,
      allowedNumbers: this.cfg.allowedNumbers,
      receivedAt: this.now(),
    });
  }

  /** The next free slot, waited for when it is close; false when it is too far off. */
  private async takeSlot(): Promise<boolean> {
    if (this.paceMs <= 0) return true;
    const now = this.now().getTime();
    const at = Math.max(now, this.nextSlotAt);
    if (at - now > this.maxPaceWaitMs) return false;
    // Reserved before the wait, so two sends in flight take two slots.
    this.nextSlotAt = at + this.paceMs;
    if (at > now) await this.sleep(at - now);
    return true;
  }

  async send(msg: OutboundMessage): Promise<SendResult> {
    const now = this.now();
    const early = windowRefusal(msg.content, msg.lastCustomerMessageAt, now, this.capabilities.freeTextWindowHours);
    if (early) {
      return { ok: false, refusal: early, retryable: false, providerCode: null, detail: 'outside the 24-hour window' };
    }
    const to = twilioRecipientOf(msg);
    if (!to || !this.cfg.allowedNumbers.includes(to)) {
      return {
        ok: false,
        refusal: 'NOT_ALLOWED',
        retryable: false,
        providerCode: null,
        detail: 'the test line writes only to its allowed numbers',
      };
    }
    if (msg.content.kind === 'template') {
      return {
        ok: false,
        refusal: 'REJECTED',
        retryable: false,
        providerCode: 'TEMPLATE_UNAVAILABLE',
        detail: "the WhatsApp sandbox takes no custom templates (only Twilio's three samples)",
      };
    }
    let request: TwilioRequest;
    try {
      request = buildTwilioSendRequest(msg, this.cfg);
    } catch (err) {
      const detail = err instanceof ChannelError ? err.message : 'the message could not be built';
      return { ok: false, refusal: 'REJECTED', retryable: false, providerCode: null, detail };
    }
    if (!(await this.takeSlot())) {
      return {
        ok: false,
        refusal: 'RATE_LIMITED',
        retryable: true,
        providerCode: 'SANDBOX_PACE',
        detail: 'the sandbox sends one message every three seconds',
      };
    }
    let status: number;
    let answer: unknown;
    try {
      const res = await this.fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: formBody(request.form ?? []),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      status = res.status;
      answer = await res.json().catch(() => null);
    } catch {
      return { ok: false, refusal: 'UNREACHABLE', retryable: true, providerCode: null, detail: 'no answer from Twilio' };
    }
    const sid = isObject(answer) && typeof answer['sid'] === 'string' ? answer['sid'] : null;
    if (status >= 200 && status < 300 && sid) return { ok: true, externalMessageId: sid, acceptedAt: now };
    const code = isObject(answer) ? Number(answer['code']) : NaN;
    const { refusal, retryable } = refusalForTwilioError(code, status);
    return {
      ok: false,
      refusal,
      retryable,
      providerCode: Number.isFinite(code) ? String(code) : `http_${status}`,
      // Twilio's message can quote the number it refused: never kept.
      detail: null,
    };
  }

  /**
   * One media item: GET its URL with the account's credentials — to
   * `api.twilio.com`, under this account's path, and nowhere else. A redirect
   * is followed WITHOUT them.
   */
  async fetchMedia(ref: Pick<MediaRef, 'providerMediaId'> & Partial<MediaRef>): Promise<FetchedMedia> {
    if (!isOwnMediaUrl(ref.providerMediaId, this.cfg.accountSid)) {
      throw new ChannelError('MEDIA_FETCH_FAILED', "the media URL is not this account's on Twilio's API host");
    }
    const read = async (res: Awaited<ReturnType<TwilioFetch>>): Promise<FetchedMedia> => {
      if (res.status === 404) throw new ChannelError('MEDIA_NOT_FOUND', 'Twilio has no such media');
      if (!res.ok) throw new ChannelError('MEDIA_FETCH_FAILED', `the media download answered ${res.status}`);
      const declared = Number(res.headers.get('content-length') ?? NaN);
      if (Number.isFinite(declared) && declared > TWILIO_MEDIA_MAX_BYTES) {
        throw new ChannelError('MEDIA_FETCH_FAILED', 'the media is larger than WhatsApp allows');
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > TWILIO_MEDIA_MAX_BYTES) {
        throw new ChannelError('MEDIA_FETCH_FAILED', 'the media is larger than WhatsApp allows');
      }
      const contentType =
        res.headers.get('content-type')?.split(';', 1)[0]?.trim() || ref.mimeType || 'application/octet-stream';
      return { contentType, bytes };
    };
    try {
      const first = await this.fetch(ref.providerMediaId, {
        method: 'GET',
        headers: { authorization: authHeader(this.cfg) },
        redirect: 'manual',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (first.status >= 300 && first.status < 400) {
        const location = first.headers.get('location');
        let next: URL | null = null;
        try {
          next = location ? new URL(location, ref.providerMediaId) : null;
        } catch {
          next = null;
        }
        if (!next || next.protocol !== 'https:') {
          throw new ChannelError('MEDIA_FETCH_FAILED', 'the media redirect is not https');
        }
        return await read(
          await this.fetch(next.toString(), {
            method: 'GET',
            headers: {},
            redirect: 'follow',
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          }),
        );
      }
      return await read(first);
    } catch (err) {
      if (err instanceof ChannelError) throw err;
      throw new ChannelError('MEDIA_FETCH_FAILED', 'the media download did not answer');
    }
  }

  /** The account's own record: refused credentials or a suspended account show here before a send fails. */
  async health(): Promise<ChannelHealth> {
    const checkedAt = this.now();
    try {
      const res = await this.fetch(`${apiRoot(this.cfg)}.json`, {
        method: 'GET',
        headers: { authorization: authHeader(this.cfg) },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      const body = await res.json().catch(() => null);
      if (res.status === 401) return { status: 'error', checkedAt, detail: 'the Twilio credentials were refused' };
      if (!res.ok) return { status: 'error', checkedAt, detail: `Twilio answered ${res.status}` };
      const state = isObject(body) && typeof body['status'] === 'string' ? body['status'] : null;
      if (state && state !== 'active') return { status: 'error', checkedAt, detail: `the Twilio account is ${state}` };
      return { status: 'active', checkedAt, detail: this.paceMs > 0 ? 'the WhatsApp sandbox' : null };
    } catch {
      return { status: 'error', checkedAt, detail: 'Twilio did not answer' };
    }
  }
}
