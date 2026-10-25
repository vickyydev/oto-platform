import { useWorkingAuthority } from '@/lib/workingAuthority';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'wouter';
import { ArrowUpRight, Clock3, Loader2, RefreshCw } from 'lucide-react';
import { formatTHB, type AnalyticsSource } from '@oto/shared';
import type { Permission } from '@oto/shared/permissions';
import { useSession } from '@/auth/SessionContext';
import {
  overviewApi, type OverviewAggregates, type OverviewBranch, type OverviewDecisions, type OverviewSnapshot, type OverviewSource,
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
type RequestOwner = { key: string; serial: number };

export function Overview() {
  const working = useWorkingAuthority();
  const { state, me, has, locked, permissions, refreshing } = useSession();
  const allowed = state === 'signed-in' && !refreshing && !locked && !!me && me.account.status === 'active'
    && !me.account.mustChangePassword && has('console:overview:read');
  const authority = JSON.stringify([working.epoch, me?.operatorContext, refreshing, state, locked, me?.account.id, me?.operatorContext.effectiveOperatorId, me?.account.status,
    me?.account.mustChangePassword, me?.branch?.id, permissions.map(row => [row.permission, row.scopeType, row.scopeId]).sort()]);
  const [selection, setSelection] = useState<{ epoch: number; branchId: string } | null>(null);
  const [directory, setDirectory] = useState<{ epoch: number; branches: OverviewBranch[] } | null>(null);
  const [result, setResult] = useState<(RequestOwner & { data: OverviewSnapshot | null; error: string | null }) | null>(null);
  const [source, setSource] = useState<(RequestOwner & { opening: OverviewSource | null; error: string | null }) | null>(null);
  const [copy, setCopy] = useState<(RequestOwner & { pending: boolean; message: string | null; error: string | null }) | null>(null);
  const [refresh, setRefresh] = useState(0);
  const pendingSource = useRef<RequestOwner | null>(null), pendingCopy = useRef<RequestOwner | null>(null);
  const owner = useRef({ authority, epoch: 0, key: '', serial: 0, mounted: true, allowed });
  if (owner.current.authority !== authority) { owner.current.authority = authority; owner.current.epoch++; owner.current.serial++; }
  const epoch = owner.current.epoch;
  const branchId = selection?.epoch === epoch ? selection.branchId : '';
  const requestKey = JSON.stringify([epoch, branchId, refresh]);
  if (owner.current.key !== requestKey) { owner.current.key = requestKey; owner.current.serial++; }
  owner.current.allowed = allowed;
  const viewOwner = { key: requestKey, serial: owner.current.serial };
  const current = (held: RequestOwner) => working.isCurrent() && owner.current.mounted && owner.current.allowed
    && owner.current.key === held.key && owner.current.serial === held.serial;

  useEffect(() => {
    const held = owner; held.current.mounted = true;
    return () => { held.current.mounted = false; held.current.serial++; };
  }, []);

  useEffect(() => {
    if (!working.isCurrent() || !allowed) return;
    let active = true;
    const held = { key: requestKey, serial: ++owner.current.serial };
    setResult({ ...held, data: null, error: null });
    void working.run(() => overviewApi.read(branchId)).then((answer) => {
      if (!working.isCurrent() || !active || !owner.current.mounted || !owner.current.allowed || owner.current.key !== held.key || owner.current.serial !== held.serial) return;
      setDirectory({ epoch, branches: answer.branches });
      setResult({ ...held, data: answer, error: null });
    }).catch((failure: unknown) => {
      if (working.isCurrent() && active && owner.current.mounted && owner.current.allowed && owner.current.key === held.key && owner.current.serial === held.serial) {
        setResult({ ...held, data: null, error: failure instanceof Error ? failure.message : 'Could not read today’s figures.' });
      }
    });
    return () => { active = false; };
  }, [allowed, branchId, epoch, requestKey, working.isCurrent, working.run]);

  if (!allowed) return <PermissionRequired permission="console:overview:read" />;
  const visible = result && current(result) ? result : null;
  const branches = directory?.epoch === epoch ? directory.branches : [];
  const sourceState = source && current(source) ? source : null;
  const copyState = copy && current(copy) ? copy : null;
  const invalidate = () => { owner.current.serial++; setResult(null); setSource(null); setCopy(null); };
  const reload = () => {
    if (!current(viewOwner)) return;
    invalidate();
    setRefresh((held) => held + 1);
  };
  const chooseBranch = (next: string) => {
    if (!current(viewOwner) || next !== '' && !branches.some(branch => branch.id === next)) return;
    invalidate(); setSelection({ epoch, branchId: next });
  };
  const openSource = (target: OverviewSource) => {
    if (!current(viewOwner) || !visible?.data || pendingSource.current && current(pendingSource.current)) return;
    const held = { ...viewOwner }; pendingSource.current = held;
    setSource({ ...held, opening: target, error: null });
    void working.run(() => overviewApi.openSource(target, () => current(held) && pendingSource.current === held)).catch((failure: unknown) => {
      if (current(held) && pendingSource.current === held) setSource({ ...held, opening: null,
        error: failure instanceof Error ? failure.message : 'Could not open the source screen.' });
    }).finally(() => {
      if (current(held) && pendingSource.current === held) {
        pendingSource.current = null;
        setSource(previous => previous && previous.key === held.key && previous.serial === held.serial ? { ...previous, opening: null } : previous);
      }
    });
  };
  const copySummary = async () => {
    if (!current(viewOwner) || !visible?.data?.parks.length || typeof visible.data.statusSummary !== 'string'
      || pendingCopy.current && current(pendingCopy.current)) return;
    const held = { ...viewOwner }, text = visible.data.statusSummary; pendingCopy.current = held;
    setCopy({ ...held, pending: true, message: null, error: null });
    try {
      if (!navigator.clipboard?.writeText) throw new Error();
      if (!current(held)) return;
      await navigator.clipboard.writeText(text);
      if (current(held) && pendingCopy.current === held) setCopy({ ...held, pending: false, message: 'Status summary copied.', error: null });
    } catch {
      if (current(held) && pendingCopy.current === held) setCopy({ ...held, pending: false, message: null, error: 'Status summary could not be copied. Try again.' });
    } finally { if (current(held) && pendingCopy.current === held) pendingCopy.current = null; }
  };

  return <>
    {sourceState?.error && <div role="alert"><ErrorNote message={sourceState.error} /></div>}
    {copyState?.error && <div role="alert"><ErrorNote message={copyState.error} /></div>}
    {copyState?.message && <p role="status" className="text-sm text-muted-foreground">{copyState.message}</p>}
    <OverviewContent data={visible?.data ?? null} branches={branches} branchId={branchId} loading={!visible || !visible.data && !visible.error}
      error={visible?.error ?? null} has={has} onBranchChange={chooseBranch} onRefresh={reload}
      onOpenSource={openSource} openingSource={sourceState?.opening ?? null} onCopy={() => void copySummary()} copying={copyState?.pending ?? false} />
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
  onCopy?: () => void;
  copying?: boolean;
}

export function OverviewContent({
  data, branches, branchId, loading, error, has, onBranchChange, onRefresh,
  onOpenSource, openingSource, onCopy, copying = false,
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
      <Button variant="outline" size="sm" className="h-9 rounded-full px-4" onClick={onCopy}
        disabled={loading || !data?.parks.length || typeof data.statusSummary !== 'string' || !onCopy || copying}>
        {copying ? 'Copying…' : 'Copy status summary'}
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
      {data.aggregates && data.decisions ? <>
        <AggregateGroups aggregates={data.aggregates} has={has} />
        <DecisionGroups decisions={data.decisions} branches={data.branches} has={has} onOpenSource={onOpenSource} openingSource={openingSource} />
      </> : <Panel><UnreadNote what="Overview v2 sources" /><p className="text-sm text-muted-foreground">The additional summaries are not available on this deployment yet.</p></Panel>}
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

function MetricGrid({ values }: { values: Array<[string, number | string]> }) {
  return <div className="grid min-w-0 gap-3 @xl:grid-cols-2 @3xl:grid-cols-3">
    {values.map(([label, value]) => <StatTile key={label} inset label={label}
      value={typeof value === 'number' ? value.toLocaleString('en-US') : value} />)}
  </div>;
}

function calendarNote(period: { from: string; to: string }) {
  return `Bangkok calendar ${period.from}${period.from === period.to ? '' : ` through ${period.to}`}`;
}

function AggregateGroups({ aggregates, has }: { aggregates: OverviewAggregates; has: (permission: Permission) => boolean }) {
  const { members, bookings, assistantUsage, inboxAiUsage, fleet } = aggregates;
  return <>
    <CardShell title="Members & visits" note={calendarNote(members.period)}>
      <p className="text-sm text-muted-foreground">Stored visit dates. Visiting members are distinct across the selected parks and period; daily or park counts are not added together.</p>
      <MetricGrid values={[
        ['Visits', members.totals.visits], ['Visiting members', members.totals.visitingMembers],
        ['Draft visits', members.totals.draftVisits], ['Active visits', members.totals.activeVisits], ['Closed visits', members.totals.closedVisits],
      ]} />
      {has('pos:member:update') && <Link href="/catalogue/members" className="text-sm font-semibold text-primary-ink">Open Members</Link>}
    </CardShell>
    <CardShell title="Booking activity" note={calendarNote(bookings.period)}>
      <p className="text-sm text-muted-foreground">Bookings and redemptions follow the booking-date cohort. Priced booking value is not payment revenue.</p>
      <MetricGrid values={[
        ['Bookings', bookings.totals.bookings], ['Priced booking value', formatTHB(bookings.totals.bookedValueSatang)],
        ['Redeemed bookings', bookings.totals.redeemedBookings],
      ]} />
      {has('pos:booking:read') && <Link href="/reports/bookings" className="text-sm font-semibold text-primary-ink">Open booking activity</Link>}
    </CardShell>
    <UsageGroup title="Internal assistant" data={assistantUsage} />
    <UsageGroup title="Inbox AI" data={inboxAiUsage} />
    <CardShell title="Fleet" note="Current snapshot">
      <p className="text-sm text-muted-foreground">Persisted box statuses, as of <time dateTime={fleet.asOf}>{formatExact(fleet.asOf, 'UTC')}</time> UTC. This is not a historical-day or heartbeat-age calculation.</p>
      <MetricGrid values={[
        ['Boxes', fleet.totals.boxes], ['Online', fleet.totals.online], ['Offline', fleet.totals.offline],
        ['Unclaimed', fleet.totals.unclaimed], ['Disabled', fleet.totals.disabled],
      ]} />
      {has('admin:station:read') && has('admin:box:read') && <Link href="/devices" className="text-sm font-semibold text-primary-ink">Open fleet devices</Link>}
    </CardShell>
  </>;
}

function UsageGroup({ title, data }: {
  title: string; data: OverviewAggregates['assistantUsage'] | OverviewAggregates['inboxAiUsage'];
}) {
  const totals = data.totals;
  return <CardShell title={title} note={calendarNote(data.period)}>
    <p className="text-sm text-muted-foreground">Retained records{data.retentionDays === null ? '' : `, up to ${data.retentionDays} days`}.{' '}
      {data.attribution === 'seat-at-ask' ? 'Park recorded when the ask was made.' : 'Park currently assigned to the conversation; its historical attribution can change.'}</p>
    <MetricGrid values={[
      [data.attribution === 'seat-at-ask' ? 'Asks' : 'Turns', totals.count], ['Input tokens', totals.inputTokens],
      ['Output tokens', totals.outputTokens], ['Cache-read tokens', totals.cacheReadTokens], ['Total tokens', totals.totalTokens],
    ]} />
    <div className="min-w-0 rounded-xl border border-border/60 p-3 text-sm">
      <p className="font-semibold">{totals.spendEstimate === null ? 'Price unavailable' : `Estimated spend: USD ${totals.spendEstimate.toLocaleString('en-US', { maximumFractionDigits: 8 })}`}</p>
      <p className="mt-1 break-words text-muted-foreground">{data.currency}{totals.reason ? <> · <code className="text-xs">{totals.reason}</code></> : ''}{' '}
        · {totals.unpricedTokens.toLocaleString('en-US')} unpriced tokens{data.excludesCacheWrites ? ' · estimate excludes cache writes' : ''}.</p>
    </div>
    {data.operatorWide && <div className="min-w-0 border-t border-border/60 pt-3">
      <h3 className="text-sm font-bold">Unassigned operator-wide usage</h3>
      <p className="mt-1 text-xs text-muted-foreground">Included once in the totals above. It is separate from park usage and is unavailable when a park is explicitly selected.</p>
      <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-2 text-sm">
        <div><dt className="text-xs text-muted-foreground">{data.attribution === 'seat-at-ask' ? 'Asks' : 'Turns'}</dt><dd>{data.operatorWide.totals.count.toLocaleString('en-US')}</dd></div>
        <div><dt className="text-xs text-muted-foreground">Tokens</dt><dd>{data.operatorWide.totals.totalTokens.toLocaleString('en-US')}</dd></div>
      </dl>
    </div>}
  </CardShell>;
}

type DecisionItem = OverviewDecisions['items'][number];
const decisionMeaning: Record<DecisionItem['key'], string> = {
  pendingPayments: 'Station payment attempts older than the existing pending-payment threshold.',
  syncQuarantine: 'Open quarantine at boxes in the selected parks.',
  cashVariances: 'Off cash lines in saved closes for each park’s current business date. An absent close is unavailable.',
  latePayments: 'Unresolved native late-payment alerts at these parks.',
  strandedOccupants: 'Native end-of-day rows for the current business date; includes normal current occupants.',
  erasureRequests: 'The erasure-request queue is not built yet.',
  approvalRequests: 'The approval-request queue is not built yet.',
};

function DecisionGroups({ decisions, branches, has, onOpenSource, openingSource }: {
  decisions: OverviewDecisions; branches: OverviewBranch[]; has: (permission: Permission) => boolean;
  onOpenSource: (source: OverviewSource) => void; openingSource: OverviewSource | null;
}) {
  const renderItems = (items: DecisionItem[], actions: boolean) => <StripedList label={actions ? 'Decision counts' : 'Park decision counts'}>
    {items.map(item => <li key={item.key} className="flex min-w-0 flex-wrap items-start justify-between gap-3 p-3">
      <div className="min-w-0 flex-1 basis-[220px]">
        <p className="font-semibold break-words">{item.label}</p>
        <p className="mt-1 text-xs text-muted-foreground">{decisionMeaning[item.key]}</p>
        {actions && item.status === 'available' && <div className="mt-2 text-xs font-semibold text-primary-ink">
          {item.key === 'syncQuarantine' && has('admin:health:read') && <Link href="/watch/failures">Open quarantine</Link>}
          {['pendingPayments', 'latePayments'].includes(item.key) && has('admin:health:read') && <Link href="/watch/health">Open Health</Link>}
          {['cashVariances', 'strandedOccupants'].includes(item.key) && has('app:pos:access') && has('pos:cash:read') &&
            <button type="button" disabled={openingSource !== null} onClick={() => onOpenSource('end-of-day')}>Open POS end of day</button>}
        </div>}
      </div>
      <span className="shrink-0 text-sm font-bold tabular-nums">{item.status === 'available' && item.count !== null
        ? item.count.toLocaleString('en-US') : item.status === 'not-built' ? 'Not built' : 'Unavailable'}</span>
    </li>)}
  </StripedList>;
  return <CardShell title="Needs a decision" note={<>
    Checked <time dateTime={decisions.generatedAt}>{formatExact(decisions.generatedAt, 'UTC')}</time> UTC
  </>}>
    <p className="text-sm text-muted-foreground">Current readings from the selected parks. Unavailable and not-built sources are not zero. Source screens retain their own access.</p>
    {renderItems(decisions.items, true)}
    {decisions.parks.length > 1 && decisions.parks.map(park => <details key={park.branchId} className="min-w-0 rounded-xl border p-3">
      <summary className="cursor-pointer text-sm font-semibold break-words">{branches.find(branch => branch.id === park.branchId)?.name ?? 'Park'} decision readings</summary>
      <div className="mt-3">{renderItems(park.items, false)}</div>
    </details>)}
  </CardShell>;
}
