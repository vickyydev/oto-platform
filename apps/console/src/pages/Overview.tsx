import { useEffect, useState } from 'react';
import { Link } from 'wouter';
import { ArrowUpRight, Clock3, Loader2, RefreshCw } from 'lucide-react';
import { formatTHB, type AnalyticsSource } from '@oto/shared';
import type { Permission } from '@oto/shared/permissions';
import { useSession } from '@/auth/SessionContext';
import {
  overviewApi, type OverviewBranch, type OverviewSnapshot, type OverviewSource,
} from '@/api/overview';
import { ErrorNote, Loading, Panel, PermissionRequired } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { CommandBar } from '@/components/redesign/CommandBar';
import { BarChip, SelectChip, StatusChip } from '@/components/redesign/chips';
import { CardShell, PageGrid, spanClass, StripedList, type Span } from '@/components/redesign/layout';
import { EmptyNote, StatTile, UnreadNote } from '@/components/redesign/StatTile';
import { formatExact } from '@/lib/time';

const sourceNames: Record<AnalyticsSource, string> = { oto_pos: 'OTO POS', pisell: 'Pisell', papaya: 'Papaya' };

/** One read model owns the totals; a failed source must never turn into a zero on this page. */
export function Overview() {
  const { has } = useSession();
  const allowed = has('console:overview:read');
  const [branchId, setBranchId] = useState('');
  const [branches, setBranches] = useState<OverviewBranch[]>([]);
  const [data, setData] = useState<OverviewSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sourceError, setSourceError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [openingSource, setOpeningSource] = useState<OverviewSource | null>(null);

  useEffect(() => {
    if (!allowed) return;
    let active = true;
    setLoading(true);
    setData(null);
    setError(null);
    void overviewApi.read(branchId).then((answer) => {
      if (!active) return;
      setBranches(answer.branches);
      setData(answer);
    }).catch((failure: unknown) => {
      if (active) setError(failure instanceof Error ? failure.message : 'Could not read today’s figures.');
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [allowed, branchId, refresh]);

  if (!allowed) return <PermissionRequired permission="console:overview:read" />;
  const reload = () => {
    setData(null);
    setLoading(true);
    setRefresh((held) => held + 1);
  };
  const chooseBranch = (next: string) => {
    setData(null);
    setLoading(true);
    setSourceError(null);
    setBranchId(next);
  };
  const openSource = (source: OverviewSource) => {
    if (openingSource) return;
    setOpeningSource(source);
    setSourceError(null);
    void overviewApi.openSource(source).catch((failure: unknown) => {
      setSourceError(failure instanceof Error ? failure.message : 'Could not open the source screen.');
    }).finally(() => setOpeningSource(null));
  };

  return <>
    {sourceError && <ErrorNote message={sourceError} />}
    <OverviewContent data={data} branches={branches} branchId={branchId} loading={loading}
      error={error} has={has} onBranchChange={chooseBranch} onRefresh={reload}
      onOpenSource={openSource} openingSource={openingSource} />
  </>;
}

interface OverviewContentProps {
  data: OverviewSnapshot | null;
  branches: OverviewBranch[];
  branchId: string;
  loading: boolean;
  error: string | null;
  has: (permission: Permission) => boolean;
  onBranchChange: (branchId: string) => void;
  onRefresh: () => void;
  onOpenSource: (source: OverviewSource) => void;
  openingSource: OverviewSource | null;
}

export function OverviewContent({
  data, branches, branchId, loading, error, has, onBranchChange, onRefresh,
  onOpenSource, openingSource,
}: OverviewContentProps) {
  const branch = branches.find((row) => row.id === branchId);
  const timezone = branch?.timezone ?? 'UTC';
  const canPerformance = has('app:pos:access') && (has('analytics:read') || has('pos:cash:read'));
  const canOccupancy = has('app:pos:access') && has('pos:checkin:read');
  const canInbox = has('app:inbox:access') && has('inbox:dashboard:read');
  const figures: Array<{
    key: keyof OverviewSnapshot['totals']; label: string; detail: string; span: Span;
    permitted: boolean; href?: string; source?: OverviewSource; action: string;
  }> = [
    { key: 'revenueSatang', label: 'Revenue today', detail: 'Today’s sales summary', span: 6,
      permitted: canPerformance, source: 'performance', action: 'Open Performance' },
    { key: 'guests', label: 'Guests today', detail: 'Guests in today’s summary', span: 3,
      permitted: canPerformance, source: 'performance', action: 'Open Performance' },
    { key: 'inParkNow', label: 'In park now', detail: 'Latest occupancy snapshot', span: 3,
      permitted: canOccupancy, source: 'occupancy', action: 'Open POS occupancy' },
    { key: 'bookingsToday', label: 'Bookings today', detail: 'Bookings for today’s visit date', span: 3,
      permitted: has('pos:booking:read'), href: '/reports/bookings', action: 'Open Bookings' },
    { key: 'inboxUnanswered', label: 'Inbox unanswered', detail: 'Conversations waiting for an answer', span: 3,
      permitted: canInbox, source: 'inbox', action: 'Open unanswered Inbox' },
    { key: 'openAlerts', label: 'Open alerts', detail: 'Unresolved alerts at these parks', span: 3,
      permitted: has('admin:health:read'), href: '/watch/health', action: 'Open Health' },
    { key: 'boxesOffline', label: 'Boxes offline', detail: 'Boxes not reporting online', span: 3,
      permitted: has('admin:station:read') && has('admin:box:read'), href: '/devices', action: 'Open Devices' },
  ];
  return <>
    <CommandBar sectionId="overview" place={branch?.name ?? 'All reachable parks'} actions={<>
      <SelectChip label="Park" showLabel value={branchId} onChange={onBranchChange}
        anyLabel="All reachable parks" options={branches.map((row) => ({ value: row.id, label: row.name }))}
        disabled={branches.length === 0} />
      <Button variant="outline" size="sm" className="h-9 gap-2 rounded-full px-4"
        disabled={loading} onClick={onRefresh}>
        {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
        Refresh
      </Button>
    </>} />
    {data && <p className="text-sm text-muted-foreground">
      {data.selectedBranchIds.length} park{data.selectedBranchIds.length === 1 ? '' : 's'} · Today follows each park’s business date.{' '}
      Checked <time dateTime={data.generatedAt} title={data.generatedAt}>{formatExact(data.generatedAt, timezone)}</time>.
    </p>}
    {error && <ErrorNote message={error} onRetry={onRefresh} />}
    {loading && <Loading what="today’s figures" />}
    {!loading && !data && error && <Panel><UnreadNote what="Overview figures" /></Panel>}
    {data && data.parks.length === 0 && <Panel><EmptyNote title="No reachable parks"
      detail="There are no active parks in your Overview access. A manager can review your park access." /></Panel>}
    {data && data.parks.length > 0 && <>
      <PageGrid>
        {figures.map((figure) => <article key={figure.key} aria-label={figure.label}
          className={`flex min-w-0 flex-col rounded-[20px] border border-card-border bg-card ${spanClass(figure.span)}`}>
          <StatTile inset className="flex-1 bg-transparent px-[22px] pt-5" label={figure.label}
            value={figure.key === 'revenueSatang' ? formatTHB(data.totals[figure.key]) : data.totals[figure.key].toLocaleString('en-US')}
            detail={figure.detail} />
          <div className="border-t border-border/60 px-[22px] py-3 text-[12.5px]">
            {!figure.permitted ? <span className="text-muted-foreground">Source screen is not on your access.</span>
              : figure.href ? <Link href={figure.href} className="inline-flex items-center gap-1 font-semibold text-primary-ink hover:underline">
                {figure.action}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
              </Link>
                : <button type="button" disabled={openingSource !== null}
                  onClick={() => figure.source && onOpenSource(figure.source)}
                  className="inline-flex items-center gap-1 font-semibold text-primary-ink hover:underline disabled:opacity-50">
                  {openingSource === figure.source && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
                  {figure.action}<ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </button>}
          </div>
        </article>)}
      </PageGrid>
      <p className="text-xs text-muted-foreground">Source screens keep their own access and park controls. Choose the park again there when needed.</p>
      <CardShell title="Reporting dates & freshness" icon={Clock3} note="the dates and source readings behind these figures">
        <StripedList label="Park freshness">
          {data.parks.map((park) => {
            const place = data.branches.find((row) => row.id === park.branchId);
            const zone = place?.timezone ?? 'UTC';
            return <li key={park.branchId} className="flex min-w-0 flex-wrap items-start justify-between gap-3 px-3 py-3">
              <div className="min-w-0 flex-1 basis-[240px]">
                <p className="text-sm font-bold break-words">{place?.name ?? 'Park'}</p>
                <p className="mt-1 text-xs text-muted-foreground">Business date {park.businessDate} · {zone}</p>
                <p className="mt-2 text-xs text-muted-foreground">Revenue and guests: {sourceNames[park.analyticsSource]} summary.{' '}
                  {park.lastRolledUpAt ? <>Last rolled up <time dateTime={park.lastRolledUpAt} title={park.lastRolledUpAt}>{formatExact(park.lastRolledUpAt, zone)}</time>.</>
                    : 'No rollup timestamp reported.'}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Occupancy: {park.occupancyAsOf
                  ? <time dateTime={park.occupancyAsOf} title={park.occupancyAsOf}>{formatExact(park.occupancyAsOf, zone)}</time>
                  : 'No snapshot timestamp reported'}.</p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {park.provisional && <BarChip tone="warn">Provisional</BarChip>}
                {park.occupancyStale && <StatusChip tone="warn">Occupancy is stale</StatusChip>}
              </div>
            </li>;
          })}
        </StripedList>
      </CardShell>
    </>}
  </>;
}
