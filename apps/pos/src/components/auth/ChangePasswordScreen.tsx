import { useState, type FormEvent } from 'react';
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useOperator } from '@/auth/OperatorContext';

const FIELD =
  'w-full h-14 rounded-2xl border border-input bg-background px-4 text-lg focus:outline-none focus:ring-2 focus:ring-ring';

/**
 * The way out of a temporary password, shown where the person is stopped
 * (SCRUM-235).
 *
 * A manager issues a temporary password so somebody can start a shift. It
 * signs them in and then the API refuses every guarded route with
 * MUST_CHANGE_PASSWORD — the station list included — so the till used to hand
 * them "Password change required before continuing" beside a station picker
 * with nothing in it, and no field anywhere in the app to do anything about
 * it. Their only route was to find the suite launcher on their own.
 *
 * So the form lives here, between the lock screen and the station picker,
 * which is the one place it is ever needed.
 */
export function ChangePasswordScreen() {
  const { operator, changePassword, logout } = useOperator();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = current.length > 0 && next.length >= 8 && next === confirm;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !ready) return;
    setBusy(true);
    setError(null);
    try {
      await changePassword(current, next);
      // Nothing to reset: a success unmounts this screen.
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password');
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6 py-10 text-foreground">
      <div className="w-full max-w-md flex flex-col items-center text-center">
        <div className="relative w-24 h-24 rounded-[2rem] bg-primary flex items-center justify-center text-primary-foreground mb-6 shadow-2xl shadow-primary/30">
          <ShieldCheck className="w-12 h-12" />
        </div>
        <h1 className="text-3xl font-black tracking-tight mb-2">Choose your own password</h1>
        <p className="text-base text-foreground/60 mb-8">
          {operator?.name ? `${operator.name}, you` : 'You'} signed in with a temporary password.
          Replace it and the till opens.
        </p>

        <form onSubmit={submit} className="w-full flex flex-col gap-3 text-left">
          <label
            className="text-sm font-semibold text-foreground/60 flex items-center gap-2"
            htmlFor="current-password"
          >
            <KeyRound className="w-4 h-4" /> Temporary password
          </label>
          <input
            id="current-password"
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            placeholder="••••••••"
            autoComplete="current-password"
            autoFocus
            className={FIELD}
          />

          <label
            className="text-sm font-semibold text-foreground/60 flex items-center gap-2 mt-1"
            htmlFor="new-password"
          >
            <KeyRound className="w-4 h-4" /> New password (min 8 characters)
          </label>
          <input
            id="new-password"
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            placeholder="••••••••"
            autoComplete="new-password"
            className={FIELD}
          />

          <label
            className="text-sm font-semibold text-foreground/60 flex items-center gap-2 mt-1"
            htmlFor="confirm-password"
          >
            <KeyRound className="w-4 h-4" /> Type it again
          </label>
          <input
            id="confirm-password"
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="••••••••"
            autoComplete="new-password"
            className={FIELD}
          />

          {mismatch && <p className="text-sm text-destructive">The two new passwords do not match.</p>}
          {error && <p className="text-sm text-destructive">{error}</p>}

          <Button
            type="submit"
            size="lg"
            className="h-16 text-lg gap-3 rounded-2xl w-full mt-2"
            disabled={busy || !ready}
          >
            {busy ? <Loader2 className="w-6 h-6 animate-spin" /> : <ShieldCheck className="w-6 h-6" />}
            {busy ? 'Saving…' : 'Save and open the till'}
          </Button>
        </form>

        <Button variant="ghost" className="mt-4 rounded-xl" onClick={() => logout()}>
          Sign in as a different user
        </Button>
      </div>
    </div>
  );
}
