import { useEffect, useRef, useState } from 'react';
import { ArrowUpRight, Loader2, RefreshCw, Search, Users } from 'lucide-react';
import { departmentsApi, type DepartmentDirectory } from '@/api/departments';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { Tag } from '@/components/redesign/chips';
import { CardShell, StripedList } from '@/components/redesign/layout';
import { EmptyNote } from '@/components/redesign/StatTile';
import { Button } from '@/components/ui/button';

export function Departments() {
  const { has } = useSession();
  const allowed = has('admin:account:read');
  const [query, setQuery] = useState('');
  const [data, setData] = useState<DepartmentDirectory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [openingSource, setOpeningSource] = useState(false);
  const sourcePending = useRef(false);
  const sourceRequest = useRef(0);

  useEffect(() => {
    if (!allowed) return;
    let active = true;
    setData(null);
    setError(null);
    void departmentsApi.read(query.trim()).then((answer) => { if (active) setData(answer); })
      .catch((failure: unknown) => {
        if (active) setError(failure instanceof Error ? failure.message : 'Could not read departments.');
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
    setQuery(next);
  };
  const openSource = () => {
    if (sourcePending.current || !has('app:oto_app:access')) return;
    sourcePending.current = true;
    const request = ++sourceRequest.current;
    setOpeningSource(true);
    setSourceError(null);
    void departmentsApi.sourceDestination().then((destination) => {
      if (request === sourceRequest.current) window.location.assign(destination);
    }).catch((failure: unknown) => {
      if (request === sourceRequest.current) {
        setSourceError(failure instanceof Error ? failure.message : 'Could not open OTO App.');
      }
    }).finally(() => {
      if (request === sourceRequest.current) {
        sourcePending.current = false;
        setOpeningSource(false);
      }
    });
  };

  return <>
    <CommandBar sectionId="departments" actions={<>
      {has('app:oto_app:access') && <Button variant="outline" size="sm" disabled={openingSource} onClick={openSource}>
        {openingSource ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          : <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />}
        {openingSource ? 'Opening OTO App…' : 'Open in OTO App'}
      </Button>}
      <Button variant="outline" size="sm" className="rounded-full" onClick={reload}>
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh
      </Button>
    </>} />
    {sourceError && <div role="alert"><ErrorNote message={sourceError} /></div>}
    <CardShell title="Department directory" icon={Users} note="read-only department mirror">
      <p className="text-sm text-muted-foreground">Mirrored departments are managed in OTO App.</p>
      <p className="text-sm text-muted-foreground">Member counts use current employee links in your reach, including archived employees.</p>
      <label className="relative block w-full max-w-md min-w-0">
        <Search className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" aria-hidden="true" />
        <span className="sr-only">Search departments</span>
        <input value={query} onChange={(event) => search(event.target.value)} placeholder="Department name…"
          className="h-10 w-full min-w-0 rounded-lg border border-input bg-background pl-9 pr-3 text-sm" />
      </label>
      <DepartmentsContent data={data} error={error} query={query} onRetry={reload} />
    </CardShell>
  </>;
}

export function DepartmentsContent({ data, error, query, onRetry }: {
  data: DepartmentDirectory | null;
  error: string | null;
  query: string;
  onRetry: () => void;
}) {
  if (error) return <div role="alert"><ErrorNote message={error} onRetry={onRetry} /></div>;
  if (!data) return <div role="status"><Loading what="departments" /></div>;
  if (!data.departments.length) return <EmptyNote
    title={query.trim() ? 'No matching departments' : 'No departments in your reach'}
    detail={query.trim() ? 'Try another department name.' : 'No department records were returned for your account access.'} />;

  return <StripedList label="Departments">{data.departments.map((department) => <li key={department.id} className="min-w-0 p-3 @2xl:p-4">
    <h3 className="font-bold break-words [overflow-wrap:anywhere]">{department.name}</h3>
    <div className="mt-2 flex flex-wrap gap-2">
      <Tag>{department.source === 'otoapp' ? 'OTO App' : 'Platform'}</Tag>
      {department.archivedAt && <Tag>Archived</Tag>}
    </div>
    <dl className="mt-3 grid min-w-0 gap-3 text-sm @2xl:grid-cols-2">
      <div className="min-w-0"><dt className="text-xs text-muted-foreground">Park</dt>
        <dd className="mt-1 min-w-0 break-words [overflow-wrap:anywhere]">{department.branch?.name ?? 'Operator-wide · no park'}</dd>
      </div>
      <div className="min-w-0"><dt className="text-xs text-muted-foreground">Member count</dt>
        <dd className="mt-1 min-w-0 font-semibold break-words [overflow-wrap:anywhere]">{department.memberCount.toLocaleString('en-GB')}</dd>
      </div>
    </dl>
  </li>)}</StripedList>;
}
