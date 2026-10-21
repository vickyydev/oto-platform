import { useEffect, useMemo, useState } from 'react';
import {
  AccountAppsDialog, AccountsTable, AdminNotifications, createAccountsApi, scopeWords, UnlinkedOtoAppUsers,
  type AccountRow, type AdminBranch, type AppsDialogAccount,
} from '@oto/admin-screens';
import { Search } from 'lucide-react';
import { api } from '@/api/client';
import { directoryApi } from '@/api/platform';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';

/** App identities are written only through the existing provisioning seam. */
export function AppAccess() {
  const { me, has } = useSession();
  const accountsApi = useMemo(() => createAccountsApi(api), []);
  const [query, setQuery] = useState('');
  const [refresh, setRefresh] = useState(0);
  const [accounts, setAccounts] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<AdminBranch[]>([]);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [appsFor, setAppsFor] = useState<AppsDialogAccount | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true); setError(null); setAccounts([]);
    void accountsApi.accounts(query || undefined).then(answer => {
      if (active) setAccounts(answer.accounts);
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : 'Could not read accounts.');
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [accountsApi, query, refresh]);

  useEffect(() => {
    let active = true;
    void directoryApi.branches().then(answer => {
      if (active) setBranches(answer.branches.filter(branch => !branch.archived)
        .map(branch => ({ id: branch.id, apiId: branch.id, name: branch.name })));
    }).catch((failure: unknown) => {
      if (active) setBranchError(failure instanceof Error ? failure.message : 'Could not read parks.');
    });
    return () => { active = false; };
  }, []);

  if (!me) return null;
  return <>
    <CommandBar sectionId="app-access" />
    {branchError && <ErrorNote message={`Park names could not be read. ${branchError}`} />}
    <label className="relative block max-w-md">
      <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-foreground/40" aria-hidden="true" />
      <span className="sr-only">Search name or phone</span>
      <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search name or phone…"
        className="w-full h-10 rounded-lg border border-input bg-background pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring" />
    </label>
    {!has('admin:role:read') && <p className="text-sm text-muted-foreground">Reading linked apps also needs role-read access.</p>}
    <AccountsTable accounts={accounts} loading={loading} error={error} onRetry={() => setRefresh(held => held + 1)}
      onApps={has('admin:role:read') ? setAppsFor : undefined} />
    <UnlinkedOtoAppUsers api={api} canLink={has('admin:role:assign')} onLinked={() => setRefresh(held => held + 1)} />
    <AccountAppsDialog account={appsFor} api={api} branches={branches}
      scopeLabel={(type, id) => scopeWords(type, id, branches)} canAssign={has('admin:role:assign')}
      onClose={() => setAppsFor(null)} />
    <AdminNotifications />
  </>;
}
