import { useState, type FormEvent, type ReactNode } from 'react';
import { KeyRound, Loader2, Lock, LogIn, MessagesSquare, ShieldOff } from 'lucide-react';
import { useSession } from '@/auth/SessionContext';
import { Eyebrow } from '@/components/atoms';

const LAUNCHER_URL = import.meta.env.VITE_LAUNCHER_URL?.trim();

const FIELD =
  'w-full rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-3.5 py-2.5 text-[14px] placeholder:text-slate-400 focus:border-slate-300 dark:focus:border-slate-500 focus:outline-none focus:ring-2 focus:ring-slate-200 dark:focus:ring-slate-600';
const PRIMARY =
  'inline-flex w-full items-center justify-center gap-2 rounded-xl bg-slate-900 px-4 py-2.5 text-[14px] font-medium text-white hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-white disabled:opacity-60';
const SECONDARY =
  'inline-flex items-center justify-center rounded-xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 px-4 py-2 text-[13px] font-medium text-slate-700 dark:text-slate-200 hover:bg-slate-50 dark:hover:bg-slate-800';

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-6 shadow-[0_12px_40px_-16px_rgba(15,23,42,0.18)] sm:p-8">
        {children}
      </div>
    </div>
  );
}

export function Splash() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center text-slate-400">
      <Loader2 className="h-5 w-5 animate-spin" />
    </div>
  );
}

/**
 * Signing in to the Inbox directly, for the person who opened its address
 * cold rather than through the launcher's tile — the Console's panel
 * (apps/console/src/components/SignInPanel.tsx), in the Inbox's own look.
 * Phone and password only: a first password and a forgotten one are the
 * launcher's and the till's.
 */
export function SignInPanel() {
  const { signIn, handoffError } = useSession();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !phone.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(phone.trim(), password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sign-in failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500 dark:text-slate-400">
        <MessagesSquare className="h-3.5 w-3.5" />
        Unified Customer Inbox
      </div>
      <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">Sign in</h1>
      <p className="mt-1 mb-5 text-[13px] text-slate-500 dark:text-slate-400">Every message from a family in one place, routed to the right team.</p>

      {/* A refused hand-off from the launcher: why this screen appeared at all. */}
      {handoffError && (
        <p className="mb-4 rounded-xl border border-dashed border-slate-300 dark:border-slate-600 px-3 py-2 text-[13px] text-slate-600 dark:text-slate-300">{handoffError}</p>
      )}

      <form onSubmit={submit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <Eyebrow>Phone number</Eyebrow>
          <input
            type="tel"
            inputMode="tel"
            autoComplete="username"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="090 000 0001"
            className={FIELD}
          />
        </label>
        <label className="flex flex-col gap-1">
          <Eyebrow>Password</Eyebrow>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            className={FIELD}
          />
        </label>
        {error && <p className="text-[13px] text-rose-600 dark:text-rose-400">{error}</p>}
        <button type="submit" className={`${PRIMARY} mt-1`} disabled={busy || !phone.trim() || !password}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <LogIn className="h-4 w-4" />}
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="mt-4 text-[12.5px] text-slate-500 dark:text-slate-400">
        {LAUNCHER_URL ? (
          <>
            First shift, or a forgotten password?{' '}
            <a href={LAUNCHER_URL} className="font-medium text-slate-700 dark:text-slate-200 hover:underline">
              Start at the suite front door
            </a>
            .
          </>
        ) : (
          'First shift, or a forgotten password? Set it from the suite front door or the till, then come back here.'
        )}
      </p>
    </Card>
  );
}

/** The shared session was locked by another app: the password re-opens it here. */
export function LockedPanel() {
  const { unlock, signOut } = useSession();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      await unlock(password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unlock failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-400">
        <Lock className="h-5 w-5" />
      </span>
      <h1 className="mt-3 text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">This session is locked</h1>
      <p className="mt-1 mb-5 text-[13px] text-slate-500 dark:text-slate-400">
        It locked after a quiet spell on another app. Your password opens it again, here and there.
      </p>
      <form onSubmit={submit} className="flex flex-col gap-3">
        <input
          type="password"
          autoComplete="current-password"
          aria-label="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          className={FIELD}
        />
        {error && <p className="text-[13px] text-rose-600 dark:text-rose-400">{error}</p>}
        <button type="submit" className={PRIMARY} disabled={busy || !password}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
          Unlock
        </button>
        <button type="button" className={SECONDARY} onClick={() => void signOut()}>
          Sign out
        </button>
      </form>
    </Card>
  );
}

/** Signed in, but owing a password change or without `app:inbox:access`. */
export function BlockedPanel({ reason }: { reason: 'must-change-password' | 'no-access' }) {
  const { signOut } = useSession();
  const changing = reason === 'must-change-password';
  return (
    <Card>
      <span className="flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-300">
        {changing ? <KeyRound className="h-5 w-5" /> : <ShieldOff className="h-5 w-5" />}
      </span>
      <h1 className="mt-3 text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">
        {changing ? 'Choose a password first' : 'The inbox is not on your access'}
      </h1>
      <p className="mt-1 text-[13px] text-slate-500 dark:text-slate-400">
        {changing ? (
          'This account is on a temporary password. The inbox stays closed until it is changed.'
        ) : (
          <>
            Opening the inbox needs <code className="font-mono text-[12px]">app:inbox:access</code>. A manager grants it
            from the Login Users panel.
          </>
        )}
      </p>
      <div className="mt-6 flex flex-col gap-2 sm:flex-row">
        {LAUNCHER_URL && (
          <a href={LAUNCHER_URL} className={`${SECONDARY} flex-1`}>
            {changing ? 'Change it on the suite front door' : 'Back to the suite'}
          </a>
        )}
        <button type="button" className={`${SECONDARY} flex-1`} onClick={() => void signOut()}>
          Sign out
        </button>
      </div>
    </Card>
  );
}
