/**
 * When the staff panel closes itself (SCRUM-223, SCRUM-694).
 *
 * A panel left open on a booth television is staff furniture on a guest's
 * screen, and a guest can reach this one: a touch on the corner chip opens it,
 * and it offers Reprint, Change booth and the diagnostics with no credential
 * behind them (nobody signs in at a booth). So the panel runs two countdowns
 * from the moment it opens:
 *
 *  - **Idle, `PANEL_IDLE_MS`.** Started again by anything staff do in it — a
 *    key, a click or tap, a reprint coming back — EXCEPT the booth's button
 *    key. That key is what a guest presses, and a guest pressing every few
 *    seconds must not keep the panel up for as long as they keep pressing.
 *  - **A cap, `PANEL_OPEN_CAP_MS`,** that nothing moves. Whatever is pressed,
 *    the panel is off the guest's screen two minutes after it opened.
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
