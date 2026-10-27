import { CircleDashed, ExternalLink, EyeOff, ShieldAlert, Timer, UserRoundSearch } from 'lucide-react';
import type {
  ImpersonationApproval, ImpersonationWindow, SupportLookup, SupportTrace,
} from '@/api/support';
import { ErrorNote } from '@/components/Panel';
import { Field, Select, TextInput } from '@/components/Form';
import { CardShell } from '@/components/redesign/layout';
import { StatusChip } from '@/components/redesign/chips';
import { EmptyNote } from '@/components/redesign/StatTile';
import { Button } from '@/components/ui/button';
import { formatExact, millis } from '@/lib/time';
import { cn } from '@/lib/utils';
import {
  groupByApp, isMasked, refusalWords, remaining, rowFacts, sectionStatus, TARGET_APP_NAMES,
  type StartDraft, type StartGate,
} from '@/lib/supportRules';

/**
 * SCRUM-648 Support tools, the parts a reader sees. Every component takes its
 * state as props and calls nothing, so the markup of each rule — grouped and
 * denied sections, masked values, trace gaps, refusals, the write approval —
 * is pinned by the console's node tests; `pages/Support.tsx` owns the reads
 * and the writes.
 */

function Value({ value }: { value: string | number | boolean | null }) {
  if (isMasked(value)) {
    return <span className="inline-flex items-center gap-1 text-muted-foreground" data-masked="true">
      <EyeOff className="h-3 w-3" aria-hidden="true" />Masked</span>;
  }
  if (value === null) return <span className="text-muted-foreground">—</span>;
  return <span className="break-all">{String(value)}</span>;
}

/** The lookup's answer, grouped by the app that owns each section. */
export function LookupResults({ answer }: { answer: SupportLookup }) {
  const groups = groupByApp(answer.sections);
  if (groups.length === 0) {
    return <EmptyNote title="Nothing to search for"
      detail="That does not look like a phone, band, receipt, booking, voucher, account or action id." />;
  }
  return <div className="flex flex-col gap-4" data-testid="lookup-results">
    {answer.masked && <p className="flex items-center gap-2 rounded-xl border border-dashed px-3 py-2 text-sm text-muted-foreground">
      <EyeOff className="h-4 w-4 shrink-0" aria-hidden="true" />
      Personal details are masked: unmasked reads need <code className="font-mono text-xs">admin:audit:read_sensitive</code>.
    </p>}
    {groups.map(group => <CardShell key={group.app} title={group.name} as="section"
      badge={<StatusChip tone="idle">{group.sections.reduce((n, s) => n + s.rowCount, 0)} records</StatusChip>}>
      <div className="flex flex-col gap-3">
        {group.sections.map(section => {
          const status = sectionStatus(section);
          return <div key={`${section.kind}:${section.key}`} className="rounded-xl border border-card-border p-3" data-section={section.key}
            data-status={section.status}>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold">{section.label}</h3>
              <StatusChip tone={status.tone}>{status.words}</StatusChip>
            </div>
            {section.note && <p className="mt-1 text-sm text-muted-foreground break-words">{section.note}</p>}
            {section.rows.length > 0 && <ul className="mt-2 flex flex-col gap-2">
              {section.rows.map((row, i) => <li key={i} className="rounded-lg bg-foreground/[0.03] px-3 py-2">
                <dl className="grid grid-cols-[minmax(0,10rem)_minmax(0,1fr)] gap-x-3 gap-y-1 text-sm">
                  {rowFacts(row).map(([key, value]) => <div key={key} className="contents">
                    <dt className="text-muted-foreground break-words">{key}</dt><dd className="min-w-0"><Value value={value} /></dd>
                  </div>)}
                </dl>
                {typeof row.href === 'string' && <a className="mt-1 inline-flex items-center gap-1 text-sm underline" href={row.href}>
                  Open the trace</a>}
              </li>)}
            </ul>}
          </div>;
        })}
      </div>
    </CardShell>)}
  </div>;
}

const STEP_TONE = { recorded: 'ok', failed: 'down', quarantined: 'down', pending: 'warn', gap: 'idle' } as const;

/** One vertical trace in pipeline order; a stage with no record is drawn as a gap, never left out. */
export function TraceView({ trace }: { trace: SupportTrace }) {
  return <CardShell title="What happened" as="section" note={<>
    {trace.anchor.kind.replace('_', ' ')} <code className="font-mono text-xs break-all">{trace.anchor.id}</code>
    {trace.anchor.receiptNumber ? <> · receipt {trace.anchor.receiptNumber}</> : null}
    {trace.anchor.alsoMatched > 0 ? <> · {trace.anchor.alsoMatched} more with the same key elsewhere</> : null}
  </>} badge={trace.gaps.length > 0 ? <StatusChip tone="warn">{trace.gaps.length} gaps</StatusChip> : <StatusChip tone="ok">No gaps</StatusChip>}>
    <ol className="relative flex flex-col gap-2 border-l border-card-border pl-4" data-testid="trace">
      {trace.steps.map((step, i) => <li key={`${step.stage}:${step.recordId ?? i}`} data-stage={step.stage} data-status={step.status}
        className={cn('rounded-xl border p-3', step.status === 'gap' ? 'border-dashed bg-transparent' : 'border-card-border')}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="flex items-center gap-2 font-semibold">
            {step.status === 'gap' && <CircleDashed className="h-4 w-4" aria-hidden="true" />}
            {step.label}
          </span>
          <StatusChip tone={STEP_TONE[step.status]}>{step.status === 'gap' ? 'Gap — no record' : step.status}</StatusChip>
        </div>
        {step.status === 'gap'
          ? <p className="mt-1 text-sm text-muted-foreground">{step.note}</p>
          : <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground">
            {step.at && <time dateTime={step.at}>{formatExact(step.at)}</time>}
            {step.source && <span>{step.source}</span>}
            {step.latencyMs !== null && <span>took {millis(step.latencyMs)}</span>}
            {step.sincePreviousMs !== null && <span>+{millis(step.sincePreviousMs)} after the previous step</span>}
            {step.outOfOrder && <span className="text-[var(--status-warn)]">earlier than the step before it</span>}
            {step.opsRunId && <span>run <code className="font-mono text-xs">{step.opsRunId}</code></span>}
            {Object.entries(step.detail).filter(([, v]) => v !== null).map(([k, v]) => <span key={k}>{k}: {String(v)}</span>)}
            {step.traceUrl && <a className="inline-flex items-center gap-1 underline" href={step.traceUrl} target="_blank" rel="noreferrer">
              External trace<ExternalLink className="h-3 w-3" aria-hidden="true" /></a>}
            {step.note && <span>{step.note}</span>}
          </div>}
      </li>)}
    </ol>
  </CardShell>;
}

/** A refusal in the words the reader needs: which rule said no. */
export function RefusalNote({ code, message }: { code?: string; message: string }) {
  return <div role="alert" data-refusal={code ?? 'unknown'}><ErrorNote message={refusalWords(code, message)} /></div>;
}

const TARGETS = (['pos', 'oto_app', 'radar', 'inbox'] as const).map(value => ({ value, label: TARGET_APP_NAMES[value] }));

export interface StartFormProps {
  draft: StartDraft;
  onDraft: (next: StartDraft) => void;
  gate: StartGate;
  maxMinutes: number;
  dualControl: boolean;
  busy: boolean;
  onStart: () => void;
  onRequest: () => void;
}

/** Choose the person and the app; read-only unless a second administrator approved changes. */
export function ImpersonationStartForm({ draft, onDraft, gate, maxMinutes, dualControl, busy, onStart, onRequest }: StartFormProps) {
  const set = (patch: Partial<StartDraft>) => onDraft({ ...draft, ...patch });
  const write = draft.mode === 'write_allowed';
  return <CardShell title="View as" icon={UserRoundSearch} as="section"
    note={`A window of at most ${maxMinutes} minutes, ended early by you or by your sign-out. Every request in it is recorded.`}>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Account id"><TextInput value={draft.subjectAccountId} onChange={v => set({ subjectAccountId: v })} maxLength={36}
        placeholder="The staff account to view as" /></Field>
      <Field label="App"><Select value={draft.targetApp} onChange={v => set({ targetApp: v as StartDraft['targetApp'] })} options={TARGETS} /></Field>
      <Field label="Mode"><Select value={draft.mode} onChange={v => set({ mode: v as StartDraft['mode'] })} options={[
        { value: 'read_only', label: 'Read only' }, { value: 'write_allowed', label: 'Changes allowed' }]} /></Field>
      {write && <>
        <Field label="Reason" hint="Required. Recorded with the window."><TextInput value={draft.reason} onChange={v => set({ reason: v })} maxLength={1000} /></Field>
        <Field label="Reference" hint="A ticket or incident number."><TextInput value={draft.reference} onChange={v => set({ reference: v })} maxLength={200} /></Field>
      </>}
    </div>
    {write && dualControl && <p className="mt-2 flex items-start gap-2 text-sm text-muted-foreground" data-testid="needs-approval">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
      A window that can change things needs a second platform administrator&rsquo;s approval of exactly this person, app, reason and reference.
    </p>}
    {gate.missing.length > 0 && <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground" aria-label="Still needed">
      {gate.missing.map(item => <li key={item}>{item}</li>)}
    </ul>}
    <div className="mt-3 flex flex-wrap gap-2">
      {gate.kind === 'request'
        ? <Button onClick={onRequest} disabled={!gate.ready || busy} data-action="request">Ask a second administrator</Button>
        : <Button onClick={onStart} disabled={!gate.ready || busy} data-action="start">
          {write ? 'Open a window with changes' : 'Open a read-only window'}</Button>}
    </div>
  </CardShell>;
}

/** Open write requests: approve another administrator's; your own wait, then open. */
export function ApprovalCards({ approvals, now, busy, onApprove }: {
  approvals: readonly ImpersonationApproval[]; now: number; busy: boolean; onApprove: (approval: ImpersonationApproval) => void;
}) {
  if (approvals.length === 0) return null;
  return <CardShell title="Write requests" as="section" note="Each needs a different platform administrator within ten minutes.">
    <ul className="flex flex-col gap-2">
      {approvals.map(a => <li key={a.id} className="rounded-xl border border-card-border p-3" data-approval={a.id} data-state={a.state}>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-semibold">{a.requesterName ?? 'An administrator'} → {a.subjectName ?? a.subjectAccountId} in {TARGET_APP_NAMES[a.targetApp]}</span>
          <StatusChip tone={a.state === 'approved' ? 'ok' : 'warn'}>{a.state === 'approved' ? 'Approved' : `Waiting · ${remaining(a.requestExpiresAt, now)} left`}</StatusChip>
        </div>
        <p className="text-sm text-muted-foreground break-words">{a.reason} · {a.reference}</p>
        {!a.mine && a.state === 'pending' && <Button className="mt-2" size="sm" disabled={busy} onClick={() => onApprove(a)}>Approve</Button>}
        {a.mine && a.state === 'approved' && <p className="mt-1 text-sm">Approved — open the window above with the same reason and reference.</p>}
      </li>)}
    </ul>
  </CardShell>;
}

/** The open window: who, where, the countdown, and the way to end it now. */
export function ActiveWindowCard({ window: w, now, busy, onEnd, launchUrl }: {
  window: ImpersonationWindow; now: number; busy: boolean; onEnd: () => void; launchUrl?: string | null;
}) {
  return <CardShell title="Open window" icon={Timer} as="section" badge={<StatusChip tone="warn">{remaining(w.expiresAt, now)} left</StatusChip>}>
    <div data-window={w.id} className="flex flex-col gap-2 text-sm">
      <p>Viewing <strong>{TARGET_APP_NAMES[w.targetApp]}</strong> as <strong>{w.subject.name ?? w.subject.accountId}</strong>
        {' '}— {w.mode === 'read_only' ? 'read only' : 'changes allowed'}.</p>
      {w.reason && <p className="text-muted-foreground break-words">{w.reason} · {w.reference}</p>}
      <div className="flex flex-wrap gap-2">
        {launchUrl && <Button asChild variant="outline"><a href={launchUrl} target="_blank" rel="noreferrer">Open {TARGET_APP_NAMES[w.targetApp]}</a></Button>}
        <Button variant="destructive" disabled={busy} onClick={onEnd} data-action="end">End now</Button>
      </div>
    </div>
  </CardShell>;
}
