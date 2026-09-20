import { useState, type FormEvent } from 'react';
import { KeyRound, Loader2, LogIn, Phone as PhoneIcon, type LucideIcon } from 'lucide-react';
import { Backdrop } from '@/components/Backdrop';
import { BrandMark } from '@/components/BrandMark';
import { Button } from '@/components/ui/button';
import { useSession } from '@/auth/SessionContext';
import { useTheme } from '@/lib/theme';
import { Moon, Sun } from 'lucide-react';

const LAUNCHER_URL = import.meta.env.VITE_LAUNCHER_URL?.trim();

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
 * Signing in to the console directly, for the person who opened its address
 * cold rather than through a tile.
 *
 * Phone and password only. Setting a first password and resetting a forgotten
 * one both need a code sent to a phone, and both already exist on the launcher
 * and the till — a third copy here would be a third place a change to that flow
 * has to land, on the one app nobody's first shift starts at.
 */
export function SignInPanel() {
  const { signIn, handoffError } = useSession();
  const [theme, setTheme] = useTheme();
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doSignIn = async (e?: FormEvent) => {
    e?.preventDefault();
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
    <div className="min-h-[100dvh] flex flex-col">
      <Backdrop />
      <div className="flex items-center justify-between px-4 sm:px-6 h-16 shrink-0">
        <BrandMark />
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          title={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
          aria-label={theme === 'dark' ? 'Switch to light' : 'Switch to dark'}
        >
          {theme === 'dark' ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
        </Button>
      </div>

      <main className="flex-1 flex items-center justify-center px-4 sm:px-6 py-6">
        <div className="w-full max-w-md rounded-[1.75rem] border bg-card/80 backdrop-blur-sm shadow-xl p-6 sm:p-8">
          <p className="text-xs font-bold uppercase tracking-[0.2em] text-primary">Oto Console</p>
          <h1 className="mt-2 text-2xl font-black tracking-tight">Sign in</h1>
          <p className="mt-1 mb-6 text-sm text-foreground/60">
            Activity, failures, health and integrations for the platform.
          </p>

          {/* A refused hand-off from the launcher: why this screen appeared at
              all, in words the reader can act on. */}
          {handoffError && (
            <p className="mb-4 rounded-xl border border-dashed px-3 py-2 text-sm text-foreground/70">
              {handoffError}
            </p>
          )}

          <form onSubmit={doSignIn} className="flex flex-col gap-3">
            <FieldLabel icon={PhoneIcon}>Phone number</FieldLabel>
            <input
              type="tel"
              inputMode="tel"
              autoComplete="username"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="090 000 0001"
              className={FIELD}
            />
            <p className="-mt-1 text-xs text-foreground/50">
              Thai numbers can be typed as 090…; for any other country start with + and its code.
            </p>
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
          </form>

          <p className="mt-4 text-sm text-foreground/50">
            {LAUNCHER_URL ? (
              <>
                First shift, or a forgotten password?{' '}
                <a href={LAUNCHER_URL} className="font-semibold text-foreground/70 hover:text-foreground">
                  Start at the suite front door
                </a>
                .
              </>
            ) : (
              'First shift, or a forgotten password? Set it from the suite front door or the till, then come back here.'
            )}
          </p>
        </div>
      </main>

      <footer className="shrink-0 px-6 py-6 text-center text-xs text-foreground/40">
        For the park's team. Every sign-in and every refusal is recorded.
      </footer>
    </div>
  );
}
