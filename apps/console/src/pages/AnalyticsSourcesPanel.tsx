import { useState } from 'react';
import {
  consoleConfigurationApi,
  type AnalyticsParkSource, type AnalyticsRerun, type AnalyticsSourceChoice, type AnalyticsSourcePreview, type AnalyticsSources,
} from '@/api/consoleConfiguration';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Loading } from '@/components/Panel';
import { Button } from '@/components/ui/button';
import { SelectChip, StatusChip, Tag } from '@/components/redesign/chips';
import { CardShell, PageGrid } from '@/components/redesign/layout';
import { UnreadNote } from '@/components/redesign/StatTile';
import { formatExact } from '@/lib/time';
import { useWorkingAuthority } from '@/lib/workingAuthority';

/**
 * SCRUM-646, Q27 Stage 1 — the sources panel, showing the model as it is: one
 * serving source for every date at a park, Radar's own preference, and when the
 * switch was last EDITED (never a date it takes effect from). A switch is only
 * saved after its read-only preview has been shown and confirmed. A re-run
 * queues our own POS days and nothing else. There is no unfreeze.
 */

const sourceNames: Record<AnalyticsParkSource['source'], string> = { oto_pos: 'OTO POS', pisell: 'Pisell', papaya: 'Papaya' };
const preferenceNames: Record<AnalyticsParkSource['preference'], string> = { oto_pos: 'OTO POS', legacy: 'Legacy', both: 'Both' };
const isLegacy = (source: AnalyticsParkSource['source']) => source !== 'oto_pos';
const exact = (value: string) => <time dateTime={value}>{formatExact(value, 'UTC')}</time>;

export const RERUN_COPY = 'A re-run recomputes our POS figures from our own records; it cannot rebuild a day from Pisell or Papaya.';

/** All in-scope parks' panels, or why there are none. */
export function SourcesPanel({ sources, error, onRetry, onChanged }: {
  sources: AnalyticsSources | null;
  error: string | null;
  onRetry: () => void;
  onChanged: () => void;
}) {
  return <CardShell title="Report sources" note="One source serves every date at a park; changing it applies to the whole park">
    {error && <div role="alert"><ErrorNote message={error} onRetry={onRetry} /></div>}
    {error && <UnreadNote what="Report sources" />}
    {!sources && !error && <div role="status"><Loading what="report sources" /></div>}
    {sources && <PageGrid>{sources.branches.map(park => <SourceParkCard key={park.branchId} park={park} onChanged={onChanged} />)}</PageGrid>}
  </CardShell>;
}

/** One park: what it reports from, and the two controls its holder may use. */
export function SourceParkCard({ park, onChanged }: { park: AnalyticsParkSource; onChanged: () => void }) {
  const working = useWorkingAuthority();
  const { has } = useSession();
  const mayManage = park.mayManageSource && has('console:analytics:manage_source');
  const mayRerun = park.mayRerun && has('console:analytics:rerun');
  const [draft, setDraft] = useState<AnalyticsSourceChoice>({ source: park.source, preference: park.preference });
  const [preview, setPreview] = useState<{ choice: AnalyticsSourceChoice; data: AnalyticsSourcePreview } | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'preview' | 'save' | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [range, setRange] = useState(() => { const today = new Date().toISOString().slice(0, 10); return { from: today, to: today }; });
  const [rerunBusy, setRerunBusy] = useState(false);
  const [rerunResult, setRerunResult] = useState<AnalyticsRerun | null>(null);
  const [rerunError, setRerunError] = useState<string | null>(null);
  const message = (failure: unknown, fallback: string) => failure instanceof Error ? failure.message : fallback;

  const changeDraft = (next: AnalyticsSourceChoice) => { setDraft(next); setPreview(null); setPreviewError(null); setSaveError(null); };
  const runPreview = () => {
    if (busy || !working.isCurrent()) return;
    const choice = draft;
    setBusy('preview'); setPreviewError(null); setPreview(null);
    void working.run(() => consoleConfigurationApi.sourcePreview(park.branchId, choice.source))
      .then(data => { if (working.isCurrent()) setPreview({ choice, data }); })
      .catch((failure: unknown) => { if (working.isCurrent()) setPreviewError(message(failure, 'The preview could not be read.')); })
      .finally(() => { if (working.isCurrent()) setBusy(null); });
  };
  const confirm = () => {
    if (busy || !preview || !working.isCurrent()) return;
    setBusy('save'); setSaveError(null);
    void working.run(() => consoleConfigurationApi.switchSource(park.branchId, preview.choice))
      .then(() => { if (working.isCurrent()) { setPreview(null); onChanged(); } })
      .catch((failure: unknown) => { if (working.isCurrent()) setSaveError(message(failure, 'The switch was not saved.')); })
      .finally(() => { if (working.isCurrent()) setBusy(null); });
  };
  const rerun = () => {
    if (rerunBusy || !working.isCurrent()) return;
    setRerunBusy(true); setRerunError(null); setRerunResult(null);
    void working.run(() => consoleConfigurationApi.rerun(park.branchId, range.from, range.to))
      .then(answer => { if (working.isCurrent()) setRerunResult(answer); })
      .catch((failure: unknown) => { if (working.isCurrent()) setRerunError(message(failure, 'The re-run was not queued.')); })
      .finally(() => { if (working.isCurrent()) setRerunBusy(false); });
  };

  return <CardShell span={6} title={park.name}>
    <div data-source-park={park.branchId} className="flex min-w-0 flex-col gap-3">
      <dl className="grid min-w-0 gap-3 text-sm sm:grid-cols-3">
        <div><dt className="text-muted-foreground">Reports from</dt><dd className="font-semibold">{sourceNames[park.source]}</dd></div>
        <div><dt className="text-muted-foreground">Radar shows</dt><dd className="font-semibold">{preferenceNames[park.preference]}</dd></div>
        <div><dt className="text-muted-foreground">Setting last edited</dt><dd>{park.lastEditedAt ? exact(park.lastEditedAt) : 'Never edited (OTO POS by default)'}</dd></div>
      </dl>
      <p className="text-xs text-muted-foreground">The edit time is when this setting was changed, not a date it takes effect from. The source serves every date at this park.</p>
      {mayManage
        ? <SourceSwitchView park={park} draft={draft} preview={preview?.choice.source === draft.source && preview.choice.preference === draft.preference ? preview.data : null}
          previewError={previewError} saveError={saveError} busy={busy}
          onDraft={changeDraft} onPreview={runPreview} onConfirm={confirm} onCancel={() => changeDraft({ source: park.source, preference: park.preference })} />
        : <p className="text-sm text-muted-foreground" data-control="switch-unavailable">Switching the source needs console:analytics:manage_source.</p>}
      {mayRerun
        ? <RerunView park={park} from={range.from} to={range.to} busy={rerunBusy} result={rerunResult} error={rerunError}
          onRange={next => { setRange(next); setRerunResult(null); setRerunError(null); }} onRerun={rerun} />
        : <p className="text-sm text-muted-foreground" data-control="rerun-unavailable">Re-running days needs console:analytics:rerun.</p>}
    </div>
  </CardShell>;
}

/**
 * The switch: choose, preview, then confirm. The confirm control exists only
 * while a preview of exactly the chosen source and preference is on screen.
 */
export function SourceSwitchView({ park, draft, preview, previewError, saveError, busy, onDraft, onPreview, onConfirm, onCancel }: {
  park: AnalyticsParkSource;
  draft: AnalyticsSourceChoice;
  preview: AnalyticsSourcePreview | null;
  previewError: string | null;
  saveError: string | null;
  busy: 'preview' | 'save' | null;
  onDraft: (next: AnalyticsSourceChoice) => void;
  onPreview: () => void;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const unchanged = draft.source === park.source && draft.preference === park.preference;
  return <section aria-label={`Switch the source for ${park.name}`} data-control="switch" className="flex min-w-0 flex-col gap-2 rounded-2xl border p-3">
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <SelectChip label="Reports from" showLabel value={draft.source} disabled={busy !== null}
        options={Object.entries(sourceNames).map(([value, label]) => ({ value, label }))}
        onChange={next => onDraft({ ...draft, source: next as AnalyticsSourceChoice['source'] })} />
      <SelectChip label="Radar shows" showLabel value={draft.preference} disabled={busy !== null}
        options={Object.entries(preferenceNames).map(([value, label]) => ({ value, label }))}
        onChange={next => onDraft({ ...draft, preference: next as AnalyticsSourceChoice['preference'] })} />
      {!preview && <Button variant="outline" size="sm" disabled={unchanged || busy !== null} onClick={onPreview}>
        {busy === 'preview' ? 'Reading preview…' : 'Preview this switch'}
      </Button>}
    </div>
    {previewError && <div role="alert"><ErrorNote message={previewError} /></div>}
    {preview && <div data-preview="shown" className="flex min-w-0 flex-col gap-2 text-sm">
      <p>From {preview.from} to {preview.to} ({preview.days} days), {sourceNames[preview.proposedSource]} has <strong>{preview.servedDays}</strong> stored {preview.servedDays === 1 ? 'day' : 'days'} that would be served{preview.servesFrozenOnly ? ' — its frozen, imported days only' : ''}.</p>
      <p><strong>{preview.emptyDays}</strong> {preview.emptyDays === 1 ? 'day has' : 'days have'} no stored {sourceNames[preview.proposedSource]} row and will show empty.</p>
      {preview.newestWrittenAt && <p className="text-muted-foreground">Newest of those rows written {exact(preview.newestWrittenAt)}.</p>}
      <p className="text-muted-foreground">This applies to every date at {park.name}; it is not a dated cutover, and no figures are recomputed or deleted.</p>
      {saveError && <div role="alert"><ErrorNote message={saveError} /></div>}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" disabled={busy !== null} onClick={onConfirm}>{busy === 'save' ? 'Saving…' : 'Confirm switch'}</Button>
        <Button variant="outline" size="sm" disabled={busy !== null} onClick={onCancel}>Cancel</Button>
      </div>
    </div>}
  </section>;
}

/** Queue our own days. A park serving a legacy source has no form: the refusal is the answer. */
export function RerunView({ park, from, to, busy, result, error, onRange, onRerun }: {
  park: AnalyticsParkSource;
  from: string;
  to: string;
  busy: boolean;
  result: AnalyticsRerun | null;
  error: string | null;
  onRange: (next: { from: string; to: string }) => void;
  onRerun: () => void;
}) {
  if (isLegacy(park.source)) {
    return <section aria-label={`Re-run days for ${park.name}`} data-control="rerun-refused" className="flex min-w-0 flex-col gap-2 rounded-2xl border p-3 text-sm">
      <StatusChip tone="idle">Re-run not available</StatusChip>
      <p>This park reports from {sourceNames[park.source]}. {RERUN_COPY}</p>
    </section>;
  }
  const input = 'h-9 rounded-full border border-border bg-card px-3.5 text-[12.5px] font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-ring';
  return <section aria-label={`Re-run days for ${park.name}`} data-control="rerun" className="flex min-w-0 flex-col gap-2 rounded-2xl border p-3 text-sm">
    <p>{RERUN_COPY} Days are queued for the next rollup; frozen days are never recomputed.</p>
    <div className="flex min-w-0 flex-wrap items-end gap-3">
      <label className="min-w-0" htmlFor={`rerun-from-${park.branchId}`}>From <input id={`rerun-from-${park.branchId}`} type="date" value={from} className={input}
        onChange={event => onRange({ from: event.target.value, to })} /></label>
      <label className="min-w-0" htmlFor={`rerun-to-${park.branchId}`}>To <input id={`rerun-to-${park.branchId}`} type="date" value={to} className={input}
        onChange={event => onRange({ from, to: event.target.value })} /></label>
      <Button variant="outline" size="sm" disabled={busy || !from || !to || from > to} onClick={onRerun}>{busy ? 'Queuing…' : 'Queue re-run'}</Button>
    </div>
    {from > to && <p className="text-destructive">The start date must not be after the end date.</p>}
    {error && <div role="alert"><ErrorNote message={error} /></div>}
    {result && <p role="status"><Tag variant="mint">Queued</Tag> {result.days} {result.days === 1 ? 'day' : 'days'}, {result.from} to {result.to}, for the next rollup.</p>}
  </section>;
}
