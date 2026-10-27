import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearch } from 'wouter';
import { Search, Waypoints } from 'lucide-react';
import {
  supportApi, type ImpersonationApproval, type ImpersonationCard, type SupportLookup, type SupportQueryKind,
  type SupportTrace, type TraceKind,
} from '@/api/support';
import { ApiError, idemKey } from '@/api/client';
import { useSession } from '@/auth/SessionContext';
import { Field, Select, TextInput } from '@/components/Form';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { CardShell } from '@/components/redesign/layout';
import {
  ActiveWindowCard, ApprovalCards, ImpersonationStartForm, LookupResults, RefusalNote, TraceView,
} from '@/components/support/SupportViews';
import { Button } from '@/components/ui/button';
import { matchingApproval, startGate, traceFromSearch, type StartDraft } from '@/lib/supportRules';
import { useWorkingAuthority } from '@/lib/workingAuthority';

/**
 * SCRUM-648 (S2-23 P5-6) — Support tools: "a customer is standing at the desk
 * and something is wrong". One search box across the suite, the one-action
 * trace (opened directly by the Money oversight links,
 * `/support?trace=<id>&kind=…`), and audited, time-boxed impersonation for
 * platform administrators. Lookup and trace are reads, each recorded; the
 * window is opened, approved and ended here.
 */

type Grant = 'console:support:lookup' | 'console:support:trace' | 'console:support:impersonate';
const KINDS: Array<{ value: '' | SupportQueryKind; label: string }> = [
  { value: '', label: 'Work it out' }, { value: 'phone', label: 'Phone' }, { value: 'band', label: 'Band code' },
  { value: 'receipt', label: 'Receipt number' }, { value: 'booking', label: 'Booking reference' },
  { value: 'voucher', label: 'Voucher code' }, { value: 'account', label: 'Account id' }, { value: 'action', label: 'Action id' },
];
const TRACE_KINDS: Array<{ value: TraceKind; label: string }> = [
  { value: 'action', label: 'Action id' }, { value: 'sale', label: 'Sale id' }, { value: 'receipt', label: 'Receipt number' },
  { value: 'refund', label: 'Refund id' }, { value: 'payment_attempt', label: 'Payment attempt id' }, { value: 'wallet', label: 'Wallet id' },
];
const messageOf = (failure: unknown) => failure instanceof Error ? failure.message : 'The request did not answer.';

/** Operator-wide grants of the working operator, read off the confirmed session. */
function useGrants() {
  const { me, permissions } = useSession();
  const operatorId = me?.operatorContext.effectiveOperatorId;
  const holds = (permission: Grant) => permissions.some(g => g.permission === permission && g.scopeType === 'operator'
    && (g.scopeId === null || g.scopeId === operatorId));
  const platform = (permission: Grant) => !!me?.isPlatformAdmin
    && permissions.some(g => g.permission === permission && g.scopeType === 'operator' && g.scopeId === null);
  return { lookup: holds('console:support:lookup'), trace: holds('console:support:trace'), impersonate: platform('console:support:impersonate') };
}

export function Support() {
  const grants = useGrants();
  if (!grants.lookup && !grants.trace && !grants.impersonate) {
    return <><CommandBar sectionId="support" /><PermissionRequired permission="console:support:lookup" /></>;
  }
  return <div className="flex flex-col gap-5">
    <CommandBar sectionId="support" />
    {grants.lookup && <LookupCard />}
    {grants.trace && <TraceCard />}
    {grants.impersonate && <ImpersonationPanel />}
  </div>;
}

function LookupCard() {
  const working = useWorkingAuthority();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState<'' | SupportQueryKind>('');
  const [state, setState] = useState<{ busy: boolean; answer: SupportLookup | null; error: string | null }>({ busy: false, answer: null, error: null });
  const search = () => {
    if (!q.trim()) return;
    setState({ busy: true, answer: null, error: null });
    void working.run(() => supportApi.lookup(q.trim(), kind || undefined))
      .then(answer => setState({ busy: false, answer, error: null }))
      .catch(failure => setState({ busy: false, answer: null, error: messageOf(failure) }));
  };
  return <CardShell title="Find anything" icon={Search} as="section"
    note="A phone, band, receipt number, booking reference, voucher code, account id or action id. Every search is recorded.">
    <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); search(); }}>
      <div className="min-w-[14rem] flex-1"><Field label="Search"><TextInput value={q} onChange={setQ} maxLength={200} /></Field></div>
      <Field label="Kind"><Select value={kind} onChange={v => setKind(v as '' | SupportQueryKind)} options={KINDS} /></Field>
      <Button type="submit" disabled={state.busy || !q.trim()}>Search</Button>
    </form>
    <div className="mt-4">
      {state.busy && <Loading what="the suite" />}
      {state.error && <ErrorNote message={state.error} />}
      {state.answer && <LookupResults answer={state.answer} />}
    </div>
  </CardShell>;
}

function TraceCard() {
  const working = useWorkingAuthority();
  const linked = traceFromSearch(useSearch());
  const [id, setId] = useState(linked?.id ?? '');
  const [kind, setKind] = useState<TraceKind>(linked?.kind ?? 'action');
  const [state, setState] = useState<{ busy: boolean; trace: SupportTrace | null; error: string | null }>({ busy: false, trace: null, error: null });
  const open = useCallback((target: { id: string; kind: TraceKind }) => {
    setState({ busy: true, trace: null, error: null });
    void working.run(() => supportApi.trace(target.id, target.kind))
      .then(trace => setState({ busy: false, trace, error: null }))
      .catch(failure => setState({ busy: false, trace: null, error: failure instanceof ApiError && failure.code === 'TRACE_NOT_FOUND'
        ? 'Nothing in this park group carries that key.' : messageOf(failure) }));
  }, [working.run]);
  // A Money oversight link lands here with the record named: open it at once.
  const linkedKey = linked ? `${linked.kind}:${linked.id}` : null;
  // Once per linked record: the key, not the parsed object, decides when.
  useEffect(() => { if (linked) open(linked); }, [linkedKey]);
  return <CardShell title="What happened to this sale" icon={Waypoints} as="section"
    note="Till intent, box, device, outbox, cloud apply, audit, payment and rollup — gaps shown, never hidden. Every trace is recorded.">
    <form className="flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); if (id.trim()) open({ id: id.trim(), kind }); }}>
      <div className="min-w-[14rem] flex-1"><Field label="Id or number"><TextInput value={id} onChange={setId} maxLength={128} /></Field></div>
      <Field label="Kind"><Select value={kind} onChange={v => setKind(v as TraceKind)} options={TRACE_KINDS} /></Field>
      <Button type="submit" disabled={state.busy || !id.trim()}>Trace</Button>
    </form>
    <div className="mt-4">
      {state.busy && <Loading what="the trace" />}
      {state.error && <ErrorNote message={state.error} />}
      {state.trace && <TraceView trace={state.trace} />}
    </div>
  </CardShell>;
}

function useNow(everyMs = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

function ImpersonationPanel() {
  const working = useWorkingAuthority();
  const { refreshSession } = useSession();
  const now = useNow();
  const [card, setCard] = useState<ImpersonationCard | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [refusal, setRefusal] = useState<{ code?: string; message: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [launchUrl, setLaunchUrl] = useState<string | null>(null);
  const [draft, setDraft] = useState<StartDraft>({ subjectAccountId: '', targetApp: 'pos', mode: 'read_only', reason: '', reference: '' });
  const reload = useCallback(() => {
    void working.run(() => supportApi.impersonations()).then(answer => { setCard(answer); setReadError(null); })
      .catch(failure => setReadError(messageOf(failure)));
  }, [working.run]);
  useEffect(() => { reload(); }, [reload]);

  const gate = useMemo(() => startGate(draft, { dualControl: card?.dualControl ?? true, approvals: card?.approvals ?? [] }), [draft, card]);
  const act = async (work: () => Promise<unknown>) => {
    setBusy(true); setRefusal(null);
    try { await work(); } catch (failure) {
      setRefusal(failure instanceof ApiError ? { code: failure.code, message: failure.message } : { message: messageOf(failure) });
    } finally { setBusy(false); reload(); void refreshSession().catch(() => undefined); }
  };
  const start = () => act(async () => {
    const approval = draft.mode === 'write_allowed' ? matchingApproval(draft, card?.approvals ?? []) : null;
    const started = await working.run(() => supportApi.start({
      subjectAccountId: draft.subjectAccountId.trim(), targetApp: draft.targetApp, mode: draft.mode,
      ...(draft.mode === 'write_allowed' ? { reason: draft.reason.trim(), reference: draft.reference.trim() } : {}),
      ...(approval ? { approval: { id: approval.id, expectedPayloadSha256: approval.payloadSha256 } } : {}),
    }));
    setLaunchUrl(started.launchUrl);
    window.open(started.launchUrl, '_blank', 'noopener');
  });
  const request = () => act(() => working.run(() => supportApi.requestWrite({ subjectAccountId: draft.subjectAccountId.trim(),
    targetApp: draft.targetApp, reason: draft.reason.trim(), reference: draft.reference.trim() }, idemKey())));
  const approve = (a: ImpersonationApproval) => act(() => working.run(() =>
    supportApi.approveWrite(a.id, { expectedPayloadSha256: a.payloadSha256 }, idemKey())));
  const end = (id: string) => act(() => working.run(() => supportApi.end(id, idemKey())));

  if (readError) return <ErrorNote message={readError} onRetry={reload} />;
  if (!card) return <Loading what="your view-as windows" />;
  const active = card.windows.filter(w => w.state === 'active' && Date.parse(w.expiresAt) > now);
  return <div className="flex flex-col gap-4">
    {active.map(w => <ActiveWindowCard key={w.id} window={w} now={now} busy={busy} onEnd={() => end(w.id)}
      launchUrl={launchUrl} />)}
    <ImpersonationStartForm draft={draft} onDraft={setDraft} gate={gate} maxMinutes={card.maxMinutes} dualControl={card.dualControl}
      busy={busy} onStart={start} onRequest={request} />
    {refusal && <RefusalNote code={refusal.code} message={refusal.message} />}
    <ApprovalCards approvals={card.approvals} now={now} busy={busy} onApprove={approve} />
  </div>;
}
