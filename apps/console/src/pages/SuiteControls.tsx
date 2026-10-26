import { useCallback, useEffect, useRef, useState } from 'react';
import { AppWindow, History, RefreshCw, Server } from 'lucide-react';
import { suiteControlsApi, type SuiteAgents, type SuiteApps, type SuiteReleases } from '@/api/suite-controls';
import { useSession } from '@/auth/SessionContext';
import { ErrorNote, Fact, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { CardShell } from '@/components/redesign/layout';
import { BarChip, StatusChip } from '@/components/redesign/chips';
import { EmptyNote } from '@/components/redesign/StatTile';
import { Button } from '@/components/ui/button';
import { formatExact } from '@/lib/time';
import { useWorkingAuthority } from '@/lib/workingAuthority';

type Page = 'apps' | 'releases';
type ReadPermission = 'console:app_registry:read' | 'console:release:read';

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
    me?.account.id, me?.account.status, me?.account.mustChangePassword, me?.sessionLocked,
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
  return { key, allowed, operatorId, isCurrent, run: working.run };
}
type Authority = ReturnType<typeof useSuiteAuthority>;

function useSuiteRead<T>(read: () => Promise<T>, authority: Authority) {
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ read: typeof read; retry: number; answer: T | null; error: string | null } | null>(null);
  const currentRead = useRef(read);
  currentRead.current = read;
  useEffect(() => {
    if (!authority.allowed || !authority.isCurrent()) return;
    let active = true;
    setState({ read, retry, answer: null, error: null });
    void authority.run(read).then(answer => {
      if (active && currentRead.current === read && authority.isCurrent()) setState({ read, retry, answer, error: null });
    }).catch((failure: unknown) => {
      if (active && currentRead.current === read && authority.isCurrent()) setState({ read, retry, answer: null,
        error: failure instanceof Error ? failure.message : 'This read did not answer.' });
    });
    return () => { active = false; };
  }, [read, retry, authority.allowed, authority.isCurrent, authority.run]);
  const current = authority.allowed && state?.read === read && state.retry === retry;
  return {
    answer: current ? state.answer : null,
    error: current ? state.error : null,
    refresh: () => { if (authority.isCurrent()) setRetry(value => value + 1); },
  };
}

export function SuiteControls({ page }: { page: Page }) {
  const permission = page === 'apps' ? 'console:app_registry:read' : 'console:release:read';
  const authority = useSuiteAuthority(permission);
  if (!authority.allowed) return <><CommandBar sectionId={page} /><PermissionRequired permission={permission} /></>;
  return page === 'apps' ? <Apps key={authority.key} authority={authority} /> : <Releases key={authority.key} authority={authority} />;
}

function Stamp({ value }: { value: string | null }) {
  return value ? <time dateTime={value}>{formatExact(value)}</time> : <>Not recorded</>;
}

function Apps({ authority }: { authority: Authority }) {
  const { answer, error, refresh } = useSuiteRead(suiteControlsApi.apps, authority);
  return <>
    <CommandBar sectionId="apps" badges={<BarChip>Read only</BarChip>} actions={
      <Button variant="outline" onClick={refresh} disabled={!answer && !error}><RefreshCw className="h-4 w-4" />Refresh</Button>
    } />
    {error ? <ErrorNote message={error} onRetry={refresh} /> : !answer ? <Loading what="app registry" /> : <>
      <p className="text-xs text-muted-foreground">Registry read at <Stamp value={answer.generatedAt} />.</p>
      {answer.apps.length === 0 ? <CardShell title="App registry"><EmptyNote title="No apps are recorded." /></CardShell>
        : answer.apps.map(app => <AppRecord key={app.id} app={app} />)}
    </>}
  </>;
}

const tileWords = { open: 'Open', coming_soon: 'Coming soon', hidden: 'Hidden', maintenance: 'Maintenance' };
function AppRecord({ app }: { app: SuiteApps['apps'][number] }) {
  return <CardShell title={app.name} icon={AppWindow} badge={
    <StatusChip tone={app.effectiveState === 'maintenance' ? 'warn' : app.effectiveState === 'open' ? 'ok' : 'idle'}>
      {tileWords[app.effectiveState]}
    </StatusChip>
  } note={app.key}>
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
      <p className="mt-2 text-xs text-muted-foreground">Expires <Stamp value={app.maintenance.expiresAt} /></p>
    </div>}
  </CardShell>;
}

function Releases({ authority }: { authority: Authority }) {
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
  return <>
    <CommandBar sectionId="releases" badges={<BarChip>Read only</BarChip>} actions={
      <Button variant="outline" onClick={() => { refresh(); agents.refresh(); }} disabled={!answer && !error && !agents.answer && !agents.error}>
        <RefreshCw className="h-4 w-4" />Refresh
      </Button>
    } />
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
        {answer.deployments.length === 0 ? <EmptyNote title={answer.total === 0 ? 'No releases are recorded.' : 'No releases on this page.'}
          detail={answer.total === 0 ? 'No deployment status is inferred.' : 'Use Newer releases to read the recorded history.'} /> :
          answer.deployments.map(release => <ReleaseRecord key={release.id} release={release} />)}
      </CardShell>}
    <AgentVersions answer={agents.answer} error={agents.error} refresh={agents.refresh} offset={agentOffset} onOffset={next => {
      if (authority.isCurrent()) setAgentOffset(next);
    }} />
  </>;
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
