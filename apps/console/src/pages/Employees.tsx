import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, Loader2, RefreshCw, Search, Users } from 'lucide-react';
import { employeeSourcePath, employeesApi, type DirectoryEmployee, type EmployeeDirectory } from '@/api/employees';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { Tag } from '@/components/redesign/chips';
import { CardShell, StripedList } from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';
import { Button } from '@/components/ui/button';
import { formatExact } from '@/lib/time';

export function Employees() {
  const { has } = useSession();
  const allowed = has('admin:account:read');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<EmployeeDirectory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [openingEmployee, setOpeningEmployee] = useState<string | null>(null);
  const sourceRequest = useRef(0);
  const sourcePending = useRef(false);

  useEffect(() => {
    if (!allowed) return;
    let active = true;
    setData(null);
    setError(null);
    void employeesApi.read(query.trim()).then((answer) => { if (active) setData(answer); })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : 'Could not read employees.');
      });
    return () => { active = false; };
  }, [allowed, query, refresh]);

  useEffect(() => () => { sourceRequest.current++; }, []);

  if (!allowed) return <PermissionRequired permission="admin:account:read" />;
  const reload = () => {
    setData(null);
    setError(null);
    setRefresh((held) => held + 1);
  };
  const search = (next: string) => {
    setData(null);
    setError(null);
    setSourceError(null);
    setQuery(next);
  };
  const openSource = (employee: DirectoryEmployee) => {
    if (sourcePending.current || !has('app:oto_app:access') || !employeeSourcePath(employee)) return;
    sourcePending.current = true;
    const request = ++sourceRequest.current;
    setOpeningEmployee(employee.id);
    setSourceError(null);
    void employeesApi.sourceDestination(employee).then((destination) => {
      if (request === sourceRequest.current) window.location.assign(destination);
    }).catch((failure: unknown) => {
      if (request === sourceRequest.current) {
        setSourceError(failure instanceof Error ? failure.message : 'Could not open OTO App.');
      }
    }).finally(() => {
      if (request === sourceRequest.current) {
        sourcePending.current = false;
        setOpeningEmployee(null);
      }
    });
  };

  return <>
    <CommandBar sectionId="employees" actions={<Button variant="outline" size="sm" className="rounded-full" onClick={reload}>
      <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh
    </Button>} />
    {sourceError && <div role="alert"><ErrorNote message={sourceError} /></div>}
    <CardShell title="Employee directory" icon={Users} note="read-only, within your account access">
      <p className="text-sm text-muted-foreground">Employee details are read-only here. Mirrored records are managed in OTO App. Last sign-in is a successful suite sign-in.</p>
      <label className="relative block w-full max-w-md min-w-0">
        <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Search employees</span>
        <input value={query} onChange={(event) => search(event.target.value)} placeholder="Name, nickname or linked phone…"
          className="h-10 w-full min-w-0 rounded-lg border border-input bg-background pl-9 pr-3 text-sm" />
      </label>
      <EmployeesContent data={data} error={error} query={query} onRetry={reload}
        sourceAccess={has('app:oto_app:access')} openingEmployee={openingEmployee} onOpenSource={openSource} />
    </CardShell>
  </>;
}

export function EmployeesContent({ data, error, query, onRetry, sourceAccess, openingEmployee, onOpenSource }: {
  data: EmployeeDirectory | null;
  error: string | null;
  query: string;
  onRetry: () => void;
  sourceAccess: boolean;
  openingEmployee: string | null;
  onOpenSource: (employee: DirectoryEmployee) => void;
}) {
  if (error) return <div role="alert"><ErrorNote message={error} onRetry={onRetry} /></div>;
  if (!data) return <div role="status"><Loading what="employees" /></div>;
  if (!data.employees.length) return <EmptyNote
    title={query.trim() ? 'No matching employees' : 'No employees in your reach'}
    detail={query.trim() ? 'Try another name, nickname or linked phone.' : 'No employee records were returned for your account access.'} />;

  return <StripedList label="Employees">{data.employees.map((employee) => <li key={employee.id} className="min-w-0 p-3 @2xl:p-4">
    <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1 basis-[220px]">
        <h3 className="font-bold break-words [overflow-wrap:anywhere]">{employee.name}</h3>
        {employee.nickname && <p className="text-sm text-muted-foreground break-words [overflow-wrap:anywhere]">{employee.nickname}</p>}
        <div className="mt-2 flex flex-wrap gap-2">
          <Tag>{employee.source === 'otoapp' ? 'OTO App' : 'Platform'}</Tag>
          {employee.archivedAt && <Tag>Archived</Tag>}
        </div>
      </div>
      {employee.source === 'otoapp' && (employeeSourcePath(employee)
        ? sourceAccess ? <Button variant="outline" size="sm" disabled={openingEmployee !== null} onClick={() => onOpenSource(employee)}>
          {openingEmployee === employee.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            : <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />}
          {openingEmployee === employee.id ? 'Opening OTO App…' : 'Open in OTO App'}
        </Button> : <p className="text-xs text-muted-foreground">OTO App is not on your access.</p>
        : <p className="text-xs text-muted-foreground">The source employee link is unavailable.</p>)}
    </div>
    <dl className="mt-4 grid min-w-0 gap-3 text-sm @2xl:grid-cols-2">
      <EmployeeFact label="Park">{employee.branch?.name ?? 'No park recorded'}</EmployeeFact>
      <EmployeeFact label="Department">{employee.department?.name ?? 'No department recorded'}</EmployeeFact>
      <EmployeeFact label="Last sign-in"><SignInTime value={employee.lastSignInAt} /></EmployeeFact>
      <EmployeeFact label="Linked sign-ins">
        {employee.accounts.length ? <div className="flex min-w-0 flex-col gap-2">{employee.accounts.map((account) => <div key={account.id} className="min-w-0">
          <p className="break-words [overflow-wrap:anywhere]">{account.phone} <Tag>{account.status === 'active' ? 'Active' : account.status === 'inactive' ? 'Inactive' : 'Invited'}</Tag></p>
          <p className="mt-1 text-xs text-muted-foreground">Last sign-in: <SignInTime value={account.lastSignInAt} /></p>
        </div>)}</div> : 'No visible linked sign-in'}
      </EmployeeFact>
    </dl>
  </li>)}</StripedList>;
}

function EmployeeFact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="min-w-0"><dt className="text-xs text-muted-foreground">{label}</dt>
    <dd className="mt-1 min-w-0 break-words [overflow-wrap:anywhere]">{children}</dd></div>;
}

function SignInTime({ value }: { value: string | null }) {
  return value ? <time dateTime={value} title={value}>{formatExact(value)}</time> : <>No recorded sign-in</>;
}
