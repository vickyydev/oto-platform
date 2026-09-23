import { useCallback, useEffect, useRef, useState } from 'react';
import { boothCredential } from '../booth/client';
import { BoothCallError } from '../booth/contract';
import { COPY, PAIR_COPY } from '../copy';
import OtoWordmark from './OtoWordmark';

/**
 * The screen a booth shows before anybody has paired it (SCRUM-244).
 *
 * **It is the booth's existing "not set up" screen with a way out.** The
 * unsynced state already says "Booth not set up, connect to internet" in the
 * same centred wordmark-and-line layout; this is that screen, plus the six
 * digits a member of staff reads off the Console. Nothing is restyled: the
 * panel, the entry field, the number pad and the button are the classes the
 * staff sign-in panel already uses (`k-panel`, `k-pin`, `k-keypad`, `k-key`,
 * `k-panel-btn`), because a booth with two visual languages is a booth
 * somebody has to be taught twice.
 *
 * **What a guest can see, and what they can do with it** (D15). The line is
 * bilingual and says a member of staff is needed — the same shape as every
 * other guest-facing line on this television. The digits are shown as dots
 * rather than characters, exactly as the PIN is, because a code in large type
 * on a screen facing a shopping centre is a code anybody can read from the far
 * side of it. Nothing on this panel names the booth, the branch or the
 * service.
 *
 * **It takes the keyboard in the capture phase**, like the sign-in panel, so a
 * member of staff typing a code cannot spin the wheel by reaching the digit
 * that happens to be the booth's button. The game is unreachable anyway in
 * this state, and the habit is the point: this panel and that one must not
 * disagree about who owns a keystroke.
 */

/** Six digits, and the pad is digits, so nothing longer can be typed. */
const CODE_LENGTH = 6;

export function PairScreen({ onPaired }: { onPaired: () => void }) {
  const [entry, setEntry] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  /** Refused codes in a row, so a mistyped one is not reported as a fault. */
  const failures = useRef(0);

  const submit = useCallback(
    (code: string) => {
      if (code.length !== CODE_LENGTH || busy) return;
      setBusy(true);
      setMessage(null);
      void boothCredential
        .redeem(code)
        .then(() => {
          failures.current = 0;
          onPaired();
        })
        .catch((error: unknown) => {
          failures.current += 1;
          /**
           * Two different failures, two different things to do about them, and
           * telling them apart is the whole value of this line: a booth in a
           * mall whose wifi has dropped shows "the booth service did not
           * answer" and somebody checks the network, while a wrong code shows
           * "that code was not accepted" and somebody mints another. Reporting
           * both as "wrong code" sends staff to re-read digits at a booth that
           * could not have accepted any of them.
           */
          const unreachable = error instanceof BoothCallError && error.code === 'unreachable';
          setMessage(unreachable ? PAIR_COPY.unreachable : PAIR_COPY.refused);
        })
        .finally(() => {
          setBusy(false);
          setEntry('');
        });
    },
    [busy, onPaired],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key;
      const isDigit = key.length === 1 && key >= '0' && key <= '9';
      if (!isDigit && key !== 'Backspace' && key !== 'Enter') return;
      event.preventDefault();
      event.stopPropagation();
      if (key === 'Backspace') {
        setEntry((current) => current.slice(0, -1));
        return;
      }
      if (key === 'Enter') {
        // A USB badge scanner ends its burst with Enter, which is exactly why
        // the booth button may never be Enter — here it is simply "submit",
        // and a six-digit entry is the only thing it can submit.
        setEntry((current) => {
          submit(current);
          return current;
        });
        return;
      }
      setEntry((current) => (current.length >= CODE_LENGTH ? current : current + key));
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [submit]);

  const keypad = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '⌫', '0', '✓'];

  return (
    <div className="k-body k-body--center">
      <OtoWordmark height={56} />
      <div className="k-setup">
        <p className="k-setup-line">{PAIR_COPY.guest.en}</p>
        <p className="k-setup-line k-th">{PAIR_COPY.guest.th}</p>
      </div>

      <div className="k-panel k-panel--center" data-booth-panel="pair">
        <div className="k-panel-head">{PAIR_COPY.title}</div>
        <p className="k-panel-line">{PAIR_COPY.hint}</p>

        {/* Dots, not digits — a pairing code in 18px type on a television
            faces a shopping centre, and the code is what pairs a screen. */}
        <div className="k-pin" aria-hidden>
          {entry === '' ? <span className="k-pin-empty">·</span> : '•'.repeat(entry.length)}
        </div>

        <div className="k-keypad">
          {keypad.map((label) => (
            <button
              key={label}
              type="button"
              className="k-key"
              disabled={busy}
              onClick={() => {
                if (label === '⌫') {
                  setEntry((current) => current.slice(0, -1));
                  return;
                }
                if (label === '✓') {
                  submit(entry);
                  return;
                }
                setEntry((current) =>
                  current.length >= CODE_LENGTH ? current : current + label,
                );
              }}
            >
              {label}
            </button>
          ))}
        </div>

        {message !== null && <p className="k-panel-warn">{message}</p>}
        {busy && <p className="k-panel-line">{PAIR_COPY.working}</p>}
      </div>

      {/* The terms line stays, so the screen reads as the booth it is rather
          than as an error page. */}
      <p className="k-terms">{COPY.terms.en}</p>
    </div>
  );
}
