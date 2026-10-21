import { useEffect, useState } from 'react';
import { AdminNotifications, LoginUsersPanel, type AdminBranch } from '@oto/admin-screens';
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
      me={{ operatorId: me.account.operatorId, isPlatformAdmin: me.isPlatformAdmin }} can={has} />
    <AdminNotifications />
  </>;
}
