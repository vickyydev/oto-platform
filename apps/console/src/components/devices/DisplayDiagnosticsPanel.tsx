import { useEffect, useRef, useState } from 'react';
import {
  DISPLAY_TEST_INTENTS, DISPLAY_TEST_STAGES, fleetApi, isMissingRoute,
  type DisplayTestIntent, type DisplayTestResult, type StationRefusalEvent,
} from '@/api/fleet';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/Form';
import { EmptyState, ErrorNote, Loading, RouteUnavailable, Unreadable } from '@/components/Panel';
import { formatExact } from '@/lib/time';

export function DisplayIntentTestPanel({ stationId, displayId, onOpenBoxLog }: {
  stationId: string; displayId: string; onOpenBoxLog?: () => void;
}) {
  const [stage, setStage] = useState<DisplayTestIntent['stage']>('identify');
  const [intent, setIntent] = useState<DisplayTestIntent['intent']>('identify');
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [result, setResult] = useState<DisplayTestResult | null>(null);
  const pending = useRef<DisplayTestIntent | null>(null);
  const inFlight = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    generation.current += 1;
    return () => { generation.current += 1; };
  }, [stationId, displayId]);
  const reset = () => { pending.current = null; setResult(null); setFailed(null); };
  const send = async () => {
    if (inFlight.current) return;
    const currentGeneration = generation.current;
    const body = pending.current ?? { stage, intent, actionId: crypto.randomUUID() };
    pending.current = body;
    inFlight.current = true;
    setBusy(true); setFailed(null); setResult(null);
    try {
      const answer = await fleetApi.displayTestIntent(stationId, displayId, body);
      if (generation.current !== currentGeneration) return;
      if (answer.actionId !== body.actionId || answer.testStage !== body.stage
        || typeof answer.accepted !== 'boolean' || typeof answer.message !== 'string'
        || answer.message.length > 500 || typeof answer.liveStage !== 'string'
        || !Number.isSafeInteger(answer.sequence) || answer.sequence < 0
        || ![null, 'stale', 'no_lease', 'wrong_stage', 'not_permitted', 'unknown_intent'].includes(answer.reason)) {
        throw new Error('Unverified diagnostic result');
      }
      pending.current = null;
      setResult(answer);
    } catch {
      if (generation.current === currentGeneration) setFailed('The test result could not be read. Retry sends the same diagnostic check.');
    } finally {
      inFlight.current = false;
      if (generation.current === currentGeneration) setBusy(false);
    }
  };
  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">Checks the display rules on a diagnostic copy. It does not change the live till, answer for a visitor, change language or collect money.</p>
    <div className="grid gap-3 sm:grid-cols-2">
      <Field label="Stage to test"><Select value={stage} disabled={busy}
        onChange={value => { setStage(value as DisplayTestIntent['stage']); reset(); }}
        options={DISPLAY_TEST_STAGES.map(value => ({ value, label: value }))} /></Field>
      <Field label="Intent"><Select value={intent} disabled={busy}
        onChange={value => { setIntent(value as DisplayTestIntent['intent']); reset(); }}
        options={DISPLAY_TEST_INTENTS.map(value => ({ value, label: value }))} /></Field>
    </div>
    <Button disabled={busy} onClick={() => void send()}>{busy ? 'Checking…' : 'Send test intent'}</Button>
    {failed && <ErrorNote message={failed} />}
    {result && <div role="status" aria-label="Display test result" className="rounded-lg border p-3 text-sm space-y-1">
      <p className="font-semibold">{result.accepted ? 'Accepted for validation only' : `Refused: ${result.reason}`}</p>
      <p>{result.message}</p>
      <p className="text-xs text-muted-foreground">Test stage: {result.testStage}. Live stage: {result.liveStage}. Live till unchanged.</p>
    </div>}
    {onOpenBoxLog && <Button variant="outline" onClick={onOpenBoxLog}>Open Box refusal log</Button>}
  </div>;
}

export function StationRefusalsPanel({ boxId, timezone }: { boxId: string; timezone?: string | null }) {
  const [events, setEvents] = useState<StationRefusalEvent[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [busy, setBusy] = useState(true);
  const [failed, setFailed] = useState(false);
  const [missing, setMissing] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let stopped = false;
    setEvents(null); setBusy(true); setFailed(false); setMissing(false);
    void fleetApi.stationRefusals(boxId).then(result => {
      if (stopped) return;
      const scalar = (value: unknown) => value === null || typeof value === 'string' && value.length <= 200;
      if (!Array.isArray(result.events) || result.events.length > 50 || !result.events.every(event =>
        event && typeof event.id === 'string' && typeof event.stationId === 'string'
        && typeof event.source === 'string' && typeof event.at === 'string' && Number.isFinite(Date.parse(event.at))
        && typeof event.test === 'boolean' && [event.deviceId, event.stage, event.intentType, event.outcome,
          event.errorCode, event.actionId, event.testStage].every(scalar))) throw new Error('Unverified refusal list');
      setEvents(result.events); setTruncated(result.truncated === true);
    }).catch(error => {
      if (stopped) return;
      setMissing(isMissingRoute(error)); setFailed(true);
    }).finally(() => { if (!stopped) setBusy(false); });
    return () => { stopped = true; };
  }, [boxId, refresh]);
  return <section aria-label="Station refusal events">
    <div className="flex items-center justify-between gap-2 mb-2">
      <h3 className="text-sm font-bold">Display and station refusals</h3>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Refresh refusals</Button>
    </div>
    <p className="mb-3 text-xs text-muted-foreground">Protected display calls and station intent refusals recorded by the platform. Diagnostic checks are marked Test. This list is separate from the box's uploaded log below.</p>
    {missing ? <RouteUnavailable what="Station refusals" /> : failed ? <Unreadable what="Station refusals" />
      : busy ? <Loading what="station refusals" /> : events?.length === 0 ? <EmptyState title="No refusals recorded" />
      : <ul className="rounded-xl border divide-y max-h-96 overflow-y-auto">{events?.map(event => <li key={event.id} className="p-3 text-sm space-y-1">
        <div className="flex flex-wrap gap-x-3"><strong>{event.errorCode ?? 'Refused'}</strong><span>{event.test ? 'Test' : 'Protected call / station intent'}</span><span>{event.intentType ?? 'Operation not recorded'}</span></div>
        <p className="text-xs text-muted-foreground">{formatExact(event.at, timezone)} · {event.source} · {event.stage ? `stage ${event.stage}` : 'stage not recorded'}{event.testStage ? ` · test stage ${event.testStage}` : ''}</p>
        <p className="text-xs break-all">Station {event.stationId}{event.deviceId ? ` · display ${event.deviceId}` : ''} · {event.actionId ? `action ${event.actionId}` : 'action not recorded'}</p>
      </li>)}</ul>}
    {truncated && !busy && !failed && <p className="mt-2 text-xs text-muted-foreground">Showing the latest 50 refusals.</p>}
  </section>;
}
