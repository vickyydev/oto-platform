/** The free-text fill's deposit is a proposal, never a payment receipt. */
export interface LegacyDepositFields {
  prepaymentReceived?: number;
  depositRequested?: number;
  depositReceived?: boolean;
  depositWords?: string;
  depositDate?: string;
}

const positive = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
const foldWords = (value: string): string => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();

/**
 * SCRUM-844: an old amount-only answer is unconfirmed, not received. The
 * received flag must have the message's own words beside it; the route also
 * checks those words against the text it actually read. Staff confirm the
 * received proposal in the preview before it can enter the Deposit box.
 */
export function legacyDepositFieldsOf(fields: LegacyDepositFields, sourceText?: string): LegacyDepositFields {
  const amount = positive(fields.prepaymentReceived);
  const words = typeof fields.depositWords === "string" ? fields.depositWords.trim() : "";
  const quoted = words !== "" && (sourceText === undefined || foldWords(sourceText).includes(foldWords(words)));
  const received = fields.depositReceived === true && quoted && amount !== undefined;
  return {
    prepaymentReceived: received ? amount : undefined,
    depositRequested: positive(fields.depositRequested) ?? (received ? undefined : amount),
    depositReceived: received,
    depositWords: quoted ? words : undefined,
    depositDate: received ? fields.depositDate : undefined,
  };
}

/** The rule rides after saved advice as well as the built-in prompt. */
export const LEGACY_DEPOSIT_INSTRUCTION = `
Deposit amounts are not evidence that money was received. For partyDetails:
- depositRequested is an amount only requested, due, promised or mentioned without confirmation of receipt.
- prepaymentReceived is ONLY money the new text explicitly confirms was already received. For it, also set depositReceived: true and copy the exact words confirming receipt into depositWords.
- "the deposit is 3,000", "please pay 3,000" and "we will transfer 3,000 tomorrow" are NOT received: give depositRequested: 3000, depositReceived: false, and no prepaymentReceived or depositDate.
- A received date is only the date the text gives for that receipt. Never use a requested payment date or the party date.
- Do not carry a deposit forward from existing event data. When the new text says nothing about a deposit, leave all these deposit fields out. The editor keeps its existing deposit.
The reviewer must confirm a received deposit before the form applies it. Never invent a payment.`;
