import { z } from 'zod';

/**
 * SCRUM-825 — A DEPOSIT REQUESTED FROM THE BEO, PAID THROUGH THE GATEWAY AND
 * WATCHED BY THE PLATFORM: the shapes the OTO App's server and the platform
 * exchange over the provisioning-key doors (`/otoapp/parties/:eventId/…`).
 *
 * The home is the BEO's Billing section. Staff set an amount and press
 * "Request deposit"; the app asks the platform, which mints a station-less
 * gateway invoice on the `WEB` segment (the booking site's shape), asks the
 * gateway for its hosted page, and has the inbox assistant post ONE message
 * in the family's chat — the conversation Book Date linked to the event — in
 * the family's language, with the amount, the party's date, the link and its
 * validity. The gateway's settlement marks the request paid and writes the
 * party's ONE deposit figure back to the app (SCRUM-804's party-edit path),
 * so the BEO, the Day-of view, the Quote PDF and the till's "Deposit paid in
 * advance" all read it at once; the assistant then posts the confirmation.
 * Unpaid after a window the assistant posts ONE reminder; after a second
 * window the thread is handed to the birthday manager with the holding line.
 *
 * Money is satang. Every answer is the request as the platform holds it.
 */

/** `requested` while the link can be paid; then `paid`, `expired` (the link ran out unpaid) or `cancelled` (withdrawn by staff, or never opened). */
export const PARTY_DEPOSIT_STATES = ['requested', 'paid', 'expired', 'cancelled'] as const;
export type PartyDepositState = (typeof PARTY_DEPOSIT_STATES)[number];

/** The largest deposit the door takes: ฿1,000,000. */
export const PARTY_DEPOSIT_MAX_SATANG = 100_000_000;

export const PartyDepositParamsSchema = z.object({ eventId: z.string().uuid() });
export type PartyDepositParams = z.infer<typeof PartyDepositParamsSchema>;

export const PartyDepositRequestParamsSchema = z.object({ eventId: z.string().uuid(), requestId: z.string().uuid() });
export type PartyDepositRequestParams = z.infer<typeof PartyDepositRequestParamsSchema>;

/** `POST /otoapp/parties/:eventId/deposit-request` — one press of "Request deposit". */
export const PartyDepositRequestBodySchema = z
  .object({
    /** Whole satang, at least ฿1. */
    amountSatang: z.number().int().min(100).max(PARTY_DEPOSIT_MAX_SATANG),
    /**
     * `otoapp.users.id` of the person who pressed. The platform records the
     * platform account stamped on that user as the audit rows' actor, where
     * this operator has one; the id itself is kept beside it.
     */
    actorAppUserId: z.string().trim().min(1).max(64),
    /**
     * The inbox conversation the app holds for the event
     * (`core_events.inbox_conversation_id`). Checked against the platform's
     * own link (`inbox.conversation.event_order_ref`): a conversation that is
     * not this event's is refused.
     */
    conversationId: z.string().uuid().optional(),
  })
  .strict();
export type PartyDepositRequestBody = z.infer<typeof PartyDepositRequestBodySchema>;

/** The write-back of the new deposit figure to the OTO App, as the party-edit path records it. */
export const PartyDepositWriteBackSchema = z.object({
  editId: z.string().uuid(),
  syncState: z.enum(['synced', 'pending', 'failed']),
  syncError: z.string().nullable(),
});

/**
 * Where the assistant's request line stands with the channel (the message's
 * `provider_status`): `queued` until the channel took it, `sent` / `delivered`
 * / `read` once it did, `failed` when every attempt was refused, `withdrawn`
 * when the send path held it back. The BEO words each one.
 */
export const PARTY_LINE_STATUSES = ['queued', 'sent', 'delivered', 'read', 'failed', 'withdrawn'] as const;
export type PartyLineStatus = (typeof PARTY_LINE_STATUSES)[number];

/** One request, as the platform holds it. */
export const PartyDepositRequestViewSchema = z.object({
  id: z.string().uuid(),
  eventId: z.string().uuid(),
  conversationId: z.string().uuid(),
  amountSatang: z.number().int(),
  currency: z.string(),
  state: z.enum(PARTY_DEPOSIT_STATES),
  /** The gateway's hosted page the family pays on; null until the gateway opened it. */
  paymentLink: z.string().nullable(),
  linkExpiresAt: z.string().nullable(),
  invoiceNo: z.string(),
  requestedAt: z.string(),
  /** The one reminder the assistant posted, when it did. */
  remindedAt: z.string().nullable(),
  /** The thread handed to the birthday manager, when it was. */
  handedOverAt: z.string().nullable(),
  paidAt: z.string().nullable(),
  /** When the request became expired or cancelled, and the word for why. */
  closedAt: z.string().nullable(),
  closeReason: z.string().nullable(),
  /** The party's deposit as the app held it when the money landed, and what it was set to. */
  depositBeforeSatang: z.number().int().nullable(),
  depositAfterSatang: z.number().int().nullable(),
  writeBack: PartyDepositWriteBackSchema.nullable(),
  /** The request line's delivery state; null while no line was posted (the page never opened). */
  requestLineStatus: z.enum(PARTY_LINE_STATUSES).nullable(),
});
export type PartyDepositRequestView = z.infer<typeof PartyDepositRequestViewSchema>;

/** `GET /otoapp/parties/:eventId/deposit-request` — the open request, else the newest, and every one. */
export const PartyDepositAnswerSchema = z.object({
  eventId: z.string().uuid(),
  /** True when the party is linked to an inbox conversation the assistant can post in. */
  hasConversation: z.boolean(),
  current: PartyDepositRequestViewSchema.nullable(),
  history: z.array(PartyDepositRequestViewSchema),
});
export type PartyDepositAnswer = z.infer<typeof PartyDepositAnswerSchema>;

/** A press answered: the request as it now stands, and whether the press had been made before. */
export const PartyDepositActionAnswerSchema = z.object({
  request: PartyDepositRequestViewSchema,
  replayed: z.boolean(),
});
export type PartyDepositActionAnswer = z.infer<typeof PartyDepositActionAnswerSchema>;

/** `POST /otoapp/parties/:eventId/deposit-request/:requestId/resend` and `…/cancel`. */
export const PartyDepositActionBodySchema = z.object({ actorAppUserId: z.string().trim().min(1).max(64) }).strict();
export type PartyDepositActionBody = z.infer<typeof PartyDepositActionBodySchema>;

/** `POST /otoapp/parties/:eventId/menu-link` — the parent's set-menu link, posted by the assistant. */
export const PartyMenuLinkBodySchema = z
  .object({
    /** The app's own public link for the parent's choices (`/menu-select/<token>`). */
    link: z.string().trim().url().max(2000),
    actorAppUserId: z.string().trim().min(1).max(64),
  })
  .strict();
export type PartyMenuLinkBody = z.infer<typeof PartyMenuLinkBodySchema>;

/** `POST /otoapp/parties/:eventId/menu-received` — the parent's choices landed in the app. */
export const PartyMenuReceivedBodySchema = z
  .object({
    /** When the parent submitted, as the app recorded it; for the record only. */
    submittedAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict();
export type PartyMenuReceivedBody = z.infer<typeof PartyMenuReceivedBodySchema>;

/** What posting a party line answers: the line's ids, the language it went in, and whether this key had posted it before. */
export const PartyMessageAnswerSchema = z.object({
  conversationId: z.string().uuid(),
  messageId: z.string().uuid(),
  language: z.string(),
  replayed: z.boolean(),
});
export type PartyMessageAnswer = z.infer<typeof PartyMessageAnswerSchema>;

/** The refusals the deposit doors make, by code, so the app can word each one. */
export const PARTY_DEPOSIT_REFUSALS = {
  NO_CONVERSATION: {
    code: 'PARTY_NO_CONVERSATION',
    message: 'This party is not linked to an inbox conversation, so the assistant has nowhere to post the request. Book the date from the chat, or link the chat first.',
  },
  CONVERSATION_MISMATCH: {
    code: 'PARTY_CONVERSATION_MISMATCH',
    message: 'The conversation named is not the one linked to this party.',
  },
  REQUEST_OPEN: {
    code: 'DEPOSIT_REQUEST_OPEN',
    message: 'A deposit request is already open for this party. Resend it, or cancel it before asking for another.',
  },
  NOT_OPEN: {
    code: 'DEPOSIT_REQUEST_NOT_OPEN',
    message: 'This deposit request is no longer open.',
  },
  NOT_CONFIGURED: {
    code: 'DEPOSIT_NOT_CONFIGURED',
    message: 'Online payment is not set up on this deployment yet (no return address for the payment page).',
  },
  /** The gateway would not open its page: nothing was posted, and the same press again is answered this again (400). */
  PAGE_NOT_OPENED: {
    code: 'DEPOSIT_PAGE_NOT_OPENED',
    message: 'The payment page could not be opened, so nothing was sent to the family. Press Request deposit again in a moment.',
  },
} as const;
