import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { kiosk, type KioskBooth } from '../booth/kiosk';
import { COPY, KIOSK_COPY } from '../copy';
import OtoWordmark from './OtoWordmark';

/**
 * The screens a booth BOX shows before it has a wheel (SCRUM-223).
 *
 * They are the booth's "not set up" screen with a staff panel on it, in the
 * same classes the pairing prompt uses (`k-panel`, `k-panel--center`), so a
 * Pi at first boot looks like the booth it is about to become rather than
 * like an error page. Nothing on them names the park or the service (D15);
 * the booth names on the picker are what staff chose in the Console.
 */

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="k-body k-body--center">
      <OtoWordmark height={56} />
      <div className="k-setup">
        <p className="k-setup-line">{KIOSK_COPY.guest.en}</p>
        <p className="k-setup-line k-th">{KIOSK_COPY.guest.th}</p>
      </div>
      {children}
      <p className="k-terms">{COPY.terms.en}</p>
    </div>
  );
}

/**
 * "Enter the claim code" — a box nobody has claimed yet.
 *
 * The code is the one Console → Devices → Add a box shows, read off and typed
 * here with a keyboard (it has letters, so it is a field, not the number pad).
 * The box redeems it with the cloud once; the code is never shown back or
 * kept by the page.
 */
export function ClaimScreen({ onClaimed }: { onClaimed: () => void }) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const field = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    field.current?.focus();
  }, []);

  const submit = useCallback(
    (event?: FormEvent) => {
      event?.preventDefault();
      const typed = code.replace(/\s+/g, '').toUpperCase();
      if (busy) return;
      if (!/^[A-Z0-9-]{6,64}$/.test(typed)) {
        setMessage(KIOSK_COPY.claimInvalid);
        return;
      }
      setBusy(true);
      setMessage(KIOSK_COPY.claimWorking);
      void kiosk
        .claim(typed)
        .then((outcome) => {
          if (outcome.ok) {
            setMessage(null);
            onClaimed();
            return;
          }
          setMessage(
            outcome.reason === 'unreachable'
              ? KIOSK_COPY.claimUnreachable
              : outcome.reason === 'invalid'
                ? KIOSK_COPY.claimInvalid
                : outcome.reason === 'already_registered'
                  ? null
                  : KIOSK_COPY.claimRefused,
          );
          if (outcome.reason === 'already_registered') onClaimed();
        })
        .catch(() => setMessage(KIOSK_COPY.claimUnreachable))
        .finally(() => {
          setBusy(false);
          setCode('');
        });
    },
    [busy, code, onClaimed],
  );

  return (
    <Frame>
      <form className="k-panel k-panel--center" data-booth-panel="claim" onSubmit={submit} autoComplete="off">
        <div className="k-panel-head">{KIOSK_COPY.claimTitle}</div>
        <p className="k-panel-line">{KIOSK_COPY.claimHint}</p>
        <label className="k-field">
          <input
            ref={field}
            name="claim-code"
            className="k-code-field"
            value={code}
            maxLength={64}
            placeholder="XXXXX-XXXXX"
            disabled={busy}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
          />
        </label>
        {message !== null && <p className="k-panel-warn">{message}</p>}
        <div className="k-panel-row">
          <button type="submit" className="k-panel-btn" disabled={busy || code.trim() === ''}>
            {KIOSK_COPY.claimButton}
          </button>
        </div>
      </form>
    </Frame>
  );
}

/**
 * "Which booth is this?" — a box with more than one booth station.
 *
 * The choice is kept on the box, not in this browser, so a Chromium profile
 * that gets wiped does not lose it and the box's heartbeat speaks for the
 * right booth before the television has even loaded. A number key picks the
 * booth with that number, for a booth that has only a number pad.
 */
export function BoothPicker({
  booths,
  current,
  onChosen,
}: {
  booths: KioskBooth[];
  current: string | null;
  onChosen: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const choose = useCallback(
    (stationId: string) => {
      if (busy) return;
      setBusy(true);
      setFailed(false);
      void kiosk
        .chooseBooth(stationId)
        .then(() => onChosen())
        .catch(() => setFailed(true))
        .finally(() => setBusy(false));
    },
    [busy, onChosen],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const n = Number.parseInt(event.key, 10);
      if (!Number.isInteger(n) || n < 1 || n > booths.length) return;
      event.preventDefault();
      event.stopPropagation();
      choose(booths[n - 1]!.stationId);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [booths, choose]);

  return (
    <Frame>
      <div className="k-panel k-panel--center" data-booth-panel="pick">
        <div className="k-panel-head">{KIOSK_COPY.pickTitle}</div>
        <p className="k-panel-line">{KIOSK_COPY.pickHint}</p>
        <div className="k-panel-stack">
          {booths.map((b, i) => (
            <button
              key={b.stationId}
              type="button"
              className={b.stationId === current ? 'k-panel-btn k-panel-btn--wide k-panel-btn--on' : 'k-panel-btn k-panel-btn--wide'}
              disabled={busy}
              onClick={() => choose(b.stationId)}
              data-booth-choice={b.stationId}
            >
              {i + 1}. {b.name}
              {b.codePrefix ? ` · ${b.codePrefix}` : ''}
            </button>
          ))}
        </div>
        {failed && <p className="k-panel-warn">{KIOSK_COPY.claimUnreachable}</p>}
      </div>
    </Frame>
  );
}

/** A registered box with no booth station on it yet: the fix is in the Console. */
export function NoBoothScreen() {
  return (
    <Frame>
      <div className="k-panel k-panel--center" data-booth-panel="nobooth">
        <div className="k-panel-head">{KIOSK_COPY.noBoothTitle}</div>
        <p className="k-panel-line">{KIOSK_COPY.noBoothHint}</p>
      </div>
    </Frame>
  );
}

/** Before the box has answered at all — the first second after boot. */
export function KioskStarting() {
  return (
    <Frame>
      <p className="k-panel-line">{KIOSK_COPY.starting}</p>
    </Frame>
  );
}
