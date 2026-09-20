import { useState, type FormEvent } from 'react';
import { ArrowLeft, KeyRound, Loader2, Lock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useSession, displayName } from '@/auth/SessionContext';

/**
 * The session is locked. One session is shared by every app of the suite, so
 * the till locking on inactivity locks this page too — and the same password
 * re-opens it from either side. Nothing is signed out: the shift continues.
 */
export function LockedPanel() {
  const { me, unlock, signOut } = useSession();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  return (
    <div className="w-full max-w-md flex flex-col items-center text-center animate-in fade-in zoom-in-95 duration-500">
      <div className="relative w-24 h-24 rounded-[2rem] bg-primary flex items-center justify-center text-primary-foreground mb-6 shadow-2xl shadow-primary/30">
        <Lock className="w-12 h-12" />
      </div>
      <h1 className="text-4xl font-black tracking-tight mb-2">Locked</h1>
      <p className="text-lg text-foreground/60 mb-8">
        {displayName(me)} is still signed in — enter your password to continue.
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
        onClick={() => void signOut()}
        className="mt-8 inline-flex items-center justify-center gap-2 w-full h-12 rounded-2xl border border-dashed border-foreground/20 text-foreground/60 hover:text-foreground hover:border-foreground/40 transition-colors text-sm font-medium"
      >
        <ArrowLeft className="w-4 h-4" />
        Sign out instead
      </button>
    </div>
  );
}
