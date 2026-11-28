import { useState, type FormEvent } from 'react';
import { KeyRound, Loader2, LogIn, Phone as PhoneIcon, type LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/api/client';
import { authApi } from '@/api/platform';
import { useSession } from '@/auth/SessionContext';

type Mode = 'signin' | 'setup' | 'reset';
type RecoveryStep = 'phone' | 'requested' | 'code';

const FIELD =
  'w-full h-14 rounded-2xl border border-input bg-background px-4 text-lg focus:outline-none focus:ring-2 focus:ring-ring';

function FieldLabel({ icon: Icon, children }: { icon: LucideIcon; children: string }) {
  return (
    <label className="text-sm font-semibold text-foreground/60 flex items-center gap-2">
      <Icon className="w-4 h-4" /> {children}
    </label>
  );
}

/**
 * Phone entry. The API normalises to E.164 with Thailand as the default
 * region, so a number typed the way staff say it — 090 000 0001 — reaches the
 * same row as +66900000001. Rather than carry a second copy of the country
 * list, the field says what it accepts and lets the server be the authority on
 * what a number means.
 */
function PhoneField({ value, onChange, disabled }: { value: string; onChange: (next: string) => void; disabled?: boolean }) {
  return (
    <>
      <FieldLabel icon={PhoneIcon}>Phone number</FieldLabel>
      <input
        type="tel"
        inputMode="tel"
        autoComplete="username"
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder="090 000 0001"
        className={FIELD}
      />
      <p className="-mt-1 text-xs text-foreground/50">
        Thai numbers can be typed as 090…; for any other country start with + and its code.
      </p>
    </>
  );
}

/**
 * Sign-in for the whole suite, in the till's lock-screen language: the same
 * rounded field, the same tall primary button, the same two ways out of it
 * (first shift, forgotten password). One sign-in here opens every app.
 */
export function SignInPanel() {
  const { signIn } = useSession();
  const [mode, setMode] = useState<Mode>('signin');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<RecoveryStep>('phone');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  function changeMode(next: Mode) {
    setMode(next);
    setPassword('');
    setCode('');
    setError(null);
    setStep('phone');
  }

  function editRecoveryPhone(next: string) {
    setPhone(next);
    setStep('phone');
    setCode('');
    setPassword('');
    setError(null);
  }

  const doSignIn = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !phone.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(phone.trim(), password);
    } catch (err) {
      // SCRUM-251: sign-in no longer says which phones belong to invited staff,
      // so there is no SETUP_REQUIRED to route on. A new starter reaches setup
      // through the button under the form; the error names it.
      setError(
        err instanceof ApiError && err.code === 'INVALID_CREDENTIALS'
          ? `${err.message} First shift? Use "Set up account" below.`
          : err instanceof Error
            ? err.message
            : 'Sign-in failed',
      );
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !phone.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'setup') await authApi.setupStart(phone.trim());
      else await authApi.resetRequest(phone.trim());
      // The public acknowledgement also covers requests that send no SMS.
      setStep('requested');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the code');
    } finally {
      setBusy(false);
    }
  };

  const completeCodeFlow = async (e?: FormEvent) => {
    e?.preventDefault();
    if (step !== 'code' || busy || !phone.trim() || code.length !== 6 || password.length < 8) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'setup') await authApi.setupComplete(phone.trim(), code, password);
      else await authApi.resetComplete(phone.trim(), code, password);
      await signIn(phone.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full rounded-[1.75rem] border bg-card/80 backdrop-blur-sm shadow-xl p-6 sm:p-8 text-left">
      <h2 className="text-2xl font-black tracking-tight">
        {mode === 'signin' ? 'Sign in' : mode === 'setup' ? 'Set up your account' : 'Reset your password'}
      </h2>
      <p className="mt-1 mb-6 text-sm text-foreground/60">
        {mode === 'signin'
          ? 'Your phone number and password open every app you have access to.'
          : mode === 'setup'
            ? 'First shift? Choose a password and confirm your phone.'
            : 'Request a reset code with your registered phone number.'}
      </p>

      {mode === 'signin' && (
        <form onSubmit={doSignIn} className="flex flex-col gap-3">
          <PhoneField value={phone} onChange={setPhone} />
          <FieldLabel icon={KeyRound}>Password</FieldLabel>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            className={FIELD}
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button
            type="submit"
            size="lg"
            className="h-16 text-lg gap-3 rounded-2xl w-full mt-2"
            disabled={busy || !phone.trim() || !password}
          >
            {busy ? <Loader2 className="w-6 h-6 animate-spin" /> : <LogIn className="w-6 h-6" />}
            {busy ? 'Signing in…' : 'Sign in'}
          </Button>
          <div className="flex flex-wrap justify-between gap-2 text-sm text-foreground/50 mt-1">
            <button type="button" disabled={busy} className="hover:text-foreground" onClick={() => changeMode('setup')}>
              First shift? Set up account
            </button>
            <button type="button" disabled={busy} className="hover:text-foreground" onClick={() => changeMode('reset')}>
              Forgot password?
            </button>
          </div>
        </form>
      )}

      {(mode === 'setup' || mode === 'reset') && (
        <form onSubmit={step === 'phone' ? sendCode : completeCodeFlow} className="flex flex-col gap-3">
          <PhoneField value={phone} onChange={editRecoveryPhone} disabled={busy} />
          {step === 'phone' && (
            <Button
              type="submit"
              size="lg"
              className="h-14 text-lg rounded-2xl w-full mt-1"
              disabled={busy || !phone.trim()}
            >
              {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Send code'}
            </Button>
          )}
          {step === 'requested' && (
            <>
              <p role="status" className="text-sm text-foreground/70">
                Check your text messages. Continue if you have a code for this request.
              </p>
              <Button type="button" size="lg" className="h-14 text-lg rounded-2xl w-full" disabled={busy}
                onClick={() => { setError(null); setStep('code'); }}>
                I received my code
              </Button>
              <details className="text-sm text-foreground/70">
                <summary className="cursor-pointer font-semibold">No code?</summary>
                <ul className="mt-2 list-disc space-y-1 pl-5">
                  <li>Check the number above. If it is missing from your staff account, ask your manager to add it.</li>
                  {mode === 'setup'
                    ? <li>If you already set up your account, sign in or use Forgot password.</li>
                    : <li>If your number needs confirmation, ask your manager for help confirming it.</li>}
                  <li>If your account is switched off, ask your manager to restore access.</li>
                </ul>
                <button type="button" disabled={busy} onClick={sendCode} className="mt-3 underline">
                  Request another code
                </button>
              </details>
            </>
          )}
          {step === 'code' && (
            <>
              <label className="text-sm font-semibold text-foreground/60 mt-1">6-digit code</label>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="123456"
                className={`${FIELD} tracking-[0.4em] text-center`}
              />
              <label className="text-sm font-semibold text-foreground/60 mt-1">
                {mode === 'setup' ? 'Choose a password' : 'New password'} (min 8 characters)
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                autoComplete="new-password"
                className={FIELD}
              />
              <Button
                type="submit"
                size="lg"
                className="h-16 text-lg rounded-2xl w-full mt-2"
                disabled={busy || code.length !== 6 || password.length < 8}
              >
                {busy ? (
                  <Loader2 className="w-6 h-6 animate-spin" />
                ) : mode === 'setup' ? (
                  'Complete setup & sign in'
                ) : (
                  'Reset password & sign in'
                )}
              </Button>
            </>
          )}
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <button
            type="button"
            className="text-sm text-foreground/50 hover:text-foreground mt-1 self-center"
            disabled={busy}
            onClick={() => changeMode('signin')}
          >
            Back to sign in
          </button>
        </form>
      )}
    </div>
  );
}
