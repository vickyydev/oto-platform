import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'wouter';
import { useOperator } from '@/auth/OperatorContext';
import { Button } from '@/components/ui/button';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { ApiError } from '@/api/client';
import { authApi } from '@/api/platform';
import {
  ScanFace,
  Lock,
  Camera,
  Loader2,
  Smartphone,
  Settings,
  Boxes,
  KeyRound,
  Phone as PhoneIcon,
  ShieldCheck,
  ArrowLeft,
} from 'lucide-react';

type Mode = 'signin' | 'setup' | 'reset';

/**
 * Lock screen — prototype design preserved. "Scan my face" stays as the
 * placeholder for later face auth (CLAUDE.md §6); beneath it sits the real
 * phone + password sign-in (SCRUM-19), with links into first-time setup
 * (SCRUM-20) and password recovery (SCRUM-23) in the same visual style.
 *
 * `adminMode` renders the same form as the ADMIN CONSOLE sign-in wall
 * (/admin): distinct title + restricted-area chip so staff can tell it apart
 * from the shift sign-in, and a "Back to POS sign-in" link instead of the
 * temp module links.
 */
export function LockScreen({ adminMode = false }: { adminMode?: boolean }) {
  const { signIn, locked, operator, unlock, logout } = useOperator();
  const [, navigate] = useLocation();

  const [mode, setMode] = useState<Mode>('signin');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [faceHint, setFaceHint] = useState(false);
  const afterSignIn = useRef<string | null>(null);

  useEffect(() => {
    setError(null);
    setNotice(null);
    setCodeSent(false);
    setCode('');
  }, [mode]);

  const doSignIn = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !phone.trim() || !password) return;
    setBusy(true);
    setError(null);
    try {
      await signIn(phone, password);
      if (afterSignIn.current) {
        navigate(afterSignIn.current);
        afterSignIn.current = null;
      }
    } catch (err) {
      if (err instanceof ApiError && err.code === 'SETUP_REQUIRED') {
        setMode('setup');
        setNotice('This account still needs its first-time setup.');
      } else {
        setError(err instanceof Error ? err.message : 'Sign-in failed');
      }
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async () => {
    if (busy || !phone.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'setup') await authApi.setupStart(phone);
      else await authApi.resetRequest(phone);
      setCodeSent(true);
      setNotice('Code sent by SMS. (Dev: it appears in the API console log.)');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not send the code');
    } finally {
      setBusy(false);
    }
  };

  const completeCodeFlow = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !phone.trim() || code.length !== 6 || password.length < 8) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'setup') await authApi.setupComplete(phone, code, password);
      else await authApi.resetComplete(phone, code, password);
      await signIn(phone, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete');
    } finally {
      setBusy(false);
    }
  };

  const showFaceHint = (destination?: string) => {
    afterSignIn.current = destination ?? null;
    setFaceHint(true);
    window.setTimeout(() => setFaceHint(false), 2600);
  };

  /**
   * Locked on inactivity (S2-01a): the shift is still signed in, so the only
   * thing asked for is the password — no phone, no re-selecting the branch,
   * no lost till. "Sign out" is the way to hand the till to someone else.
   */
  const doUnlock = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !password) return;
    setBusy(true);
    setError(null);
    try {
      await unlock(password);
      setPassword('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not unlock');
    } finally {
      setBusy(false);
    }
  };

  if (locked && operator) {
    return (
      <div className="h-[100dvh] w-full flex flex-col items-center justify-center bg-background text-foreground px-6 overflow-y-auto">
        <div className="w-full max-w-md flex flex-col items-center text-center animate-in fade-in zoom-in-95 duration-500 py-8">
          <div className="relative w-24 h-24 rounded-[2rem] bg-primary flex items-center justify-center text-primary-foreground mb-6 shadow-2xl shadow-primary/30">
            <Lock className="w-12 h-12" />
          </div>
          <h1 className="text-4xl font-black tracking-tight mb-2">Locked</h1>
          <p className="text-lg text-foreground/60 mb-8">
            {operator.name} is still signed in — enter your password to continue.
          </p>

          <form onSubmit={doUnlock} className="w-full flex flex-col gap-3 text-left">
            <label className="text-sm font-semibold text-foreground/60 flex items-center gap-2">
              <KeyRound className="w-4 h-4" /> Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              autoFocus
              className="w-full h-14 rounded-2xl border border-input bg-background px-4 text-lg focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button
              type="submit"
              size="lg"
              className="h-16 text-lg gap-3 rounded-2xl w-full mt-2"
              disabled={busy || !password}
            >
              {busy ? <Loader2 className="w-6 h-6 animate-spin" /> : <Lock className="w-6 h-6" />}
              {busy ? 'Unlocking…' : 'Unlock'}
            </Button>
          </form>

          <button
            type="button"
            onClick={logout}
            className="mt-8 inline-flex items-center justify-center gap-2 w-full h-12 rounded-2xl border border-dashed border-foreground/20 text-foreground/60 hover:text-foreground hover:border-foreground/40 transition-colors text-sm font-medium"
          >
            <ArrowLeft className="w-4 h-4" />
            Sign out and hand over the till
          </button>

          <div className="flex items-center gap-2 mt-10 text-foreground/30 text-sm">
            <Lock className="w-4 h-4" />
            The shift stays open while the till is locked
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-[100dvh] w-full flex flex-col items-center justify-center bg-background text-foreground px-6 overflow-y-auto">
      <div className="w-full max-w-md flex flex-col items-center text-center animate-in fade-in zoom-in-95 duration-500 py-8">
        <div className="relative w-24 h-24 rounded-[2rem] bg-primary flex items-center justify-center text-primary-foreground mb-6 shadow-2xl shadow-primary/30">
          {adminMode ? <Settings className="w-12 h-12" /> : <ScanFace className="w-12 h-12" />}
        </div>

        <h1 className="text-4xl font-black tracking-tight mb-2">
          {adminMode ? 'Admin Console' : 'Oto POS is locked'}
        </h1>
        {adminMode && (
          <span className="mb-3 inline-flex items-center gap-1.5 rounded-full border border-amber-500/40 bg-amber-400/10 px-3 py-1 text-xs font-semibold text-amber-600 dark:text-amber-300">
            <ShieldCheck className="w-3.5 h-3.5" />
            Restricted — manager sign-in only
          </span>
        )}
        <p className="text-lg text-foreground/60 mb-8">
          {mode === 'signin'
            ? adminMode
              ? 'Sign in with your manager account to open back-office settings.'
              : 'Sign in with your phone to start your shift.'
            : mode === 'setup'
              ? 'First shift? Set up your account.'
              : 'Reset your password.'}
        </p>

        {/* Face auth placeholder — real face sign-in ships with the branch agent. */}
        <Button
          size="lg"
          variant="secondary"
          className="h-14 px-10 text-lg gap-3 rounded-2xl w-full"
          onClick={() => showFaceHint()}
        >
          <Camera className="w-6 h-6" />
          Scan my face
        </Button>
        {faceHint && (
          <p className="mt-2 text-sm text-foreground/50 animate-in fade-in">
            Face sign-in is coming soon — use your phone and password below.
          </p>
        )}

        <div className="flex items-center gap-3 w-full my-6 text-foreground/30 text-xs font-semibold">
          <span className="flex-1 h-px bg-foreground/10" />
          OR
          <span className="flex-1 h-px bg-foreground/10" />
        </div>

        {mode === 'signin' && (
          <form onSubmit={doSignIn} className="w-full flex flex-col gap-3 text-left">
            <label className="text-sm font-semibold text-foreground/60 flex items-center gap-2">
              <PhoneIcon className="w-4 h-4" /> Phone number
            </label>
            <PhoneInput value={phone} onChange={setPhone} />
            <label className="text-sm font-semibold text-foreground/60 flex items-center gap-2 mt-1">
              <KeyRound className="w-4 h-4" /> Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              autoComplete="current-password"
              className="w-full h-14 rounded-2xl border border-input bg-background px-4 text-lg focus:outline-none focus:ring-2 focus:ring-ring"
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
            {notice && <p className="text-sm text-foreground/60">{notice}</p>}
            <Button
              type="submit"
              size="lg"
              className="h-16 text-lg gap-3 rounded-2xl w-full mt-2"
              disabled={busy || !phone.trim() || !password}
            >
              {busy ? <Loader2 className="w-6 h-6 animate-spin" /> : <Lock className="w-6 h-6" />}
              {busy ? 'Signing in…' : 'Sign in'}
            </Button>
            <div className="flex justify-between text-sm text-foreground/50 mt-1">
              <button type="button" className="hover:text-foreground" onClick={() => setMode('setup')}>
                First shift? Set up account
              </button>
              <button type="button" className="hover:text-foreground" onClick={() => setMode('reset')}>
                Forgot password?
              </button>
            </div>
          </form>
        )}

        {(mode === 'setup' || mode === 'reset') && (
          <form onSubmit={completeCodeFlow} className="w-full flex flex-col gap-3 text-left">
            <label className="text-sm font-semibold text-foreground/60 flex items-center gap-2">
              <PhoneIcon className="w-4 h-4" /> Phone number
            </label>
            <PhoneInput value={phone} onChange={setPhone} />
            {!codeSent ? (
              <Button
                type="button"
                size="lg"
                className="h-14 text-lg rounded-2xl w-full mt-1"
                onClick={sendCode}
                disabled={busy || !phone.trim()}
              >
                {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : 'Send code'}
              </Button>
            ) : (
              <>
                <label className="text-sm font-semibold text-foreground/60 mt-1">6-digit code</label>
                <input
                  inputMode="numeric"
                  maxLength={6}
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  placeholder="123456"
                  className="w-full h-14 rounded-2xl border border-input bg-background px-4 text-lg tracking-[0.4em] text-center focus:outline-none focus:ring-2 focus:ring-ring"
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
                  className="w-full h-14 rounded-2xl border border-input bg-background px-4 text-lg focus:outline-none focus:ring-2 focus:ring-ring"
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
            {error && <p className="text-sm text-destructive">{error}</p>}
            {notice && <p className="text-sm text-foreground/60">{notice}</p>}
            <button
              type="button"
              className="text-sm text-foreground/50 hover:text-foreground mt-1 self-center"
              onClick={() => setMode('signin')}
            >
              Back to sign in
            </button>
          </form>
        )}

        {adminMode ? (
          /* Escape hatch for staff who landed here by accident — back to the
             regular shift sign-in without editing the URL. */
          <Link
            href="/"
            className="mt-8 inline-flex items-center justify-center gap-2 w-full h-12 rounded-2xl border border-dashed border-foreground/20 text-foreground/60 hover:text-foreground hover:border-foreground/40 transition-colors text-sm font-medium"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to POS sign-in
          </Link>
        ) : (
          <>
            <Link
              href="/book"
              className="mt-8 inline-flex items-center justify-center gap-2 w-full h-12 rounded-2xl border border-dashed border-foreground/20 text-foreground/60 hover:text-foreground hover:border-foreground/40 transition-colors text-sm font-medium"
            >
              <Smartphone className="w-4 h-4" />
              Open customer booking site (temp)
            </Link>

            {/* Admin console entry — /admin has its own auth wall (AdminAccessGate):
                it asks for sign-in and admits manager-role operators only. */}
            <Link
              href="/admin"
              className="mt-3 inline-flex items-center justify-center gap-2 w-full h-12 rounded-2xl border border-dashed border-foreground/20 text-foreground/60 hover:text-foreground hover:border-foreground/40 transition-colors text-sm font-medium"
            >
              <Settings className="w-4 h-4" />
              Open admin console (manager sign-in)
            </Link>

            {/* Staff stock module — reached from here instead of the POS bottom nav.
                Signing in below lands on /stock. */}
            <button
              type="button"
              onClick={() => showFaceHint('/stock')}
              className="mt-3 inline-flex items-center justify-center gap-2 w-full h-12 rounded-2xl border border-dashed border-foreground/20 text-foreground/60 hover:text-foreground hover:border-foreground/40 transition-colors text-sm font-medium"
            >
              <Boxes className="w-4 h-4" />
              Open stock module (temp)
            </button>
          </>
        )}

        <div className="flex items-center gap-2 mt-10 text-foreground/30 text-sm">
          <Lock className="w-4 h-4" />
          Locks automatically after inactivity
        </div>
      </div>
    </div>
  );
}
