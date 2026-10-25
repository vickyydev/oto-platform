import { useCallback, useEffect, useRef, useState } from 'react';
import { BellRing, Server, Shield, SlidersHorizontal } from 'lucide-react';
import { createRolesApi } from '@oto/admin-screens';
import { api } from '@/api/client';
import { platformAdminApi, type PlatformAlertQuery } from '@/api/platform-admin';
import { ErrorNote, Loading, PermissionRequired } from '@/components/Panel';
import { CommandBar } from '@/components/redesign/CommandBar';
import { CardShell } from '@/components/redesign/layout';
import { StatusChip, Tag } from '@/components/redesign/chips';
import { EmptyNote } from '@/components/redesign/StatTile';
import { Button } from '@/components/ui/button';
import { TestControls } from '@/components/platform/TestControls';
import { toneForHealth, toneForSeverity } from '@/components/Status';
import { usePlatformAuthority } from '@/lib/platformAuthority';
import { jobOutcomeChip, jobWaitingLine } from '@/lib/jobWords';
import { formatWhen } from '@/lib/time';

const rolesApi = createRolesApi(api);
type Page = 'system-roles' | 'platform-alerts' | 'platform-jobs' | 'platform-environment' | 'platform-test-controls';

/** Every answer belongs to the dispatch's confirmed session epoch. */
function usePlatformRead<T>(read: () => Promise<T>, kind: 'roles' | 'health') {
  const authority = usePlatformAuthority(kind === 'roles' ? 'admin:role:read' : 'admin:health:read', kind === 'health');
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ key: string; read: () => Promise<T>; answer: T | null; error: string | null } | null>(null);
  const currentRead = useRef(read);
  currentRead.current = read;
  useEffect(() => {
    if (!authority.allowed) return;
    let active = true;
    setState({ key: authority.key, read, answer: null, error: null });
    void read().then((answer) => {
      if (active && currentRead.current === read && authority.isCurrent()) setState({ key: authority.key, read, answer, error: null });
    }).catch((failure: unknown) => {
      if (active && currentRead.current === read && authority.isCurrent()) setState({ key: authority.key, read, answer: null,
        error: failure instanceof Error ? failure.message : 'The platform read failed.' });
    });
    return () => { active = false; };
  }, [read, retry, authority.allowed, authority.key, authority.isCurrent]);
  return {
    allowed: authority.allowed,
    answer: authority.allowed && state?.key === authority.key && state.read === read ? state.answer : null,
    error: authority.allowed && state?.key === authority.key && state.read === read ? state.error : null,
    refresh: () => { if (authority.isCurrent()) setRetry((value) => value + 1); },
    isCurrent: authority.isCurrent,
  };
}

export function Platform({ page }: { page: Page }) {
  if (page === 'system-roles') return <SystemRoles />;
  if (page === 'platform-alerts') return <PlatformAlerts />;
  if (page === 'platform-jobs') return <PlatformJobs />;
  if (page === 'platform-environment') return <PlatformEnvironment />;
  return <PlatformTestControls />;
}

function SystemRoles() {
  const { allowed, answer, error, refresh } = usePlatformRead(rolesApi.catalogue, 'roles');
  if (!allowed) return <PermissionRequired permission="admin:role:read (platform-wide)" />;
  return <>
    <CommandBar sectionId="system-roles" />
    {error ? <ErrorNote message={error} onRetry={refresh} /> : !answer ? <Loading what="system roles" /> :
      <CardShell title="System catalogue" icon={Shield} note="System roles are maintained by the platform. Their permissions are read-only here.">
        <div className="divide-y">
          {answer.roles.filter((role) => role.system === true).map((role) => <details key={role.id} className="py-3">
            <summary className="cursor-pointer font-semibold break-words">{role.name}</summary>
            {role.description && <p className="mt-2 text-sm text-muted-foreground break-words">{role.description}</p>}
            <ul className="mt-3 space-y-2">
              {role.permissions.map((entry) => <li key={entry.permission} className="min-w-0 text-sm">
                <p>{entry.words}</p><code className="text-xs text-muted-foreground break-all">{entry.permission}</code>
              </li>)}
            </ul>
          </details>)}
        </div>
        {answer.roles.every((role) => !role.system) && <EmptyNote title="No system roles were returned." />}
      </CardShell>}
  </>;
}

function PlatformAlerts() {
  const [state, setState] = useState<NonNullable<PlatformAlertQuery['state']>>('open');
  const [offset, setOffset] = useState(0);
  const read = useCallback(() => platformAdminApi.alerts({ state, limit: 50, offset }), [state, offset]);
  const { allowed, answer, error, refresh, isCurrent } = usePlatformRead(read, 'health');
  if (!allowed) return <PermissionRequired permission="admin:health:read (operator-wide, platform-wide account)" />;
  return <>
    <CommandBar sectionId="platform-alerts" actions={<label className="flex items-center gap-2 text-sm font-semibold">
      State<select aria-label="State" value={state} onChange={(event) => {
        if (!isCurrent()) return;
        setState(event.target.value as NonNullable<PlatformAlertQuery['state']>); setOffset(0);
      }} className="rounded-xl border bg-card px-3 py-2">
        <option value="open">Open</option><option value="resolved">Resolved</option><option value="all">All</option>
      </select>
    </label>} />
    {error ? <ErrorNote message={error} onRetry={refresh} /> : !answer ? <Loading what="platform alerts" /> :
      <CardShell title="Platform alert register" icon={BellRing} note={`Read at ${formatWhen(answer.generatedAt)}. Platform records only.`}>
        {answer.alerts.length === 0 ? <EmptyNote title="No platform alerts in this view." /> :
          <ul className="divide-y">{answer.alerts.map((row) => <li key={row.id} className="min-w-0 py-3 space-y-2">
            <div className="flex flex-wrap items-start gap-2"><p className="font-semibold flex-1 min-w-0 break-words">{row.title}</p>
              <StatusChip tone={toneForSeverity(row.severity)}>{row.severity}</StatusChip></div>
            {row.detail && <p className="text-sm text-muted-foreground break-words">{row.detail}</p>}
            <p className="text-xs text-muted-foreground break-words">Opened {formatWhen(row.openedAt)} · {row.count} occurrences
              {row.acknowledgedAt ? ` · Acknowledged ${formatWhen(row.acknowledgedAt)}` : ''}
              {row.resolvedAt ? ` · Resolved ${formatWhen(row.resolvedAt)}` : ' · Open'}</p>
          </li>)}</ul>}
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" disabled={answer.offset === 0} onClick={() => { if (isCurrent()) setOffset(Math.max(0, answer.offset - answer.limit)); }}>Previous</Button>
          <span className="text-sm text-muted-foreground">{answer.total} records</span>
          <Button variant="outline" size="sm" disabled={answer.offset + answer.limit >= answer.total} onClick={() => { if (isCurrent()) setOffset(answer.offset + answer.limit); }}>Next</Button>
        </div>
      </CardShell>}
  </>;
}

function PlatformJobs() {
  const { allowed, answer, error, refresh } = usePlatformRead(platformAdminApi.jobs, 'health');
  if (!allowed) return <PermissionRequired permission="admin:health:read (operator-wide, platform-wide account)" />;
  return <>
    <CommandBar sectionId="platform-jobs" />
    {error ? <ErrorNote message={error} onRetry={refresh} /> : !answer ? <Loading what="the platform job register" /> :
      <CardShell title="Persisted job status" icon={Server} note={`Read at ${formatWhen(answer.generatedAt)}. Opening this page does not start a job.`}>
        {answer.jobs.length === 0 ? <EmptyNote title="No jobs were returned." /> : <ul className="divide-y">
          {answer.jobs.map((job) => {
            const outcome = jobOutcomeChip(job);
            const waiting = jobWaitingLine(job);
            return <li key={job.name} className="min-w-0 py-3 space-y-2">
              <div className="flex flex-wrap items-start gap-2">
                <p className="font-semibold flex-1 min-w-0 break-all">{job.name}</p>
                <StatusChip tone={toneForHealth(job.status)}>{job.status}</StatusChip>
                {outcome && <StatusChip tone={outcome.tone}>{outcome.label}</StatusChip>}
              </div>
              <p className="text-xs text-muted-foreground break-words">Last run: {job.lastRunAt ? formatWhen(job.lastRunAt) : 'Never recorded'}
                {job.expectedEverySeconds === null ? '' : ` · Expected every ${job.expectedEverySeconds}s`}
                {job.ageSeconds === null ? '' : ` · Age ${job.ageSeconds}s`}</p>
              {waiting && <p className="text-sm break-words">{waiting}</p>}
              {job.lastError && <p className="text-sm text-muted-foreground break-words">{job.lastError}</p>}
            </li>;
          })}
        </ul>}
      </CardShell>}
  </>;
}

function PlatformEnvironment() {
  const { allowed, answer, error, refresh } = usePlatformRead(platformAdminApi.environment, 'health');
  if (!allowed) return <PermissionRequired permission="admin:health:read (operator-wide, platform-wide account)" />;
  return <>
    <CommandBar sectionId="platform-environment" />
    {error ? <ErrorNote message={error} onRetry={refresh} /> : !answer ? <Loading what="environment presence" /> :
      <CardShell title="Variable presence" icon={SlidersHorizontal} note={`Read at ${formatWhen(answer.generatedAt)}. Names and presence only; configuration values are never displayed.`}>
        {answer.variables.length === 0 ? <EmptyNote title="No variable metadata was returned." /> :
          <ul className="divide-y">{answer.variables.map((variable) => <li key={variable.name} className="min-w-0 py-3 space-y-2">
            <div className="flex flex-wrap items-start gap-2">
              <code className="flex-1 min-w-0 font-semibold text-sm break-all">{variable.name}</code>
              <StatusChip tone={variable.present ? 'ok' : variable.required ? 'warn' : 'idle'}>{variable.present ? 'Configured' : 'Not configured'}</StatusChip>
            </div>
            <p className="text-sm text-muted-foreground break-words">{variable.purpose}</p>
            <div className="flex flex-wrap gap-2"><Tag>{variable.required ? 'Required' : 'Optional'}</Tag>{variable.provider && <Tag>{variable.provider}</Tag>}</div>
          </li>)}</ul>}
      </CardShell>}
  </>;
}

function PlatformTestControls() {
  const authority = usePlatformAuthority('admin:ops:manage');
  if (!authority.allowed) return <PermissionRequired permission="admin:ops:manage (platform-wide)" />;
  return <><CommandBar sectionId="platform-test-controls" /><TestControls key={authority.key} canManage standalone /></>;
}
