import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react';
import { booth } from '../booth/client';
import { BoothCallError, type BoothStaffOnDuty, type StaffSignInResponse } from '../booth/contract';
import { STAFF_COPY } from '../copy';
import { createPanelTimer } from '../panel-timer';
import { isButtonKey } from '../press';
import { backoffFor, secondsLeft } from '../staff-backoff';

interface Props {
  open: boolean;
  signedIn: boolean;
  /** Who is on duty, when somebody is: name, code, and when the session ends. */
  staff?: BoothStaffOnDuty | null;
  onClose: () => void;
  /** A sign-in or sign-out landed; the caller refreshes status from the booth. */
  onChanged: () => void;
  /** A box running several booths offers "Change booth" here. */
  onChangeBooth?: () => void;
  /** A digit typed while the panel was closed opened it; this is that digit. */
  seed?: string | null;
  /**
   * The key the booth's button sends. A press of it is a guest's, so it never
   * keeps the panel open (`panel-timer.ts`).
   */
  buttonKey: string;
}

/** Longer than any PIN, short enough to bound a badge burst. */
const MAX_ENTRY = 32;
/**
 * A USB badge scanner types its characters in a few milliseconds; a person at
 * a keypad does not. Sixty milliseconds between keystrokes is comfortably
 * above a scanner and comfortably below a human, so an entry that arrives
 * faster than this AND is longer than a PIN is treated as a scan.
 *
 * It is a heuristic and it can be wrong in one direction: a very fast typist
 * entering a six-digit PIN could be read as a badge, the booth would refuse
 * it, and the attempt would count toward the backoff. The alternative — a
 * separate "scan" mode staff have to select — costs a touch on every scan, at
 * a booth where the scan is meant to be the quick path. If this misfires in
 * the park, the fix is a mode switch, not a tighter threshold.
 */
const SCAN_MAX_MEAN_GAP_MS = 60;

type Mode = 'pin' | 'account';

/**
 * The staff panel: sign in with a PIN or with a phone and password, and —
 * once signed in — reprint the last voucher, change booth, or sign out
 * (SCRUM-223).
 *
 * **Two ways in, one rule about the game.** Nothing typed here ever reaches
 * the wheel: the PIN pad takes its digits in the capture phase, and the phone
 * and password fields keep theirs because the press listener ignores keys
 * typed into a field. And nothing here stops the wheel either — a booth with
 * nobody signed in still plays, and the spin is recorded unattributed.
 *
 * **An account sign-in needs the internet** — the box asks the cloud — so
 * with none, the answer is "No internet — sign in with your PIN", which the
 * box can check on its own.
 */
export function StaffSignIn({
  open,
  signedIn,
  staff,
  onClose,
  onChanged,
  onChangeBooth,
  seed,
  buttonKey,
}: Props) {
  const [mode, setMode] = useState<Mode>('pin');
  const [entry, setEntry] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [failures, setFailures] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  // Keystroke timing for the scanner heuristic above. Refs, not state: they
  // are written on every keypress and read once, at submit.
  const firstKeyAt = useRef(0);
  const lastKeyAt = useRef(0);
  const keyCount = useRef(0);
  const phoneField = useRef<HTMLInputElement | null>(null);
  const passwordField = useRef<HTMLInputElement | null>(null);
  const signedInPanel = useRef<HTMLDivElement | null>(null);
  /** A phone-and-password sign-in was refused: the password box takes the keyboard back. */
  const refocusPassword = useRef(false);

  const locked = lockedUntil > now;

  const reset = useCallback(() => {
    setEntry('');
    setPassword('');
    firstKeyAt.current = 0;
    lastKeyAt.current = 0;
    keyCount.current = 0;
  }, []);

  /** What a refusal tells the person at the booth, by code (D15: the words are ours). */
  const refusalLine = useCallback((result: StaffSignInResponse): string => {
    switch (result.reason) {
      case 'offline':
        return STAFF_COPY.offline;
      case 'not_assigned':
        return STAFF_COPY.notAssigned;
      case 'not_allowed':
        return STAFF_COPY.notAllowed;
      case 'must_change_password':
        return STAFF_COPY.mustChange;
      // The internet is fine and the person may be too: it is the box, or the
      // booth's place on it, that the cloud refused (SCRUM-223).
      case 'box_refused':
        return STAFF_COPY.boxRefused;
      case 'booth_not_on_box':
        return STAFF_COPY.boothNotOnBox;
      default:
        return STAFF_COPY.signInWrong;
    }
  }, []);

  const settle = useCallback(
    (result: StaffSignInResponse) => {
      if (result.ok) {
        setFailures(0);
        setLockedUntil(0);
        setMessage(STAFF_COPY.signInOk);
        onChanged();
        return;
      }
      // Reasons that are not a wrong guess do not move the panel's backoff:
      // no internet, a role or a box the Console has to fix, is not somebody
      // guessing.
      const guess = result.reason === undefined || result.reason === 'wrong' || result.reason === 'locked';
      const next = guess ? failures + 1 : failures;
      if (guess) setFailures(next);
      // The panel's own backoff and whatever the booth says, whichever is
      // longer. The panel's exists so the wait is right even against a
      // service that sends nothing; the booth's is the one that is real.
      const wait = Math.max(guess ? backoffFor(next) : 0, result.retryAfterMs ?? 0);
      if (wait > 0) {
        // The clock the countdown reads is moved to the same instant the
        // deadline is set from, so the first frame does not read a second long.
        const at = Date.now();
        setNow(at);
        setLockedUntil(at + wait);
      }
      setMessage(refusalLine(result));
    },
    [failures, onChanged, refusalLine],
  );

  const submitPin = useCallback(
    (value: string) => {
      if (value === '' || busy || Date.now() < lockedUntil) return;
      const gaps = keyCount.current - 1;
      const meanGap =
        gaps > 0 ? (lastKeyAt.current - firstKeyAt.current) / gaps : Number.POSITIVE_INFINITY;
      const scanned = value.length >= 6 && meanGap < SCAN_MAX_MEAN_GAP_MS;

      setBusy(true);
      setMessage(null);
      void booth
        .signIn(scanned ? { badge: value } : { mode: 'pin', pin: value })
        .then(settle)
        .catch(() => {
          // A booth that cannot be reached is not a wrong PIN: it must not
          // count toward a lockout, or an hour of flaky wifi locks the shift
          // out of their own booth.
          setMessage(STAFF_COPY.signInWrong);
        })
        .finally(() => {
          setBusy(false);
          reset();
        });
    },
    [busy, lockedUntil, reset, settle],
  );

  const submitAccount = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      if (busy || Date.now() < lockedUntil) return;
      if (phone.trim() === '' || password === '') return;
      setBusy(true);
      setMessage(STAFF_COPY.working);
      const typed = { phone: phone.trim(), password };
      // The password is held only for this one request.
      setPassword('');
      void booth
        .signIn({ mode: 'account', ...typed })
        .then((result) => {
          settle(result);
          if (!result.ok) refocusPassword.current = true;
        })
        .catch(() => {
          setMessage(STAFF_COPY.offline);
          refocusPassword.current = true;
        })
        .finally(() => setBusy(false));
    },
    [busy, lockedUntil, password, phone, settle],
  );

  // ---- Keyboard --------------------------------------------------------
  // Capture phase, and every key the PIN pad consumes is stopped here. The
  // press listener (src/press.ts) is on the bubble phase, so a key the panel
  // takes never reaches the game — and every other key, the booth's button
  // included, passes straight through. That is deliberate: a staff member
  // fumbling a PIN must not stop a child spinning. In the account form the
  // fields take their own keys and only Escape is the panel's.
  useEffect(() => {
    if (!open || signedIn) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key;
      if (key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        reset();
        onClose();
        return;
      }
      if (mode === 'account') return;
      const isEntryChar = key.length === 1 && /[0-9A-Za-z]/.test(key);
      if (!isEntryChar && key !== 'Backspace' && key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      if (key === 'Backspace') {
        setEntry((current) => current.slice(0, -1));
        return;
      }
      if (key === 'Enter') {
        setEntry((current) => {
          submitPin(current);
          return current;
        });
        return;
      }
      const at = Date.now();
      if (keyCount.current === 0) firstKeyAt.current = at;
      lastKeyAt.current = at;
      keyCount.current += 1;
      setEntry((current) => (current.length >= MAX_ENTRY ? current : current + key));
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, signedIn, mode, onClose, reset, submitPin]);

  // A digit that opened the panel is the first digit of the PIN.
  useEffect(() => {
    if (!open || signedIn || !seed) return;
    setMode('pin');
    const at = Date.now();
    firstKeyAt.current = at;
    lastKeyAt.current = at;
    keyCount.current = 1;
    setEntry(seed);
  }, [open, signedIn, seed]);

  useEffect(() => {
    if (open && mode === 'account' && !signedIn) phoneField.current?.focus();
  }, [open, mode, signedIn]);

  /**
   * After a refusal the password box has the keyboard again, as it had before
   * the form was sent (the fields are disabled while the box answers, and that
   * drops the focus onto the page). Staff retype the password, which a refusal
   * clears, without reaching for the touchpad — and the red button goes on
   * waiting, as it does while anything is typed here, instead of spinning
   * behind a form that is still up. Not before a lockout has run out: a
   * disabled box cannot take the focus. A form that has gone — closed,
   * signed in, the PIN tab — owes nobody the focus, and a later one starts
   * on the phone box as usual.
   */
  useEffect(() => {
    if (!open || signedIn || mode !== 'account') {
      refocusPassword.current = false;
      return;
    }
    if (busy || locked || !refocusPassword.current) return;
    refocusPassword.current = false;
    passwordField.current?.focus();
  }, [open, signedIn, mode, busy, locked]);

  // Signed in, the panel is buttons. It takes the focus when it opens, so Tab
  // starts at Reprint — a booth with a keypad and no pointer reaches every
  // action with Tab and Enter — and Escape closes it.
  useEffect(() => {
    if (!open || !signedIn) return;
    signedInPanel.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, signedIn, onClose]);

  // ---- Countdown and auto-close ---------------------------------------
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [open]);

  /**
   * The panel closes itself: 45 seconds after the last thing staff did in it,
   * and two minutes after it opened whatever is done (`panel-timer.ts`, which
   * also says why a press of the booth's button is not something staff did).
   * Read through refs, so the one timer made here always closes the panel and
   * judges a key as they are now.
   */
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const buttonKeyRef = useRef(buttonKey);
  buttonKeyRef.current = buttonKey;
  const autoClose = useMemo(
    () =>
      createPanelTimer({
        onClose: () => closeRef.current(),
        isButtonKey: (event) => isButtonKey(event, buttonKeyRef.current),
      }),
    [],
  );

  // Opened, or signed in — a new view: both countdowns from now.
  useEffect(() => {
    if (!open) return;
    autoClose.open();
    return () => autoClose.stop();
  }, [open, signedIn, autoClose]);

  // Every key, in the capture phase, where the PIN pad takes its digits.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => autoClose.key(event);
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, autoClose]);

  // A sign-in sent or answered, a tab changed: somebody is working the panel.
  useEffect(() => {
    if (open) autoClose.touch();
  }, [open, busy, mode, autoClose]);

  useEffect(() => {
    if (!open) {
      reset();
      setMessage(null);
      setMode('pin');
    }
  }, [open, reset]);

  const reprint = useCallback(() => {
    if (busy) return;
    setBusy(true);
    setMessage(STAFF_COPY.reprinting);
    void booth
      .reprint({})
      .then((result) => {
        setMessage(
          result.printState === 'printed'
            ? STAFF_COPY.reprinted
            : result.printState === 'no_printer'
              ? STAFF_COPY.reprintNoPrinter
              : STAFF_COPY.reprintQueued,
        );
      })
      .catch((error: unknown) => {
        const code = error instanceof BoothCallError ? error.code : null;
        setMessage(
          code === 'nothing_to_reprint'
            ? STAFF_COPY.nothingToReprint
            : code === 'staff_required'
              ? STAFF_COPY.reprintNeedsStaff
              : STAFF_COPY.reprintFailed,
        );
      })
      .finally(() => setBusy(false));
  }, [busy]);

  if (!open) return null;

  /**
   * A pressed action button hands its focus back to the panel. Left on the
   * button, the focus would let the next Enter — the badge scanner ends every
   * scan with one — press it again: a second reprint, or a sign-out nobody
   * asked for. (The booth's own button key never reaches a focused button:
   * the press listener cancels it.)
   */
  const act = (run: () => void) => (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.currentTarget.blur();
    signedInPanel.current?.focus();
    run();
  };

  if (signedIn) {
    const who = staff ? [staff.name, staff.code ? `(${staff.code})` : null].filter(Boolean).join(' ') : '';
    const until = staff?.expiresAt ? formatTime(staff.expiresAt) : null;
    return (
      <div
        className="k-panel"
        data-booth-panel="staff"
        ref={signedInPanel}
        tabIndex={-1}
        onPointerDown={() => autoClose.touch()}
      >
        <div className="k-panel-head">{STAFF_COPY.signInTitle}</div>
        <p className="k-panel-line" data-booth-staff-name="1">
          {who ? STAFF_COPY.signedInAs(who) : STAFF_COPY.signInOk}
        </p>
        {until && <p className="k-panel-line">{STAFF_COPY.until(until)}</p>}
        <div className="k-panel-stack">
          <button
            type="button"
            className="k-panel-btn k-panel-btn--wide"
            disabled={busy}
            onClick={act(reprint)}
            data-booth-action="reprint"
          >
            {STAFF_COPY.reprint}
          </button>
          {onChangeBooth && (
            <button
              type="button"
              className="k-panel-btn k-panel-btn--wide"
              onClick={act(() => {
                onClose();
                onChangeBooth();
              })}
            >
              {STAFF_COPY.changeBooth}
            </button>
          )}
        </div>
        {message !== null && <p className="k-panel-line k-panel-note">{message}</p>}
        <div className="k-panel-row">
          <button
            type="button"
            className="k-panel-btn"
            onClick={act(() => {
              void booth.signOut().then(onChanged).catch(onChanged);
              onClose();
            })}
          >
            {STAFF_COPY.signOut}
          </button>
          <button type="button" className="k-panel-btn" onClick={act(onClose)}>
            {STAFF_COPY.cancel}
          </button>
        </div>
      </div>
    );
  }

  const keypad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'];

  return (
    <div className="k-panel" data-booth-panel="staff" onPointerDown={() => autoClose.touch()}>
      <div className="k-panel-head">{STAFF_COPY.signInTitle}</div>
      <div className="k-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'pin'}
          className={mode === 'pin' ? 'k-tab k-tab--on' : 'k-tab'}
          onClick={() => {
            setMode('pin');
            setMessage(null);
          }}
        >
          {STAFF_COPY.usePin}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'account'}
          className={mode === 'account' ? 'k-tab k-tab--on' : 'k-tab'}
          onClick={() => {
            setMode('account');
            setMessage(null);
          }}
          data-booth-tab="account"
        >
          {STAFF_COPY.useAccount}
        </button>
      </div>

      {mode === 'pin' ? (
        <>
          <p className="k-panel-line">{STAFF_COPY.signInHint}</p>
          {/* Dots, never characters: a booth screen faces a shopping centre. */}
          <div className="k-pin" aria-hidden>
            {entry === '' ? <span className="k-pin-empty">·</span> : '•'.repeat(entry.length)}
          </div>
          <div className="k-keypad">
            {keypad.map((label) => (
              <button
                key={label}
                type="button"
                className="k-key"
                disabled={busy || locked}
                onClick={() => {
                  if (label === '⌫') {
                    setEntry((current) => current.slice(0, -1));
                    return;
                  }
                  if (label === '✓') {
                    submitPin(entry);
                    return;
                  }
                  const at = Date.now();
                  if (keyCount.current === 0) firstKeyAt.current = at;
                  lastKeyAt.current = at;
                  keyCount.current += 1;
                  setEntry((current) => (current.length >= MAX_ENTRY ? current : current + label));
                }}
              >
                {label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <form className="k-account" onSubmit={submitAccount} autoComplete="off">
          <p className="k-panel-line">{STAFF_COPY.accountHint}</p>
          <label className="k-field">
            <span>{STAFF_COPY.phoneLabel}</span>
            <input
              ref={phoneField}
              type="tel"
              inputMode="tel"
              name="booth-phone"
              autoComplete="off"
              value={phone}
              maxLength={32}
              disabled={busy || locked}
              // No spaces: the cloud reads a number without them, and the red
              // button sends a space. Pressed while this field has the
              // keyboard it then changes nothing. (Nor does it keep the panel
              // open: the button's key never restarts its countdown.)
              onChange={(event) => setPhone(event.target.value.replace(/\s+/g, ''))}
            />
          </label>
          <label className="k-field">
            <span>{STAFF_COPY.passwordLabel}</span>
            <input
              ref={passwordField}
              type="password"
              name="booth-password"
              autoComplete="off"
              value={password}
              maxLength={256}
              disabled={busy || locked}
              onChange={(event) => setPassword(event.target.value)}
            />
          </label>
          <div className="k-panel-row">
            <button
              type="submit"
              className="k-panel-btn"
              disabled={busy || locked || phone.trim() === '' || password === ''}
            >
              {STAFF_COPY.signInButton}
            </button>
          </div>
        </form>
      )}

      {locked && (
        <p className="k-panel-warn">{STAFF_COPY.signInLocked(secondsLeft(lockedUntil, now))}</p>
      )}
      {!locked && message !== null && <p className="k-panel-warn">{message}</p>}

      <div className="k-panel-row">
        <button type="button" className="k-panel-btn" onClick={onClose}>
          {STAFF_COPY.cancel}
        </button>
      </div>
    </div>
  );
}

/** "18:00" in the television's own time, which on a booth box is the park's. */
function formatTime(iso: string): string | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(at);
}
