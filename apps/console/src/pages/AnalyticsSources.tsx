import { useEffect, useState } from 'react';
import { formatTHB } from '@oto/shared/money';
import { consoleConfigurationApi, type AnalyticsMetadata, type AnalyticsSummary } from '@/api/consoleConfiguration';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CommandBar } from '@/components/redesign/CommandBar';
import { SelectChip } from '@/components/redesign/chips';
import { CardShell, PageGrid } from '@/components/redesign/layout';
import { EmptyNote, StatTile, UnreadNote } from '@/components/redesign/StatTile';
import { formatExact } from '@/lib/time';
import { useWorkingAuthority } from '@/lib/workingAuthority';
import { RadarTile } from './Reports';

const sources = { oto_pos: 'OTO POS', pisell: 'Pisell', papaya: 'Papaya' };
const preferences = { oto_pos: 'OTO POS', legacy: 'Legacy', both: 'Both' };
const recordedAt = (value: string | null) => value ? formatExact(value, 'UTC') : 'Not recorded';

export function AnalyticsSources() {
  const { has } = useSession();
  if (!has('console:analytics:read')) return <PermissionRequired permission="console:analytics:read" />;
  if (!has('analytics:read')) return <PermissionRequired permission="analytics:read" />;
  return <AnalyticsSourcesBody />;
}

function AnalyticsSourcesBody() {
  const working = useWorkingAuthority();
  const { has } = useSession();
  const [metadata, setMetadata] = useState<AnalyticsMetadata | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [branchId, setBranchId] = useState('');
  const [from, setFrom] = useState(() => new Date().toISOString().slice(0, 10));
  const [to, setTo] = useState(() => new Date().toISOString().slice(0, 10));
  const [summary, setSummary] = useState<AnalyticsSummary | null>(null);
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryRefresh, setSummaryRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    setMetadata(null); setError(null);
    void working.run(() => consoleConfigurationApi.analytics()).then(answer => {
      if (live && working.isCurrent()) setMetadata(answer);
    }).catch((failure: unknown) => {
      if (live && working.isCurrent()) setError(failure instanceof Error ? failure.message : 'Analytics sources could not be read.');
    });
    return () => { live = false; };
  }, [refresh, working.run, working.isCurrent]);
  useEffect(() => {
    let live = true;
    setSummary(null); setSummaryError(null);
    if (!metadata || !from || !to || from > to) return;
    const ids = metadata.branches.filter(park => !branchId || park.branchId === branchId).map(park => park.branchId);
    if (ids.length === 0) return;
    void working.run(() => consoleConfigurationApi.summary(from, to, ids)).then(answer => {
      if (live && working.isCurrent()) setSummary(answer);
    }).catch((failure: unknown) => {
      if (live && working.isCurrent()) setSummaryError(failure instanceof Error ? failure.message : 'The analytics summary could not be read.');
    });
    return () => { live = false; };
  }, [metadata, branchId, from, to, summaryRefresh, working.run, working.isCurrent]);
  const parks = metadata?.branches.filter(park => !branchId || park.branchId === branchId) ?? [];
  return <>
    <CommandBar sectionId="analytics" actions={<Button variant="outline" onClick={() => setRefresh(value => value + 1)}>Refresh</Button>} />
    {error && <ErrorNote message={error} onRetry={() => setRefresh(value => value + 1)} />}
    {!metadata && !error && <Loading what="analytics sources" />}
    {!metadata && error && <UnreadNote what="Analytics sources" />}
    {metadata && <>
      <div className="flex min-w-0 flex-wrap items-end gap-3">
        <SelectChip label="Park" showLabel value={branchId} onChange={setBranchId} anyLabel="All readable parks"
          options={metadata.branches.map(park => ({ value: park.branchId, label: park.name }))} />
        <label className="min-w-0 text-sm" htmlFor="analytics-from">From<Input id="analytics-from" type="date" value={from} onChange={event => setFrom(event.target.value)} /></label>
        <label className="min-w-0 text-sm" htmlFor="analytics-to">To<Input id="analytics-to" type="date" value={to} onChange={event => setTo(event.target.value)} /></label>
      </div>
      {from > to && <p className="text-sm text-destructive">The start date must not be after the end date.</p>}
      {metadata.omitted.length > 0 && <p className="text-sm text-muted-foreground">{metadata.omitted.length} requested parks were outside this reading.</p>}
      {metadata.branches.length === 0 ? <EmptyNote title="No readable analytics parks" detail="No park was included in this reading." /> : <>
        <CardShell title="Summary" note="For the selected dates, from each park’s recorded summary source">
          {summaryError && <ErrorNote message={summaryError} onRetry={() => setSummaryRefresh(value => value + 1)} />}
          {!summary && !summaryError && from && to && from <= to && <Loading what="analytics summary" />}
          {summary && <>
            <p className="text-sm text-muted-foreground">{summary.from} to {summary.to} · Last rollup: {recordedAt(summary.lastRolledUpAt)}</p>
            {summary.omitted.length > 0 && <p className="text-sm text-muted-foreground">{summary.omitted.length} requested parks were omitted from these figures.</p>}
            {summary.merged[0] ? <SummaryFigures row={summary.merged[0]} label="Combined summary" />
              : <EmptyNote title="No combined summary recorded" />}
            {summary.branches.map(park => <section key={park.branchId} className="min-w-0 rounded-2xl border p-4">
              <h3 className="font-bold break-words">{park.name}</h3>
              <p className="mt-1 text-sm text-muted-foreground">{sources[park.source]} · Trading day {park.today} · Last rollup: {recordedAt(park.lastRolledUpAt)}</p>
              {park.rows[0] ? <SummaryFigures row={park.rows[0]} label="Park summary" /> : <p className="mt-2 text-sm text-muted-foreground">No summary row recorded.</p>}
            </section>)}
          </>}
        </CardShell>
        <p className="text-sm text-muted-foreground">Source, formula and queue metadata below cover all retained records, independently of the summary date range. Read at {recordedAt(metadata.generatedAt)}.</p>
        <PageGrid>{parks.map(park => <CardShell key={park.branchId} span={12} title={park.name}>
          <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-3">
            <div><dt className="text-muted-foreground">Summary source</dt><dd className="font-semibold">{sources[park.source]}</dd></div>
            <div><dt className="text-muted-foreground">Radar display preference</dt><dd className="font-semibold">{preferences[park.preference]}</dd></div>
            <div><dt className="text-muted-foreground">Source settings last edited</dt><dd>{recordedAt(park.switchedAt)}</dd></div>
          </dl>
          <p className="text-xs text-muted-foreground">The edit time is not an effective business-date cutover.</p>
          {park.formulaRows.length === 0 ? <EmptyNote title="No stored formula rows" /> : <div className="min-w-0 overflow-x-auto">
            <table className="w-full text-left text-sm"><thead><tr>{['Source', 'Formula version', 'Daily rows', 'Hourly rows', 'Frozen daily rows', 'Provisional daily rows'].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead>
              <tbody>{park.formulaRows.map(row => <tr key={`${row.source}:${row.formulaVersion}`}>
                {[sources[row.source], row.formulaVersion, row.dailyRows, row.hourlyRows, row.frozenDailyRows, row.provisionalDailyRows].map((value, index) => <td key={index} className="p-2">{value}</td>)}
              </tr>)}</tbody></table>
          </div>}
          <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-3">
            <div><dt className="text-muted-foreground">Dirty dates queued</dt><dd className="font-semibold">{park.dirtyDates.total}</dd></div>
            <div><dt className="text-muted-foreground">Oldest queued business date</dt><dd>{park.dirtyDates.oldestBusinessDate ?? 'Not recorded'}</dd></div>
            <div><dt className="text-muted-foreground">Newest queue mark</dt><dd>{recordedAt(park.dirtyDates.newestMarkedAt)}</dd></div>
          </dl>
          <p className="text-sm text-muted-foreground">Sales {park.dirtyDates.byKind.sales} · Hourly {park.dirtyDates.byKind.hourly} · Booth {park.dirtyDates.byKind.booth} · Wallet {park.dirtyDates.byKind.wallet}. Queue counts include claimed rows.</p>
        </CardShell>)}</PageGrid>
      </>}
    </>}
    {has('app:radar:access') && <RadarTile />}
  </>;
}

function SummaryFigures({ row, label }: { row: AnalyticsSummary['merged'][number]; label: string }) {
  return <div className="mt-3 flex min-w-0 flex-col gap-3" aria-label={label}>
    <div className="grid gap-3 sm:grid-cols-3">
      <StatTile inset label="Revenue" value={formatTHB(row.revenueSatang)} />
      <StatTile inset label="Kids" value={row.guestsKids} />
      <StatTile inset label="Adults" value={row.guestsAdults} />
    </div>
    <p className="text-sm text-muted-foreground">Formula version {row.formulaVersion ?? 'Not recorded'} · {row.rolledDays} stored days · {row.provisional ? 'Provisional' : 'Final'} · Computed {recordedAt(row.computedAt)}</p>
    <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-3">
      {([['Tickets', row.ticketsSatang], ['F&B', row.fnbSatang], ['Merch', row.merchSatang], ['Parties', row.partiesSatang], ['Drop-off', row.dropoffSatang], ['Paid via credit', row.creditPaidSatang]] as const).map(([name, value]) => <div key={name}><dt className="text-muted-foreground">{name}</dt><dd>{formatTHB(value)}</dd></div>)}
    </dl>
    <p className="text-sm text-muted-foreground">Ticket mix: 1 hour {row.mix1h} · 2 hours {row.mix2h} · Full day {row.mixFullDay}.</p>
    {Object.entries(row.byChannel).map(([channel, figures]) => <p key={channel} className="text-sm break-words">{channel}: {formatTHB(figures.revenue)} · {figures.txn_count} transactions</p>)}
  </div>;
}
