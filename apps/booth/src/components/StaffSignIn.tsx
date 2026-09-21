import { useCallback, useEffect, useRef, useState } from 'react';
import { booth } from '../booth/client';
import { STAFF_COPY } from '../copy';
import { backoffFor, secondsLeft } from '../staff-backoff';

interface Props {
  open: boolean;
  signedIn: boolean;
  onClose: () => void;
  /** A sign-in or sign-out landed; the caller refreshes status from the booth. */
  onChanged: () => void;
}

/** A panel left open on a booth television is staff furniture on a guest's screen. */
const AUTO_CLOSE_MS = 45_000;
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

export function StaffSignIn({ open, signedIn, onClose, onChanged }: Props) {
  const [entry, setEntry] = useState('');
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

  const locked = lockedUntil > now;

  const reset = useCallback(() => {
    setEntry('');
    firstKeyAt.current = 0;
    lastKeyAt.current = 0;
    keyCount.current = 0;
  }, []);

  const submit = useCallback(
    (value: string) => {
      if (value === '' || busy || Date.now() < lockedUntil) return;
      const gaps = keyCount.current - 1;
      const meanGap =
        gaps > 0 ? (lastKeyAt.current - firstKeyAt.current) / gaps : Number.POSITIVE_INFINITY;
      const scanned = value.length >= 6 && meanGap < SCAN_MAX_MEAN_GAP_MS;

      setBusy(true);
      setMessage(null);
      void booth
        .signIn(scanned ? { badge: value } : { pin: value })
        .then((result) => {
          if (result.ok) {
            setFailures(0);
            setLockedUntil(0);
            setMessage(STAFF_COPY.signInOk);
            onChanged();
            return;
          }
          const next = failures + 1;
          setFailures(next);
          // The panel's own backoff and whatever the booth says, whichever is
          // longer. The panel's exists so the wait is right even against a
          // service that sends nothing; the booth's is the one that is real.
          const wait = Math.max(backoffFor(next), result.retryAfterMs ?? 0);
          if (wait > 0) {
            // The clock the countdown reads is moved to the same instant the
            // deadline is set from. Without this the first frame shows 31s for
            // a 30-second wait, because `now` is up to half a second stale and
            // the remainder is rounded up.
            const at = Date.now();
            setNow(at);
            setLockedUntil(at + wait);
          }
          setMessage(STAFF_COPY.signInWrong);
        })
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
    [busy, failures, lockedUntil, onChanged, reset],
  );

  // ---- Keyboard --------------------------------------------------------
  // Capture phase, and every key this panel consumes is stopped here. The
  // press listener (src/press.ts) is on the bubble phase, so a key the panel
  // takes never reaches the game — and every other key, the booth's button
  // included, passes straight through. That is deliberate: a staff member
  // fumbling a PIN must not stop a child spinning.
  useEffect(() => {
    if (!open || signedIn) return;
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key;
      const isEntryChar = key.length === 1 && /[0-9A-Za-z]/.test(key);
      if (!isEntryChar && key !== 'Backspace' && key !== 'Enter' && key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (key === 'Escape') {
        reset();
        onClose();
        return;
      }
      if (key === 'Backspace') {
        setEntry((current) => current.slice(0, -1));
        return;
      }
      if (key === 'Enter') {
        setEntry((current) => {
          submit(current);
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
  }, [open, signedIn, onClose, reset, submit]);

  // ---- Countdown and auto-close ---------------------------------------
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const timer = window.setTimeout(onClose, AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer);
    // `entry` and `busy` are in the list so that typing and submitting keep
    // the panel open — every interaction restarts the countdown.
  }, [open, entry, busy, onClose]);

  useEffect(() => {
    if (!open) {
      reset();
      setMessage(null);
    }
  }, [open, reset]);

  if (!open) return null;

  if (signedIn) {
    return (
      <div className="k-panel" data-booth-panel="staff">
        <div className="k-panel-head">{STAFF_COPY.signInTitle}</div>
        <p className="k-panel-line">{STAFF_COPY.signInOk}</p>
        <div className="k-panel-row">
          <button
            type="button"
            className="k-panel-btn"
            onClick={() => {
              void booth.signOut().then(onChanged).catch(onChanged);
              onClose();
            }}
          >
            {STAFF_COPY.signOut}
          </button>
          <button type="button" className="k-panel-btn" onClick={onClose}>
            {STAFF_COPY.cancel}
          </button>
        </div>
      </div>
    );
  }

  const keypad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'];

  return (
    <div className="k-panel" data-booth-panel="staff">
      <div className="k-panel-head">{STAFF_COPY.signInTitle}</div>
      <p className="k-panel-line">{STAFF_COPY.signInHint}</p>

      {/* The entry is shown as dots and never as characters: a booth screen
          faces a shopping centre, and a PIN in 40px type would be readable
          from the far side of it. */}
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
                submit(entry);
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
