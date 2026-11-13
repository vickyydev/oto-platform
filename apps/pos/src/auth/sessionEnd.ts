/**
 * SCRUM-878 — A STAFF SESSION THAT ENDS DURING A LONG SHIFT.
 *
 * A staff session ends twelve hours after sign-in (the platform's
 * `SESSION_TTL_HOURS`; how long is the owner's decision and is not changed
 * here). Its cookie is given the same life, so at that moment the browser
 * stops sending it and the platform answers the next request — the minute's
 * heartbeat, a poll, an unlock — with a plain 401 "Not signed in".
 *
 * BEFORE: the till dropped to "Oto POS is locked — Sign in with your phone to
 * start your shift" with no explanation, and the cart on screen was gone (the
 * selling screen was unmounted with the operator). A LOCKED till met the end
 * differently: until the next heartbeat landed, a correct password answered
 * "Not signed in" under a line still saying the person was signed in.
 *
 * NOW (`auth/OperatorContext.tsx`): a session ended on the platform is not a
 * sign-out. The till stays as it was under the lock — the same screen, the
 * same sale, rendering nothing while locked, as a staff lock already keeps it
 * (`App.tsx`) — and the lock screen becomes the sign-in form with one line
 * saying what happened. Signing in again on the same till carries on:
 *
 *  - the same person: the sale is back exactly as it was (lines, member,
 *    tier, codes, step), the customer display follows again, and a payment
 *    that was waiting is read back from the platform by the payment stage's
 *    own recovery (`lib/usePaymentStage.ts`, "Checking the payment after
 *    unlock"), so nothing is charged twice and nothing is lost;
 *  - a different person who may sell: the sale is offered to them plainly —
 *    who started it and when — to continue or to discard; never silently
 *    made theirs (`components/auth/KeptSaleOffer.tsx`). A sale already rung
 *    up is offered to continue only, saying a payment may be waiting;
 *  - anyone else, another park, another operator, another trading day, or a
 *    person who may not sell: a fresh till, as before.
 *
 * The sale is kept in this page's memory only: never on the platform, never in
 * the browser's storage, with no token, password or session value beside it.
 * A reload loses an unwritten cart as it always has; a sale already rung up
 * comes back through the left-behind path (`lib/leftBehindSale.ts`), as before.
 *
 * SCRUM-964 — A RELOAD AT THE SIGN-IN FORM. What survives it is what this tab
 * keeps of the END, never of the sale: the form's line (whose session ended,
 * how, and whether a sale is kept) and who may have the kept screen (the
 * person, park, operator, station and trading day, `KeptTill`), in this tab's
 * `sessionStorage` (`saveSessionEnd`). An unwritten cart cannot survive: its
 * lines, member, tier, codes and the customer's number lived in the page's
 * memory only and are gone, so after a reload the line no longer says a sale
 * is kept. A sale the counter till had already rung up is the platform's, and
 * is still offered to the next sign-in: the till opens it again from the
 * platform by its id once it is checked still open at this station.
 */

/** SCRUM-964 — where this tab keeps the end of a session through a reload (`sessionStorage`). */
export const SESSION_END_KEY = 'oto.till.sessionEnded';

/** What this tab keeps of an ended session through a reload: the form's line and who may have the screen. */
export interface SavedSessionEnd {
  ended: SessionEnded;
  kept: KeptTill | null;
}

function tabStore(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null {
  try {
    return (globalThis as unknown as { sessionStorage?: Storage }).sessionStorage ?? null;
  } catch {
    return null; // Blocked site data: the end lives for this page only.
  }
}

/** SCRUM-964 — keep the end of a session for a reload of this tab. Best effort. */
export function saveSessionEnd(saved: SavedSessionEnd): void {
  try {
    tabStore()?.setItem(SESSION_END_KEY, JSON.stringify(saved));
  } catch {
    // Storage refused the write: the form still says it until a reload.
  }
}

/** SCRUM-964 — nothing ended is kept any more: a sign-in took it, a sign-out dropped it. */
export function forgetSessionEnd(): void {
  try {
    tabStore()?.removeItem(SESSION_END_KEY);
  } catch {
    // Nothing to forget here.
  }
}

/**
 * SCRUM-964 — the end of a session this tab kept before it reloaded, as the
 * form can still say it. Only a sale the counter till rang up is still kept:
 * anything else on screen was in the page's memory and is gone.
 */
export function readSessionEnd(): SavedSessionEnd | null {
  let raw: string | null = null;
  try {
    raw = tabStore()?.getItem(SESSION_END_KEY) ?? null;
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const saved = JSON.parse(raw) as Partial<SavedSessionEnd> | null;
    const ended = saved?.ended;
    if (!ended || typeof ended.name !== 'string' || typeof ended.expired !== 'boolean') return null;
    const kept = saved.kept && typeof saved.kept.accountId === 'string' && typeof saved.kept.tradingDate === 'string'
      ? saved.kept : null;
    const survives = kept?.rungUpSaleId && kept.rungUpSurface === 'till' && kept.saleSince !== null ? kept.rungUpSaleId : null;
    let back: KeptTill | null = null;
    if (kept) {
      const { rungUpSaleId: _sale, rungUpSurface: _surface, ...rest } = kept;
      back = { ...rest, saleSince: survives ? kept.saleSince : null, fromReload: true,
        ...(survives ? { rungUpSaleId: survives, rungUpSurface: 'till' } : {}) };
    }
    return {
      ended: { name: ended.name, expired: ended.expired, afterHours: ended.afterHours ?? null, saleKept: survives !== null },
      kept: back,
    };
  } catch {
    return null;
  }
}

/** A refusal this close to the end the platform gave counts as the end (clock drift, a slow answer). */
export const SESSION_END_SLACK_MS = 60_000;

/** What the sign-in screen says about the session that has just ended. */
export interface SessionEnded {
  /** Who was signed in. */
  name: string;
  /** The session reached the end it was given, rather than being ended from elsewhere. */
  expired: boolean;
  /** The session's whole life in hours, as the platform gave it; null from an api that does not say. */
  afterHours: number | null;
  /** A sale was on screen when it ended, and is kept for the next sign-in on this till. */
  saleKept: boolean;
}

/** The selling screen left under the lock when its session ended: what decides who may have it. */
export interface KeptTill {
  accountId: string;
  name: string;
  /** The operator and park the session sat at, as `/me` said. */
  operatorId: string | null;
  branchId: string | null;
  /** The platform station the till stood at; null on a deployment with no fleet. */
  stationId: string | null;
  /** The branch's trading day when it ended: a kept sale never outlives it. */
  tradingDate: string;
  /** When the sale on screen was started, or null when nothing was on screen. */
  saleSince: number | null;
  endedAt: number;
  /**
   * The sale on screen had been rung up (Pay pressed, not yet closed): its id,
   * as this till remembers it for the payment screen (`lib/saleOnScreen.ts`).
   * Absent when the sale on screen was still a cart.
   */
  rungUpSaleId?: string;
  /**
   * SCRUM-964 — the selling surface that rang it up (`setSaleRungUp`): only
   * the counter till's ('till') can open a sale again by its id after a reload.
   */
  rungUpSurface?: string;
  /** SCRUM-964 — read back from this tab's storage after a reload: no screen holds the sale. */
  fromReload?: boolean;
}

/** The offer a different person sees after signing in over a kept sale. */
export interface KeptSaleOffer {
  startedBy: string;
  startedAt: number;
  endedAt: number;
  stationId: string | null;
  /**
   * The kept sale is rung up, and a QR or card payment may be waiting on the
   * customer display. It is offered to continue only: discarding it would put
   * the display back to its welcome with the sale still open on the platform,
   * which only the person who rang it up may resume (`resumableHere`), and the
   * platform refuses its void once money is taken. Continuing reads the
   * payment back first (`lib/usePaymentStage.ts`); the till's own Cancel then
   * voids it, or is refused in the platform's words.
   */
  rungUpSaleId?: string;
}

/** Who signed in next, and where. */
export interface NextSignIn {
  accountId: string;
  operatorId: string | null;
  branchId: string | null;
  tradingDate: string;
  /** Holds `pos:sale:create` somewhere: a person who may not sell never continues a sale. */
  maySell: boolean;
}

/**
 * What a sign-in does with the screen a session left behind:
 * `continue` it (the same person), `offer` it (a different person who may
 * sell, with a sale on it), or start `fresh`.
 */
export function afterSignIn(kept: KeptTill | null, next: NextSignIn): 'continue' | 'offer' | 'fresh' {
  if (!kept) return 'fresh';
  const samePlace = kept.operatorId === next.operatorId && kept.branchId === next.branchId
    && kept.tradingDate === next.tradingDate;
  if (!samePlace) return 'fresh';
  if (kept.saleSince !== null && !next.maySell) return 'fresh';
  if (kept.accountId === next.accountId) return 'continue';
  return kept.saleSince !== null ? 'offer' : 'fresh';
}

/**
 * The moment, on this device's clock, the session ends: when `/me` was
 * answered plus the seconds the platform said were left. Counting from the
 * answer rather than reading the platform's timestamp keeps a till whose own
 * clock is wrong on the right moment.
 */
export function sessionDeadline(end: { inSeconds: number } | null | undefined, answeredAt: number): number | null {
  if (!end || !Number.isFinite(end.inSeconds) || end.inSeconds < 0) return null;
  return answeredAt + end.inSeconds * 1000;
}

/** Whether a session refused at `now` had reached its end, rather than being ended from elsewhere. */
export function endedByExpiry(deadline: number | null, now: number): boolean {
  return deadline !== null && now >= deadline - SESSION_END_SLACK_MS;
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/** "twelve hours", "one hour", "24 hours". */
export function hoursInWords(hours: number): string {
  const n = Math.max(0, Math.round(hours));
  const word = NUMBER_WORDS[n] ?? String(n);
  return `${word} ${n === 1 ? 'hour' : 'hours'}`;
}

/** The sign-in screen's one line, in the till's own English. */
export function sessionEndedLine(ended: SessionEnded): string {
  const what = ended.expired && ended.afterHours !== null && ended.afterHours > 0
    ? `The session of ${ended.name} ended after ${hoursInWords(ended.afterHours)}.`
    : `The session of ${ended.name} has ended.`;
  return `${what} Sign in again to carry on.${ended.saleKept ? ' The sale in progress is kept on this till.' : ''}`;
}

/**
 * Whether the till is no longer at the station the kept sale was on: the
 * station was let go when the new session asked for it, or another was taken.
 * The sale then goes, and is never shown at another station.
 */
export function keptSaleElsewhere(
  offer: Pick<KeptSaleOffer, 'stationId'>,
  here: { stationId: string | null; resolved: boolean },
): boolean {
  return offer.stationId !== null && here.resolved && here.stationId !== offer.stationId;
}

/** "20:05", on the till's own clock. */
export function clockTime(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** What the offer says: who started the sale and when, and when their session ended. */
export function keptSaleOfferLine(offer: KeptSaleOffer): string {
  return `${offer.startedBy} started this sale at ${clockTime(offer.startedAt)}. The session of ${offer.startedBy} ended at ${clockTime(offer.endedAt)}.`;
}

/** The offer's second line, for a kept sale already rung up. */
export const KEPT_SALE_RUNG_UP_LINE = 'It is rung up; a payment may be waiting on the customer display.';

/** What the offer asks of the person: continue or discard, or continue only for a sale rung up. */
export function keptSaleOfferAsk(offer: Pick<KeptSaleOffer, 'rungUpSaleId'>): string {
  return offer.rungUpSaleId
    ? 'Continue it to read its payment back, then finish it or cancel it.'
    : 'Continue it, or discard it and start a new sale.';
}
