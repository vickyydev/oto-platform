import { useWorkingAuthority } from '@/lib/workingAuthority';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ArrowUpRight, CalendarCheck, ClipboardList, Landmark, Loader2, RefreshCw, Users, type LucideIcon } from 'lucide-react';
import { staffApi, type StaffSource, type StaffSummary } from '@/api/staff';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { Tag } from '@/components/redesign/chips';
import { CardShell, PageGrid, spanClass } from '@/components/redesign/layout';
import { Button } from '@/components/ui/button';
import { formatExact } from '@/lib/time';

type RequestOwner = { key: string; serial: number };
type ReadResult = RequestOwner & { data: StaffSummary | null; error: string | null };
type SourceResult = RequestOwner & { opening: StaffSource | null; error: string | null };

export function Staff() {
  const working = useWorkingAuthority();
  const { state, me, locked, has, permissions, refreshing } = useSession();
  const allowed = state === 'signed-in' && !refreshing && !locked && me?.account.status === 'active'
    && !me.account.mustChangePassword && has('app:oto_app:access') && has('admin:account:read');
  const authority = JSON.stringify([working.epoch, me?.operatorContext, refreshing, state, locked, me?.account.id, me?.operatorContext.effectiveOperatorId, me?.account.status,
    me?.account.mustChangePassword, me?.branch?.id,
    permissions.map(row => [row.permission, row.scopeType, row.scopeId]).sort()]);
  const [selection, setSelection] = useState<{ authorityEpoch: number; branchId: string } | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [result, setResult] = useState<ReadResult | null>(null);
  const [directory, setDirectory] = useState<{ authorityEpoch: number; branches: StaffSummary['branches']; selected: string | null } | null>(null);
  const [source, setSource] = useState<SourceResult | null>(null);
  const pendingSource = useRef<RequestOwner | null>(null);
  const owner = useRef({ authority, authorityEpoch: 0, key: '', serial: 0, mounted: true, allowed });
  if (owner.current.authority !== authority) {
    owner.current.authority = authority;
    owner.current.authorityEpoch++;
    owner.current.serial++;
  }
  const authorityEpoch = owner.current.authorityEpoch;
  const branchId = selection?.authorityEpoch === authorityEpoch ? selection.branchId : null;
  const requestKey = JSON.stringify([authorityEpoch, branchId, refresh]);
  if (owner.current.key !== requestKey) {
    owner.current.key = requestKey;
    owner.current.serial++;
  }
  owner.current.allowed = allowed;
  const viewOwner = { key: requestKey, serial: owner.current.serial };
  const current = (held: RequestOwner) => working.isCurrent() && owner.current.mounted && owner.current.allowed
    && owner.current.key === held.key && owner.current.serial === held.serial;

  useEffect(() => {
    const holder = owner;
    holder.current.mounted = true;
    return () => { holder.current.mounted = false; holder.current.serial++; };
  }, []);

  useEffect(() => {
    if (!working.isCurrent() || !allowed) return;
    let active = true;
    const held = { key: requestKey, serial: ++owner.current.serial };
    setResult({ ...held, data: null, error: null });
    void working.run(() => staffApi.read(branchId)).then(answer => {
      if (!working.isCurrent() || !active || !owner.current.mounted || !owner.current.allowed
        || owner.current.key !== held.key || owner.current.serial !== held.serial) return;
      setResult({ ...held, data: answer, error: null });
      setDirectory({ authorityEpoch, branches: answer.branches, selected: answer.selectedBranchId });
    }).catch((failure: unknown) => {
      if (working.isCurrent() && active && owner.current.mounted && owner.current.allowed && owner.current.key === held.key && owner.current.serial === held.serial) {
        setResult({ ...held, data: null, error: failure instanceof Error ? failure.message : 'Could not read the staff summary.' });
      }
    });
    return () => { active = false; };
  }, [allowed, authorityEpoch, branchId, requestKey, working.isCurrent, working.run]);

  const visible = result && current(result) ? result : null;
  const options = directory?.authorityEpoch === authorityEpoch && allowed ? directory : null;
  const sourceState = source && current(source) ? source : null;
  const invalidate = () => {
    owner.current.serial++;
    setResult(null);
    setSource(null);
  };
  const reload = () => {
    if (!current(viewOwner)) return;
    invalidate();
    setRefresh(value => value + 1);
  };
  const selectPark = (next: string) => {
    if (!current(viewOwner) || !options?.branches.some(branch => branch.id === next)) return;
    invalidate();
    setSelection({ authorityEpoch, branchId: next });
  };
  const openSource = (target: StaffSource) => {
    if (!current(viewOwner) || pendingSource.current && current(pendingSource.current)) return;
    const held = { ...viewOwner };
    pendingSource.current = held;
    setSource({ ...held, opening: target, error: null });
    void working.run(() => staffApi.sourceDestination(target)).then(destination => {
      if (current(held) && pendingSource.current === held) window.location.assign(destination);
    }).catch((failure: unknown) => {
      if (current(held) && pendingSource.current === held) {
        setSource({ ...held, opening: null, error: failure instanceof Error ? failure.message : 'Could not open OTO App.' });
      }
    }).finally(() => {
      if (current(held) && pendingSource.current === held) {
        pendingSource.current = null;
        setSource(previous => previous && previous.key === held.key && previous.serial === held.serial
          ? { ...previous, opening: null } : previous);
      }
    });
  };

  if (!allowed) return <><CommandBar sectionId="staff" />
    <PermissionRequired permission={has('app:oto_app:access') ? 'admin:account:read' : 'app:oto_app:access'} /></>;

  return <>
    <CommandBar sectionId="staff" actions={<>
      <label className="flex min-w-0 max-w-full flex-wrap items-center gap-2 text-sm font-medium">
        Park
        <select aria-label="Park" value={branchId ?? options?.selected ?? ''} onChange={event => selectPark(event.target.value)}
          disabled={!options?.branches.length} className="h-10 min-w-0 max-w-full rounded-lg border border-input bg-background px-3 sm:max-w-sm">
          {!options?.branches.length && <option value="">{visible?.data ? 'No parks in your reach' : 'Loading parks…'}</option>}
          {options?.branches.map(branch => <option key={branch.id} value={branch.id}>{branch.name}</option>)}
        </select>
      </label>
      <Button variant="outline" size="sm" onClick={reload}>
        <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" /> Refresh
      </Button>
    </>} />
    {sourceState?.error && <div role="alert"><ErrorNote message={sourceState.error} /></div>}
    <StaffContent data={visible?.data ?? null} error={visible?.error ?? null} onRetry={reload}
      onOpenSource={openSource} openingSource={sourceState?.opening ?? null} />
  </>;
}

const sourceNotes: Record<StaffSummary['source'], string | null> = {
  ready: null,
  'not-configured': 'OTO App is not configured for this environment.',
  'not-provisioned': 'This sign-in is not linked to OTO App.',
  unavailable: 'OTO App could not provide a current summary. Try again.',
  'unmapped-branch': 'This park has no unambiguous OTO App branch mapping.',
};
const payrollLabels: Record<StaffSummary['payroll']['entities'][number]['status'], string> = {
  'not-started': 'Not started', draft: 'Draft', 'gm-confirmed': 'GM confirmed', locked: 'Locked', paid: 'Paid', superseded: 'Superseded',
};

export function StaffContent({ data, error, onRetry, onOpenSource, openingSource }: {
  data: StaffSummary | null;
  error: string | null;
  onRetry: () => void;
  onOpenSource: (source: StaffSource) => void;
  openingSource: StaffSource | null;
}) {
  if (error) return <div role="alert"><ErrorNote message={error} onRetry={onRetry} /></div>;
  if (!data) return <div role="status"><Loading what="staff summary" /></div>;
  const timezone = data.branches.find(branch => branch.id === data.selectedBranchId)?.timezone;
  const open = (target: StaffSource, forbidden = false) => <Button variant="outline" size="sm"
    disabled={openingSource !== null || forbidden} onClick={() => onOpenSource(target)}>
    {openingSource === target ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      : <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />}
    {openingSource === target ? 'Opening OTO App…' : 'Open in OTO App'}
  </Button>;
  return <>
    <div className="min-w-0 space-y-2 text-sm text-muted-foreground">
      <p>{data.date ? <>Park day <time dateTime={data.date}>{data.date}</time>. </> : 'No reachable park was selected. '}
        Read <time dateTime={data.generatedAt}>{formatExact(data.generatedAt, timezone)}</time>.</p>
      {sourceNotes[data.source] && <p role="status">{sourceNotes[data.source]}</p>}
      {data.source !== 'ready' && <Button variant="outline" size="sm" onClick={onRetry}>Try again</Button>}
    </div>
    <PageGrid>
      <MetricCard title="On shift now" icon={Users} metric={data.working} timezone={timezone}
        detail="Current working count from OTO App." action={open('working', data.working.status === 'forbidden')} />
      <MetricCard title="Attendance issues" icon={ClipboardList} metric={data.attendance} timezone={timezone}
        detail="The selected day's existing attendance issue count." action={open('attendance', data.attendance.status === 'forbidden')} />
      <MetricCard title="Leave entries today" icon={CalendarCheck} metric={data.leave} timezone={timezone}
        detail="Time-off entries for this day, not unique people or approvals." action={open('leave', data.leave.status === 'forbidden')} />
      <section aria-label="Payroll month status" className={`min-w-0 ${spanClass(6)}`}>
        <CardShell as="div" title="Payroll month status" icon={Landmark} className="h-full" footer={open('payroll', data.payroll.status === 'forbidden')}>
          <p className="text-sm text-muted-foreground">Company / park-group view; not filtered by the selected park.</p>
          {data.payroll.status === 'ready' ? <>
            <p className="text-sm font-semibold">Month {data.payroll.month}</p>
            {data.payroll.entities.length ? <ul aria-label="Payroll companies" className="divide-y divide-border">
              {data.payroll.entities.map(entity => <li key={entity.id} className="min-w-0 space-y-2 py-3">
                <h3 className="min-w-0 break-words font-semibold [overflow-wrap:anywhere]">{entity.name}</h3>
                <div className="flex min-w-0 flex-wrap gap-2"><Tag>{payrollLabels[entity.status]}</Tag>
                  {entity.version !== null && <Tag>Version {entity.version}</Tag>}</div>
              </li>)}
            </ul> : <p className="text-sm text-muted-foreground">No active paying companies were returned.</p>}
          </> : <p className="font-semibold">{data.payroll.status === 'forbidden' ? 'Not on your access' : 'Unavailable'}</p>}
        </CardShell>
      </section>
    </PageGrid>
  </>;
}

function MetricCard({ title, icon, metric, timezone, detail, action }: {
  title: string;
  icon: LucideIcon;
  metric: StaffSummary['working'];
  timezone?: string;
  detail: string;
  action: ReactNode;
}) {
  const ready = metric.status === 'ready' && metric.count !== null;
  return <section aria-label={title} className={`min-w-0 ${spanClass(6)}`}>
    <CardShell as="div" title={title} icon={icon} className="h-full" footer={action}>
      <p className={ready ? 'text-[34px] font-extrabold tabular-nums tracking-tight' : 'font-semibold'}>
        {ready ? metric.count!.toLocaleString('en-GB') : metric.status === 'forbidden' ? 'Not on your access' : 'Unavailable'}
      </p>
      <p className="text-sm text-muted-foreground">{detail}</p>
      {ready && metric.asOf && <p className="text-xs text-muted-foreground">Source updated <time dateTime={metric.asOf}>{formatExact(metric.asOf, timezone)}</time></p>}
    </CardShell>
  </section>;
}
