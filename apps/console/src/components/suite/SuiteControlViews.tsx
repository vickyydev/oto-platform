import type { ReactNode } from 'react';
import { Flag, Lock, ShieldAlert } from 'lucide-react';
import type { SuiteApps, SuiteFlagPreview, SuiteFlags } from '@/api/suite-controls';
import { ErrorNote, Fact } from '@/components/Panel';
import { ChoiceRow, Field, NumberInput, Select, TextInput } from '@/components/Form';
import { CardShell } from '@/components/redesign/layout';
import { StatusChip } from '@/components/redesign/chips';
import { EmptyNote } from '@/components/redesign/StatTile';
import { Button } from '@/components/ui/button';
import { CONTROL } from '@/components/Filters';
import { formatExact } from '@/lib/time';
import { cn } from '@/lib/utils';
import {
  approvalStep, autoRevertAt, isActionableSwitch, operationOf, personWords, previewMatches, SCOPE_WORDS, SUITE_APP_NAMES,
  type ApprovalOperation, type ApprovalStep, type CatalogueEntry, type FlagOverride, type Gate,
  type PendingApproval, type ScopeType, type SwitchChoice,
} from '@/lib/suiteControlRules';

/**
 * SCRUM-643 Release controls, the parts a reader sees. Every component here
 * takes its state as props and calls nothing, so each safety rule's markup
 * is pinned by the console's node tests; `pages/SuiteControls.tsx` owns the
 * reads, the writes and the drawers.
 */

export function When({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{formatExact(value)}</time> : <>Not recorded</>;
}

const valueWords = (value: boolean | string) => value === true ? 'On' : value === false ? 'Off' : value;

/** A write this reader cannot make, said where the control would have been. */
export function WriteLocked({ permission, what }: { permission: string; what: string }) {
  return <p className="flex min-w-0 items-start gap-2 rounded-xl border border-dashed px-3 py-2 text-sm text-muted-foreground">
    <Lock className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
    <span className="min-w-0 break-words">
      {what} needs <code className="font-mono text-xs break-all">{permission}</code> held by a platform administrator.
      What is set is shown; nothing here can be changed from this account.
    </span>
  </p>;
}

function Missing({ gate }: { gate: Gate }) {
  if (gate.ready) return null;
  return <ul className="list-disc pl-5 text-xs text-muted-foreground" aria-label="Before this can be confirmed">
    {gate.missing.map(item => <li key={item} className="break-words">{item}</li>)}
  </ul>;
}

/** Reason and the typed phrase: rule (c), on every flip. */
export function ConfirmFields({ phrase, reason, onReason, confirmation, onConfirmation, disabled, reasonLabel = 'Reason' }: {
  phrase: string; reason?: string; onReason?: (next: string) => void; confirmation: string;
  onConfirmation: (next: string) => void; disabled?: boolean; reasonLabel?: string;
}) {
  return <>
    {onReason && <Field label={reasonLabel} hint="Required. Recorded in the audit log with the change.">
      <textarea value={reason ?? ''} onChange={event => onReason(event.target.value)} maxLength={1000} rows={3} disabled={disabled}
        className={cn(CONTROL, 'h-auto py-2 leading-snug resize-y disabled:opacity-60')} />
    </Field>}
    <Field label="Type to confirm" hint={<>Type <code className="font-mono break-all">{phrase}</code> exactly.</>}>
      <TextInput value={confirmation} onChange={onConfirmation} disabled={disabled} maxLength={128} />
    </Field>
  </>;
}

/** Rule (b): the blast radius of exactly the pending choice, or an honest note that there is none on screen. */
export function BlastRadius({ preview, choice, busy, error, onPreview, canPreview }: {
  preview: SuiteFlagPreview | null; choice: SwitchChoice | null; busy: boolean; error: string | null;
  onPreview: () => void; canPreview: boolean;
}) {
  const current = previewMatches(preview, choice);
  return <section className="flex min-w-0 flex-col gap-3 rounded-xl border border-card-border p-4" aria-label="Blast radius">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-bold">Blast radius</h3>
      <Button type="button" variant="outline" size="sm" onClick={onPreview} disabled={!canPreview || busy}>
        {busy ? 'Previewing…' : current ? 'Preview again' : 'Preview blast radius'}
      </Button>
    </div>
    {error && <ErrorNote message={error} />}
    {!preview ? <p className="text-sm text-muted-foreground">No preview yet. The confirm button stays off until one is shown for this exact choice.</p>
      : !current ? <p className="text-sm text-muted-foreground">The preview on record was for a different choice. Preview again for this one.</p>
        : <PreviewFacts preview={preview} />}
  </section>;
}

function PreviewFacts({ preview }: { preview: SuiteFlagPreview }) {
  const branches = preview.branches.filter(row => row.current !== row.after);
  const stations = preview.stations.filter(row => row.current !== row.after);
  return <div className="flex min-w-0 flex-col gap-3">
    <p className="text-sm break-words"><span className="font-semibold">What stops working: </span>{preview.effect}</p>
    <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 @xl:grid-cols-3">
      <Fact label="Places that change">{preview.changes}</Fact>
      <Fact label="Staff sessions open there">{preview.openSessions}</Fact>
      <Fact label="Previewed at"><When value={preview.generatedAt} /></Fact>
    </dl>
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">Parks affected</p>
      {branches.length === 0 ? <p className="mt-1 text-sm">No park changes: the switch already says this everywhere it reaches.</p>
        : <ul className="mt-1 flex flex-col gap-1 text-sm">{branches.map(row => <li key={row.branchId} className="break-words">
          {row.name}: {valueWords(row.current)} → {valueWords(row.after)}</li>)}</ul>}
    </div>
    <div className="min-w-0">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">Stations affected</p>
      {stations.length === 0 ? <p className="mt-1 text-sm">No station changes.</p>
        : <ul className="mt-1 flex flex-col gap-1 text-sm">{stations.map(row => <li key={row.stationId} className="break-words">
          {row.name}: {valueWords(row.current)} → {valueWords(row.after)}</li>)}</ul>}
    </div>
  </div>;
}

function placeWords(scopeType: ScopeType, scopeId: string | null) {
  return <>{SCOPE_WORDS[scopeType]}{scopeId && <> · <code className="text-xs break-all">{scopeId}</code></>}</>;
}

/** The kill switches: every named one listed, only the integrated ones actionable. */
export function KillSwitchCard({ flags, me, canWrite, nowMs, onSwitchOn, onSwitchOff, onReview }: {
  flags: SuiteFlags; me: string | null; canWrite: boolean; nowMs: number;
  onSwitchOn: (entry: CatalogueEntry) => void; onSwitchOff: (override: FlagOverride) => void;
  onReview: (approval: PendingApproval) => void;
}) {
  const switches = flags.catalogue.filter(entry => entry.kind === 'kill_switch');
  return <CardShell title="Kill switches" icon={ShieldAlert} badge={flags.killSwitchDualControl
    ? <StatusChip tone="idle">Second administrator approves</StatusChip> : undefined}
  note={<>Read at <When value={flags.generatedAt} /></>}>
    <p className="text-sm text-muted-foreground break-words">
      Every switch expires on its own: {flags.defaultTtlMinutes} minutes unless you choose otherwise, at most {flags.maxTtlMinutes} minutes,
      then it reverts and an alert says so. A preview of exactly what stops working comes before every confirm.
    </p>
    {!canWrite && <WriteLocked permission="console:release:kill_switch" what="Turning a switch on or off" />}
    {switches.length === 0 ? <EmptyNote title="No kill switches are in the catalogue." /> : switches.map(entry =>
      <SwitchRow key={entry.flagKey} entry={entry} me={me} canWrite={canWrite} nowMs={nowMs}
        overrides={flags.overrides.filter(row => row.flagKey === entry.flagKey)}
        approvals={flags.approvals.filter(row => row.operation.key === entry.flagKey)}
        onSwitchOn={onSwitchOn} onSwitchOff={onSwitchOff} onReview={onReview} />)}
  </CardShell>;
}

export function SwitchRow({ entry, overrides, approvals, me, canWrite, nowMs, onSwitchOn, onSwitchOff, onReview }: {
  entry: CatalogueEntry; overrides: FlagOverride[]; approvals: PendingApproval[]; me: string | null; canWrite: boolean; nowMs: number;
  onSwitchOn: (entry: CatalogueEntry) => void; onSwitchOff: (override: FlagOverride) => void; onReview: (approval: PendingApproval) => void;
}) {
  const live = overrides.filter(row => !row.expired && (row.expiresAt === null || Date.parse(row.expiresAt) > nowMs));
  const actionable = isActionableSwitch(entry);
  return <article className="min-w-0 rounded-xl border border-card-border p-4" data-flag={entry.flagKey}>
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <h3 className="min-w-0 font-semibold break-words">{entry.label}</h3>
      {!entry.supported ? <StatusChip tone="idle">Not wired to its consumer yet</StatusChip>
        : live.length > 0 ? <StatusChip tone="warn">{`On at ${live.length} ${live.length === 1 ? 'place' : 'places'}`}</StatusChip>
          : <StatusChip tone="ok">Not set anywhere</StatusChip>}
    </div>
    <p className="mt-2 text-sm break-words">{entry.effect}</p>
    <dl className="mt-3 grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 @xl:grid-cols-3">
      <Fact label="App">{SUITE_APP_NAMES[entry.targetApp]}</Fact>
      <Fact label="Can be set for">{entry.scopes.map(scope => SCOPE_WORDS[scope]).join(', ')}</Fact>
      <Fact label="Key"><code className="text-xs break-all">{entry.flagKey}</code></Fact>
    </dl>
    {!entry.supported ? <p className="mt-3 text-sm text-muted-foreground break-words">
      Nothing reads this switch yet, so no control is offered for it here.
    </p> : <>
      {overrides.length > 0 && <ul className="mt-3 flex min-w-0 flex-col gap-2">
        {overrides.map(row => <OverrideRow key={row.id} row={row} me={me} nowMs={nowMs}
          action={canWrite && live.includes(row)
            ? <Button type="button" variant="outline" size="sm" onClick={() => onSwitchOff(row)}>Switch off…</Button> : null} />)}
      </ul>}
      {approvals.map(approval => <PendingApprovalCard key={approval.id} approval={approval} me={me} canWrite={canWrite} nowMs={nowMs}
        onReview={onReview} />)}
      {canWrite && (actionable
        ? <div className="mt-3"><Button type="button" size="sm" onClick={() => onSwitchOn(entry)}>Switch on…</Button></div>
        : <p className="mt-3 text-sm text-muted-foreground">This switch takes a choice of values this page does not offer yet.</p>)}
    </>}
  </article>;
}

function OverrideRow({ row, me, nowMs, action }: { row: FlagOverride; me: string | null; nowMs: number; action: ReactNode }) {
  const lapsed = row.expired || (row.expiresAt !== null && Date.parse(row.expiresAt) <= nowMs);
  return <li className="min-w-0 rounded-lg border border-card-border p-3">
    <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 @xl:grid-cols-3">
      <Fact label="Where">{placeWords(row.scopeType, row.scopeId)}</Fact>
      <Fact label="Value">{valueWords(row.value)}</Fact>
      <Fact label="Set by">{personWords(row.updatedBy, me)}</Fact>
      <Fact label="Why">{row.reason ?? 'Not recorded'}</Fact>
      <Fact label={lapsed ? 'Expired at' : 'Auto-reverts at'}><When value={row.expiresAt} /></Fact>
      <Fact label="Set at"><When value={row.updatedAt} /></Fact>
    </dl>
    {lapsed && <p className="mt-2 text-xs text-muted-foreground">Expired: it already reads as normal; the expiry job removes the record.</p>}
    {action && <div className="mt-2">{action}</div>}
  </li>;
}

export function PendingApprovalCard({ approval, me, canWrite, nowMs, onReview, step: given }: {
  approval: PendingApproval; me: string | null; canWrite: boolean; nowMs: number; onReview: (approval: PendingApproval) => void;
  step?: ApprovalStep;
}) {
  const op = operationOf(approval);
  const step = given ?? approvalStep(approval, me, canWrite, nowMs);
  return <section className="mt-3 min-w-0 rounded-xl border p-4" aria-label="Pending approval"
    style={{ borderColor: 'hsl(var(--status-warn) / 0.45)', backgroundColor: 'hsl(var(--status-warn) / 0.06)' }}>
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <h4 className="text-sm font-bold">{approval.state === 'approved' ? 'Approved, waiting to be applied' : 'Waiting for a second administrator'}</h4>
      <StatusChip tone="warn">{approval.state === 'approved' ? 'Approved' : 'Pending approval'}</StatusChip>
    </div>
    {!op ? <p className="mt-2 text-sm">This request could not be read, so it is not offered for approval.</p> : <>
      <dl className="mt-3 grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 @xl:grid-cols-3">
        <Fact label="Requested by">{personWords(approval.requesterAccountId, me)}</Fact>
        <Fact label="Reason">{op.reason}</Fact>
        <Fact label="Where">{placeWords(op.scopeType, op.scopeId)}</Fact>
        <Fact label="Value">{valueWords(op.value)}</Fact>
        <Fact label="Request expires"><When value={approval.requestExpiresAt} /></Fact>
        <Fact label="Switch would auto-revert at"><When value={op.expiresAt} /></Fact>
        {approval.approverAccountId && <Fact label="Approved by">{personWords(approval.approverAccountId, me)}</Fact>}
      </dl>
      <p className="mt-2 text-xs text-muted-foreground">A request lapses ten minutes after it was made unless it is approved and applied by then.</p>
    </>}
    {op && step.kind !== 'none' && <div className="mt-3 flex min-w-0 flex-col gap-1">
      <div><Button type="button" size="sm" disabled={!step.enabled} onClick={() => onReview(approval)}>
        {step.kind === 'approve' ? 'Approve…' : 'Apply…'}
      </Button></div>
      {step.why && <p className="text-xs text-muted-foreground break-words">{step.why}</p>}
    </div>}
    {step.kind === 'none' && step.why && <p className="mt-2 text-xs text-muted-foreground break-words">{step.why}</p>}
  </section>;
}

/** Feature flags: listed honestly; nothing is offered to change while no consumer reads one. */
export function FeatureFlagsCard({ flags }: { flags: SuiteFlags }) {
  const features = flags.catalogue.filter(entry => entry.kind === 'feature');
  const supported = features.filter(entry => entry.supported);
  return <CardShell title="Feature flags" icon={Flag}>
    {supported.length === 0 ? <EmptyNote title="No feature flag can be changed yet."
      detail="No app reads a feature flag yet, so nothing is offered to change. Flags will appear here once their consumer is built." />
      : <p className="text-sm text-muted-foreground">Changing a feature flag is not offered on this page yet.</p>}
    {features.map(entry => <article key={entry.flagKey} className="min-w-0 rounded-xl border border-card-border p-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
        <h3 className="min-w-0 font-semibold break-words">{entry.label}</h3>
        <StatusChip tone="idle">{entry.supported ? 'Supported' : 'Not wired to its consumer yet'}</StatusChip>
      </div>
      <p className="mt-2 text-sm break-words">{entry.effect}</p>
      <dl className="mt-3 grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 @xl:grid-cols-3">
        <Fact label="Default">{valueWords(entry.defaultValue)}</Fact>
        <Fact label="Can be set for">{entry.scopes.map(scope => SCOPE_WORDS[scope]).join(', ')}</Fact>
        <Fact label="Key"><code className="text-xs break-all">{entry.flagKey}</code></Fact>
      </dl>
    </article>)}
  </CardShell>;
}

// --- Forms (drawer bodies) ------------------------------------------------------

export interface PlaceOption { id: string; name: string }

export interface SwitchOnFormProps {
  entry: CatalogueEntry;
  dualControl: boolean;
  defaultTtlMinutes: number;
  maxTtlMinutes: number;
  scopeType: ScopeType;
  onScopeType: (next: ScopeType) => void;
  branches: PlaceOption[] | null;
  branchesError: string | null;
  branchId: string;
  onBranch: (next: string) => void;
  stations: PlaceOption[] | null;
  stationsError: string | null;
  stationId: string;
  onStation: (next: string) => void;
  minutes: number | null;
  onMinutes: (next: number | null) => void;
  nowMs: number;
  choice: SwitchChoice | null;
  preview: SuiteFlagPreview | null;
  previewBusy: boolean;
  previewError: string | null;
  onPreview: () => void;
  reason: string;
  onReason: (next: string) => void;
  confirmation: string;
  onConfirmation: (next: string) => void;
  gate: Gate;
  busy: boolean;
  error: string | null;
  onSubmit: () => void;
}

export function SwitchOnForm(props: SwitchOnFormProps) {
  const { entry, scopeType } = props;
  const needsBranch = scopeType === 'branch' || scopeType === 'station';
  return <div className="flex min-w-0 flex-col gap-5">
    <p className="text-sm break-words">{entry.effect}</p>
    <Field label="Where it applies">
      <ChoiceRow value={scopeType} onChange={next => props.onScopeType(next as ScopeType)} disabled={props.busy}
        options={entry.scopes.map(scope => ({ value: scope, label: SCOPE_WORDS[scope] }))} />
    </Field>
    {needsBranch && (props.branchesError ? <ErrorNote message={props.branchesError} />
      : <Field label="Park"><Select value={props.branchId} onChange={props.onBranch} disabled={props.busy || !props.branches}
        placeholder={props.branches ? 'Choose a park' : 'Loading parks…'}
        options={(props.branches ?? []).map(branch => ({ value: branch.id, label: branch.name }))} /></Field>)}
    {scopeType === 'station' && props.branchId && (props.stationsError ? <ErrorNote message={props.stationsError} />
      : <Field label="Station"><Select value={props.stationId} onChange={props.onStation} disabled={props.busy || !props.stations}
        placeholder={props.stations ? 'Choose a station' : 'Loading stations…'}
        options={(props.stations ?? []).map(station => ({ value: station.id, label: station.name }))} /></Field>)}
    <Field label="Minutes until it switches itself off" hint={<>
      Default {props.defaultTtlMinutes}, at most {props.maxTtlMinutes}.{' '}
      {props.minutes !== null && Number.isInteger(props.minutes) && props.minutes >= 1 && props.minutes <= props.maxTtlMinutes
        && <>If sent now, it auto-reverts at <When value={autoRevertAt(props.nowMs, props.minutes)} />.</>}
    </>}>
      <NumberInput value={props.minutes} onChange={props.onMinutes} min={1} disabled={props.busy} />
    </Field>
    <BlastRadius preview={props.preview} choice={props.choice} busy={props.previewBusy} error={props.previewError}
      onPreview={props.onPreview} canPreview={props.choice !== null && !props.busy} />
    <ConfirmFields phrase={entry.flagKey} reason={props.reason} onReason={props.onReason} confirmation={props.confirmation}
      onConfirmation={props.onConfirmation} disabled={props.busy} />
    {props.dualControl && <p className="text-xs text-muted-foreground break-words">
      This makes a request. A different platform administrator approves it within ten minutes; then either of you applies it.
    </p>}
    {props.error && <ErrorNote message={props.error} />}
    <Missing gate={props.gate} />
    <div><Button type="button" onClick={props.onSubmit} disabled={!props.gate.ready} data-confirm="switch-on">
      {props.busy ? 'Sending…' : props.dualControl ? 'Ask a second administrator' : 'Switch on'}
    </Button></div>
  </div>;
}

export function SwitchOffForm({ entry, override, reason, onReason, confirmation, onConfirmation, gate, busy, error, onSubmit }: {
  entry: CatalogueEntry; override: FlagOverride; reason: string; onReason: (next: string) => void; confirmation: string;
  onConfirmation: (next: string) => void; gate: Gate; busy: boolean; error: string | null; onSubmit: () => void;
}) {
  return <div className="flex min-w-0 flex-col gap-5">
    <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 @xl:grid-cols-2">
      <Fact label="Switch">{entry.label}</Fact>
      <Fact label="Where">{placeWords(override.scopeType, override.scopeId)}</Fact>
      <Fact label="Why it was set">{override.reason ?? 'Not recorded'}</Fact>
      <Fact label="Would auto-revert at"><When value={override.expiresAt} /></Fact>
    </dl>
    <p className="text-sm break-words">
      Switching off restores service here now: whatever is set above this place, or normal, applies at once. One administrator is enough.
    </p>
    <ConfirmFields phrase={entry.flagKey} reason={reason} onReason={onReason} confirmation={confirmation}
      onConfirmation={onConfirmation} disabled={busy} />
    {error && <ErrorNote message={error} />}
    <Missing gate={gate} />
    <div><Button type="button" onClick={onSubmit} disabled={!gate.ready} data-confirm="switch-off">
      {busy ? 'Sending…' : 'Switch off'}
    </Button></div>
  </div>;
}

export function ReviewForm({ entry, approval, op, step, choice, preview, previewBusy, previewError, onPreview,
  confirmation, onConfirmation, gate, busy, error, onSubmit, me }: {
  entry: CatalogueEntry | null; approval: PendingApproval; op: ApprovalOperation; step: ApprovalStep; choice: SwitchChoice | null;
  preview: SuiteFlagPreview | null; previewBusy: boolean; previewError: string | null; onPreview: () => void;
  confirmation: string; onConfirmation: (next: string) => void; gate: Gate; busy: boolean; error: string | null;
  onSubmit: () => void; me: string | null;
}) {
  const ready = gate.ready && step.enabled;
  return <div className="flex min-w-0 flex-col gap-5">
    <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 @xl:grid-cols-2">
      <Fact label="Switch">{entry?.label ?? op.key}</Fact>
      <Fact label="Requested by">{personWords(approval.requesterAccountId, me)}</Fact>
      <Fact label="Reason">{op.reason}</Fact>
      <Fact label="Where">{placeWords(op.scopeType, op.scopeId)}</Fact>
      <Fact label="Request expires"><When value={approval.requestExpiresAt} /></Fact>
      <Fact label="Switch would auto-revert at"><When value={op.expiresAt} /></Fact>
    </dl>
    <BlastRadius preview={preview} choice={choice} busy={previewBusy} error={previewError} onPreview={onPreview}
      canPreview={choice !== null && !busy} />
    <ConfirmFields phrase={op.key} confirmation={confirmation} onConfirmation={onConfirmation} disabled={busy} />
    {step.why && <p className="text-sm text-muted-foreground break-words">{step.why}</p>}
    {error && <ErrorNote message={error} />}
    <Missing gate={gate} />
    <div><Button type="button" onClick={onSubmit} disabled={!ready} data-confirm={step.kind}>
      {busy ? 'Sending…' : step.kind === 'apply' ? 'Apply the switch' : 'Approve'}
    </Button></div>
  </div>;
}

type App = SuiteApps['apps'][number];

export function MaintenanceSetForm({ app, message, onMessage, minutes, onMinutes, defaultMinutes, maxTtlMinutes, nowMs,
  reason, onReason, confirmation, onConfirmation, gate, busy, error, onSubmit }: {
  app: App; message: string; onMessage: (next: string) => void; minutes: number | null; onMinutes: (next: number | null) => void;
  defaultMinutes: number; maxTtlMinutes: number | null; nowMs: number; reason: string; onReason: (next: string) => void;
  confirmation: string; onConfirmation: (next: string) => void; gate: Gate; busy: boolean; error: string | null; onSubmit: () => void;
}) {
  return <div className="flex min-w-0 flex-col gap-5">
    <section className="min-w-0 rounded-xl border border-card-border p-4" aria-label="What this stops">
      <h3 className="text-sm font-bold">What this stops</h3>
      <ul className="mt-2 list-disc pl-5 text-sm">
        <li className="break-words">The {app.name} tile shows your message instead of opening.</li>
        <li className="break-words">New hand-offs into {app.name} are refused, at every park.</li>
        <li className="break-words">Sessions already open in {app.name}, platform sign-in and every other app keep working.</li>
      </ul>
      <p className="mt-2 text-xs text-muted-foreground break-words">
        The server has no per-park preview for maintenance: it reaches every park at once, so no count of places or sessions is shown.
      </p>
    </section>
    <Field label="Message on the tile" hint="At most 500 characters.">
      <TextInput value={message} onChange={onMessage} maxLength={500} disabled={busy} />
    </Field>
    <Field label="Minutes until it ends on its own" hint={<>
      Default {defaultMinutes}{maxTtlMinutes !== null ? `, at most ${maxTtlMinutes}` : '; the server sets the maximum'}.{' '}
      {minutes !== null && Number.isInteger(minutes) && minutes >= 1 && (maxTtlMinutes === null || minutes <= maxTtlMinutes)
        && <>If sent now, it ends at <When value={autoRevertAt(nowMs, minutes)} />.</>}
    </>}>
      <NumberInput value={minutes} onChange={onMinutes} min={1} disabled={busy} />
    </Field>
    <ConfirmFields phrase={app.key} reason={reason} onReason={onReason} confirmation={confirmation}
      onConfirmation={onConfirmation} disabled={busy} />
    {error && <ErrorNote message={error} />}
    <Missing gate={gate} />
    <div><Button type="button" onClick={onSubmit} disabled={!gate.ready} data-confirm="maintenance-set">
      {busy ? 'Sending…' : app.storedState === 'maintenance' ? 'Change the window' : 'Start maintenance'}
    </Button></div>
  </div>;
}

export function MaintenanceClearForm({ app, reason, onReason, confirmation, onConfirmation, gate, busy, error, onSubmit }: {
  app: App; reason: string; onReason: (next: string) => void; confirmation: string; onConfirmation: (next: string) => void;
  gate: Gate; busy: boolean; error: string | null; onSubmit: () => void;
}) {
  return <div className="flex min-w-0 flex-col gap-5">
    <p className="text-sm break-words">
      Ends {app.name}&apos;s maintenance now: the tile returns to the state it had before and new hand-offs are accepted again.
    </p>
    {app.maintenance && <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-3 @xl:grid-cols-2">
      <Fact label="Message on the tile">{app.maintenance.message}</Fact>
      <Fact label="Would end on its own at"><When value={app.maintenance.expiresAt} /></Fact>
    </dl>}
    <ConfirmFields phrase={app.key} reason={reason} onReason={onReason} confirmation={confirmation}
      onConfirmation={onConfirmation} disabled={busy} />
    {error && <ErrorNote message={error} />}
    <Missing gate={gate} />
    <div><Button type="button" onClick={onSubmit} disabled={!gate.ready} data-confirm="maintenance-clear">
      {busy ? 'Sending…' : 'End maintenance now'}
    </Button></div>
  </div>;
}
