import { createHash } from 'node:crypto';
import {
  ChannelError,
  type Channel,
  type ChannelCapabilities,
  type ChannelHealth,
  type ChannelIdentity,
  type ClassificationHint,
  type DeliveryStatus,
  type FetchedMedia,
  type InboundEvent,
  type MediaRef,
  type MessagingChannel,
  type OutboundMessage,
  type RawWebhook,
  type SendRefusal,
  type SendResult,
  type WebhookVerdict,
} from './contract';
import {
  bodyBytes,
  signMetaPayload,
  verifyMetaDelivery,
  verifyMetaWebhook,
  SIGNATURE_HEADER,
} from './webhook';
import { parseWhatsAppPayload } from './whatsapp-cloud';
import { windowRefusal } from './window';

/**
 * THE SIMULATOR CHANNEL — the twin of a Meta account (plan §2.1, [B]).
 *
 * A scriptable channel for the checks, the demo conversations (I1's
 * `seed:inbox-demo` on Cut B) and the staging Simulator panel (I3b). It makes
 * NO network call, ever.
 *
 * IT DRIVES THE REAL PATH, NOT A SHORTCUT PAST IT. `inbound()` does not hand
 * back an `InboundEvent`; it builds a WhatsApp Cloud API webhook body, signs
 * it with the per-deployment `INBOX_SIMULATOR_SECRET` exactly as Meta signs
 * with the app secret, and returns the `RawWebhook` the api's webhook handler
 * then verifies and parses like any delivery — as the 2C2P simulator signs its
 * own notification. The parser is the WhatsApp adapter's own
 * (`parseWhatsAppPayload`), so a demo press exercises the live parser.
 *
 * WHAT IT ADDS ON TOP OF META'S SHAPE: an `oto_hint` on a message — the
 * classification the router takes in place of the AI (plan §3.1). Only this
 * adapter reads it; the live adapter ignores it.
 *
 * SENDS are accepted at once (the 24-hour rule enforced first, so the
 * template-only rule is exercised before any Meta account exists), and each
 * accepted send schedules a `delivered` then a `read` status delivery.
 * Nothing fires on a timer: `takeScheduled()` hands them over, and the api's
 * `/inbox/simulator/status` route posts them through the webhook handler.
 *
 * DETERMINISTIC IDS. Every id is a counter under `runId`:
 * `wamid.SIM.<runId>.IN.000001`, `…OUT.000001`, `SIMMEDIA.<runId>.000001`.
 * Two simulators with the same inputs produce the same ids, which is what
 * makes the checks exact. The api passes a per-boot `runId`, so a restart
 * never re-mints an id an earlier boot already stored.
 *
 * ITS MEMORY IS THIS PROCESS — the sends, the scheduled statuses and the
 * minted media ids. A pretend phone's pretend state is not a business record.
 */

/** A 1×1 PNG: the bundled image every simulated media id resolves to. */
export const SIMULATOR_FIXTURE_IMAGE = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    'base64',
  ),
);
const FIXTURE_CONTENT_TYPE = 'image/png';

export interface SimulatorChannelDeps {
  /** `INBOX_SIMULATOR_SECRET`. Signs and verifies; never reaches a browser. */
  secret: string;
  /** What the GET challenge must present. Defaults to `oto-simulator`. */
  verifyToken?: string;
  /** `channel_account.external_id` for the simulator account. */
  phoneNumberId?: string;
  displayPhoneNumber?: string;
  displayName?: string;
  /** Which channel the simulator stands in for. Its envelope is WhatsApp's whatever this says. */
  channel?: Channel;
  /** Distinguishes one boot's ids from another's. */
  runId?: string;
  now?: () => Date;
}

/** One customer message to play. `from` is the WhatsApp id: the phone in digits, country code first. */
export interface SimulatedInbound {
  from: string;
  name?: string;
  text?: string;
  /** An image with an optional caption; it resolves to the bundled fixture. */
  image?: { caption?: string };
  replyTo?: string;
  hint?: ClassificationHint;
  at?: Date;
}

export interface SimulatedSend {
  clientRef: string;
  externalMessageId: string;
  to: string;
  kind: OutboundMessage['content']['kind'];
  at: Date;
}

export interface SimulatedInboundResult {
  webhook: RawWebhook;
  externalMessageId: string;
  /** The `providerEventId` the parser will give it — the dedupe key. */
  providerEventId: string;
}

function pad(n: number): string {
  return String(n).padStart(6, '0');
}

export class SimulatorChannel implements MessagingChannel {
  readonly provider = 'simulator' as const;
  readonly capabilities: ChannelCapabilities = {
    reply: true,
    media: true,
    freeTextWindowHours: 24,
  };
  readonly identity: ChannelIdentity;

  private readonly secret: string;
  private readonly verifyToken: string;
  private readonly phoneNumberId: string;
  private readonly displayPhoneNumber: string;
  private readonly runId: string;
  private readonly now: () => Date;

  private inboundSeq = 0;
  private outboundSeq = 0;
  private mediaSeq = 0;
  private readonly media = new Set<string>();
  private readonly sends: SimulatedSend[] = [];
  private scheduled: RawWebhook[] = [];
  private readonly refusals: { refusal: SendRefusal; providerCode: string | null }[] = [];

  constructor(deps: SimulatorChannelDeps) {
    if (!deps.secret)
      throw new Error('the simulator channel needs INBOX_SIMULATOR_SECRET to sign with');
    this.secret = deps.secret;
    this.verifyToken = deps.verifyToken ?? 'oto-simulator';
    this.phoneNumberId = deps.phoneNumberId ?? 'SIM-PHONE-NUMBER-ID';
    this.displayPhoneNumber = deps.displayPhoneNumber ?? '000 000 0000';
    this.runId = deps.runId ?? '0';
    this.now = deps.now ?? (() => new Date());
    this.identity = {
      provider: 'simulator',
      channel: deps.channel ?? 'whatsapp',
      externalId: this.phoneNumberId,
      displayName: deps.displayName ?? 'Simulator',
    };
  }

  // -- playing the customer ------------------------------------------------

  /** A customer message, as a signed delivery for the real webhook handler. */
  inbound(input: SimulatedInbound): SimulatedInboundResult {
    if (!/^\d{6,15}$/.test(input.from)) {
      throw new Error('a simulated sender is a WhatsApp id: 6 to 15 digits, country code first');
    }
    if (!input.text && !input.image)
      throw new Error('a simulated message carries text or an image');
    const id = `wamid.SIM.${this.runId}.IN.${pad(++this.inboundSeq)}`;
    const at = input.at ?? this.now();
    const message: Record<string, unknown> = {
      from: input.from,
      id,
      timestamp: String(Math.floor(at.getTime() / 1000)),
    };
    if (input.image) {
      const mediaId = `SIMMEDIA.${this.runId}.${pad(++this.mediaSeq)}`;
      this.media.add(mediaId);
      const caption = input.image.caption ?? input.text;
      message['type'] = 'image';
      message['image'] = {
        id: mediaId,
        mime_type: FIXTURE_CONTENT_TYPE,
        sha256: createHash('sha256').update(SIMULATOR_FIXTURE_IMAGE).digest('base64'),
        ...(caption ? { caption } : {}),
      };
    } else {
      message['type'] = 'text';
      message['text'] = { body: input.text };
    }
    if (input.replyTo)
      message['context'] = { from: this.displayPhoneNumber.replace(/\D/g, ''), id: input.replyTo };
    if (input.hint) message['oto_hint'] = input.hint;
    const webhook = this.delivery({
      contacts: [{ profile: { name: input.name ?? input.from }, wa_id: input.from }],
      messages: [message],
    });
    return { webhook, externalMessageId: id, providerEventId: `msg:${id}` };
  }

  /** A whole conversation set, one delivery per message, in order. */
  scenario(inputs: readonly SimulatedInbound[]): SimulatedInboundResult[] {
    return inputs.map((i) => this.inbound(i));
  }

  /** A status delivery for an outbound message — the panel's "push a receipt". */
  statusWebhook(
    externalMessageId: string,
    status: DeliveryStatus,
    opts: { errorCode?: number; errorTitle?: string; at?: Date } = {},
  ): RawWebhook {
    const send = this.sends.find((s) => s.externalMessageId === externalMessageId);
    const entry: Record<string, unknown> = {
      id: externalMessageId,
      status,
      timestamp: String(Math.floor((opts.at ?? this.now()).getTime() / 1000)),
      recipient_id: send?.to ?? null,
    };
    if (send) entry['biz_opaque_callback_data'] = send.clientRef;
    if (status === 'failed') {
      entry['errors'] = [
        { code: opts.errorCode ?? 131026, title: opts.errorTitle ?? 'Message undeliverable' },
      ];
    }
    return this.delivery({ statuses: [entry] });
  }

  /** The delivered and read deliveries the accepted sends scheduled, oldest first. Drains the queue. */
  takeScheduled(): RawWebhook[] {
    const out = this.scheduled;
    this.scheduled = [];
    return out;
  }

  /** Make the next send come back refused — for the send job's failure checks. */
  refuseNext(refusal: SendRefusal, providerCode: string | null = null): void {
    this.refusals.push({ refusal, providerCode });
  }

  /** Every send accepted so far. */
  sent(): readonly SimulatedSend[] {
    return this.sends;
  }

  private delivery(value: Record<string, unknown>): RawWebhook {
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: `SIM-WABA.${this.runId}`,
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: {
                  display_phone_number: this.displayPhoneNumber,
                  phone_number_id: this.phoneNumberId,
                },
                ...value,
              },
            },
          ],
        },
      ],
    };
    const rawBody = JSON.stringify(body);
    return {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        [SIGNATURE_HEADER]: signMetaPayload(rawBody, this.secret),
      },
      query: {},
      rawBody,
    };
  }

  // -- the contract --------------------------------------------------------

  verifyWebhook(req: RawWebhook): WebhookVerdict {
    return verifyMetaWebhook(req, { appSecret: this.secret, verifyToken: this.verifyToken });
  }

  parseWebhook(req: RawWebhook): InboundEvent[] {
    if (!verifyMetaDelivery(req, this.secret).ok) {
      throw new ChannelError('UNVERIFIED', 'the delivery does not carry a valid signature');
    }
    let body: unknown;
    try {
      body = JSON.parse(bodyBytes(req.rawBody).toString('utf8'));
    } catch {
      throw new ChannelError('MALFORMED_PAYLOAD', 'the delivery is not JSON');
    }
    return parseWhatsAppPayload(body, { receivedAt: this.now(), acceptHints: true });
  }

  send(msg: OutboundMessage): Promise<SendResult> {
    const at = this.now();
    const early = windowRefusal(
      msg.content,
      msg.lastCustomerMessageAt,
      at,
      this.capabilities.freeTextWindowHours,
    );
    if (early) {
      return Promise.resolve({
        ok: false,
        refusal: early,
        retryable: false,
        providerCode: null,
        detail: 'outside the 24-hour window',
      });
    }
    const forced = this.refusals.shift();
    if (forced) {
      return Promise.resolve({
        ok: false,
        refusal: forced.refusal,
        retryable: forced.refusal === 'RATE_LIMITED' || forced.refusal === 'UNREACHABLE',
        providerCode: forced.providerCode,
        detail: 'refused by the simulator on request',
      });
    }
    const to = msg.to.handle || msg.to.phone?.replace(/^\+/, '') || '';
    if (!to) {
      return Promise.resolve({
        ok: false,
        refusal: 'REJECTED',
        retryable: false,
        providerCode: null,
        detail: 'no recipient',
      });
    }
    const externalMessageId = `wamid.SIM.${this.runId}.OUT.${pad(++this.outboundSeq)}`;
    this.sends.push({
      clientRef: msg.clientRef,
      externalMessageId,
      to,
      kind: msg.content.kind,
      at,
    });
    this.scheduled.push(this.statusWebhook(externalMessageId, 'delivered', { at }));
    this.scheduled.push(this.statusWebhook(externalMessageId, 'read', { at }));
    return Promise.resolve({ ok: true, externalMessageId, acceptedAt: at });
  }

  fetchMedia(ref: Pick<MediaRef, 'providerMediaId'> & Partial<MediaRef>): Promise<FetchedMedia> {
    if (!this.media.has(ref.providerMediaId)) {
      return Promise.reject(
        new ChannelError('MEDIA_NOT_FOUND', 'the simulator minted no such media id'),
      );
    }
    return Promise.resolve({
      contentType: FIXTURE_CONTENT_TYPE,
      bytes: SIMULATOR_FIXTURE_IMAGE.slice(),
    });
  }

  health(): Promise<ChannelHealth> {
    return Promise.resolve({
      status: 'active',
      checkedAt: this.now(),
      detail: 'simulated; reaches no one',
    });
  }
}
