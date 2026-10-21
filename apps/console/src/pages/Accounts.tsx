import { useEffect, useState } from 'react';
import { AccountAppsDialog, AccountPermissionsDialog, AdminNotifications, LoginUsersPanel, scopeWords, type AdminBranch, type AppsDialogAccount, type PermissionAccount } from '@oto/admin-screens';
import { api } from '@/api/client';
import { directoryApi } from '@/api/platform';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';

/** Host wiring only: account controls stay in the lifted panel. */
export function Accounts() {
  const { me, has } = useSession();
  const [branches, setBranches] = useState<AdminBranch[]>([]);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [permissionsFor, setPermissionsFor] = useState<PermissionAccount | null>(null);
  const [appsFor, setAppsFor] = useState<AppsDialogAccount | null>(null);

  useEffect(() => {
    let active = true;
    setBranchError(null);
    void directoryApi.branches().then((answer) => {
      if (active) setBranches(answer.branches.filter((branch) => !branch.archived)
        .map((branch) => ({ id: branch.id, apiId: branch.id, name: branch.name })));
    }).catch((failure: unknown) => {
      if (active) setBranchError(failure instanceof Error ? failure.message : 'Could not load the parks.');
    });
    return () => { active = false; };
  }, [refresh]);

  if (!me) return null;
  return <>
    <CommandBar sectionId="accounts" />
    {branchError && <ErrorNote message={`The park list could not be read. ${branchError}`}
      onRetry={() => setRefresh((held) => held + 1)} />}
    <LoginUsersPanel key={me.account.id} api={api} branches={branches}
      me={{ operatorId: me.account.operatorId, isPlatformAdmin: me.isPlatformAdmin }} can={has}
      onPermissions={has('admin:role:read') ? setPermissionsFor : undefined}
      onApps={has('admin:role:read') ? setAppsFor : undefined} />
    <AccountPermissionsDialog account={permissionsFor} api={api} branches={branches}
      me={{ operatorId: me.account.operatorId, isPlatformAdmin: me.isPlatformAdmin }}
      canAssign={has('admin:role:assign')} onClose={() => setPermissionsFor(null)} />
    <AccountAppsDialog account={appsFor} api={api} branches={branches}
      scopeLabel={(type, id) => scopeWords(type, id, branches)}
      canAssign={has('admin:role:assign')} onClose={() => setAppsFor(null)} />
    <AdminNotifications />
  </>;
}
