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
  /**
   * The button's key arrived while a staff field had the keyboard, so it was
   * the field's and nothing spun (SCRUM-223). The page says so on screen,
   * because a press that visibly does nothing reads as a broken booth.
   */
  onPressWhileTyping?: () => void;
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
 * The staff panel now has a phone and a password field, and a password may
 * well contain the booth's button key — a space, a letter. Typed there, it is
 * part of the password and must not spin the wheel behind the panel.
 *
 * **Why the wheel waits rather than spins** while such a field has the
 * keyboard: the red button and the keyboard's space bar send the same key, and
 * nothing in a browser tells them apart. Spinning on it would give a prize
 * away — and print a voucher nobody pressed for — every time a member of staff
 * typed a space in a password; taking the key away from the field would make
 * such a password impossible to type at the booth. A guest's press in that
 * moment is the cheaper mistake: nothing is drawn, the screen says staff are
 * signing in, and the wheel is back once somebody signs in or the form
 * closes — which it does by itself, however often the button is pressed
 * (`panel-timer.ts`).
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
 * sign-in panel taking digits — listens in the capture phase and stops the
 * event there, so it never arrives here. That is the whole arbitration
 * between the panel and the game, and it is why a staff member typing a PIN
 * cannot spin the wheel by reaching the digit that happens to be the button.
 */
export function installPressListener(options: PressListenerOptions): () => void {
  const { buttonKey, lockoutMs, onPress, onPressWhileTyping, onKeyRecorded } = options;
  let sawKeyDown = false;
  let lastPressAt = 0;

  const matches = (event: KeyboardEvent): boolean => isButtonKey(event, buttonKey);

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
    if (isTypingTarget(event.target)) {
      // The field's key, typed into it as it is; never a press. Its release
      // is expected like any other, so it cannot turn into one on the way up.
      if (!event.repeat) {
        onKeyRecorded?.('press ignored (a staff field has the keyboard)');
        onPressWhileTyping?.();
      }
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
    accept();
  };

  const onKeyUp = (event: KeyboardEvent): void => {
    if (!matches(event)) return;
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
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
  };
}
