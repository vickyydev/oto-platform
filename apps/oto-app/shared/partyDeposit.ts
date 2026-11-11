import { z } from "zod";

/**
 * A PARTY'S DEPOSIT ASKED FROM THE BEO (SCRUM-825).
 *
 * The home is the BEO's Billing section. Staff type an amount and press
 * "Request deposit": this app's server asks the platform
 * (`POST /otoapp/parties/:eventId/deposit-request`, with the provisioning key:
 * server/lib/partyDeposit.ts), which mints the 2C2P payment link, has the
 * inbox assistant post it in the family's chat (the conversation Book Date
 * linked to the event) and watches the payment. When the family pays, the
 * platform moves the party's ONE deposit figure (SCRUM-813) and writes it back
 * to this app, so the Billing section, the Day-of view, the Quote PDF and the
 * till's "Deposit paid in advance" all read it at once; the assistant confirms
 * in the chat. Unpaid, the platform reminds once and then hands the thread to
 * the birthday manager. "Resend" posts the same link again; "Cancel request"
 * withdraws it. "Send the menu choice link" posts the parent's set-menu link
 * the same way, and the parent's choices are confirmed in the chat when they
 * land (server/party-deposit-routes.ts).
 *
 * This file is what the screens and the server share: the platform's answer
 * as far as this app reads it, the words for each state, and the amount rule.
 * Money arrives in SATANG; the field is typed in baht.
 */

const Int = z.number().int();

export const PARTY_DEPOSIT_STATES = ["requested", "paid", "expired", "cancelled"] as const;
export type PartyDepositState = (typeof PARTY_DEPOSIT_STATES)[number];

/** One request, as the platform holds it (its `PartyDepositRequestViewSchema`). */
export const PartyDepositRequestSchema = z.object({
  id: z.string(),
  eventId: z.string(),
  conversationId: z.string(),
  amountSatang: Int,
  currency: z.string(),
  state: z.enum(PARTY_DEPOSIT_STATES),
  paymentLink: z.string().nullable(),
  linkExpiresAt: z.string().nullable(),
  invoiceNo: z.string(),
  requestedAt: z.string(),
  remindedAt: z.string().nullable(),
  handedOverAt: z.string().nullable(),
  paidAt: z.string().nullable(),
  closedAt: z.string().nullable(),
  closeReason: z.string().nullable(),
  depositBeforeSatang: Int.nullable(),
  depositAfterSatang: Int.nullable(),
  writeBack: z.object({ editId: z.string(), syncState: z.enum(["synced", "pending", "failed"]), syncError: z.string().nullable() }).nullable(),
});
export type PartyDepositRequest = z.infer<typeof PartyDepositRequestSchema>;

/** `GET /otoapp/parties/:eventId/deposit-request`: the open request (else the newest), every one, and whether the party has a chat. */
export const PartyDepositAnswerSchema = z.object({
  eventId: z.string(),
  hasConversation: z.boolean(),
  current: PartyDepositRequestSchema.nullable(),
  history: z.array(PartyDepositRequestSchema),
});
export type PartyDepositAnswer = z.infer<typeof PartyDepositAnswerSchema>;

/** A press answered: the request as it stands, and whether the press had been made before. */
export const PartyDepositActionAnswerSchema = z.object({ request: PartyDepositRequestSchema, replayed: z.boolean() });
export type PartyDepositActionAnswer = z.infer<typeof PartyDepositActionAnswerSchema>;

/** A party line posted: where it went and whether this press had posted it before. */
export const PartyMessageAnswerSchema = z.object({
  conversationId: z.string(),
  messageId: z.string(),
  language: z.string(),
  replayed: z.boolean(),
});
export type PartyMessageAnswer = z.infer<typeof PartyMessageAnswerSchema>;

/**
 * What `GET /api/events/:eventId/beo/deposit-request` answers the browser: the
 * platform's answer, or why there is none — the same reasons as the till's
 * money (shared/tillBilling.ts): the platform not answering, the park not
 * linked, this deployment without the key, an event the till never settles.
 */
export type PartyDepositReading =
  | { status: "ok"; answer: PartyDepositAnswer; readAt: string }
  | { status: "not_reachable" | "not_linked" | "unconfigured" | "not_a_party"; message: string };

/** The largest deposit the platform takes: ฿1,000,000. */
export const PARTY_DEPOSIT_MAX_BAHT = 1_000_000;

/** The amount as typed, in baht; null when the field is empty. */
export function depositAmountOf(field: string): number | null {
  const t = field.trim();
  if (!t) return null;
  const n = Number(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : Number.NaN;
}

/** Why the amount typed cannot be asked; null when it can. Whole baht, ฿1 to ฿1,000,000. */
export function depositRequestProblem(amountBaht: number | null): string | null {
  if (amountBaht === null) return "Type the deposit to ask for, in baht.";
  if (!Number.isFinite(amountBaht) || !Number.isInteger(amountBaht)) return "The deposit is whole baht.";
  if (amountBaht < 1) return "The deposit is at least ฿1.";
  if (amountBaht > PARTY_DEPOSIT_MAX_BAHT) return `The deposit is at most ฿${PARTY_DEPOSIT_MAX_BAHT.toLocaleString("en-GB")}.`;
  return null;
}

/** Whole baht to satang. */
export const satangOfWholeBaht = (baht: number): number => Math.round(baht) * 100;

/** Satang in baht, as the till writes money: "฿3,000". */
export function bahtOfSatang(satang: number): string {
  const sign = satang < 0 ? "-" : "";
  const abs = Math.abs(Math.round(satang));
  const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const cents = abs % 100;
  return `${sign}฿${whole}${cents ? `.${cents.toString().padStart(2, "0")}` : ""}`;
}

/** A moment in the park's clock: "14 Nov, 15:02". */
export function depositClockOf(iso: string | null): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleString("en-GB", { timeZone: "Asia/Bangkok", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** The request's state in words for the Billing section, and the colour it reads in. */
export interface DepositStateWords {
  headline: string;
  detail: string;
  tone: "open" | "overdue" | "paid" | "closed";
}

/**
 * "Deposit requested ฿3,000 · in the family's chat" while the link can be
 * paid; "Deposit overdue" once the thread went to a person; "Deposit paid"
 * when the money landed (and whether the app has it yet); "Link expired" or
 * "Request cancelled" when it closed unpaid.
 */
export function depositStateWordsOf(r: PartyDepositRequest): DepositStateWords {
  const amount = bahtOfSatang(r.amountSatang);
  switch (r.state) {
    case "requested": {
      const until = depositClockOf(r.linkExpiresAt);
      if (r.handedOverAt) {
        return { headline: `Deposit overdue · ${amount}`, detail: "Unpaid after the reminder: the chat is with the birthday manager.", tone: "overdue" };
      }
      return {
        headline: `Deposit requested · ${amount}`,
        detail: `${r.remindedAt ? "Reminded once. " : ""}The payment link is in the family's chat${until ? `, valid until ${until}` : ""}.`,
        tone: "open",
      };
    }
    case "paid": {
      const wb = r.writeBack;
      const landed = wb?.syncState === "synced" ? "The deposit figure is updated here and at the till." : wb?.syncState === "failed" ? "The deposit figure is still on its way to this app: refresh from the till." : "The deposit figure is on its way to this app.";
      return { headline: `Deposit paid · ${amount}`, detail: `Paid ${depositClockOf(r.paidAt) ?? ""} through the chat. ${landed}`.replace("  ", " "), tone: "paid" };
    }
    case "expired":
      return { headline: `Link expired · ${amount}`, detail: "The payment link ran out unpaid. Press Request deposit to send a fresh one.", tone: "closed" };
    default:
      return { headline: `Request cancelled · ${amount}`, detail: "Withdrawn from the BEO. Press Request deposit to ask again.", tone: "closed" };
  }
}

/** Why there is no reading, in words a screen shows; null when there is one. */
export function depositProblemOf(reading: PartyDepositReading | null | undefined): { headline: string; detail: string } | null {
  if (!reading || reading.status === "ok") return null;
  if (reading.status === "not_a_party") return { headline: "Not settled at the till", detail: reading.message };
  return { headline: "Till not reachable", detail: reading.message };
}

/** The words when the party has no chat the assistant can post in. */
export const NO_CONVERSATION_WORDS = "This party is not linked to an inbox chat, so the assistant has nowhere to post. Book the date from the family's chat, or link the chat first.";
