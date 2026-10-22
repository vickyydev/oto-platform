import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Loader2, ShieldCheck } from 'lucide-react';
import { adminAccountsDestination } from '@/api/admin-entry';
import { useOperator } from '@/auth/OperatorContext';
import { Button } from '@/components/ui/button';

/** The approved account controls now live in Admin; this keeps their former POS entry. */
export function LoginUsersPanel() {
  const { can } = useOperator();
  const allowed = can('app:console:access');
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const request = useRef(0);

  useEffect(() => () => { request.current++; }, []);

  const openAccounts = () => {
    if (!allowed || pending.current) return;
    pending.current = true;
    const current = ++request.current;
    setOpening(true);
    setError(null);
    void adminAccountsDestination().then(destination => {
      if (current !== request.current) return;
      try { window.location.assign(destination); }
      catch { setError('Admin could not be opened.'); }
    }).catch((failure: unknown) => {
      if (current === request.current) setError(failure instanceof Error ? failure.message : 'Admin could not be opened.');
    }).finally(() => {
      if (current === request.current) { pending.current = false; setOpening(false); }
    });
  };

  return <section aria-label="Account administration" className="min-w-0 rounded-2xl border border-foreground/10 p-5 sm:p-6">
    <div className="flex min-w-0 items-start gap-3">
      <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-primary" aria-hidden="true" />
      <div className="min-w-0">
        <h2 className="text-lg font-bold">Manage sign-in accounts in Admin</h2>
        <p className="mt-1 text-sm font-medium">Admin → People → Accounts</p>
        <p className="mt-3 text-sm text-foreground/60">Account invitations, roles, app access, passwords and sessions are managed in Admin.</p>
      </div>
    </div>
    <div className="mt-5 flex min-w-0 flex-col items-start gap-3">
      {allowed ? <Button onClick={openAccounts} disabled={opening} className="gap-2">
        {opening ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ArrowUpRight className="h-4 w-4" aria-hidden="true" />}
        {opening ? 'Opening Admin…' : 'Open Accounts in Admin'}
      </Button> : <p className="text-sm text-foreground/60">Admin is not on your access. Ask an administrator for access.</p>}
      {error && <p role="alert" className="min-w-0 break-words text-sm text-destructive">{error}</p>}
    </div>
  </section>;
}
