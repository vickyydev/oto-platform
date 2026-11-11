import type { BeoEventBilling } from "@shared/schema";
import type { OneDeposit } from "@shared/partyDeposit";

/**
 * THE BILLING MODULE'S DEPOSIT, SENT ONCE (SCRUM-822).
 *
 * The billing module (beo-billing-module.tsx, kept whole) calls its
 * `onBillingChange` on every keystroke of Deposit Paid. That figure is the
 * party's one deposit (SCRUM-813) and the till reads it as "Deposit paid in
 * advance", so a write per keystroke raced: four writes in flight together
 * landed in any order and an older figure could end up the party's deposit,
 * and the 0 of a field emptied to be retyped wiped the deposit's day.
 *
 * The buffer holds what is typed and sends ONE write: on blur or Enter, or
 * after a pause in typing (`DEPOSIT_IDLE_MS`). An emptied field is never sent:
 * it is a field being retyped, not a deposit of 0 (a deposit is cleared by
 * typing 0); left empty, the field goes back to the saved figure. A figure
 * equal to the one the field already holds is not sent. Any other billing
 * change (the deposit's day) goes at once, carrying a pending deposit in the
 * same write. The writes themselves run one after another in the order they
 * were sent (`beoBillingMutationScope`), so the last figure typed is the one
 * the server keeps.
 */

export type BillingPatch = Partial<BeoEventBilling>;

/** The pause in typing after which a typed deposit is sent. */
export const DEPOSIT_IDLE_MS = 800;

/** One queue for a party's billing writes: react-query runs mutations of one scope in order, one at a time. */
export const beoBillingMutationScope = (eventId: string) => ({ id: `beo-billing-${eventId}` });

export interface DepositBufferTimers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (handle: unknown) => void;
}

export interface DepositBufferOptions {
  /** Sends one billing write; settles when the server has answered (or refused). */
  send: (patch: BillingPatch) => Promise<unknown> | unknown;
  /** The deposit the field shows from the saved billing (whole baht; 0 for none). */
  saved: () => number;
  /** Told whenever what the field shows changes. */
  onChange?: () => void;
  idleMs?: number;
  timers?: DepositBufferTimers;
}

const realTimers: DepositBufferTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class DepositBuffer {
  /** What is typed and not sent: a figure, null for an emptied field, undefined for nothing. */
  private typed: number | null | undefined = undefined;
  /** The deposit on its way to the server, shown until it has answered. */
  private sending: number | undefined = undefined;
  private timer: unknown = null;
  private generation = 0;
  private readonly timers: DepositBufferTimers;

  constructor(private readonly options: DepositBufferOptions) {
    this.timers = options.timers ?? realTimers;
  }

  /** What the Deposit Paid field shows over the saved billing; undefined to show the saved figure. */
  shown(): number | undefined {
    if (this.typed !== undefined) return this.typed ?? 0;
    return this.sending;
  }

  /** A keystroke: the figure now in the field, or null when the field was emptied. */
  type(amount: number | null): void {
    this.typed = amount === null || !Number.isFinite(amount) ? null : Math.max(0, Math.round(amount));
    this.arm();
    this.notify();
  }

  /** Blur or Enter: the typed figure goes now; an emptied field goes back to the saved figure. */
  flush(): void {
    this.disarm();
    this.commit(null);
  }

  /** Any other billing change: sent at once, with a pending deposit in the same write. */
  pass(patch: BillingPatch): void {
    this.disarm();
    this.commit(patch);
  }

  /** The field is going away: a typed figure is not lost. */
  dispose(): void {
    this.disarm();
    if (typeof this.typed === "number") this.commit(null);
  }

  private current(): number {
    return this.sending ?? this.options.saved();
  }

  private arm(): void {
    this.disarm();
    this.timer = this.timers.set(() => {
      this.timer = null;
      // A pause on an emptied field sends nothing: it is being retyped.
      if (typeof this.typed === "number") this.commit(null);
    }, this.options.idleMs ?? DEPOSIT_IDLE_MS);
  }

  private disarm(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }

  private commit(extra: BillingPatch | null): void {
    const typed = this.typed;
    this.typed = undefined;
    let patch: BillingPatch = { ...(extra ?? {}) };
    if (typeof typed === "number" && typed !== this.current()) {
      patch = { depositPaidAmount: typed, depositPaid: typed > 0, ...patch };
    }
    if (Object.keys(patch).length === 0) {
      this.notify();
      return;
    }
    const generation = ++this.generation;
    if (typeof patch.depositPaidAmount === "number") this.sending = patch.depositPaidAmount;
    this.notify();
    const settled = () => {
      if (generation !== this.generation) return;
      this.sending = undefined;
      this.notify();
    };
    let sent: Promise<unknown>;
    try {
      sent = Promise.resolve(this.options.send(patch));
    } catch (error) {
      sent = Promise.reject(error);
    }
    // A refused write is said by the sender (its toast) and the saved billing read again.
    sent.then(settled, settled);
  }

  private notify(): void {
    this.options.onChange?.();
  }
}

// --- The summary's deposit on a party with no billing record (SCRUM-839) ------------------

/** The event's own deposit (its Prepayment): whole baht and its day, YYYY-MM-DD, when known. */
export interface EventDeposit {
  amountThb: number;
  date: string | null;
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The event's own Prepayment as the BEO's read carries it
 * (`prepaymentAmount`, `prepaymentDate`): the party's one deposit while the
 * BEO keeps no billing record (SCRUM-813, server/lib/partyDeposit.ts
 * `currentDeposit`). Null when the event holds none.
 */
export function eventDepositOf(event: { prepaymentAmount?: unknown; prepaymentDate?: unknown } | null | undefined): EventDeposit | null {
  const n = typeof event?.prepaymentAmount === "number" ? event.prepaymentAmount : Number.NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  const day = typeof event?.prepaymentDate === "string" ? event.prepaymentDate.trim().slice(0, 10) : "";
  return { amountThb: Math.round(n), date: DAY.test(day) ? day : null };
}

/**
 * THE FINANCIAL SUMMARY'S BILLING. With a billing record, the record: the
 * server keeps its deposit equal to the party's one deposit. With none
 * (nobody saved the BEO's billing yet), the event's own deposit and its day,
 * so a deposit paid through the chat or typed on the Events page reads here
 * as it does at the till, never "Deposit Paid: 0" beside it. Shown only: no
 * record is made by reading.
 */
export function summaryBillingOf(billing: BeoEventBilling | null, eventDeposit: EventDeposit | null | undefined): BeoEventBilling | null {
  if (billing || !eventDeposit || eventDeposit.amountThb <= 0) return billing;
  return {
    depositPaid: true,
    depositPaidAmount: eventDeposit.amountThb,
    depositPaidAt: eventDeposit.date ? `${eventDeposit.date}T00:00:00.000Z` : null,
  } as unknown as BeoEventBilling;
}

/**
 * A write from the summary while it shows the event's deposit: a patch that
 * names the deposit's day and no amount carries the amount shown, so the new
 * record says the deposit is paid. Without it the route would read a record
 * with a day and no deposit, and clear the party's deposit.
 */
export function patchOverEventDeposit(patch: BillingPatch, billing: BeoEventBilling | null, eventDeposit: EventDeposit | null | undefined): BillingPatch {
  if (billing || !eventDeposit || eventDeposit.amountThb <= 0) return patch;
  if (!("depositPaidAt" in patch) || "depositPaidAmount" in patch) return patch;
  return { depositPaidAmount: eventDeposit.amountThb, depositPaid: true, ...patch };
}

// --- The deposit a form was opened with, and what its Save carries (SCRUM-840) ------------

const NO_DEPOSIT: OneDeposit = { amountThb: 0, date: null };
const oneDeposit = (amount: unknown, date: unknown): OneDeposit => {
  const n = typeof amount === "number" ? amount : Number(amount);
  if (!Number.isFinite(n) || n <= 0) return NO_DEPOSIT;
  const day = typeof date === "string" ? date.trim().slice(0, 10) : "";
  return { amountThb: Math.round(n), date: DAY.test(day) ? day : null };
};

export const sameOneDeposit = (a: OneDeposit, b: OneDeposit) => a.amountThb === b.amountThb && (a.date ?? null) === (b.date ?? null);

/**
 * THE DEPOSIT THE FORM WAS OPENED WITH: the party's one deposit as the BEO's
 * read (or a Save's answer) says it (`oneDeposit`); from a server before the
 * rule, Party Details' own figure and day. The form sends it back with its
 * Save, so the server can tell a deposit that moved while the form was open
 * (the family paid through the chat) from one the person changed
 * (server/lib/depositSaveGuard.ts).
 */
export function loadedDepositOf(
  read: { oneDeposit?: { amountThb?: unknown; date?: unknown } | null; partyDetails?: { prepaymentReceived?: unknown; depositDate?: unknown } | null } | null | undefined,
): OneDeposit {
  if (read?.oneDeposit && typeof read.oneDeposit === "object") return oneDeposit(read.oneDeposit.amountThb, read.oneDeposit.date);
  return oneDeposit(read?.partyDetails?.prepaymentReceived, read?.partyDetails?.depositDate);
}

/**
 * WHETHER THE PERSON CHANGED THE DEPOSIT IN THE FORM: Party Details' figure
 * and day are no longer the deposit the form was opened with. The Save says
 * so (`depositChanged`), and the server takes Party Details' deposit only
 * then; a form that did not touch it leaves the stored deposit alone. (The
 * fields themselves travel with every Save, as they always did, so a server
 * from before the rule reads the Save as it used to.)
 */
export function depositChangedIn(form: { prepaymentReceived: number; depositDate: string }, loaded: OneDeposit): boolean {
  return !sameOneDeposit(oneDeposit(form.prepaymentReceived, form.depositDate), loaded);
}

/** Whether a billing write names the deposit paid: the writes that travel with the deposit this form last read. */
export const billingNamesDeposit = (patch: BillingPatch): boolean => "depositPaidAmount" in patch || "depositPaid" in patch || "depositPaidAt" in patch;

/** The least time between two reads of the deposit asked by the window coming back. */
export const DEPOSIT_READ_AGAIN_MS = 5_000;
