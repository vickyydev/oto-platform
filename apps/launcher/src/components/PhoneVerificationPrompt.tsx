import { useEffect, useRef, useState, type ReactNode } from 'react';
import { authApi } from '@/api/platform';
import { useSession } from '@/auth/SessionContext';
import { Button } from '@/components/ui/button';

const DISMISSAL = 'oto:phone-verification:deferred';

function wasDeferred(key: string) {
  try { return sessionStorage.getItem(DISMISSAL) === key; }
  catch { return false; }
}

function VerificationDialog({ phone, onLater, onVerified }: {
  phone: string;
  onLater: () => void;
  onVerified: () => Promise<void>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const el = dialog.current;
    if (el && !el.open) el.showModal();
    return () => el?.close();
  }, []);

  async function submit(send: boolean) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      if (send) {
        await authApi.requestPhoneVerification();
        setSent(true);
        setCode('');
      } else {
        await authApi.confirmPhoneVerification(code);
        await onVerified();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Please try again.');
    } finally { setBusy(false); }
  }

  return (
    <dialog ref={dialog} aria-labelledby="verify-phone-title"
      onCancel={e => { e.preventDefault(); if (!busy) onLater(); }}
      className="m-auto w-[min(92vw,26rem)] rounded-2xl border bg-background p-6 text-foreground shadow-xl backdrop:bg-black/40">
      <h1 id="verify-phone-title" className="text-xl font-bold">Verify your phone number</h1>
      <p className="my-3 text-sm">{sent
        ? `Enter the six-digit code sent to your number ending in ${phone.slice(-4)}.`
        : `Your registered number ending in ${phone.slice(-4)} is unverified. Confirm it by text, or do this on your next sign-in.`}</p>
      <form onSubmit={e => { e.preventDefault(); void submit(!sent); }}>
        {sent && <label className="block text-sm">6-digit code
          <input autoFocus inputMode="numeric" autoComplete="one-time-code" maxLength={6}
            value={code} onChange={e => setCode(e.target.value.replace(/\D/g, ''))}
            className="mt-2 w-full rounded-xl border bg-background p-3 text-lg" />
        </label>}
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        <div className="mt-5 flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || (sent && code.length !== 6)}>
            {busy ? 'Please wait…' : sent ? 'Confirm code' : 'Verify now'}
          </Button>
          <Button type="button" variant="outline" disabled={busy} onClick={onLater}>Do it later</Button>
        </div>
        {sent && <button type="button" disabled={busy} onClick={() => void submit(true)} className="mt-4 text-sm underline">Send another code</button>}
      </form>
    </dialog>
  );
}

export function PhoneVerificationPrompt({ children }: { children: ReactNode }) {
  const { state, me, locked, refresh } = useSession();
  const [dismissed, setDismissed] = useState('');
  const key = me?.phoneVerificationReminder;
  if (!key || !me || state !== 'signed-in' || locked || me.account.mustChangePassword || me.impersonation ||
      key === dismissed || wasDeferred(key)) return <>{children}</>;
  return <VerificationDialog key={key} phone={me.account.phone} onVerified={refresh} onLater={() => {
    try { sessionStorage.setItem(DISMISSAL, key); } catch { /* Keep this login's in-memory choice. */ }
    setDismissed(key);
  }} />;
}
