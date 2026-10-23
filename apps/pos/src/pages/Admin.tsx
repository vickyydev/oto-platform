import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useSearch } from 'wouter';
import { ArrowLeft, ArrowUpRight, Loader2, ShieldAlert } from 'lucide-react';
import { adminDestination } from '@/api/admin-entry';
import { useOperator } from '@/auth/OperatorContext';
import { useBranch } from '@/branch/BranchContext';
import { ChangePasswordScreen } from '@/components/auth/ChangePasswordScreen';
import { LockScreen } from '@/components/auth/LockScreen';
import { Button } from '@/components/ui/button';

function refusalWords(failure: unknown): string {
  const status = typeof failure === 'object' && failure !== null && 'status' in failure ? failure.status : null;
  if (status === 401) return 'Sign in again before opening Admin.';
  if (status === 403) return 'This account cannot open Admin. Ask an administrator for access.';
  if (status === 423) return 'Unlock this session before opening Admin.';
  return 'Admin could not be opened. Check the connection and try again.';
}

/** One-release bookmark entry; the server opens Admin as this same signed-in person. */
export default function Admin() {
  const { operator, can, locked, sessionResolved, mustChangePassword, logout } = useOperator();
  const { branch, switching } = useBranch();
  const [location] = useLocation();
  const search = useSearch();
  const allowed = can('app:console:access');
  const ready = sessionResolved && !!operator && !locked && !mustChangePassword && allowed && !switching && location === '/admin';
  const values = [operator, operator?.id, can, allowed, locked, sessionResolved, mustChangePassword,
    branch.id, branch.apiId, switching, location, search];
  const owner = useRef({ values, version: 0 });
  // Change ownership during render: an old reply cannot win before effect cleanup,
  // including a park/actor/address that leaves and returns to its previous value.
  if (values.some((value, index) => !Object.is(value, owner.current.values[index]))) {
    owner.current = { values, version: owner.current.version + 1 };
  }
  const version = owner.current.version;
  const mounted = useRef(false);
  const lifetime = useRef(0);
  const serial = useRef(0);
  const pending = useRef<{ version: number; lifetime: number; serial: number } | null>(null);
  const attempted = useRef<{ version: number; lifetime: number } | null>(null);
  const [outcome, setOutcome] = useState<{ version: number; status: 'opening' | 'failed'; message: string | null } | null>(null);

  useEffect(() => {
    const requestSerial = serial;
    mounted.current = true;
    lifetime.current++;
    return () => { mounted.current = false; requestSerial.current++; pending.current = null; };
  }, []);

  const openAdmin = useCallback(() => {
    if (!mounted.current || !ready || owner.current.version !== version ||
      (pending.current?.version === version && pending.current.lifetime === lifetime.current)) return;
    const attempt = { version, lifetime: lifetime.current, serial: ++serial.current };
    pending.current = attempt;
    attempted.current = attempt;
    const live = () => mounted.current && owner.current.version === version &&
      lifetime.current === attempt.lifetime && serial.current === attempt.serial;
    setOutcome({ version, status: 'opening', message: null });
    // Defer issuance until the committed lifetime survives StrictMode's cleanup.
    void Promise.resolve().then(() => live() ? adminDestination(search) : null).then(destination => {
      if (!live() || destination === null) return;
      try { window.location.replace(destination); }
      catch { setOutcome({ version, status: 'failed', message: 'Admin could not be opened.' }); }
    }).catch((failure: unknown) => {
      if (live()) setOutcome({ version, status: 'failed', message: refusalWords(failure) });
    }).finally(() => { if (live()) pending.current = null; });
  }, [ready, search, version]);

  useEffect(() => {
    if (ready && (attempted.current?.version !== version || attempted.current.lifetime !== lifetime.current)) openAdmin();
  }, [openAdmin, ready, version]);

  if (!sessionResolved) return <div className="flex min-h-[100dvh] items-center justify-center bg-background text-foreground/60" role="status">
    <Loader2 className="mr-2 h-5 w-5 animate-spin" aria-hidden="true" />Checking sign-in…
  </div>;
  if (!operator || locked) return <LockScreen adminMode />;
  if (mustChangePassword) return <ChangePasswordScreen />;

  const current = outcome?.version === version ? outcome : null;
  const failed = current?.status === 'failed';
  return <main className="flex min-h-[100dvh] items-center justify-center bg-background px-5 py-10 text-foreground">
    <section aria-label="Open Admin" className="w-full min-w-0 max-w-lg rounded-3xl border border-foreground/10 p-6 sm:p-8">
      {allowed ? <ArrowUpRight className="mb-4 h-8 w-8 text-primary" aria-hidden="true" />
        : <ShieldAlert className="mb-4 h-8 w-8 text-destructive" aria-hidden="true" />}
      <h1 className="text-2xl font-black tracking-tight">{!allowed ? 'Admin is not on your access' : failed ? 'Admin could not be opened' : 'Opening Admin'}</h1>
      <p className="mt-3 text-sm text-foreground/60">{allowed
        ? 'Park administration is now in Admin. Your saved address opens its page with your current sign-in.'
        : 'Ask an administrator to give this account access to Admin.'}</p>
      {allowed && !failed && <p role="status" className="mt-5 flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
        {switching ? 'Waiting for park selection…' : 'Opening your Admin page…'}
      </p>}
      {failed && <><p role="alert" className="mt-5 break-words text-sm text-destructive">{current.message}</p>
        <Button className="mt-4" onClick={openAdmin}>Try opening Admin again</Button></>}
      <div className="mt-6 flex flex-wrap items-center gap-4">
        <Link href="/" className="inline-flex items-center gap-2 text-sm font-medium text-foreground/70"><ArrowLeft className="h-4 w-4" aria-hidden="true" />Back to POS</Link>
        {!allowed && <Button variant="secondary" onClick={() => logout()}>Sign in as a different user</Button>}
      </div>
    </section>
  </main>;
}
