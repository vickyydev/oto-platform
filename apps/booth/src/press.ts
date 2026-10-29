/**
 * The red dome button.
 *
 * Lifted from the outgoing game's input handling (D21) with its two lockouts
 * and its held-key pairing intact, and with four things deliberately left
 * behind:
 *
 *   - **catch-any-key.** That game answered Space, Enter, NumpadEnter,
 *     "Select", keyCode 13, 23 and 32, because nobody knew what the button
 *     sent. A booth here has a configured key and answers that key only. The
 *     reason is a device, not tidiness: the park's USB badge scanner types
 *     digits and then Enter, and a booth that answers Enter spins the wheel
 *     every time somebody scans a badge.
 *   - **click-to-spin.** Pointer and click handlers existed to catch a TV
 *     browser that turned a remote press into a mouse click at the cursor. A
 *     screen in a mall that spins when it is touched is a screen that spins
 *     when it is cleaned.
 *   - **Enter, under any configuration.** The column's CHECK refuses it and so
 *     does the bundle schema; this refuses it a third time, because the page
 *     is the last thing between a badge scan and a spin.
 *   - **the staff arrow-key shortcuts.** Reload, dismiss, spin and mute on the
 *     remote's arrows were a way to work an Android stick with no keyboard.
 *
 * What is kept is the pairing, which is subtle and was learned the hard way: a
 * key we saw go DOWN is expected to come back UP, and that release is not a
 * second press however long it was held. A release we did NOT see go down
 * means something ate the keydown, and that release IS the press.
 */

export interface PressListenerOptions {
  /**
   * Captured before an immediate spin starts: holding that press for three
   * seconds opens the staff panel — the only way to Reprint on a booth with a
   * button and no pointer (docs/ops/PI_BOOTH.md).
   */
  canOpenStaff?: () => boolean;
  onOpenStaff?: () => void;
  /**
   * `KeyboardEvent.code` (`Space`, `KeyF`, `NumpadEnter`) or `.key`. Both are
   * compared, because a booth is configured by a person reading one of them
   * off a device and there is no way to tell which they wrote down.
   */
  buttonKey: string;
  /** The lockout to apply right now, in ms — it differs by phase. */
  lockoutMs: () => number;
  /** A press that got through the lockout. */
  onPress: () => void;
  /** Every accepted and rejected key, for the `#debug` input line. */
  onKeyRecorded?: (line: string) => void;
}

/** Ignore presses closer together than this: switch bounce, not two presses. */
export const PRESS_LOCKOUT_MS = 350;
/**
 * The shorter lockout while the prize card is up, so the second press of the
 * double-press "play again" gesture is never swallowed.
 */
export const RESULT_PRESS_LOCKOUT_MS = 200;

interface ButtonOverlay {
  move(): void;
  select(): void;
  touch(): void;
}
let activeOverlay: ButtonOverlay | null = null;

/** Overlays register actions; this file remains the sole source of button keys. */
export function registerButtonOverlay(overlay: ButtonOverlay): () => void {
  activeOverlay = overlay;
  return () => {
    if (activeOverlay === overlay) activeOverlay = null;
  };
}

/** Never the badge scanner's key, whatever a bundle says. */
export function isForbiddenButtonKey(key: string): boolean {
  return key === 'Enter' || key === 'NumpadEnter';
}

/**
 * Whether a key is the booth's button, by `code` or by `key` (see
 * `PressListenerOptions.buttonKey`). The press listener and the staff panel's
 * countdown (`panel-timer.ts`) ask the same question, so they cannot disagree
 * about which key a guest's press is.
 */
export function isButtonKey(event: { key: string; code: string }, buttonKey: string): boolean {
  if (isForbiddenButtonKey(event.key) || isForbiddenButtonKey(event.code)) return false;
  return event.code === buttonKey || event.key === buttonKey;
}

/**
 * A key typed into a field is the field's (SCRUM-223).
 *
 * The one field on the booth's screens today is the claim code a box is set
 * up with (`ClaimScreen`); nobody signs in at the booth (SCRUM-694). A code
 * may well contain the booth's button key — a letter — and typed there it is
 * part of the code and must not spin a wheel.
 *
 * **Why a press waits rather than spins** while such a field has the
 * keyboard: the red button and the keyboard send the same key, and nothing in
 * a browser tells them apart. Spinning on it would give a prize away every
 * time somebody typed that letter; taking the key away from the field would
 * make such a code impossible to type. A guest's press in that moment is the
 * cheaper mistake: nothing is drawn.
 */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (typeof HTMLElement === 'undefined' || !(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Installs the listener and returns its remover.
 *
 * Bubble phase on `window`, not capture: an overlay that wants a key — the
 * staff panel's Escape — listens in the capture phase and stops the event
 * there, so it never arrives here. That is the whole arbitration between a
 * panel and the game.
 */
export function installPressListener(options: PressListenerOptions): () => void {
  const { buttonKey, lockoutMs, onPress, onKeyRecorded } = options;
  let sawKeyDown = false;
  let lastPressAt = 0;
  let single: ReturnType<typeof setTimeout> | undefined;
  let hold: ReturnType<typeof setTimeout> | undefined;
  let repeat: ReturnType<typeof setInterval> | undefined;
  let firstTapAt: number | null = null;
  let tappedOverlay: ButtonOverlay | null = null;
  const stopHold = () => {
    clearTimeout(hold);
    clearInterval(repeat);
  };
  const overlayPress = (overlay: ButtonOverlay) => {
    overlay.touch();
    const at = Date.now();
    if (firstTapAt !== null && tappedOverlay === overlay && at - firstTapAt <= 400) {
      clearTimeout(single);
      firstTapAt = null;
      overlay.select();
    } else {
      clearTimeout(single);
      firstTapAt = at;
      tappedOverlay = overlay;
      single = setTimeout(() => {
        firstTapAt = null;
        if (activeOverlay === overlay) overlay.move();
      }, 400);
    }
  };

  const matches = (event: KeyboardEvent): boolean => isButtonKey(event, buttonKey);

  const accept = (): void => {
    if (activeOverlay) {
      overlayPress(activeOverlay);
      return;
    }
    const now = Date.now();
    // A wall clock that stepped BACK since the last press (time sync correcting
    // a Pi whose clock was ahead) would otherwise hold the lockout for the
    // whole step — hours of dead button until a reload resets it (SCRUM-467).
    if (now >= lastPressAt && now - lastPressAt < lockoutMs()) {
      onKeyRecorded?.('press ignored (lockout)');
      return;
    }
    lastPressAt = now;
    onPress();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!matches(event)) return;
    sawKeyDown = true;
    if (isTypingTarget(event.target)) {
      // The field's key, typed into it as it is; never a press. Its release
      // is expected like any other, so it cannot turn into one on the way up.
      if (!event.repeat) onKeyRecorded?.('press ignored (a field has the keyboard)');
      return;
    }
    event.preventDefault();
    if (event.repeat) {
      // A held button becomes key-repeat on some HID mappings. It never
      // advances the game, but the default still has to be cancelled or the
      // browser is free to run its own long-press behaviour.
      onKeyRecorded?.('press repeat suppressed');
      return;
    }
    onKeyRecorded?.('press (keydown)');
    stopHold();
    const overlay = activeOverlay;
    if (overlay) {
      hold = setTimeout(() => {
        if (activeOverlay !== overlay) return;
        clearTimeout(single);
        firstTapAt = null;
        overlay.move();
        overlay.touch();
        repeat = setInterval(() => {
          if (activeOverlay !== overlay) {
            stopHold();
            return;
          }
          overlay.move();
          overlay.touch();
        }, 250);
      }, 600);
    } else if (options.canOpenStaff?.()) {
      hold = setTimeout(() => options.onOpenStaff?.(), 3_000);
    }
    accept();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (!matches(event)) return;
    stopHold();
    if (sawKeyDown) {
      sawKeyDown = false;
      if (!isTypingTarget(event.target)) event.preventDefault();
      return;
    }
    if (isTypingTarget(event.target)) return;
    event.preventDefault();
    onKeyRecorded?.('press (keyup, keydown was swallowed)');
    accept();
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  return () => {
    stopHold();
    clearTimeout(single);
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  };
}

/** How often the booth checks that its window still has the keyboard. */
export const KEYBOARD_CHECK_MS = 5_000;
/** After the window loses the keyboard, the first try to take it back. */
export const KEYBOARD_RECLAIM_DELAY_MS = 1_000;

interface KeyboardWindow {
  addEventListener(type: string, handler: () => void): void;
  removeEventListener(type: string, handler: () => void): void;
  focus(): void;
}
interface KeyboardDocument {
  addEventListener(type: string, handler: () => void): void;
  removeEventListener(type: string, handler: () => void): void;
  hasFocus(): boolean;
}

/**
 * Keeps the booth's window holding the keyboard (SCRUM-467).
 *
 * The press listener above sits on `window` and is never removed while the
 * page runs, so the page cannot lose its button by itself. What it can lose
 * is the keyboard: the button is a USB keyboard, and key events only reach
 * the window the desktop has focused. Once anything takes focus away from the
 * kiosk browser — a desktop notification, a dialog, the compositor after the
 * screen woke — every press goes elsewhere and the wheel looks dead until the
 * browser is restarted, which hands it focus again.
 *
 * So whenever the document reports it no longer has focus — on the window's
 * blur, when the page is shown again, and on a slow periodic check — it asks
 * for focus back. Focus INSIDE the page is left alone: a staff field or a
 * panel button keeps the keyboard it has. `onLost` / `onBack` fire once per
 * loss, for the `#debug` input line.
 */
export function installKeyboardKeeper(
  options: {
    onLost?: () => void;
    onBack?: () => void;
    win?: KeyboardWindow;
    doc?: KeyboardDocument;
  } = {},
): () => void {
  const win = options.win ?? window;
  const doc = options.doc ?? document;
  let lost = false;
  let soon: ReturnType<typeof setTimeout> | undefined;
  const reclaim = (): void => {
    if (doc.hasFocus()) return;
    if (!lost) {
      lost = true;
      options.onLost?.();
    }
    try {
      win.focus();
    } catch {
      // A window that refuses is tried again on the next check.
    }
  };
  const onBlur = (): void => {
    clearTimeout(soon);
    soon = setTimeout(reclaim, KEYBOARD_RECLAIM_DELAY_MS);
  };
  const onFocus = (): void => {
    clearTimeout(soon);
    if (lost) {
      lost = false;
      options.onBack?.();
    }
  };
  const timer = setInterval(reclaim, KEYBOARD_CHECK_MS);
  win.addEventListener('blur', onBlur);
  win.addEventListener('focus', onFocus);
  win.addEventListener('pageshow', reclaim);
  doc.addEventListener('visibilitychange', reclaim);
  return () => {
    clearTimeout(soon);
    clearInterval(timer);
    win.removeEventListener('blur', onBlur);
    win.removeEventListener('focus', onFocus);
    win.removeEventListener('pageshow', reclaim);
    doc.removeEventListener('visibilitychange', reclaim);
  };
}
