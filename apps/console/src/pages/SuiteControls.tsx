import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AppWindow, History, RefreshCw, Server } from 'lucide-react';
import {
  suiteControlsApi, type SuiteAgents, type SuiteApps, type SuiteFlagPreview, type SuiteFlags, type SuiteReleases,
} from '@/api/suite-controls';
import { ApiError, idemKey } from '@/api/client';
import { directoryApi } from '@/api/platform';
import { fleetApi } from '@/api/fleet';
import { useSession } from '@/auth/SessionContext';
import { Drawer } from '@/components/Drawer';
import { ErrorNote, Fact, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { CardShell } from '@/components/redesign/layout';
import { BarChip, StatusChip } from '@/components/redesign/chips';
import { EmptyNote } from '@/components/redesign/StatTile';
import {
  FeatureFlagsCard, KillSwitchCard, MaintenanceClearForm, MaintenanceSetForm, ReviewForm, SwitchOffForm, SwitchOnForm,
  WriteLocked, type PlaceOption,
} from '@/components/suite/SuiteControlViews';
import { Button } from '@/components/ui/button';
import {
  approvalStep, choiceOfOperation, maintenanceClearGate, maintenanceSetGate, operationOf, previewMatches, previewQuery,
  revisionAt, reviewGate, switchOffGate, switchOnGate,
  type CatalogueEntry, type FlagOverride, type PendingApproval, type ScopeType, type SwitchChoice,
} from '@/lib/suiteControlRules';
import { formatExact } from '@/lib/time';
import { useWorkingAuthority } from '@/lib/workingAuthority';

type Page = 'apps' | 'releases';
type ReadPermission = 'console:app_registry:read' | 'console:release:read';
type WritePermission = 'console:app_registry:manage' | 'console:release:kill_switch';
const MAINTENANCE_DEFAULT_MINUTES = 60;

/** A registry/history answer belongs to one confirmed working-session epoch. */
function useSuiteAuthority(permission: ReadPermission) {
  const working = useWorkingAuthority();
  const { state, refreshing, me, permissions } = useSession();
  const operatorId = me?.operatorContext.effectiveOperatorId;
  const allowed = working.isCurrent() && state === 'signed-in' && !refreshing && !!operatorId
    && me?.account.status === 'active' && !me.account.mustChangePassword && !me.sessionLocked
    && permissions.some(grant => grant.permission === permission && grant.scopeType === 'operator'
      && (grant.scopeId === null || grant.scopeId === operatorId));
  const key = JSON.stringify([working.epoch, permission, state, refreshing, me?.operatorContext,
    me?.account.id, me?.account.status, me?.account.mustChangePassword, me?.sessionLocked, me?.isPlatformAdmin,
    permissions.map(grant => [grant.permission, grant.scopeType, grant.scopeId]).sort()]);
  const owner = useRef({ key, allowed, mounted: true, epoch: 0 });
  if (owner.current.key !== key) { owner.current.key = key; owner.current.epoch++; }
  owner.current.allowed = allowed;
  const epoch = owner.current.epoch;
  useEffect(() => {
    owner.current.mounted = true;
    return () => { owner.current.mounted = false; owner.current.epoch++; };
  }, []);
  const isCurrent = useCallback(() => working.isCurrent() && owner.current.mounted && owner.current.allowed
    && owner.current.epoch === epoch, [epoch, working.isCurrent]);
  return { key, allowed, operatorId, accountId: me?.account.id ?? null, isCurrent, run: working.run };
}
type Authority = ReturnType<typeof useSuiteAuthority>;

/**
 * An offer only (S2-23: platform administrators only): the write permission
 * held platform-wide, by a platform administrator. The server re-checks the
 * system `platform_admin` role inside every write's transaction.
 */
function useWriteGrant(permission: WritePermission): boolean {
  const { me, permissions } = useSession();
  return !!me?.isPlatformAdmin && permissions.some(grant => grant.permission === permission
    && grant.scopeType === 'operator' && grant.scopeId === null);
}

function useSuiteRead<T>(read: () => Promise<T>, authority: Authority, enabled = true) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ read: typeof read; retry: number; answer: T | null; error: string | null } | null>(null);
  const currentRead = useRef(read);
  currentRead.current = read;
  useEffect(() => {
    if (!enabled || !authority.allowed || !authority.isCurrent()) return;
    let active = true;
    setState({ read, retry, answer: null, error: null });
    void authority.run(read).then(answer => {
      if (active && currentRead.current === read && authority.isCurrent()) setState({ read, retry, answer, error: null });
    }).catch((failure: unknown) => {
      if (active && currentRead.current === read && authority.isCurrent()) setState({ read, retry, answer: null,
        error: failure instanceof Error ? failure.message : 'This read did not answer.' });
    });
    return () => { active = false; };
  }, [read, retry, enabled, authority.allowed, authority.isCurrent, authority.run]);
  const current = enabled && authority.allowed && state?.read === read && state.retry === retry;
  return {
    answer: current ? state.answer : null,
    error: current ? state.error : null,
    refresh: () => { if (authority.isCurrent()) setRetry(value => value + 1); },
  };
}

/** The clock the expiry words read; a request's ten minutes are shown lapsing without a reload. */
function useNow(everyMs = 15_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), everyMs);
    return () => window.clearInterval(timer);
  }, [everyMs]);
  return now;
}

/**
 * One keyed send: a retry after a request that never answered re-sends the
 * same body under the same Idempotency-Key, so it is the same change; once the
 * server has answered (a refusal included), the next press is a new attempt.
 */
function useKeyedSend() {
  const held = useRef<{ inputs: string; body: unknown; key: string } | null>(null);
  return useCallback(async <B, T>(inputs: string, build: () => B, send: (body: B, key: string) => Promise<T>): Promise<T> => {
    if (!held.current || held.current.inputs !== inputs) held.current = { inputs, body: build(), key: idemKey() };
    const { body, key } = held.current;
    try {
      const answer = await send(body as B, key);
      held.current = null;
      return answer;
    } catch (failure) {
      if (failure instanceof ApiError) held.current = null;
      throw failure;
    }
  }, []);
}

const messageOf = (failure: unknown) => failure instanceof Error ? failure.message : 'The request did not answer.';

export function SuiteControls({ page }: { page: Page }) {
  const permission = page === 'apps' ? 'console:app_registry:read' : 'console:release:read';
  const authority = useSuiteAuthority(permission);
  const canWrite = useWriteGrant(page === 'apps' ? 'console:app_registry:manage' : 'console:release:kill_switch');
  if (!authority.allowed) return <><CommandBar sectionId={page} /><PermissionRequired permission={permission} /></>;
  return page === 'apps'
    ? <Apps key={`${authority.key}:${canWrite}`} authority={authority} canManage={canWrite} />
    : <Releases key={`${authority.key}:${canWrite}`} authority={authority} canWrite={canWrite} />;
}

function Stamp({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{formatExact(value)}</time> : <>Not recorded</>;
}

function Notice({ text }: { text: string | null }) {
  return text ? <p role="status" className="rounded-xl border px-4 py-3 text-sm break-words">{text}</p> : null;
}

// --- Apps: registry tiles and maintenance ---------------------------------------

type MaintenanceOpen = { mode: 'set' | 'clear'; app: SuiteApps['apps'][number] };

function Apps({ authority, canManage }: { authority: Authority; canManage: boolean }) {
  const { answer, error, refresh } = useSuiteRead(suiteControlsApi.apps, authority);
  // Only for the maximum window: a person who cannot read it still gets the server's own refusal.
  const settings = useSuiteRead(suiteControlsApi.flags, authority, canManage);
  const [open, setOpen] = useState<MaintenanceOpen | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const close = useCallback(() => setOpen(null), []);
  return <>
    <CommandBar sectionId="apps" badges={<BarChip>{canManage ? 'Platform controls' : 'Read only'}</BarChip>} actions={
      <Button variant="outline" onClick={refresh} disabled={!answer && !error}><RefreshCw className="h-4 w-4" />Refresh</Button>
    } />
    {!canManage && <WriteLocked permission="console:app_registry:manage" what="Starting or ending an app's maintenance" />}
    <Notice text={notice} />
    {error ? <ErrorNote message={error} onRetry={refresh} /> : !answer ? <Loading what="app registry" /> : <>
      <p className="text-xs text-muted-foreground">Registry read at <Stamp value={answer.generatedAt} />.</p>
      {answer.apps.length === 0 ? <CardShell title="App registry"><EmptyNote title="No apps are recorded." /></CardShell>
        : answer.apps.map(app => <AppRecord key={app.id} app={app} actions={canManage ? <>
          <Button type="button" size="sm" variant="outline" onClick={() => { setNotice(null); setOpen({ mode: 'set', app }); }}>
            {app.storedState === 'maintenance' ? 'Change maintenance window…' : 'Start maintenance…'}
          </Button>
          {app.storedState === 'maintenance' && <Button type="button" size="sm" variant="outline"
            onClick={() => { setNotice(null); setOpen({ mode: 'clear', app }); }}>End maintenance…</Button>}
        </> : null} />)}
    </>}
    {open && <MaintenanceDrawer key={`${open.mode}:${open.app.key}:${open.app.revision}`} open={open} authority={authority}
      maxTtlMinutes={settings.answer?.maxTtlMinutes ?? null} onClose={close}
      onDone={text => { setOpen(null); setNotice(text); refresh(); }} />}
  </>;
}

function MaintenanceDrawer({ open, authority, maxTtlMinutes, onClose, onDone }: {
  open: MaintenanceOpen; authority: Authority; maxTtlMinutes: number | null; onClose: () => void; onDone: (notice: string) => void;
}) {
  const { app, mode } = open;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  const current = () => mounted.current && authority.isCurrent();
  const now = useNow();
  const send = useKeyedSend();
  const [message, setMessage] = useState(app.maintenance?.message ?? '');
  const [minutes, setMinutes] = useState<number | null>(MAINTENANCE_DEFAULT_MINUTES);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (gateReady: boolean) => {
    if (!gateReady || busy || !current()) return;
    setBusy(true); setError(null);
    try {
      if (mode === 'set') {
        await send(JSON.stringify([message, minutes, reason, confirmation]), () => ({
          message: message.trim(), expiresAt: new Date(Date.now() + (minutes ?? MAINTENANCE_DEFAULT_MINUTES) * 60_000).toISOString(),
          reason: reason.trim(), expectedRevision: app.revision, confirmation,
        }), (body, key) => authority.run(() => suiteControlsApi.setMaintenance(app.key, body, key)));
        if (current()) onDone(`${app.name} is in maintenance. The tile shows the message and new hand-offs are refused until it ends.`);
      } else {
        await send(JSON.stringify([reason, confirmation]), () => ({ reason: reason.trim(), expectedRevision: app.revision, confirmation }),
          (body, key) => authority.run(() => suiteControlsApi.clearMaintenance(app.key, body, key)));
        if (current()) onDone(`${app.name} maintenance has ended.`);
      }
    } catch (failure) {
      if (current()) setError(messageOf(failure));
    } finally {
      if (current()) setBusy(false);
    }
  };
  if (mode === 'clear') {
    const gate = maintenanceClearGate({ appKey: app.key, reason, confirmation, busy });
    return <Drawer title={`End ${app.name} maintenance`} onClose={onClose}>
      <MaintenanceClearForm app={app} reason={reason} onReason={setReason} confirmation={confirmation} onConfirmation={setConfirmation}
        gate={gate} busy={busy} error={error} onSubmit={() => void submit(gate.ready)} />
    </Drawer>;
  }
  const gate = maintenanceSetGate({ appKey: app.key, message, minutes, maxTtlMinutes, reason, confirmation, busy });
  return <Drawer title={`${app.name} maintenance`} onClose={onClose}>
    <MaintenanceSetForm app={app} message={message} onMessage={setMessage} minutes={minutes} onMinutes={setMinutes}
      defaultMinutes={MAINTENANCE_DEFAULT_MINUTES} maxTtlMinutes={maxTtlMinutes} nowMs={now} reason={reason} onReason={setReason}
      confirmation={confirmation} onConfirmation={setConfirmation} gate={gate} busy={busy} error={error}
      onSubmit={() => void submit(gate.ready)} />
  </Drawer>;
}

const tileWords = { open: 'Open', coming_soon: 'Coming soon', hidden: 'Hidden', maintenance: 'Maintenance' };
function AppRecord({ app, actions }: { app: SuiteApps['apps'][number]; actions?: ReactNode }) {
  return <CardShell title={app.name} icon={AppWindow} badge={
    <StatusChip tone={app.effectiveState === 'maintenance' ? 'warn' : app.effectiveState === 'open' ? 'ok' : 'idle'}>
      {tileWords[app.effectiveState]}
    </StatusChip>
  } note={app.key} actions={actions ?? undefined}>
    <p className="text-sm break-words">{app.purpose}</p>
    <dl className="grid min-w-0 grid-cols-1 gap-x-6 gap-y-4 @xl:grid-cols-2 @3xl:grid-cols-3">
      <Fact label="Saved tile state">{tileWords[app.storedState]}</Fact>
      <Fact label="Owning service">{app.owningService}</Fact>
      <Fact label="Schema">{app.schemaName}</Fact>
      <Fact label="Version source">{app.versionSource}</Fact>
      <Fact label="Required permission"><code className="text-xs break-all">{app.requiredPermission}</code></Fact>
      <Fact label="Sort order">{app.sortOrder}</Fact>
      <Fact label="Revision">{app.revision}</Fact>
      <Fact label="Health address">{app.healthUrl ? <code className="text-xs break-all">{app.healthUrl}</code> : 'Not recorded'}</Fact>
    </dl>
    <div className="min-w-0 border-t border-card-border pt-3">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Origins by environment</p>
      {Object.keys(app.origins).length === 0 ? <p className="mt-2 text-sm">Not recorded</p> :
        <dl className="mt-2 grid min-w-0 grid-cols-1 gap-3 @xl:grid-cols-2">{Object.entries(app.origins).map(([environment, origin]) =>
          <Fact key={environment} label={environment}><code className="text-xs break-all">{origin}</code></Fact>)}</dl>}
    </div>
    {app.maintenance && <div className="min-w-0 border-t border-card-border pt-3">
      <p className="font-semibold text-sm">Maintenance message</p>
      <p className="mt-1 text-sm break-words">{app.maintenance.message}</p>
      <p className="mt-2 text-xs text-muted-foreground">Ends on its own at <Stamp value={app.maintenance.expiresAt} /></p>
    </div>}
  </CardShell>;
}

// --- Releases: switches, flags, history, agents -----------------------------------

type SwitchOpen = { kind: 'on'; entry: CatalogueEntry } | { kind: 'off'; override: FlagOverride } | { kind: 'review'; approval: PendingApproval };

function Releases({ authority, canWrite }: { authority: Authority; canWrite: boolean }) {
  const [offset, setOffset] = useState(0);
  const [agentOffset, setAgentOffset] = useState(0);
  const read = useCallback(() => suiteControlsApi.releases(offset), [offset]);
  const { answer, error, refresh } = useSuiteRead(read, authority);
  const readAgents = useCallback(async () => {
    const agents = await suiteControlsApi.agents(agentOffset);
    if (agents.operatorId !== authority.operatorId) throw new Error('Agent version records belong to a different operator.');
    return agents;
  }, [agentOffset, authority.operatorId]);
  const agents = useSuiteRead(readAgents, authority);
  const flags = useSuiteRead(suiteControlsApi.flags, authority);
  const now = useNow();
  const [open, setOpen] = useState<SwitchOpen | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const done = (text: string) => { setOpen(null); setNotice(text); flags.refresh(); };
  const choose = (next: SwitchOpen) => { if (authority.isCurrent()) { setNotice(null); setOpen(next); } };
  return <>
    <CommandBar sectionId="releases" badges={<BarChip>{canWrite ? 'Platform controls' : 'Read only'}</BarChip>} actions={
      <Button variant="outline" onClick={() => { refresh(); agents.refresh(); flags.refresh(); }}
        disabled={!answer && !error && !agents.answer && !agents.error && !flags.answer && !flags.error}>
        <RefreshCw className="h-4 w-4" />Refresh
      </Button>
    } />
    <Notice text={notice} />
    {flags.error ? <CardShell title="Kill switches"><ErrorNote message={flags.error} onRetry={flags.refresh} /></CardShell>
      : !flags.answer ? <CardShell title="Kill switches"><Loading what="kill switches" /></CardShell> : <>
        <KillSwitchCard flags={flags.answer} me={authority.accountId} canWrite={canWrite} nowMs={now}
          onSwitchOn={entry => choose({ kind: 'on', entry })} onSwitchOff={override => choose({ kind: 'off', override })}
          onReview={approval => choose({ kind: 'review', approval })} />
        <FeatureFlagsCard flags={flags.answer} />
      </>}
    {error ? <ErrorNote message={error} onRetry={refresh} /> : !answer ? <Loading what="release history" /> :
      <CardShell title="Recorded releases" icon={History} note={<>Read at <Stamp value={answer.generatedAt} /></>} footer={
        <>
          <span>{answer.total === 0 ? '0 records' : answer.deployments.length === 0
            ? `0 records on this page; ${answer.total} ${answer.total === 1 ? 'record' : 'records'} total`
            : `${answer.offset + 1}–${answer.offset + answer.deployments.length} of ${answer.total} records`}</span>
          <div className="flex min-w-0 flex-wrap gap-2">
            <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => {
              if (authority.isCurrent()) setOffset(Math.max(0, offset - answer.limit));
            }}>Newer releases</Button>
            <Button variant="outline" size="sm" disabled={offset + answer.limit >= answer.total} onClick={() => {
              if (authority.isCurrent()) setOffset(offset + answer.limit);
            }}>Older releases</Button>
          </div>
        </>
      }>
        <DeployHistoryBody answer={answer} />
      </CardShell>}
    <AgentVersions answer={agents.answer} error={agents.error} refresh={agents.refresh} offset={agentOffset} onOffset={next => {
      if (authority.isCurrent()) setAgentOffset(next);
    }} />
    {open && flags.answer && <SwitchDrawer key={drawerKey(open)} open={open} flags={flags.answer} authority={authority}
      canWrite={canWrite} onClose={close} onDone={done} />}
  </>;
}

const drawerKey = (open: SwitchOpen) => open.kind === 'on' ? `on:${open.entry.flagKey}`
  : open.kind === 'off' ? `off:${open.override.id}:${open.override.revision}` : `review:${open.approval.id}:${open.approval.state}`;

/** The history, or an honest note that nothing has been recorded — never a table that implies zero deploys. */
export function DeployHistoryBody({ answer }: { answer: SuiteReleases }) {
  if (answer.deployments.length > 0) return <>{answer.deployments.map(release => <ReleaseRecord key={release.id} release={release} />)}</>;
  return answer.total === 0
    ? <EmptyNote title="No releases are recorded."
      detail="Nothing has reported a deploy to this history yet. That is not a statement that nothing was deployed; no deployment status is inferred." />
    : <EmptyNote title="No releases on this page." detail="Use Newer releases to read the recorded history." />;
}

function SwitchDrawer({ open, flags, authority, canWrite, onClose, onDone }: {
  open: SwitchOpen; flags: SuiteFlags; authority: Authority; canWrite: boolean; onClose: () => void; onDone: (notice: string) => void;
}) {
  if (open.kind === 'on') return <SwitchOnDrawer entry={open.entry} flags={flags} authority={authority} onClose={onClose} onDone={onDone} />;
  if (open.kind === 'off') {
    const entry = flags.catalogue.find(row => row.flagKey === open.override.flagKey);
    return entry ? <SwitchOffDrawer entry={entry} override={open.override} authority={authority} onClose={onClose} onDone={onDone} /> : null;
  }
  return <ReviewDrawer approval={open.approval} flags={flags} authority={authority} canWrite={canWrite} onClose={onClose} onDone={onDone} />;
}

/** The preview of one exact choice; a late answer for an older choice never replaces a newer one. */
function usePreview(authority: Authority) {
  const [state, setState] = useState<{ preview: SuiteFlagPreview | null; busy: boolean; error: string | null }>(
    { preview: null, busy: false, error: null });
  const sequence = useRef(0);
  const { run, isCurrent } = authority;
  const ask = useCallback((choice: SwitchChoice) => {
    if (!isCurrent()) return;
    const mine = ++sequence.current;
    setState(old => ({ ...old, busy: true, error: null }));
    void run(() => suiteControlsApi.preview(previewQuery(choice))).then(preview => {
      if (mine !== sequence.current || !isCurrent()) return;
      setState(previewMatches(preview, choice) ? { preview, busy: false, error: null }
        : { preview: null, busy: false, error: 'The preview that came back was for a different choice. Preview again.' });
    }).catch((failure: unknown) => {
      if (mine === sequence.current && isCurrent()) setState({ preview: null, busy: false, error: messageOf(failure) });
    });
  }, [run, isCurrent]);
  return { ...state, ask };
}

type Places = { list: PlaceOption[] | null; error: string | null };
const NOT_READ: Places = { list: null, error: null };

/** The parks and stations a switch can name, read once per drawer and per park. */
function usePlaces(authority: Authority, needBranches: boolean, branchId: string, needStations: boolean) {
  const { run, isCurrent } = authority;
  const [branches, setBranches] = useState<Places>(NOT_READ);
  const [stations, setStations] = useState<Record<string, Places>>({});
  useEffect(() => {
    if (!needBranches || !isCurrent()) return;
    let active = true;
    void run(() => directoryApi.branches()).then(answer => {
      if (active && isCurrent()) setBranches({ list: answer.branches.filter(row => !row.archived)
        .map(row => ({ id: row.id, name: row.name })), error: null });
    }).catch((failure: unknown) => { if (active && isCurrent()) setBranches({ list: null, error: messageOf(failure) }); });
    return () => { active = false; };
  }, [needBranches, run, isCurrent]);
  useEffect(() => {
    if (!needStations || !branchId || !isCurrent()) return;
    let active = true;
    void run(() => fleetApi.stations(branchId)).then(answer => {
      if (active && isCurrent()) setStations(old => ({ ...old, [branchId]: { list: answer.stations.filter(row => !row.archived)
        .map(row => ({ id: row.id, name: row.name })), error: null } }));
    }).catch((failure: unknown) => {
      if (active && isCurrent()) setStations(old => ({ ...old, [branchId]: { list: null, error: messageOf(failure) } }));
    });
    return () => { active = false; };
  }, [needStations, branchId, run, isCurrent]);
  return { branches, stations: stations[branchId] ?? NOT_READ };
}

function SwitchOnDrawer({ entry, flags, authority, onClose, onDone }: {
  entry: CatalogueEntry; flags: SuiteFlags; authority: Authority; onClose: () => void; onDone: (notice: string) => void;
}) {
  const now = useNow();
  const send = useKeyedSend();
  const preview = usePreview(authority);
  const [scopeType, setScopeType] = useState<ScopeType>(entry.scopes[0] ?? 'platform');
  const [branchId, setBranchId] = useState('');
  const [stationId, setStationId] = useState('');
  const [minutes, setMinutes] = useState<number | null>(flags.defaultTtlMinutes);
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const places = usePlaces(authority, scopeType === 'branch' || scopeType === 'station', branchId, scopeType === 'station');
  const operatorId = authority.operatorId ?? null;
  const choice = useMemo<SwitchChoice>(() => {
    const at = (scopeId: string | null, owner: string | null) => ({ key: entry.flagKey, scopeType, scopeId, operatorId: owner, value: 'true' });
    if (scopeType === 'platform') return at(null, null);
    if (scopeType === 'operator') return at(operatorId, operatorId);
    if (scopeType === 'branch') return at(branchId || null, operatorId);
    return at(stationId || null, operatorId);
  }, [entry.flagKey, scopeType, branchId, stationId, operatorId]);
  const gate = switchOnGate({ choice, preview: preview.preview, minutes, maxTtlMinutes: flags.maxTtlMinutes, reason, confirmation, busy });
  const submit = async () => {
    if (!gate.ready || busy || !authority.isCurrent()) return;
    setBusy(true); setError(null);
    try {
      const body = () => ({ key: choice.key, scopeType: choice.scopeType, scopeId: choice.scopeId, operatorId: choice.operatorId,
        value: true, expiresAt: new Date(Date.now() + (minutes ?? flags.defaultTtlMinutes) * 60_000).toISOString(), reason: reason.trim(),
        expectedRevision: revisionAt(flags.overrides, choice.key, choice.scopeType, choice.scopeId), confirmation });
      const inputs = JSON.stringify([choice, minutes, reason, confirmation, flags.killSwitchDualControl]);
      if (flags.killSwitchDualControl) {
        await send(inputs, body, (b, key) => authority.run(() => suiteControlsApi.requestSwitch(b, key)));
        if (authority.isCurrent()) onDone(`${entry.label}: request recorded. A different platform administrator must approve it within ten minutes.`);
      } else {
        await send(inputs, body, (b, key) => authority.run(() => suiteControlsApi.setSwitch(b, key)));
        if (authority.isCurrent()) onDone(`${entry.label} is on.`);
      }
    } catch (failure) {
      if (authority.isCurrent()) setError(messageOf(failure));
    } finally {
      if (authority.isCurrent()) setBusy(false);
    }
  };
  return <Drawer title={entry.label} subtitle="Switch on" onClose={onClose}>
    <SwitchOnForm entry={entry} dualControl={flags.killSwitchDualControl} defaultTtlMinutes={flags.defaultTtlMinutes}
      maxTtlMinutes={flags.maxTtlMinutes} scopeType={scopeType}
      onScopeType={next => { setScopeType(next); setStationId(''); if (next !== 'branch' && next !== 'station') setBranchId(''); }}
      branches={places.branches.list} branchesError={places.branches.error} branchId={branchId}
      onBranch={next => { setBranchId(next); setStationId(''); }}
      stations={places.stations.list} stationsError={places.stations.error} stationId={stationId} onStation={setStationId}
      minutes={minutes} onMinutes={setMinutes} nowMs={now} choice={choice} preview={preview.preview} previewBusy={preview.busy}
      previewError={preview.error} onPreview={() => preview.ask(choice)} reason={reason} onReason={setReason}
      confirmation={confirmation} onConfirmation={setConfirmation} gate={gate} busy={busy} error={error} onSubmit={() => void submit()} />
  </Drawer>;
}

function SwitchOffDrawer({ entry, override, authority, onClose, onDone }: {
  entry: CatalogueEntry; override: FlagOverride; authority: Authority; onClose: () => void; onDone: (notice: string) => void;
}) {
  const send = useKeyedSend();
  const [reason, setReason] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = switchOffGate({ key: entry.flagKey, reason, confirmation, busy });
  const submit = async () => {
    if (!gate.ready || busy || !authority.isCurrent()) return;
    setBusy(true); setError(null);
    try {
      await send(JSON.stringify([override.id, override.revision, reason, confirmation]), () => ({
        key: override.flagKey, scopeType: override.scopeType, scopeId: override.scopeId, operatorId: override.operatorId,
        expectedRevision: override.revision, reason: reason.trim(), confirmation,
      }), (body, key) => authority.run(() => suiteControlsApi.clearSwitch(body, key)));
      if (authority.isCurrent()) onDone(`${entry.label} is off there; service is restored.`);
    } catch (failure) {
      if (authority.isCurrent()) setError(messageOf(failure));
    } finally {
      if (authority.isCurrent()) setBusy(false);
    }
  };
  return <Drawer title={entry.label} subtitle="Switch off" onClose={onClose}>
    <SwitchOffForm entry={entry} override={override} reason={reason} onReason={setReason} confirmation={confirmation}
      onConfirmation={setConfirmation} gate={gate} busy={busy} error={error} onSubmit={() => void submit()} />
  </Drawer>;
}

function ReviewDrawer({ approval, flags, authority, canWrite, onClose, onDone }: {
  approval: PendingApproval; flags: SuiteFlags; authority: Authority; canWrite: boolean; onClose: () => void; onDone: (notice: string) => void;
}) {
  const now = useNow();
  const send = useKeyedSend();
  const preview = usePreview(authority);
  const op = operationOf(approval);
  const choice = choiceOfOperation(op);
  const entry = flags.catalogue.find(row => row.flagKey === op?.key) ?? null;
  const step = approvalStep(approval, authority.accountId, canWrite, now);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const gate = reviewGate({ choice, preview: preview.preview, confirmation, busy });
  if (!op) return null;
  const submit = async () => {
    if (!gate.ready || !step.enabled || busy || !authority.isCurrent()) return;
    setBusy(true); setError(null);
    try {
      const body = () => ({ expectedPayloadSha256: approval.payloadSha256, confirmation });
      if (step.kind === 'approve') {
        await send(JSON.stringify(['approve', approval.id, confirmation]), body,
          (b, key) => authority.run(() => suiteControlsApi.approveSwitch(approval.id, b, key)));
        if (authority.isCurrent()) onDone(`${entry?.label ?? op.key}: approved. Either administrator can now apply it.`);
      } else if (step.kind === 'apply') {
        await send(JSON.stringify(['apply', approval.id, confirmation]), body,
          (b, key) => authority.run(() => suiteControlsApi.applySwitch(approval.id, b, key)));
        if (authority.isCurrent()) onDone(`${entry?.label ?? op.key} is on until the time it auto-reverts.`);
      }
    } catch (failure) {
      if (authority.isCurrent()) setError(messageOf(failure));
    } finally {
      if (authority.isCurrent()) setBusy(false);
    }
  };
  return <Drawer title={entry?.label ?? op.key} subtitle={step.kind === 'apply' ? 'Apply an approved switch' : 'Approve a switch'} onClose={onClose}>
    <ReviewForm entry={entry} approval={approval} op={op} step={step} choice={choice} preview={preview.preview}
      previewBusy={preview.busy} previewError={preview.error} onPreview={() => { if (choice) preview.ask(choice); }}
      confirmation={confirmation} onConfirmation={setConfirmation} gate={gate} busy={busy} error={error}
      onSubmit={() => void submit()} me={authority.accountId} />
  </Drawer>;
}

function AgentVersions({ answer, error, refresh, offset, onOffset }: {
  answer: SuiteAgents | null; error: string | null; refresh: () => void; offset: number; onOffset: (next: number) => void;
}) {
  return <CardShell title="Box agent versions" icon={Server} note={answer ? <>Read at <Stamp value={answer.generatedAt} /></> : undefined}
    footer={answer ? <>
      <span>{answer.total === 0 ? '0 boxes' : answer.agents.length === 0
        ? `0 boxes on this page; ${answer.total} ${answer.total === 1 ? 'box' : 'boxes'} total`
        : `${answer.offset + 1}–${answer.offset + answer.agents.length} of ${answer.total} boxes`}</span>
      <div className="flex min-w-0 flex-wrap gap-2">
        <Button variant="outline" size="sm" disabled={offset === 0} onClick={() => onOffset(Math.max(0, offset - answer.limit))}>
          Newer agent records
        </Button>
        <Button variant="outline" size="sm" disabled={offset + answer.limit >= answer.total} onClick={() => onOffset(offset + answer.limit)}>
          Older agent records
        </Button>
      </div>
    </> : undefined}>
    {error ? <ErrorNote message={error} onRetry={refresh} /> : !answer ? <Loading what="box agent versions" /> : <>
      <dl><Fact label="Minimum supported agent version"><code className="text-xs break-all">{answer.minimumSupportedVersion}</code></Fact></dl>
      {answer.agents.length === 0 ? <EmptyNote title={answer.total === 0 ? 'No boxes are recorded.' : 'No boxes on this page.'}
        detail={answer.total === 0 ? 'No agent version is inferred.' : 'Use Newer agent records to read the recorded boxes.'} /> :
        answer.agents.map(agent => <AgentRecord key={agent.id} agent={agent} />)}
    </>}
  </CardShell>;
}

function AgentRecord({ agent }: { agent: SuiteAgents['agents'][number] }) {
  return <article className="min-w-0 rounded-xl border border-card-border p-4">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <h3 className="min-w-0 font-semibold break-words">{agent.name}</h3>
      <StatusChip tone={agent.belowMinimum === null ? 'idle' : agent.belowMinimum ? 'warn' : 'ok'}>
        {agent.belowMinimum === null ? 'Not recorded' : agent.belowMinimum ? 'Below minimum' : 'Meets minimum'}
      </StatusChip>
    </div>
    <dl className="mt-4 grid min-w-0 grid-cols-1 gap-x-6 gap-y-4 @xl:grid-cols-2 @3xl:grid-cols-3">
      <Fact label="Park">{agent.branchName}</Fact>
      <Fact label="Box slot"><code className="text-xs break-all">{agent.slot}</code></Fact>
      <Fact label="Agent version"><code className="text-xs break-all">{agent.agentVersion ?? 'Not recorded'}</code></Fact>
      <Fact label="Last heartbeat"><Stamp value={agent.lastHeartbeatAt} /></Fact>
    </dl>
  </article>;
}

function ReleaseRecord({ release }: { release: SuiteReleases['deployments'][number] }) {
  return <article className="min-w-0 rounded-xl border border-card-border p-4">
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold break-words">{release.appName}</h3>
      <span className="text-xs text-muted-foreground break-words">{release.status}</span>
    </div>
    <dl className="mt-4 grid min-w-0 grid-cols-1 gap-x-6 gap-y-4 @xl:grid-cols-2 @3xl:grid-cols-3">
      <Fact label="Version">{release.version ?? 'Not recorded'}</Fact>
      <Fact label="Commit"><code className="text-xs break-all">{release.commit ?? 'Not recorded'}</code></Fact>
      <Fact label="Triggered by"><span className="break-all">{release.actorAccountId ?? 'Not recorded'}</span></Fact>
      <Fact label="CI">{release.ciGreen === null ? 'Not recorded' : release.ciGreen ? 'Passed' : 'Failed'}</Fact>
      <Fact label="Deployed at"><Stamp value={release.deployedAt} /></Fact>
      <Fact label="Recorded at"><Stamp value={release.recordedAt} /></Fact>
    </dl>
  </article>;
}
