import type { DepositSaveNote, DepositSaveReason, OneDeposit, PartyDepositAnswer } from "@shared/partyDeposit";
import { depositMovedWords, depositWordsOf } from "@shared/partyDeposit";
import { dayOf, sameDeposit, wholeBahtOf, type PartyDeposit } from "./partyDeposit";

/**
 * A SAVE NEVER LOWERS OR CLEARS A DEPOSIT IT DID NOT DELIBERATELY CHANGE (SCRUM-840).
 *
 * The BEO's Save and the Events page's Save send the whole form, the party's
 * deposit in it (SCRUM-813's one deposit). A form opened before the family
 * paid through the chat (SCRUM-825: the platform's write-back lands as the
 * fact `gateway_deposit`, server/directory/eventWrites.ts) still holds the
 * old figure, and its Save wrote that figure over the paid deposit: the
 * gateway and the platform's request stayed right, the party's deposit, the
 * till's reading and the outstanding went wrong.
 *
 * The rule, decided here on the deposit read under the event's row lock:
 *
 *   0. the BEO's form says whether the person changed the deposit in it
 *      (`depositChanged`); a deposit it did not change is not a deposit the
 *      Save names, and the stored one is left alone;
 *   1. the form says which deposit it was opened with (`expected`). When the
 *      stored deposit is no longer that one, it moved while the form was
 *      open: the stored deposit stays, whatever the form carries, and the
 *      Save answers so (`moved`). The rest of the Save is written;
 *   2. a Save that would LOWER the deposit and names no `expected` (a page
 *      loaded before this rule) is not trusted to be deliberate: the stored
 *      deposit stays (`unconfirmed`). Raising it, or changing its day, is
 *      written as before;
 *   3. a deliberate Save (the form's `expected` IS the stored deposit) that
 *      lowers it is checked against what the family paid through the chat,
 *      as the platform holds it: below that it is not written (`gateway`),
 *      and when the platform cannot be asked it is not written either
 *      (`unchecked`): money is never lowered on a guess.
 *
 * Not ruled here: the Billing section's own Deposit Paid field (rule 1 only,
 * server/beo-routes.ts), a till's party edit and the platform's facts
 * (server/directory/eventWrites.ts) and the AI fill's reviewed approval
 * (server/lib/beoAiApprove.ts): each is a deliberate write of the deposit.
 */

/** What the family paid through the chat for a party, as far as it could be read. */
export type GatewayFloor = { known: true; amountThb: number } | { known: false };

/** A deposit of 0 is no deposit: it has no day. */
export const noDepositDay = (d: PartyDeposit): PartyDeposit =>
  d.amountThb > 0 ? { amountThb: Math.round(d.amountThb), date: d.date ?? null } : { amountThb: 0, date: null };

/**
 * The deposit a form says it was opened with (`{ amountThb, date }`, as the
 * read's `oneDeposit` gave it); undefined when the form says none.
 */
export function expectedDepositOf(raw: unknown): PartyDeposit | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (!("amountThb" in r)) return undefined;
  return noDepositDay({ amountThb: wholeBahtOf(r.amountThb), date: dayOf(r.date) });
}

/** What the family paid through the chat: every paid request of the party, in whole baht. */
export function gatewayPaidThbOf(answer: Pick<PartyDepositAnswer, "current" | "history">): number {
  const paid = new Map<string, number>();
  for (const r of [...(answer.current ? [answer.current] : []), ...answer.history]) {
    if (r.state === "paid") paid.set(r.id, r.amountSatang);
  }
  let satang = 0;
  for (const amount of paid.values()) satang += amount;
  return Math.ceil(satang / 100);
}

export type DepositSaveScreen = "BEO" | "event";

const KEPT_WORDS: Record<Exclude<DepositSaveReason, "moved">, (stays: string, screen: DepositSaveScreen, floor: string) => string> = {
unconfirmed: (stays) =>
    `The deposit was not lowered (it stays ${stays}): this page is out of date. Reload it, then change the deposit again. Your other changes were saved.`,
  gateway: (stays, _screen, floor) =>
    `${floor} of this deposit was paid through the chat, so Save does not lower it below that (it stays ${stays}). Your other changes were saved. A paid deposit is corrected in the BEO's Billing section (Deposit Paid).`,
  unchecked: (stays) =>
    `The deposit was not lowered (it stays ${stays}): the till could not be asked whether it was paid through the chat. Your other changes were saved. Try again in a moment.`,
};

export interface DepositSaveDecision {
  /** The deposit to write to every place the app keeps it; null when the stored deposit stays. */
  write: PartyDeposit | null;
  /** Said to the person when the deposit the Save carried was not written. */
  note: DepositSaveNote | null;
}

/**
 * Whether a Save's deposit is written. `was` is the stored one deposit, read
 * under the event's lock; `said` the deposit the Save carries (null when it
 * names none); `expected` the deposit the form was opened with; `floor` what
 * the family paid through the chat, where the caller asked (it asks only for
 * a deliberate lowering).
 */
export function decideDepositSave(input: {
  was: PartyDeposit;
  said: PartyDeposit | null;
  expected: PartyDeposit | undefined;
  floor?: GatewayFloor;
  screen?: DepositSaveScreen;
}): DepositSaveDecision {
  const was = noDepositDay(input.was);
  const said = input.said ? noDepositDay(input.said) : null;
  const screen = input.screen ?? "BEO";
  const kept = (reason: DepositSaveReason, floorThb = 0): DepositSaveDecision => ({
    write: null,
    note: {
      kept: true,
      reason,
      amountThb: was.amountThb,
      date: was.date,
      message:
        reason === "moved"
          ? depositMovedWords(was.amountThb, screen, true)
          : KEPT_WORDS[reason](depositWordsOf(was.amountThb), screen, depositWordsOf(floorThb)),
    },
  });
  // The Save carries the deposit as it is stored: nothing to write, nothing to say.
  if (said && sameDeposit(said, was)) return { write: null, note: null };
  if (input.expected !== undefined && !sameDeposit(noDepositDay(input.expected), was)) return kept("moved");
  if (!said) return { write: null, note: null };
  if (said.amountThb < was.amountThb) {
    if (input.expected === undefined) return kept("unconfirmed");
    if (!input.floor || !input.floor.known) return kept("unchecked");
    if (said.amountThb < input.floor.amountThb) return kept("gateway", input.floor.amountThb);
  }
  return { write: said, note: null };
}

/** Whether a Save that carries `said` over `was` is a deliberate lowering: the one case the platform is asked about. */
export function lowersDeliberately(was: PartyDeposit, said: PartyDeposit | null, expected: PartyDeposit | undefined): boolean {
  if (!said || expected === undefined) return false;
  const stored = noDepositDay(was);
  return noDepositDay(said).amountThb < stored.amountThb && sameDeposit(noDepositDay(expected), stored);
}

/** The party's one deposit as a read or a Save's answer hands it to a form. */
export const oneDepositOf = (d: PartyDeposit): OneDeposit => noDepositDay(d);

/**
 * The deposit a form's Party Details carries: the keys it names over the
 * stored deposit; null when it names neither.
 */
export function depositNamedBy(partyDetails: unknown, was: PartyDeposit): PartyDeposit | null {
  if (!partyDetails || typeof partyDetails !== "object" || Array.isArray(partyDetails)) return null;
  const pd = partyDetails as Record<string, unknown>;
  const namesAmount = "prepaymentReceived" in pd;
  const namesDay = "depositDate" in pd;
  if (!namesAmount && !namesDay) return null;
  return noDepositDay({
    amountThb: namesAmount ? wholeBahtOf(pd.prepaymentReceived) : was.amountThb,
    date: namesDay ? dayOf(pd.depositDate) : was.date,
  });
}

/** Party Details as stored: the form's other keys, and the deposit as it now stands. */
export function partyDetailsWithDeposit(partyDetails: unknown, deposit: PartyDeposit): Record<string, unknown> {
  const pd = partyDetails && typeof partyDetails === "object" && !Array.isArray(partyDetails) ? (partyDetails as Record<string, unknown>) : {};
  const { prepaymentReceived: _amount, depositDate: _day, ...rest } = pd;
  const d = noDepositDay(deposit);
  return { ...rest, prepaymentReceived: d.amountThb, ...(d.date ? { depositDate: d.date } : {}) };
}
