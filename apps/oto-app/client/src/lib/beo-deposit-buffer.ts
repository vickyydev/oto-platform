import type { BeoEventBilling } from "@shared/schema";

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
