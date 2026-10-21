import { useEffect, useMemo, useState } from 'react';
import {
  AccountPermissionsDialog, AdminNotifications, createRolesApi,
  type AdminBranch, type PermissionAccount, type PermissionHolders, type RoleCatalogue,
} from '@oto/admin-screens';
import { Search, ShieldCheck, Users } from 'lucide-react';
import { Link } from 'wouter';
import { api } from '@/api/client';
import { directoryApi } from '@/api/platform';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Loading } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { CommandBar } from '@/components/redesign/CommandBar';
import { SelectChip, Tag } from '@/components/redesign/chips';
import { CardShell, StripedList } from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';

const rolesApi = createRolesApi(api);

export function Roles() {
  const { me, has } = useSession();
  const [catalogue, setCatalogue] = useState<RoleCatalogue | null>(null);
  const [catalogueError, setCatalogueError] = useState<string | null>(null);
  const [catalogueRefresh, setCatalogueRefresh] = useState(0);
  const [permission, setPermission] = useState('');
  const [holders, setHolders] = useState<PermissionHolders | null>(null);
  const [holdersError, setHoldersError] = useState<string | null>(null);
  const [holdersRefresh, setHoldersRefresh] = useState(0);
  const [branches, setBranches] = useState<AdminBranch[]>([]);
  const [branchError, setBranchError] = useState<string | null>(null);
  const [permissionsFor, setPermissionsFor] = useState<PermissionAccount | null>(null);

  useEffect(() => {
    let active = true;
    setCatalogue(null);
    setCatalogueError(null);
    void rolesApi.catalogue().then((answer) => {
      if (active) { setCatalogue(answer); setPermission((held) => held || answer.permissions[0]?.permission || ''); }
    }).catch((failure: unknown) => {
      if (active) setCatalogueError(message(failure, 'Could not read the role catalogue.'));
    });
    return () => { active = false; };
  }, [catalogueRefresh]);

  useEffect(() => {
    let active = true;
    setHolders(null);
    setHoldersError(null);
    if (!permission) return;
    void rolesApi.holders(permission).then((answer) => { if (active) setHolders(answer); })
      .catch((failure: unknown) => { if (active) setHoldersError(message(failure, 'Could not read permission holders.')); });
    return () => { active = false; };
  }, [permission, holdersRefresh]);

  useEffect(() => {
    let active = true;
    void directoryApi.branches().then((answer) => {
      if (active) setBranches(answer.branches.filter((branch) => !branch.archived)
        .map((branch) => ({ id: branch.id, apiId: branch.id, name: branch.name })));
    }).catch((failure: unknown) => { if (active) setBranchError(message(failure, 'Could not read the parks.')); });
    return () => { active = false; };
  }, []);

  if (!me) return null;
  return <>
    <CommandBar sectionId="roles" actions={<Button asChild variant="outline" size="sm" className="rounded-full"><Link href="/people/accounts">Find an account</Link></Button>} />
    {branchError && <ErrorNote message={`Park names could not be read. ${branchError}`} />}
    <RoleCatalogueContent catalogue={catalogue} error={catalogueError} onRetry={() => setCatalogueRefresh((held) => held + 1)} />
    <CardShell title="Who holds a permission?" icon={Users}
      note="people and scopes within your reach"
      actions={catalogue && <SelectChip label="Permission" value={permission}
        onChange={(value) => { setHolders(null); setHoldersError(null); setPermission(value); }}
        options={catalogue.permissions.map((entry) => ({ value: entry.permission, label: entry.words }))} />}>
      <p className="text-sm text-muted-foreground">Pick a permission to see the accounts and role assignments that give it to them.</p>
      {holdersError ? <ErrorNote message={holdersError} onRetry={() => setHoldersRefresh((held) => held + 1)} />
        : permission && !holders ? <Loading what="permission holders" />
          : holders ? <PermissionHoldersContent result={holders} onPermissions={setPermissionsFor} />
            : <p className="text-sm text-muted-foreground">The permission picker is available after the role catalogue is read.</p>}
    </CardShell>
    <AccountPermissionsDialog account={permissionsFor} api={api} branches={branches}
      me={{ operatorId: me.account.operatorId, isPlatformAdmin: me.isPlatformAdmin }}
      canAssign={has('admin:role:assign')} onClose={() => setPermissionsFor(null)}
      onSaved={() => setHoldersRefresh((held) => held + 1)} />
    <AdminNotifications />
  </>;
}

export function RoleCatalogueContent({ catalogue, error, onRetry }: {
  catalogue: RoleCatalogue | null; error: string | null; onRetry: () => void;
}) {
  const [search, setSearch] = useState('');
  const roles = useMemo(() => {
    const query = search.trim().toLowerCase();
    return catalogue?.roles.filter((role) => `${role.name} ${role.description ?? ''} ${role.permissions.map((entry) => entry.words).join(' ')}`.toLowerCase().includes(query)) ?? [];
  }, [catalogue, search]);
  return <CardShell title="Role catalogue" icon={ShieldCheck} note="what each existing role allows">
    {error ? <ErrorNote message={error} onRetry={onRetry} /> : !catalogue ? <Loading what="roles" /> : <>
      <label className="relative block max-w-md">
        <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Search roles and permissions</span>
        <input value={search} onChange={(event) => setSearch(event.target.value)}
          placeholder="Search roles or permissions…"
          className="h-10 w-full rounded-lg border border-input bg-background pl-9 pr-3 text-sm" />
      </label>
      {roles.length === 0 ? <EmptyNote title="No matching roles" detail="Try another role name or permission." />
        : <div className="grid gap-3 @2xl:grid-cols-2">{roles.map((role) => <details key={role.id} className="min-w-0 rounded-xl border p-4">
          <summary className="cursor-pointer font-bold break-words">{role.name} <Tag>{role.system ? 'System role' : 'Operator role'}</Tag></summary>
          {role.description && <p className="mt-2 text-sm text-muted-foreground">{role.description}</p>}
          <p className="mt-3 text-xs text-muted-foreground">{role.permissions.length} permission{role.permissions.length === 1 ? '' : 's'}</p>
          <ul className="mt-2 flex flex-col gap-2">{role.permissions.map((entry) => <li key={entry.permission} className="text-sm">
            <p>{entry.words}</p><code className="break-all text-[11px] text-muted-foreground">{entry.permission}</code>
          </li>)}</ul>
        </details>)}</div>}
    </>}
  </CardShell>;
}

export function PermissionHoldersContent({ result, onPermissions }: {
  result: PermissionHolders; onPermissions: (account: PermissionAccount) => void;
}) {
  if (result.holders.length === 0) return <EmptyNote title="No holders in your reach"
    detail="The server found no visible role assignments for this permission." />;
  return <StripedList label="Permission holders">{result.holders.map((holder) => <li key={holder.accountId} className="min-w-0 px-3 py-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <div className="min-w-0"><p className="font-bold break-words">{holder.employee?.name ?? holder.phone}</p>
        <p className="text-xs text-muted-foreground">{holder.phone} · {holder.status}</p></div>
      <Button variant="outline" size="sm" className="rounded-full" onClick={() => onPermissions({ id: holder.accountId, phone: holder.phone, employee: holder.employee })}>Permissions</Button>
    </div>
    <ul className="mt-2 flex flex-col gap-1 text-sm text-muted-foreground">{holder.assignments.map((assignment) => <li key={assignment.id}>
      <span className="font-semibold">{assignment.roleName}</span> · {assignment.scopeName}
    </li>)}</ul>
  </li>)}</StripedList>;
}

function message(failure: unknown, fallback: string): string { return failure instanceof Error ? failure.message : fallback; }
