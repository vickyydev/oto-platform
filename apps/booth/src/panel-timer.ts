/**
 * When the staff panel closes itself (SCRUM-223).
 *
 * A panel left open on a booth television is staff furniture on a guest's
 * screen, and the sign-in form is worse than furniture: while its phone or
 * password box has the keyboard, the red button does not spin (`press.ts`,
 * `isTypingTarget`). So the panel runs two countdowns from the moment it opens:
 *
 *  - **Idle, `PANEL_IDLE_MS`.** Started again by anything staff do in it — a
 *    key, a click or tap, a sign-in coming back — EXCEPT the booth's button
 *    key. That key is what a guest presses, and the red button and the space
 *    bar send the same one: pressed while the password box has the keyboard it
 *    types a space into the password. The countdown used to restart on every
 *    change to what was typed, so guests pressing every few seconds kept the
 *    form up, and the wheel held, for as long as they kept pressing.
 *  - **A cap, `PANEL_OPEN_CAP_MS`,** that nothing moves. Whatever is typed, the
 *    panel is off the guest's screen two minutes after it opened. A sign-in,
 *    which changes the panel into staff's buttons, starts both countdowns
 *    again for that view.
 *
 * No React and no DOM, so a test can run the clock by hand.
 */

/** How long a panel nobody is using stays up. */
export const PANEL_IDLE_MS = 45_000;

/** How long a panel stays up at most, from when it opened, whatever is typed. */
export const PANEL_OPEN_CAP_MS = 120_000;

export interface PanelTimerOptions {
  onClose: () => void;
  /** Whether a key is the booth's button: `isButtonKey` in `press.ts`, with the booth's key. */
  isButtonKey: (event: { key: string; code: string }) => boolean;
  /** `window.setTimeout` unless a test runs the clock. */
  setTimer?: (fire: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface PanelTimer {
  /** The panel opened, or turned into another view: both countdowns start. */
  open(): void;
  /** Staff did something: the idle countdown starts again; the cap does not move. */
  touch(): void;
  /** A key reached the panel: `touch`, unless it is the booth's button. */
  key(event: { key: string; code: string }): void;
  /** The panel closed some other way: nothing is left to fire. */
  stop(): void;
}

export function createPanelTimer(options: PanelTimerOptions): PanelTimer {
  const setTimer = options.setTimer ?? ((fire, ms) => window.setTimeout(fire, ms));
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle as number));
  let idle: unknown = null;
  let cap: unknown = null;

  function stop(): void {
    if (idle !== null) clearTimer(idle);
    if (cap !== null) clearTimer(cap);
    idle = null;
    cap = null;
  }

  function fire(): void {
    stop();
    options.onClose();
  }

  function touch(): void {
    // Only while open: a key after the panel closed opens nothing.
    if (cap === null) return;
    if (idle !== null) clearTimer(idle);
    idle = setTimer(fire, PANEL_IDLE_MS);
  }

  return {
    open() {
      stop();
      idle = setTimer(fire, PANEL_IDLE_MS);
      cap = setTimer(fire, PANEL_OPEN_CAP_MS);
    },
    touch,
    key(event) {
      if (!options.isButtonKey(event)) touch();
    },
    stop,
  };
}
