import { useEffect, useState } from 'react';
import { formatTHB } from '@oto/shared';
import {
  consoleConfigurationApi, type AnalyticsDrift, type AnalyticsMetadata, type AnalyticsSummary, type DriftComparison,
} from '@/api/consoleConfiguration';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { CommandBar } from '@/components/redesign/CommandBar';
import { CodeTag, SelectChip, StatusChip, Tag } from '@/components/redesign/chips';
import type { Tone } from '@/components/Status';
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
  if (!has('console:analytics:read')) return <><CommandBar sectionId="analytics" /><PermissionRequired permission="console:analytics:read" /></>;
  if (!has('analytics:read')) return <><CommandBar sectionId="analytics" /><PermissionRequired permission="analytics:read" /></>;
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
  const [drift, setDrift] = useState<AnalyticsDrift | null>(null);
  const [driftError, setDriftError] = useState<string | null>(null);
  const [driftRefresh, setDriftRefresh] = useState(0);
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
  useEffect(() => {
    let live = true;
    setDrift(null); setDriftError(null);
    void working.run(() => consoleConfigurationApi.drift(branchId ? [branchId] : undefined)).then(answer => {
      if (live && working.isCurrent()) setDrift(answer);
    }).catch((failure: unknown) => {
      if (live && working.isCurrent()) setDriftError(failure instanceof Error ? failure.message : 'The drift comparison could not be read.');
    });
    return () => { live = false; };
  }, [branchId, refresh, driftRefresh, working.run, working.isCurrent]);
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
        <label className="min-w-0 text-sm" htmlFor="analytics-from">From<input id="analytics-from" type="date" value={from} onChange={event => setFrom(event.target.value)} className="h-9 rounded-full border border-border bg-card px-3.5 text-[12.5px] font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-ring" /></label>
        <label className="min-w-0 text-sm" htmlFor="analytics-to">To<input id="analytics-to" type="date" value={to} onChange={event => setTo(event.target.value)} className="h-9 rounded-full border border-border bg-card px-3.5 text-[12.5px] font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-ring" /></label>
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
      <DriftPanel drift={drift} error={driftError} parks={metadata.branches}
        onRetry={() => setDriftRefresh(value => value + 1)} />
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

const comparisonTitles: Record<DriftComparison['key'], string> = {
  branch_names: 'Park names in the OTO App',
  employees: 'Employee records copied from the OTO App',
  app_accounts: 'OTO App sign-ins',
};
const masters: Record<DriftComparison['master'], string> = { platform: 'Platform', oto_app: 'OTO App' };
const statusWords: Record<DriftComparison['status'], { tone: Tone; label: string }> = {
  clean: { tone: 'ok', label: 'No drift found' },
  drift: { tone: 'down', label: 'Drift found' },
  ambiguous: { tone: 'warn', label: 'Owner unclear' },
  absent: { tone: 'idle', label: 'Source not installed' },
  denied: { tone: 'idle', label: 'Not readable' },
};
const fieldWords: Record<string, string> = {
  name: 'Name', nickname: 'Nickname', phone: 'Phone', email: 'Email', branchId: 'Owned park',
  archivedAt: 'Archived state', platformUserId: 'Sign-in link', isActive: 'Active state', role: 'Role',
};
const kindWords: Record<DriftComparison['items'][number]['kind'], string> = {
  changed: 'Differs from its master', missing: 'No copy of the master record', orphan: 'Copy whose master is gone',
};
const entityWords: Record<DriftComparison['items'][number]['entity'], string> = { branch: 'Park', employee: 'Employee', account: 'Sign-in' };

function unreadReason(row: DriftComparison): string | null {
  switch (row.reason) {
    case 'seam_absent': return 'This source is not installed on this deployment, so nothing was compared.';
    case 'seam_not_granted': return 'The database does not let the platform read this source, so nothing was compared.';
    case 'permission': return `Comparing needs ${row.requiredPermission ?? 'a read permission you do not hold'}, so nothing was compared.`;
    case 'empty_source': return 'The OTO App answered no employees while copies exist, so nothing was compared.';
    case 'anchor_ambiguous': return 'Some records belong to a park group whose operator is not settled, so they were not compared.';
    default: return null;
  }
}

/**
 * Read-only drift between the platform's copies and their masters. Each
 * comparison says what it is; an absent, refused or unsettled source reads as
 * exactly that, never as no drift. Only the names of differing fields are shown.
 */
export function DriftPanel({ drift, error, parks, onRetry }: {
  drift: AnalyticsDrift | null;
  error: string | null;
  parks: ReadonlyArray<{ branchId: string; name: string }>;
  onRetry: () => void;
}) {
  const parkName = (id: string | null) => id === null ? null : parks.find(park => park.branchId === id)?.name ?? 'Park not in this reading';
  return <CardShell title="Copies and their masters" note="Read-only comparison; values are never shown, only which fields differ">
    {error && <div role="alert"><ErrorNote message={error} onRetry={onRetry} /></div>}
    {error && <UnreadNote what="Drift comparison" />}
    {!drift && !error && <div role="status"><Loading what="drift comparison" /></div>}
    {drift && <>
      <p className="text-sm text-muted-foreground">Read <time dateTime={drift.generatedAt}>{recordedAt(drift.generatedAt)}</time>. Nothing is repaired or copied from here.</p>
      <ul className="flex min-w-0 flex-col gap-3" aria-label="Drift comparisons">
        {drift.comparisons.map(row => {
          const words = statusWords[row.status];
          const reason = unreadReason(row);
          const read = row.status === 'clean' || row.status === 'drift' || row.status === 'ambiguous';
          return <li key={row.key} data-drift-key={row.key} data-drift-status={row.status} className="min-w-0 rounded-2xl border p-4">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h3 className="font-bold break-words">{comparisonTitles[row.key]}</h3>
              <StatusChip tone={words.tone}>{words.label}</StatusChip>
              <Tag>Master: {masters[row.master]}</Tag>
            </div>
            {read && <p className="mt-2 text-sm text-muted-foreground">
              {row.compared} compared{row.ambiguous ? ` · ${row.ambiguous} with an unsettled owner, not compared` : ''}{row.withheld ? ` · ${row.withheld} outside what you may inspect` : ''}.
            </p>}
            {reason && row.status !== 'drift' && <p className="mt-2 text-sm">{reason}</p>}
            {row.items.length > 0 && <ul className="mt-3 divide-y divide-border" aria-label={`${comparisonTitles[row.key]} differences`}>
              {row.items.map((item, index) => <li key={`${item.platformId ?? ''}:${item.externalId ?? ''}:${index}`} className="min-w-0 space-y-1 py-2 text-sm">
                <p className="font-semibold break-words">{entityWords[item.entity]}{item.branchId ? ` · ${parkName(item.branchId)}` : ''} · {kindWords[item.kind]}</p>
                {item.fields.length > 0 && <p className="flex min-w-0 flex-wrap gap-1.5">{item.fields.map(field => <Tag key={field}>{fieldWords[field] ?? field}</Tag>)}</p>}
                <p className="flex min-w-0 flex-wrap gap-1.5">
                  {item.platformId && <CodeTag>{item.platformId}</CodeTag>}
                  {item.externalId && <CodeTag>{item.externalId}</CodeTag>}
                </p>
              </li>)}
            </ul>}
          </li>;
        })}
      </ul>
    </>}
  </CardShell>;
}
