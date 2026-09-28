import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { booth } from '../booth/client';
import {
  BoothCallError,
  type BoothStaffChoice,
  type BoothStaffOnDuty,
  type StaffSignInResponse,
} from '../booth/contract';
import { STAFF_COPY } from '../copy';
import { isButtonKey, registerButtonOverlay } from '../press';
import { backoffFor, secondsLeft } from '../staff-backoff';

interface Props {
  open: boolean;
  signedIn: boolean;
  staff?: BoothStaffOnDuty | null;
  onClose: () => void;
  onChanged: () => void;
  onChangeBooth?: () => void;
  seed?: string | null;
  buttonKey: string;
}
type View = 'pick' | 'pin' | 'account' | 'menu';

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
  const [view, setView] = useState<View>('pick');
  const [people, setPeople] = useState<BoothStaffChoice[]>([]);
  const [picked, setPicked] = useState<BoothStaffChoice | null>(null);
  const [loading, setLoading] = useState(false);
  const [entry, setEntry] = useState('');
  const entryRef = useRef('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [failures, setFailures] = useState(0);
  const [lockedUntil, setLockedUntil] = useState(0);
  const [now, setNow] = useState(Date.now);
  const [message, setMessage] = useState<string | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const phoneField = useRef<HTMLInputElement>(null);
  const passwordField = useRef<HTMLInputElement>(null);
  const lastActivity = useRef(Date.now());
  const openedAt = useRef(Date.now());
  const locked = lockedUntil > now;
  const touch = useCallback(() => {
    lastActivity.current = Date.now();
  }, []);
  const changeEntry = useCallback((value: string) => {
    entryRef.current = value;
    setEntry(value);
  }, []);

  useEffect(() => {
    changeEntry(open && !signedIn ? (seed ?? '') : '');
    setPassword('');
    setPhone('');
    setPicked(null);
    setMessage(null);
    setView(signedIn ? 'menu' : seed ? 'pin' : 'pick');
    if (!open) return;
    openedAt.current = Date.now();
    touch();
    let cancelled = false;
    setLoading(true);
    void booth
      .getStaff()
      .then(({ staff: list }) => {
        if (!cancelled) setPeople(list);
      })
      .catch(() => {
        if (!cancelled) setMessage(STAFF_COPY.staffUnavailable);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, signedIn, seed, changeEntry, touch]);

  useEffect(() => {
    if (!open) return;
    const timer = setInterval(() => {
      const at = Date.now();
      setNow(at);
      const idle = view === 'pick' ? 30_000 : 45_000;
      if (
        !busyRef.current &&
        (at - lastActivity.current >= idle ||
          (view === 'account' && at - openedAt.current >= 120_000))
      )
        onClose();
    }, 250);
    return () => clearInterval(timer);
  }, [open, view, onClose]);

  useEffect(() => {
    if (!open) return;
    touch();
    if (view === 'account') phoneField.current?.focus();
    else
      panel.current
        ?.querySelector<HTMLButtonElement>('button[data-button-choice]:not(:disabled)')
        ?.focus();
    return registerButtonOverlay({
      touch,
      move: () => {
        const choices = [
          ...(panel.current?.querySelectorAll<HTMLButtonElement>(
            'button[data-button-choice]:not(:disabled)',
          ) ?? []),
        ];
        const index = choices.findIndex((button) => button === document.activeElement);
        choices[(index + 1) % choices.length]?.focus();
      },
      select: () => {
        const focused = document.activeElement;
        if (
          focused instanceof HTMLButtonElement &&
          panel.current?.contains(focused) &&
          !focused.disabled
        )
          focused.click();
      },
    });
  }, [open, view, loading, busy, locked, touch]);

  const settle = useCallback(
    (result: StaffSignInResponse) => {
      if (result.ok) {
        setFailures(0);
        setLockedUntil(0);
        onChanged();
        onClose();
        return;
      }
      const guess =
        result.reason === undefined || result.reason === 'wrong' || result.reason === 'locked';
      const next = failures + (guess ? 1 : 0);
      setFailures(next);
      const wait = Math.max(guess ? backoffFor(next) : 0, result.retryAfterMs ?? 0);
      if (wait > 0) {
        setNow(Date.now());
        setLockedUntil(Date.now() + wait);
      }
      const lines: Partial<Record<NonNullable<StaffSignInResponse['reason']>, string>> = {
        offline: STAFF_COPY.offline,
        not_assigned: STAFF_COPY.notAssigned,
        not_allowed: STAFF_COPY.notAllowed,
        must_change_password: STAFF_COPY.mustChange,
        box_refused: STAFF_COPY.boxRefused,
        booth_not_on_box: STAFF_COPY.boothNotOnBox,
      };
      setMessage(
        result.reason ? (lines[result.reason] ?? STAFF_COPY.signInWrong) : STAFF_COPY.signInWrong,
      );
    },
    [failures, onChanged, onClose],
  );

  const submitPin = useCallback(
    (value: string) => {
      if (!/^\d{5}$/.test(value) || busyRef.current || Date.now() < lockedUntil) return;
      busyRef.current = true;
      setBusy(true);
      setMessage(STAFF_COPY.working);
      changeEntry('');
      void booth
        .signIn({ mode: 'pin', pin: value, ...(picked ? { accountId: picked.accountId } : {}) })
        .then(settle)
        .catch(() => setMessage(STAFF_COPY.staffUnavailable))
        .finally(() => {
          busyRef.current = false;
          setBusy(false);
          touch();
        });
    },
    [lockedUntil, picked, settle, changeEntry, touch],
  );

  const digit = useCallback(
    (value: string) => {
      if (busyRef.current || Date.now() < lockedUntil) return;
      touch();
      const next =
        value === 'delete' ? entryRef.current.slice(0, -1) : (entryRef.current + value).slice(0, 5);
      changeEntry(next);
      if (next.length === 5) submitPin(next);
    },
    [lockedUntil, touch, changeEntry, submitPin],
  );

  const submitAccount = (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current || locked || !phone.trim() || !password) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(STAFF_COPY.working);
    const typed = { phone: phone.trim(), password };
    setPassword('');
    void booth
      .signIn({ mode: 'account', ...typed })
      .then(settle)
      .catch(() => setMessage(STAFF_COPY.offline))
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
        touch();
        setTimeout(() => passwordField.current?.focus(), 0);
      });
  };

  useEffect(() => {
    if (!open) return;
    const key = (event: KeyboardEvent) => {
      if (!isButtonKey(event, buttonKey)) touch();
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (signedIn || view === 'account' || view === 'menu') return;
      if (/^\d$/.test(event.key)) {
        event.preventDefault();
        event.stopPropagation();
        if (view !== 'pin') {
          setPicked(null);
          setView('pin');
        }
        digit(event.key);
      } else if (view === 'pin' && event.key === 'Backspace') {
        event.preventDefault();
        event.stopPropagation();
        digit('delete');
      }
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [open, signedIn, view, digit, onClose, buttonKey, touch]);

  const reprint = () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setMessage(STAFF_COPY.reprinting);
    void booth
      .reprint({})
      .then((result) =>
        setMessage(
          result.printState === 'printed'
            ? STAFF_COPY.reprinted
            : result.printState === 'no_printer'
              ? STAFF_COPY.reprintNoPrinter
              : STAFF_COPY.reprintQueued,
        ),
      )
      .catch((error: unknown) =>
        setMessage(
          error instanceof BoothCallError && error.code === 'nothing_to_reprint'
            ? STAFF_COPY.nothingToReprint
            : STAFF_COPY.reprintFailed,
        ),
      )
      .finally(() => {
        busyRef.current = false;
        setBusy(false);
        touch();
      });
  };

  if (!open) return null;
  const who = staff
    ? [staff.name, staff.code ? `(${staff.code})` : null].filter(Boolean).join(' ')
    : '';
  const until = staff?.expiresAt ? formatTime(staff.expiresAt) : null;
  return (
    <div ref={panel} className="k-panel" data-booth-panel="staff" onPointerDown={touch}>
      <div className="k-panel-head">{STAFF_COPY.signInTitle}</div>
      <p className="k-panel-line">{STAFF_COPY.buttonHint}</p>
      {view === 'menu' ? (
        <>
          {signedIn && (
            <p className="k-panel-line" data-booth-staff-name="1">
              {who ? STAFF_COPY.signedInAs(who) : STAFF_COPY.signInOk}
            </p>
          )}
          {signedIn && until && <p className="k-panel-line">{STAFF_COPY.until(until)}</p>}
          <div className="k-panel-stack">
            <button
              data-button-choice
              type="button"
              className="k-panel-btn k-panel-btn--wide"
              disabled={busy || !signedIn}
              onClick={reprint}
              data-booth-action="reprint"
            >
              {STAFF_COPY.reprint}
            </button>
            {onChangeBooth && (
              <button
                data-button-choice
                type="button"
                className="k-panel-btn k-panel-btn--wide"
                onClick={() => {
                  onClose();
                  onChangeBooth();
                }}
              >
                {STAFF_COPY.changeBooth}
              </button>
            )}
            <button
              data-button-choice
              type="button"
              className="k-panel-btn k-panel-btn--wide"
              disabled={busy || !signedIn}
              onClick={() => {
                busyRef.current = true;
                setBusy(true);
                void booth
                  .signOut()
                  .then(() => {
                    onChanged();
                    onClose();
                  })
                  .catch(() => setMessage(STAFF_COPY.staffUnavailable))
                  .finally(() => {
                    busyRef.current = false;
                    setBusy(false);
                  });
              }}
            >
              {STAFF_COPY.signOut}
            </button>
            <button
              data-button-choice
              type="button"
              className="k-panel-btn k-panel-btn--wide"
              onClick={onClose}
            >
              {STAFF_COPY.cancel}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="k-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={view !== 'account'}
              className={view !== 'account' ? 'k-tab k-tab--on' : 'k-tab'}
              onClick={() => {
                setView('pick');
                changeEntry('');
              }}
            >
              {STAFF_COPY.usePin}
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={view === 'account'}
              className={view === 'account' ? 'k-tab k-tab--on' : 'k-tab'}
              onClick={() => setView('account')}
              data-booth-tab="account"
            >
              {STAFF_COPY.useAccount}
            </button>
          </div>
          {view === 'pick' ? (
            <>
              <p className="k-panel-line">{loading ? STAFF_COPY.working : STAFF_COPY.pickStaff}</p>
              {!loading && people.length === 0 && (
                <p className="k-panel-line">{STAFF_COPY.noStaff}</p>
              )}
              <div className="k-panel-stack k-staff-list">
                {people.map((person) => (
                  <button
                    data-button-choice
                    type="button"
                    key={person.accountId}
                    className="k-panel-btn k-panel-btn--wide"
                    onClick={() => {
                      if (!person.hasPin) {
                        setMessage(STAFF_COPY.noPin);
                        return;
                      }
                      setPicked(person);
                      changeEntry('');
                      setMessage(null);
                      setView('pin');
                    }}
                  >
                    {[person.name, person.code].filter(Boolean).join(' · ') ||
                      STAFF_COPY.unnamedStaff}
                  </button>
                ))}
                <button
                  data-button-choice
                  type="button"
                  className="k-panel-btn k-panel-btn--wide"
                  onClick={() => setView('menu')}
                >
                  {STAFF_COPY.more}
                </button>
              </div>
            </>
          ) : view === 'pin' ? (
            <>
              <p className="k-panel-line">
                {picked?.name ?? picked?.code ?? STAFF_COPY.signInHint}
              </p>
              <p className="k-panel-line">{STAFF_COPY.fiveDigits}</p>
              <div className="k-pin" aria-hidden>
                {entry ? '•'.repeat(entry.length) : <span className="k-pin-empty">·</span>}
              </div>
              <div className="k-keypad">
                {['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'delete'].map((value) => (
                  <button
                    data-button-choice
                    type="button"
                    key={value}
                    className="k-key"
                    disabled={busy || locked}
                    onClick={() => digit(value)}
                    aria-label={value === 'delete' ? STAFF_COPY.deleteDigit : value}
                  >
                    {value === 'delete' ? '⌫' : value}
                  </button>
                ))}
              </div>
              <button
                data-button-choice
                type="button"
                className="k-panel-btn"
                onClick={() => {
                  changeEntry('');
                  setView('pick');
                }}
              >
                {STAFF_COPY.backToStaff}
              </button>
              <button data-button-choice type="button" className="k-panel-btn" onClick={onClose}>
                {STAFF_COPY.cancel}
              </button>
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
                  data-button-choice
                  type="submit"
                  className="k-panel-btn"
                  disabled={busy || locked || !phone.trim() || !password}
                >
                  {STAFF_COPY.signInButton}
                </button>
                <button data-button-choice type="button" className="k-panel-btn" onClick={onClose}>
                  {STAFF_COPY.cancel}
                </button>
              </div>
            </form>
          )}
        </>
      )}
      {locked && (
        <p className="k-panel-warn">{STAFF_COPY.signInLocked(secondsLeft(lockedUntil, now))}</p>
      )}
      {!locked && message && (
        <p className="k-panel-warn" role="status">
          {message}
        </p>
      )}
    </div>
  );
}

function formatTime(iso: string): string | null {
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? null
    : new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' }).format(at);
}
