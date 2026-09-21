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

/** Never the badge scanner's key, whatever a bundle says. */
export function isForbiddenButtonKey(key: string): boolean {
  return key === 'Enter' || key === 'NumpadEnter';
}

/**
 * Installs the listener and returns its remover.
 *
 * Bubble phase on `window`, not capture: an overlay that wants a key — the
 * sign-in panel taking digits — listens in the capture phase and stops the
 * event there, so it never arrives here. That is the whole arbitration
 * between the panel and the game, and it is why a staff member typing a PIN
 * cannot spin the wheel by reaching the digit that happens to be the button.
 */
export function installPressListener(options: PressListenerOptions): () => void {
  const { buttonKey, lockoutMs, onPress, onKeyRecorded } = options;
  let sawKeyDown = false;
  let lastPressAt = 0;

  const matches = (event: KeyboardEvent): boolean => {
    if (isForbiddenButtonKey(event.key) || isForbiddenButtonKey(event.code)) return false;
    return event.code === buttonKey || event.key === buttonKey;
  };

  const accept = (): void => {
    const now = Date.now();
    if (now - lastPressAt < lockoutMs()) {
      onKeyRecorded?.('press ignored (lockout)');
      return;
    }
    lastPressAt = now;
    onPress();
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!matches(event)) return;
    sawKeyDown = true;
    event.preventDefault();
    if (event.repeat) {
      // A held button becomes key-repeat on some HID mappings. It never
      // advances the game, but the default still has to be cancelled or the
      // browser is free to run its own long-press behaviour.
      onKeyRecorded?.('press repeat suppressed');
      return;
    }
    onKeyRecorded?.('press (keydown)');
    accept();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (!matches(event)) return;
    event.preventDefault();
    if (sawKeyDown) {
      sawKeyDown = false;
      return;
    }
    onKeyRecorded?.('press (keyup, keydown was swallowed)');
    accept();
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  };
}
