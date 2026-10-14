/**
 * The kiosk hides the pointer while nobody is moving it (SCRUM-419, closing
 * audit L34).
 *
 * The recommended kit is a keyboard and touchpad, and the pointer used to sit
 * on the wheel for the whole day. Hiding it outright would leave staff unable
 * to aim at the sign-in panel with the touchpad, so it is hidden after
 * `POINTER_IDLE_MS` without movement and shown again the moment it moves. The
 * box separately reports whether a pointing device is plugged in at all.
 *
 * No React and no DOM, so a test can run the clock by hand; `installPointerIdle`
 * is the one line that binds it to the page.
 */

/** How long the pointer stays visible after it last moved. */
export const POINTER_IDLE_MS = 3_000;

/** The class on `<html>` that `kiosk.css` hides the cursor under. */
export const POINTER_IDLE_CLASS = 'pointer-idle';

export interface PointerIdleOptions {
  /** True hides the pointer, false shows it. */
  setHidden: (hidden: boolean) => void;
  /** `window.setTimeout` unless a test runs the clock. */
  setTimer?: (fire: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  idleMs?: number;
}

export interface PointerIdle {
  /** The pointer moved: show it, and start the countdown again. */
  moved(): void;
  /** Nothing is left to fire. */
  stop(): void;
}

export function createPointerIdle(options: PointerIdleOptions): PointerIdle {
  const setTimer = options.setTimer ?? ((fire, ms) => window.setTimeout(fire, ms));
  const clearTimer = options.clearTimer ?? ((handle) => window.clearTimeout(handle as number));
  const idleMs = options.idleMs ?? POINTER_IDLE_MS;
  let timer: unknown = null;
  let hidden = false;

  function arm(): void {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      hidden = true;
      options.setHidden(true);
    }, idleMs);
  }

  // Hidden from the start would be wrong only for somebody already holding
  // the touchpad, and they move it; a pointer on the wheel at boot is not.
  arm();

  return {
    moved() {
      if (hidden) {
        hidden = false;
        options.setHidden(false);
      }
      arm();
    },
    stop() {
      if (timer !== null) clearTimer(timer);
      timer = null;
    },
  };
}

/** Bind it to the page: a class on `<html>`, cleared by any pointer movement. */
export function installPointerIdle(doc: Document = document): PointerIdle {
  const idle = createPointerIdle({
    setHidden: (hidden) => doc.documentElement.classList.toggle(POINTER_IDLE_CLASS, hidden),
  });
  doc.addEventListener('pointermove', () => idle.moved(), { passive: true });
  doc.addEventListener('pointerdown', () => idle.moved(), { passive: true });
  return idle;
}
