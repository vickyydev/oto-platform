import { useEffect, useState } from 'react';
import { KeyRound, RefreshCw, Shield, Users } from 'lucide-react';
import {
  accessReviewApi, type AccessReviewAccount, type AccessReviewEmployee,
  type AccessReviewHolder, type AccessReviewSnapshot,
} from '@/api/access-review';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { Tag } from '@/components/redesign/chips';
import { CardShell, PageGrid, StripedList } from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';
import { Button } from '@/components/ui/button';
import { formatExact } from '@/lib/time';

export function AccessReview() {
  const { has } = useSession();
  const allowed = has('admin:role:read');
  const [data, setData] = useState<AccessReviewSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!allowed) return;
    let active = true;
    setData(null);
    setError(null);
    void accessReviewApi.read().then((answer) => { if (active) setData(answer); })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : 'Could not read the access review.');
      });
    return () => { active = false; };
  }, [allowed, refresh]);

  if (!allowed) return <PermissionRequired permission="admin:role:read" />;
  const reload = () => {
    setData(null);
    setError(null);
    setRefresh((held) => held + 1);
  };
  return <>
    <CommandBar sectionId="access-review" actions={<Button variant="outline" size="sm" className="rounded-full" onClick={reload}>
      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh
    </Button>} />
    <p className="text-sm text-muted-foreground">Read-only records and role assignments within your access. Last sign-in is a recorded successful suite sign-in.</p>
    <AccessReviewContent data={data} error={error} onRetry={reload} />
  </>;
}

export function AccessReviewContent({ data, error, onRetry }: {
  data: AccessReviewSnapshot | null;
  error: string | null;
  onRetry: () => void;
}) {
  if (error) return <div role="alert"><ErrorNote message={error} onRetry={onRetry} /></div>;
  if (!data) return <div role="status"><Loading what="access review" /></div>;
  return <PageGrid>
    <AccountReviewCard title="Operator-wide holders" rows={data.operatorWideHolders} wide />
    <AccountReviewCard title="Platform-wide holders" rows={data.platformWideHolders} wide />
    <AccountReviewCard title="Accounts without an employee" rows={data.accountsWithoutEmployee} />
    <CardShell title="Employees without an account" icon={Users} span={6}
      note={countText(data.employeesWithoutAccount.length, 'employee')}>
      {data.employeesWithoutAccount.length ? <StripedList label="Employees without an account">
        {data.employeesWithoutAccount.map((employee) => <EmployeeReviewRow key={employee.id} employee={employee} />)}
      </StripedList> : <EmptyReview />}
    </CardShell>
    <AccountReviewCard title="Accounts with no recorded sign-in" rows={data.accountsNeverSignedIn} />
    <AccountReviewCard title="Temporary passwords outstanding" rows={data.temporaryPasswordsOutstanding} temporary />
  </PageGrid>;
}

type ReviewAccountEntry = AccessReviewAccount & Partial<Pick<AccessReviewHolder, 'assignments'>>;

function AccountReviewCard({ title, rows, wide = false, temporary = false }: {
  title: string;
  rows: readonly ReviewAccountEntry[];
  wide?: boolean;
  temporary?: boolean;
}) {
  return <CardShell title={title} icon={wide ? Shield : temporary ? KeyRound : Users} span={6} note={countText(rows.length, 'account')}>
    {rows.length ? <StripedList label={title}>{rows.map((account) => <li key={account.id} className="min-w-0 p-3">
      <h3 className="font-bold break-words [overflow-wrap:anywhere]">{account.employee?.name ?? account.phone}</h3>
      <p className="mt-1 text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">{account.employee ? account.phone : 'Employee not shown'}</p>
      <div className="mt-2 flex min-w-0 flex-wrap gap-2">
        <Tag>{account.status === 'active' ? 'Active' : account.status === 'inactive' ? 'Inactive' : 'Invited'}</Tag>
        {account.mustChangePassword && <Tag className="whitespace-normal">Password change required</Tag>}
      </div>
      <dl className="mt-3 min-w-0 text-sm">
        <dt className="text-xs text-muted-foreground">Last sign-in</dt>
        <dd className="mt-1 min-w-0 break-words [overflow-wrap:anywhere]">{account.lastSignInAt
          ? <time dateTime={account.lastSignInAt} title={account.lastSignInAt}>{formatExact(account.lastSignInAt)}</time>
          : 'No recorded sign-in'}</dd>
        {account.assignments && <>
          <dt className="mt-3 text-xs text-muted-foreground">Role assignments</dt>
          <dd className="mt-1 flex min-w-0 flex-col gap-2">{account.assignments.map((assignment) => <div key={assignment.id} className="min-w-0">
            <p className="font-semibold break-words [overflow-wrap:anywhere]">{assignment.roleName}</p>
            <p className="text-xs text-muted-foreground">{assignment.scopeId === null ? 'Platform-wide' : 'Operator-wide'}</p>
          </div>)}</dd>
        </>}
      </dl>
    </li>)}</StripedList> : <EmptyReview />}
  </CardShell>;
}

function EmployeeReviewRow({ employee }: { employee: AccessReviewEmployee }) {
  return <li className="min-w-0 p-3">
    <h3 className="font-bold break-words [overflow-wrap:anywhere]">{employee.name}</h3>
    {employee.nickname && <p className="mt-1 text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">{employee.nickname}</p>}
    <div className="mt-2 flex flex-wrap gap-2">
      <Tag>{employee.source === 'otoapp' ? 'OTO App' : 'Platform'}</Tag>
      {employee.archivedAt && <Tag>Archived</Tag>}
    </div>
    <dl className="mt-3 min-w-0 text-sm"><dt className="text-xs text-muted-foreground">Park</dt>
      <dd className="mt-1 min-w-0 break-words [overflow-wrap:anywhere]">{employee.branch?.name ?? 'No park recorded'}</dd>
    </dl>
  </li>;
}

function EmptyReview() {
  return <EmptyNote title="No matching records in your reach." />;
}

function countText(count: number, kind: 'account' | 'employee'): string {
  return `${count.toLocaleString('en-GB')} ${kind}${count === 1 ? '' : 's'}`;
}
