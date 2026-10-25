import { useWorkingAuthority } from '@/lib/workingAuthority';
import { useEffect, useState } from 'react';
import { AccountAppsDialog, AccountPermissionsDialog, AdminNotifications, LoginUsersPanel, scopeWords, type AdminBranch, type AppsDialogAccount, type PermissionAccount } from '@oto/admin-screens';
import { directoryApi } from '@/api/platform';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';

/** Host wiring only: account controls stay in the lifted panel. */
export function Accounts() {
  const working = useWorkingAuthority();
  const { me, has } = useSession();
  const [branches, setBranches] = useState<AdminBranch[]>([]);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [permissionsFor, setPermissionsFor] = useState<PermissionAccount | null>(null);
  const [appsFor, setAppsFor] = useState<AppsDialogAccount | null>(null);

  useEffect(() => {
    let active = true;
    setBranchError(null);
    void working.run(() => directoryApi.branches()).then((answer) => {
      if (working.isCurrent() && active) setBranches(answer.branches.filter((branch) => !branch.archived)
        .map((branch) => ({ id: branch.id, apiId: branch.id, name: branch.name })));
    }).catch((failure: unknown) => {
      if (working.isCurrent() && active) setBranchError(failure instanceof Error ? failure.message : 'Could not load the parks.');
    });
    return () => { active = false; };
  }, [refresh, working.run, working.isCurrent]);

  if (!me) return null;
  return <>
    <CommandBar sectionId="accounts" />
    {branchError && <ErrorNote message={`The park list could not be read. ${branchError}`}
      onRetry={() => working.isCurrent() && setRefresh((held) => held + 1)} />}
    <LoginUsersPanel key={me.account.id} api={working.api} branches={branches}
      me={{ operatorId: me.operatorContext.effectiveOperatorId, isPlatformAdmin: me.isPlatformAdmin }} can={has}
      onPermissions={has('admin:role:read') ? account => { if (working.isCurrent()) setPermissionsFor(account); } : undefined}
      onApps={has('admin:role:read') ? account => { if (working.isCurrent()) setAppsFor(account); } : undefined} />
    <AccountPermissionsDialog account={permissionsFor} api={working.api} branches={branches}
      me={{ operatorId: me.operatorContext.effectiveOperatorId, isPlatformAdmin: me.isPlatformAdmin }}
      canAssign={has('admin:role:assign')} onClose={() => setPermissionsFor(null)} />
    <AccountAppsDialog account={appsFor} api={working.api} branches={branches}
      scopeLabel={(type, id) => scopeWords(type, id, branches)}
      canAssign={has('admin:role:assign')} onClose={() => setAppsFor(null)} />
    <AdminNotifications />
  </>;
}
