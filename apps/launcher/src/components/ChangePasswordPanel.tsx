import { useState, type FormEvent } from 'react';
import { KeyRound, Loader2, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { authApi } from '@/api/platform';
import { useSession } from '@/auth/SessionContext';

const FIELD =
  'w-full h-14 rounded-2xl border border-input bg-background px-4 text-lg focus:outline-none focus:ring-2 focus:ring-ring';

/**
 * A temporary password opens the door and nothing else: the API refuses every
 * guarded route until it is replaced. The suite is where that is put right, so
 * nobody has to discover it as a screen full of refusals inside an app.
 */
export function ChangePasswordPanel() {
  const { refresh } = useSession();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (busy || !current || next.length < 8) return;
    setBusy(true);
    setError(null);
    try {
      await authApi.changePassword(current, next);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the password');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="w-full max-w-md flex flex-col items-center text-center animate-in fade-in zoom-in-95 duration-500">
      <div className="relative w-24 h-24 rounded-[2rem] bg-primary flex items-center justify-center text-primary-foreground mb-6 shadow-2xl shadow-primary/30">
        <ShieldCheck className="w-12 h-12" />
      </div>
      <h1 className="text-3xl font-black tracking-tight mb-2">Choose your own password</h1>
      <p className="text-base text-foreground/60 mb-8">
        You signed in with a temporary password. Replace it and the suite opens.
      </p>

      <form onSubmit={submit} className="w-full flex flex-col gap-3 text-left">
        <label className="text-sm font-semibold text-foreground/60 flex items-center gap-2">
          <KeyRound className="w-4 h-4" /> Temporary password
        </label>
        <input
          type="password"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          placeholder="••••••••"
          autoComplete="current-password"
          autoFocus
          className={FIELD}
        />
        <label className="text-sm font-semibold text-foreground/60 flex items-center gap-2 mt-1">
          <KeyRound className="w-4 h-4" /> New password (min 8 characters)
        </label>
        <input
          type="password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          placeholder="••••••••"
          autoComplete="new-password"
          className={FIELD}
        />
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button
          type="submit"
          size="lg"
          className="h-16 text-lg gap-3 rounded-2xl w-full mt-2"
          disabled={busy || !current || next.length < 8}
        >
          {busy ? <Loader2 className="w-6 h-6 animate-spin" /> : <ShieldCheck className="w-6 h-6" />}
          {busy ? 'Saving…' : 'Save and continue'}
        </Button>
      </form>
    </div>
  );
}
