/**
 * How often a refused credential may cost a registration (SCRUM-331).
 *
 * **What this is for.** A 401 from the cloud means the secret this box holds is
 * not the one the platform has, and the honest answer is to drop it and
 * register again — that is how an administrator rotating a claim code cuts off
 * a stolen Pi and brings a replacement up in its slot. The trouble is that two
 * agents driving ONE box row answer each other: every registration revokes the
 * other's secret, so each refusal produces a registration which produces the
 * next refusal, and the pair spin at one cycle per tick. Staging measured 637
 * refusals and 549 registrations of one box in a day, each registration pulling
 * the box's whole offline cache again because a fresh registration has no etag.
 *
 * **The rule.** A refusal re-registers at once. A further refusal inside the
 * window is counted and logged and does nothing else, so a box cannot register
 * more than once a minute however many refusals it collects. A registration
 * that SUCCEEDS resets the count, so the next window starts from one rather
 * than carrying an old episode's total.
 *
 * **What is deliberately not reset by a success:** the window itself. Two
 * agents fighting both register successfully every time, so a window that a
 * success reopened would let exactly the storm above continue. The window is
 * anchored on the last registration ATTEMPT, whatever came of it.
 *
 * It is a decision and no more — dropping the credential, clearing the store
 * and registering stay in `agent.ts` — so the rule is tested with a clock held
 * by hand and nothing else around it (`reregister.test.ts`), and a rule that
 * cheap to test is one somebody can change safely.
 */

/** One minute. A rotated claim code still brings a box back within one. */
export const REREGISTER_WINDOW_MS = 60_000;

export type RefusalVerdict =
  | { register: true }
  | {
      register: false;
      /** Refusals swallowed since the last registration, this one included. */
      swallowed: number;
      /** How much longer the door stays shut. */
      reopensInMs: number;
    };

export interface RefusalBackOff {
  /** Read on every refusal: may this one register again? */
  refused(now: number): RefusalVerdict;
  /** Told when a registration actually succeeded. */
  registered(): void;
}

export function createRefusalBackOff(windowMs: number = REREGISTER_WINDOW_MS): RefusalBackOff {
  let lastAttemptAt: number | null = null;
  let swallowed = 0;

  return {
    refused(now) {
      const since = lastAttemptAt === null ? null : now - lastAttemptAt;
      /**
       * A negative `since` is a clock that stepped backwards — a Pi with no
       * battery reading NTP for the first time — and it opens the door rather
       * than shutting it for as long as the clock is behind. The cost of being
       * wrong that way is one registration; the cost of the other way is a box
       * that cannot come back until somebody restarts it.
       */
      if (since !== null && since >= 0 && since < windowMs) {
        swallowed += 1;
        return { register: false, swallowed, reopensInMs: windowMs - since };
      }
      lastAttemptAt = now;
      return { register: true };
    },
    registered() {
      swallowed = 0;
    },
  };
}
