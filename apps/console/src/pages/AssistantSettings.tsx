import { useCallback, useEffect, useRef, useState } from 'react';
import { Plus, RefreshCw, Save } from 'lucide-react';
import { ApiError, idemKey } from '@/api/client';
import { assistantSettingsApi, type AssistantRate, type AssistantSettingsRead, type AssistantSettingsWrite } from '@/api/assistant-settings';
import { useSession } from '@/auth/SessionContext';
import { Field, NumberInput, TextInput } from '@/components/Form';
import { CONTROL } from '@/components/Filters';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { CardShell, StripedList } from '@/components/redesign/layout';
import { Button } from '@/components/ui/button';

type InternalKey = keyof AssistantSettingsRead['effective']['internal'];
type InboxKey = keyof AssistantSettingsRead['effective']['inbox'];
type NumericField<K extends string> = { key: K; label: string; unit: string; min: number; max?: number };
const INTERNAL: readonly NumericField<InternalKey>[] = [
  { key: 'personDailyCap', label: 'Per-person daily asks', unit: 'asks per Bangkok day', min: 0 },
  { key: 'dailyAskCap', label: 'Operator daily asks', unit: 'asks per Bangkok day', min: 0 },
  { key: 'dailyTokenCap', label: 'Operator daily tokens', unit: 'tokens per Bangkok day', min: 0 },
  { key: 'concurrentPerPerson', label: 'Concurrent asks per person', unit: 'asks at once', min: 1, max: 100 },
  { key: 'concurrentPerOperator', label: 'Concurrent asks per operator', unit: 'asks at once', min: 1, max: 1000 },
];
const INBOX: readonly NumericField<InboxKey>[] = [
  { key: 'dailyTurnCap', label: 'Daily turns', unit: 'turns per Bangkok day', min: 0 },
  { key: 'dailyTokenCap', label: 'Daily tokens', unit: 'tokens per Bangkok day', min: 0 },
  { key: 'debounceSeconds', label: 'Debounce (seconds)', unit: 'seconds', min: 0, max: 600 },
  { key: 'debounceMaxSeconds', label: 'Maximum debounce (seconds)', unit: 'seconds', min: 0, max: 3600 },
  { key: 'firstBubbleMs', label: 'First bubble (milliseconds)', unit: 'milliseconds', min: 0, max: 120000 },
  { key: 'bubbleGapMs', label: 'Bubble gap (milliseconds)', unit: 'milliseconds', min: 0, max: 60000 },
];
type Draft = { internal: Record<InternalKey, number | null>; inbox: Record<InboxKey, number | null>; rates: AssistantSettingsWrite['rates'] };
const draftOf = (data: AssistantSettingsRead): Draft => ({
  internal: { personDailyCap: data.overrides.internal.personDailyCap ?? null, dailyAskCap: data.overrides.internal.dailyAskCap ?? null,
    dailyTokenCap: data.overrides.internal.dailyTokenCap ?? null, concurrentPerPerson: data.overrides.internal.concurrentPerPerson ?? null,
    concurrentPerOperator: data.overrides.internal.concurrentPerOperator ?? null },
  inbox: { dailyTurnCap: data.overrides.inbox.dailyTurnCap ?? null, dailyTokenCap: data.overrides.inbox.dailyTokenCap ?? null,
    debounceSeconds: data.overrides.inbox.debounceSeconds ?? null, debounceMaxSeconds: data.overrides.inbox.debounceMaxSeconds ?? null,
    firstBubbleMs: data.overrides.inbox.firstBubbleMs ?? null, bubbleGapMs: data.overrides.inbox.bubbleGapMs ?? null },
  rates: structuredClone(data.rates),
});
function numericError<K extends string>(fields: readonly NumericField<K>[], values: Record<K, number | null>) {
  for (const field of fields) {
    const value = values[field.key];
    if (value !== null && (!Number.isSafeInteger(value) || value < field.min || value > (field.max ?? Number.MAX_SAFE_INTEGER)))
      return `${field.label} must be a whole number from ${field.min}${field.max === undefined ? ' within the safe number range' : ` to ${field.max}`}.`;
  }
  return null;
}
function bodyOf(data: AssistantSettingsRead, draft: Draft): AssistantSettingsWrite {
  const internal: AssistantSettingsWrite['overrides']['internal'] = {}, inbox: AssistantSettingsWrite['overrides']['inbox'] = {};
  for (const field of INTERNAL) { const value = draft.internal[field.key]; if (value !== null) internal[field.key] = value; }
  for (const field of INBOX) { const value = draft.inbox[field.key]; if (value !== null) inbox[field.key] = value; }
  return { expectedRevision: data.revision, schemaVersion: 1, overrides: { internal, inbox }, rates: structuredClone(draft.rates) };
}

/** Monotonic authority lifetime: returning to the same actor cannot revive an earlier editor. */
export function AssistantSettings() {
  const { state, me, permissions, locked } = useSession();
  const allowed = state === 'signed-in' && !locked && me?.account.status === 'active' && !me.account.mustChangePassword
    && permissions.some(p => p.permission === 'inbox:ai:manage' && p.scopeType === 'operator' && (p.scopeId === null || p.scopeId === me.account.operatorId));
  const key = JSON.stringify([state, me?.account.id, me?.account.operatorId, me?.account.status, me?.account.mustChangePassword, me?.branch?.id, locked,
    permissions.map(p => [p.permission, p.scopeType, p.scopeId]).sort()]);
  const owner = useRef({ key, epoch: 0, mounted: true, allowed });
  if (owner.current.key !== key) { owner.current.key = key; owner.current.epoch++; }
  owner.current.allowed = allowed;
  const epoch = owner.current.epoch;
  const isCurrent = useCallback(() => owner.current.mounted && owner.current.allowed && owner.current.epoch === epoch, [epoch]);
  useEffect(() => { const held = owner; held.current.mounted = true; return () => { held.current.mounted = false; held.current.epoch++; }; }, []);
  if (!allowed || !me) return <><CommandBar sectionId="assistant-settings" /><PermissionRequired permission="inbox:ai:manage" /></>;
  return <SettingsEditor key={epoch} operatorId={me.account.operatorId} isCurrent={isCurrent} />;
}

function SettingsEditor({ operatorId, isCurrent }: { operatorId: string; isCurrent: () => boolean }) {
  const [data, setData] = useState<AssistantSettingsRead | null>(null), [draft, setDraft] = useState<Draft | null>(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [conflict, setConflict] = useState(false), [error, setError] = useState<string | null>(null), [saved, setSaved] = useState(false);
  const mounted = useRef(false), sequence = useRef(0), version = useRef(0), reading = useRef(false), inFlight = useRef(false);
  const canonical = useRef<AssistantSettingsRead | null>(null), pending = useRef<{ body: AssistantSettingsWrite; key: string } | null>(null);
  const conflictRef = useRef(false);
  const current = useCallback(() => mounted.current && isCurrent(), [isCurrent]);
  const read = useCallback(async () => {
    if (!current() || inFlight.current || pending.current) return;
    const held = ++sequence.current; reading.current = true; version.current++;
    setLoading(true); setDraft(null); setError(null); setConflict(false); conflictRef.current = false;
    try {
      const answer = await assistantSettingsApi.read();
      if (!current() || sequence.current !== held) return;
      if (answer.operatorId !== operatorId) throw new Error('The settings response does not belong to the current operator.');
      canonical.current = answer; setData(answer); setDraft(draftOf(answer)); version.current++;
    } catch (failure) {
      if (!current() || sequence.current !== held) return;
      setError(failure instanceof Error ? failure.message : 'Assistant settings could not be read.');
      setData(canonical.current); setDraft(canonical.current ? draftOf(canonical.current) : null); version.current++;
    } finally { if (current() && sequence.current === held) { reading.current = false; setLoading(false); } }
  }, [current, operatorId]);
  useEffect(() => { mounted.current = true; void read(); return () => { mounted.current = false; sequence.current++; version.current++; pending.current = null; canonical.current = null; }; }, [read]);
  const viewVersion = version.current;
  const editable = () => current() && version.current === viewVersion && !reading.current && !inFlight.current && !pending.current && !conflictRef.current;
  const changeInternal = (key: InternalKey, value: number | null) => {
    if (!editable()) return; version.current++; setSaved(false); setDraft(d => d ? { ...d, internal: { ...d.internal, [key]: value } } : null);
  };
  const changeInbox = (key: InboxKey, value: number | null) => {
    if (!editable()) return; version.current++; setSaved(false); setDraft(d => d ? { ...d, inbox: { ...d.inbox, [key]: value } } : null);
  };
  const validation = draft ? numericError(INTERNAL, draft.internal) ?? numericError(INBOX, draft.inbox) : null;
  const save = async () => {
    if (!current() || version.current !== viewVersion || reading.current || inFlight.current || conflictRef.current || !data || !draft || validation) return;
    pending.current ??= { body: structuredClone(bodyOf(data, draft)), key: idemKey() };
    const held = pending.current; inFlight.current = true; setBusy(true); setError(null);
    try {
      const answer = await assistantSettingsApi.save(held.body, held.key);
      if (!current() || pending.current !== held) return;
      if (answer.operatorId !== operatorId) throw new Error('The save could not be confirmed for the current operator.');
      pending.current = null; canonical.current = answer; version.current++;
      setData(answer); setDraft(draftOf(answer)); setUncertain(false); setConflict(false); conflictRef.current = false; setSaved(true);
    } catch (failure) {
      if (!current() || pending.current !== held) return;
      const definite = failure instanceof ApiError && failure.status < 500 && ![408, 429].includes(failure.status) && failure.code !== 'IDEMPOTENCY_IN_FLIGHT';
      if (definite) pending.current = null;
      const stale = failure instanceof ApiError && failure.status === 409 && failure.code !== 'IDEMPOTENCY_IN_FLIGHT';
      conflictRef.current = stale; setConflict(stale); setUncertain(!definite); setSaved(false); version.current++;
      setError(failure instanceof Error ? failure.message : 'The save did not return a confirmed result.');
    } finally { inFlight.current = false; if (current()) setBusy(false); }
  };
  const refresh = () => { if (current() && version.current === viewVersion && !reading.current && !inFlight.current && !pending.current) void read(); };
  const addRate = (rate: AssistantRate) => {
    if (!editable() || !draft || draft.rates.length >= 1000 || draft.rates.some(old => old.model === rate.model && old.effectiveFrom >= rate.effectiveFrom)) return false;
    version.current++; setSaved(false); setDraft(d => d ? { ...d, rates: [...d.rates, rate] } : null); return true;
  };
  const frozen = busy || uncertain || conflict || loading;
  return <>
    <CommandBar sectionId="assistant-settings" actions={<Button variant="outline" onClick={refresh} disabled={loading || busy || uncertain}>
      <RefreshCw className="h-4 w-4" aria-hidden="true" /> Refresh</Button>} />
    <p className="text-sm text-muted-foreground">These settings apply across this operator’s parks. Blank uses the deployment default; zero is an explicit value. Existing assistant rules and channel modes stay in their own screens.</p>
    {saved && <p role="status" className="text-sm text-muted-foreground">Settings saved.</p>}
    {error && <div role="alert"><ErrorNote message={error} onRetry={!data && !uncertain ? refresh : undefined} /></div>}
    {uncertain && <p role="status" className="text-sm text-muted-foreground">The result is uncertain. Retry this same save to check its result before editing. The retry uses the original request.</p>}
    {loading && <Loading what="assistant settings" />}
    {!loading && data && draft && <>
      {data.source === 'invalid' && <p className="rounded-xl border p-3 text-sm">Stored settings are invalid. Deployment defaults are in use.</p>}
      <p className="text-xs text-muted-foreground">{data.source === 'environment' ? 'Deployment defaults are in use.' : data.source === 'operator' ? 'Saved operator settings' : 'Default fallback'} · Revision {data.revision}
        {data.updatedAt && <> · Updated <time dateTime={data.updatedAt}>{data.updatedAt}</time></>}</p>
      <CardShell title="Internal assistant" note="daily caps and concurrent asks">
        <NumericFields fields={INTERNAL} values={draft.internal} effective={data.effective.internal} disabled={frozen} onChange={changeInternal} />
      </CardShell>
      <CardShell title="Inbox assistant" note="daily caps and native pacing units">
        <NumericFields fields={INBOX} values={draft.inbox} effective={data.effective.inbox} disabled={frozen} onChange={changeInbox} />
        <p className="text-xs text-muted-foreground">The effective maximum debounce is at least the effective debounce. A lower saved maximum is retained and normalized when used.</p>
      </CardShell>
      <RateVersions key={JSON.stringify([data.revision, data.rates])} saved={data.rates} pending={draft.rates.slice(data.rates.length)} disabled={frozen}
        canEdit={editable} onAdd={addRate} />
      {validation && <p className="text-sm text-muted-foreground">{validation}</p>}
      {conflict ? <Button onClick={refresh}>Reload and review</Button> : null}
      <Button onClick={() => void save()} disabled={loading || busy || conflict || !!validation}>
        <Save className="h-4 w-4" aria-hidden="true" />{busy ? 'Saving…' : uncertain ? 'Retry same save' : 'Save settings'}
      </Button>
    </>}
  </>;
}

function NumericFields<K extends string>({ fields, values, effective, disabled, onChange }: {
  fields: readonly NumericField<K>[]; values: Record<K, number | null>; effective: Record<K, number>; disabled: boolean; onChange: (key: K, value: number | null) => void;
}) {
  return <div className="grid min-w-0 gap-4 @2xl:grid-cols-2">{fields.map(field => <Field key={field.key} label={field.label}
    hint={<>{values[field.key] === null ? 'Deployment default' : 'Current override'} · Effective: {effective[field.key].toLocaleString('en-US')} {field.unit}. Blank uses the deployment default.</>}>
    <NumberInput value={values[field.key]} min={field.min} disabled={disabled} onChange={value => onChange(field.key, value)} />
  </Field>)}</div>;
}

function RateVersions({ saved, pending, disabled, canEdit, onAdd }: {
  saved: AssistantRate[]; pending: AssistantRate[]; disabled: boolean; canEdit: () => boolean; onAdd: (rate: AssistantRate) => boolean;
}) {
  const [model, setModel] = useState(''), [effectiveFrom, setEffectiveFrom] = useState('');
  const [input, setInput] = useState<number | null>(null), [output, setOutput] = useState<number | null>(null), [cache, setCache] = useState<number | null>(null);
  const all = [...saved, ...pending], millis = effectiveFrom ? Date.parse(effectiveFrom + 'Z') : NaN;
  const utc = Number.isFinite(millis) ? new Date(millis).toISOString() : '';
  const identity = model.trim();
  const valid = identity.length > 0 && identity.length <= 200 && !!utc && utc.slice(0, 16) === effectiveFrom.slice(0, 16)
    && [input, output, cache].every(value => value !== null && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER)
    && all.length < 1000 && !all.some(rate => rate.model === identity && rate.effectiveFrom >= utc);
  const edit = (action: () => void) => { if (canEdit() && !disabled) action(); };
  const rows = (rates: AssistantRate[], label: string) => <StripedList label={label}>{rates.map(rate => <li key={JSON.stringify([rate.model, rate.effectiveFrom])} className="min-w-0 p-3 text-sm">
    <p className="font-semibold break-words [overflow-wrap:anywhere]">{rate.model}</p><p className="break-words">From <time dateTime={rate.effectiveFrom}>{rate.effectiveFrom}</time> UTC</p>
    <p className="break-words">USD per million tokens · Input {rate.inputUsdPerMillion} · Output {rate.outputUsdPerMillion} · Cache-read {rate.cacheReadUsdPerMillion}</p>
  </li>)}</StripedList>;
  return <CardShell title="Price estimates" note="versioned model rates in USD per million tokens">
    <p className="text-sm text-muted-foreground">Rates price usage; they do not select the assistant’s model. The estimate excludes unpersisted cache writes. Models without an effective rate retain an unpriced tokens remainder.</p>
    {!saved.length && <p className="text-sm text-muted-foreground">No rates configured. Spend is unavailable until an applicable rate is saved.</p>}
    {rows(saved, 'Saved rate versions')}
    {!!pending.length && <><p className="text-sm font-semibold">New versions in this draft</p>{rows(pending, 'Pending rate versions')}</>}
    <p className="text-xs text-muted-foreground">Saved versions cannot be changed or removed. Add a later version for the same model to change its rates.</p>
    <div className="grid min-w-0 gap-4 @2xl:grid-cols-2">
      <Field label="Pricing model"><TextInput value={model} maxLength={200} disabled={disabled} onChange={value => edit(() => setModel(value))} /></Field>
      <Field label="Effective from (UTC)"><input type="datetime-local" value={effectiveFrom} disabled={disabled} onChange={event => edit(() => setEffectiveFrom(event.target.value))} className={CONTROL} /></Field>
      {([['Input USD per million', input, setInput], ['Output USD per million', output, setOutput], ['Cache-read USD per million', cache, setCache]] as const).map(([label, value, change]) =>
        <Field key={label} label={label}><input type="number" min={0} step="any" value={value ?? ''} disabled={disabled} className={CONTROL}
          onChange={event => { const next = event.target.value; edit(() => change(next.trim() === '' ? null : Number(next))); }} /></Field>)}
    </div>
    <Button variant="outline" disabled={disabled || !valid} onClick={() => {
      if (!canEdit() || disabled || !valid || input === null || output === null || cache === null) return;
      if (onAdd({ model: identity, effectiveFrom: utc, inputUsdPerMillion: input, outputUsdPerMillion: output, cacheReadUsdPerMillion: cache })) {
        setModel(''); setEffectiveFrom(''); setInput(null); setOutput(null); setCache(null);
      }
    }}><Plus className="h-4 w-4" aria-hidden="true" /> Add rate version</Button>
  </CardShell>;
}
