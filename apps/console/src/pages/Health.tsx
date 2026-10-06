import { useEffect, useState } from 'react';
import { BellRing, CalendarClock, FlaskConical, LineChart, Loader2, RefreshCw, Server } from 'lucide-react';
import {
  healthApi,
  testControlsApi,
  type AlertRow,
  type HealthCheck,
  type HealthState,
  type JobStatus,
  type Readiness,
  type TestControl,
} from '@/api/observability';
import { analyticsFreshnessLines, type AnalyticsFreshnessLine } from '@/lib/analyticsFreshness';
import { Button } from '@/components/ui/button';
import { BoothSummary } from '@/components/health/BoothSummary';
import { FleetSummary } from '@/components/devices/FleetSummary';
import { ErrorNote, Loading, RouteUnavailable } from '@/components/Panel';
import {
  StatusMark,
  toneForHealth,
  toneForOutcome,
  toneForSeverity,
  type Tone,
} from '@/components/Status';
import { CommandBar } from '@/components/redesign/CommandBar';
import { BarChip, StatusChip } from '@/components/redesign/chips';
import { CardShell, PageGrid, StripedList } from '@/components/redesign/layout';
import { EmptyNote, UnreadNote } from '@/components/redesign/StatTile';
import { useSession } from '@/auth/SessionContext';
import { boxStoreAlertNote } from '@/lib/fleetWords';
import { usePlatformStatus } from '@/lib/platformStatus';
import { isEstateWide, readReach, reachLabel } from '@/lib/reach';
import { elapsed, formatWhen, millis, timeAgo } from '@/lib/time';

/**
 * Health answers one question — is anything wrong right now — and it answers it
 * in the first screenful.
 *
 * So the command bar carries the verdict, and the Alerts card beside the
 * services names the things that are wrong when there are any — or says, in
 * one line, that nothing needs anybody. The services, the boxes and the jobs
 * are where someone goes AFTER they know there is something to look at. A table
 * of green rows is not an answer; it is a reading exercise handed to somebody
 * who is already in a hurry. (Laid out on the approved design, SCRUM-474.)
 */
export function Health() {
  const { me, has } = useSession();
  const { ready, snapshot, snapshotMissing, error, loading, lastCheckedAt, refresh } =
    usePlatformStatus();
  const timezone = me?.branch?.timezone;
  const canManage = has('admin:ops:manage');

  /**
   * SCRUM-301 — whose page this is.
   *
   * The verdict, the services and the job register are the DEPLOYMENT's
   * state. A park manager cannot act on any of them — acknowledging an alert
   * or retrying a run asks for `admin:ops:manage` at the row's own branch, and
   * a platform row has no branch — so her page used to open on "2 things need
   * attention", one of which was a deployment failure that was never hers. The
   * API now answers her without them, and this is where the page stops drawing
   * them: what is left is her boxes and her alerts, which are hers to act on.
   */
  const reach = readReach(snapshot);
  const estateWide = isEstateWide(reach);
  const parkLabel = reachLabel(reach);

  // The API row comes from /ready either way: "is it answering, and how fast"
  // is the one reading this page should never lose, and the richer snapshot
  // reports on dependencies rather than on the round trip to itself.
  const checks = [...apiCheck(ready), ...(snapshot?.checks ?? checksFromReady(ready).slice(1))];
  const jobs = snapshot?.jobs ?? [];
  const rollups = snapshot?.rollups ?? [];
  const alerts = (snapshot?.alerts ?? []).filter((a) => !a.resolvedAt);
  const problems = listProblems(ready, checks, jobs, alerts);
  const verdict = overallTone(ready, checks, jobs, alerts, problems);
  // The same sentences without the alert ones: the Alerts card lists the
  // alerts themselves underneath, each with its own button.
  const systemProblems = estateWide ? listProblems(ready, checks, jobs, []) : [];
  /**
   * Whether "no open alerts" is something /ops/health actually said. Not before
   * its first answer (the snapshot is still null) and not while the last read
   * failed (what is held is older than the error above it): an all-clear drawn
   * from either would be the page's guess, dressed in the green tick.
   */
  const alertsRead = snapshot !== null && !error;

  return (
    <>
      <CommandBar
        sectionId="health"
        place={me?.branch?.name}
        actions={
          <>
            {estateWide && (
              <BarChip tone={verdict}>{headline(verdict, problems.length, snapshotMissing)}</BarChip>
            )}
            <BarChip>
              {lastCheckedAt ? `checked ${timeAgo(new Date(lastCheckedAt).toISOString())}` : 'checking…'}
            </BarChip>
            <Button
              variant="outline"
              size="sm"
              className="h-9 gap-2 rounded-full px-4"
              onClick={() => void refresh()}
              disabled={loading}
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Refresh
            </Button>
          </>
        }
      />

      {error && <ErrorNote message={error} onRetry={() => void refresh()} />}
      {/* A park manager's page says which park it is reporting on. */}
      {!estateWide && parkLabel && <p className="text-sm text-muted-foreground">{parkLabel}</p>}

      <PageGrid>
        {estateWide && (
          <CardShell
            span={7}
            icon={Server}
            title="Services"
            note={
              snapshotMissing
                ? 'from /ready, which every deployment answers'
                : 'what each dependency reported on the last check'
            }
          >
            {checks.length === 0 ? (
              <EmptyNote
                title="No checks reported"
                detail="The API answered without naming any dependency."
              />
            ) : (
              <StripedList label="Services">
                {checks.map((check) => (
                  <CheckRow key={check.key} check={check} />
                ))}
              </StripedList>
            )}
            {snapshotMissing && (
              <p className="px-3 text-xs text-muted-foreground">
                Only /ready is reporting on this deployment, so this is not yet a verdict on the jobs,
                the alerts or anything else. The fuller set of checks arrives with the observability
                API.
              </p>
            )}
          </CardShell>
        )}

        {!estateWide && <FleetSummary timezone={timezone} span={7} />}

        <CardShell
          span={5}
          icon={BellRing}
          title="Alerts"
          note={alerts.length > 0 ? 'raised by the watchdog, open until someone takes them' : undefined}
        >
          {systemProblems.length > 0 && (
            <ul className="flex flex-col gap-1.5" aria-label="What needs attention">
              {systemProblems.map((p) => (
                <li key={p} className="flex items-start gap-2 text-[13px]">
                  <StatusMark tone={verdict} className="mt-1 w-3 h-3" />
                  <span className="min-w-0 break-words">{p}</span>
                </li>
              ))}
            </ul>
          )}
          {snapshotMissing ? (
            <RouteUnavailable what="Alerting" />
          ) : alerts.length > 0 ? (
            <StripedList label="Open alerts">
              {alerts.map((alert) => (
                <AlertItem
                  key={alert.id}
                  alert={alert}
                  timezone={timezone}
                  canManage={canManage}
                  onAcknowledged={() => void refresh()}
                />
              ))}
            </StripedList>
          ) : error ? (
            // The error note above carries the reason and the Try again.
            <UnreadNote what="The alert list" />
          ) : !alertsRead ? (
            <Loading what="alerts" />
          ) : systemProblems.length === 0 ? (
            <EmptyNote
              good
              title="Nothing needs you right now"
              detail="When something does, it lands here with what is wrong, since when, and the button that takes it."
            />
          ) : null}
        </CardShell>

        {estateWide && <FleetSummary timezone={timezone} span={7} />}

        {estateWide && (
          <CardShell
            span={5}
            icon={CalendarClock}
            title="Scheduled jobs"
            note="how long since each last ran"
          >
            {snapshotMissing ? (
              <RouteUnavailable
                what="The job register"
                detail="Jobs appear here once the runner and its expectations are deployed to this environment."
              />
            ) : jobs.length === 0 ? (
              <EmptyNote
                title="No jobs registered"
                detail="Nothing has declared an expectation yet, so there is nothing to be late."
              />
            ) : (
              <StripedList label="Scheduled jobs">
                {jobs.map((job) => (
                  <JobRow key={job.name} job={job} timezone={timezone} />
                ))}
              </StripedList>
            )}
          </CardShell>
        )}

        {/*
          S2-15b round 3 (plan §1): when the analytics rollup last brought each
          park in this reader's reach up to date — what Today > Performance and
          Radar are reading. Absent on an API that does not answer it.
        */}
        {rollups.length > 0 && (
          <CardShell
            span={12}
            icon={LineChart}
            title="Analytics rollup"
            note="when each park's day, report and booth figures were last brought up to date"
          >
            <StripedList label="Analytics rollup">
              {/* Each park's daily figures, then (round 6) its report figures and (round 5) its booth figures. */}
              {analyticsFreshnessLines(rollups).map((line) => (
                <RollupRow key={line.key} line={line} timezone={timezone} />
              ))}
            </StripedList>
          </CardShell>
        )}

        {/*
          Under the boxes, because a booth IS one of them and the card above is
          where a reader has just seen it go quiet. This adds the half of a booth
          that a box-shaped row cannot carry: the wheel it is running, whether
          anybody is signed in, and the two conditions that belong to the booth
          rather than to the machine under it. It renders nothing at all where no
          box drives a booth.
        */}
        <BoothSummary boxes={snapshot?.boxes} alerts={alerts} timezone={timezone} />

        <TestControls canManage={canManage} onRan={() => void refresh()} />
      </PageGrid>
    </>
  );
}

// ---------------------------------------------------------------------------

/** The verdict in the words the command bar's chip carries. */
function headline(tone: Tone, problemCount: number, partial: boolean): string {
  if (tone === 'idle') return 'Nothing is reporting yet';
  if (tone === 'ok') return partial ? 'The API is answering' : 'Everything is healthy';
  return problemCount === 1 ? 'One thing needs attention' : `${problemCount} things need attention`;
}

function CheckRow({ check }: { check: HealthCheck }) {
  const tone = toneForHealth(check.status);
  const reading =
    check.value === null || check.value === undefined
      ? statusWord(check.status)
      : `${check.value}${check.unit ? ` ${check.unit}` : ''}`;
  return (
    <li className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-0.5 px-3 py-2.5 text-[13.5px] @lg:grid-cols-[minmax(0,1fr)_120px_minmax(0,180px)]">
      <span className="flex min-w-0 items-center gap-2.5">
        <StatusMark tone={tone} />
        <span className="truncate font-semibold">{check.label ?? prettify(check.key)}</span>
      </span>
      <span className="font-mono text-xs text-muted-foreground tabular-nums">{reading}</span>
      <span className="col-span-2 text-[12.5px] text-muted-foreground break-words @lg:col-span-1 @lg:text-right">
        {check.detail ?? ''}
      </span>
    </li>
  );
}

function JobRow({ job, timezone }: { job: JobStatus; timezone?: string | null }) {
  const tone = toneForHealth(job.status);
  const late =
    job.expectedEverySeconds && job.ageSeconds && job.ageSeconds > job.expectedEverySeconds * 2;
  return (
    <li className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <StatusMark tone={tone} />
        <span className="min-w-0 font-mono text-[12.5px] font-semibold break-all">{job.name}</span>
        {job.lastOutcome && (
          <StatusChip tone={toneForOutcome(job.lastOutcome)}>{job.lastOutcome}</StatusChip>
        )}
        <span className="ml-auto text-[12.5px] text-muted-foreground tabular-nums">
          {job.ageSeconds !== null && job.ageSeconds !== undefined ? elapsed(job.ageSeconds) : '—'}
          {job.expectedEverySeconds ? ` / every ${elapsed(job.expectedEverySeconds)}` : ''}
          {late ? ' · late' : ''}
        </span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {job.lastRunAt ? `last ran ${formatWhen(job.lastRunAt, timezone)}` : 'never run'}
      </p>
      {job.lastError && <p className="mt-0.5 text-xs text-status-down break-words">{job.lastError}</p>}
    </li>
  );
}

/** One park's figure set (daily, report or booth), drawn as a job row is. */
function RollupRow({ line, timezone }: { line: AnalyticsFreshnessLine; timezone?: string | null }) {
  const at = line.at;
  return (
    <li className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
        <StatusMark tone={at ? 'ok' : 'idle'} />
        <span className="min-w-0 text-[13.5px] font-semibold break-words">{line.label}</span>
        <span className="ml-auto text-[12.5px] text-muted-foreground tabular-nums">{at ? timeAgo(at) : '—'}</span>
      </div>
      <p className="mt-0.5 text-xs text-muted-foreground">
        {at ? `last rolled up ${formatWhen(at, timezone)}` : 'not rolled up yet'}
        {` · trading day ${line.today}`}
      </p>
    </li>
  );
}

function AlertItem({
  alert,
  timezone,
  canManage,
  onAcknowledged,
}: {
  alert: AlertRow;
  timezone?: string | null;
  canManage: boolean;
  onAcknowledged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  /**
   * A box that cannot use its store gets one more line (SCRUM-445): the
   * heading above is the platform's sentence about the box, and this is what
   * it means at the booth and where the way back is written up. Null for
   * every other alert.
   */
  const note = boxStoreAlertNote(alert.key);

  const acknowledge = async () => {
    setBusy(true);
    setFailed(null);
    try {
      await healthApi.acknowledgeAlert(alert.id);
      onAcknowledged();
    } catch (err) {
      setFailed(err instanceof Error ? err.message : 'Could not acknowledge');
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <StatusChip tone={toneForSeverity(alert.severity)}>{alert.severity}</StatusChip>
        <span className="min-w-0 text-[13.5px] font-semibold break-words">{alert.title}</span>
        {alert.count && alert.count > 1 && (
          <span className="text-xs font-bold text-muted-foreground tabular-nums">×{alert.count}</span>
        )}
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-muted-foreground">
        <span>open since {formatWhen(alert.openedAt, timezone)}</span>
        <span className="ml-auto shrink-0">
          {alert.acknowledgedAt ? (
            <span className="text-xs">
              taken {timeAgo(alert.acknowledgedAt)}
              {alert.acknowledgedBy ? ` by ${alert.acknowledgedBy}` : ''}
            </span>
          ) : canManage ? (
            <Button
              variant="outline"
              size="sm"
              className="rounded-full border-primary text-primary-ink"
              onClick={() => void acknowledge()}
              disabled={busy}
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Acknowledge
            </Button>
          ) : null}
        </span>
      </div>
      {alert.detail && <p className="mt-1 text-[12.5px] text-muted-foreground break-words">{alert.detail}</p>}
      {note && <p className="mt-1 text-[12.5px] text-muted-foreground break-words">{note}</p>}
      {failed && <p className="mt-1 text-sm text-destructive">{failed}</p>}
    </li>
  );
}

/**
 * The controls that make something go wrong on purpose. They exist only where
 * `OPS_TEST_CONTROLS` is set AND the caller is platform-wide, which the API
 * answers rather than refuses — so a deployment without them shows no section
 * at all, instead of a row of buttons that always fail.
 */
function TestControls({ canManage, onRan }: { canManage: boolean; onRan: () => void }) {
  const [controls, setControls] = useState<TestControl[] | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void testControlsApi
      .list()
      .then(({ available, controls: list }) => {
        if (!cancelled) setControls(available ? list : []);
      })
      .catch(() => {
        // Absent route, or a caller who is not platform-wide. Either way there
        // is nothing to offer and nothing to explain.
        if (!cancelled) setControls([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!canManage || !controls || controls.length === 0) return null;

  const run = async (control: TestControl) => {
    setBusyKey(control.key);
    setNote(null);
    try {
      const result = await testControlsApi.run(control.key);
      setNote(result.message ?? `${control.label} ran.`);
      onRan();
    } catch (err) {
      setNote(err instanceof Error ? err.message : 'That control failed');
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <CardShell
      span={12}
      icon={FlaskConical}
      title="Test controls"
      note="Staging-only controls add demo scenarios or simulate failures. The demo day is added at Demo Branch 2, never at a live park, and existing records are kept."
    >
      <div className="flex flex-wrap gap-2">
        {controls.map((control) => (
          <Button
            key={control.key}
            variant="outline"
            size="sm"
            className="rounded-full"
            title={control.description ?? undefined}
            disabled={busyKey !== null}
            onClick={() => void run(control)}
          >
            {busyKey === control.key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {control.label}
          </Button>
        ))}
      </div>
      {note && <p className="text-sm text-muted-foreground">{note}</p>}
    </CardShell>
  );
}


// ---------------------------------------------------------------------------

function statusWord(status: HealthState): string {
  return status === 'ok' ? 'Healthy' : status === 'warn' ? 'Degraded' : status === 'down' ? 'Failing' : 'Unknown';
}

function prettify(key: string): string {
  return key.replace(/[_.]/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/** The API's outcome noun as the verb a sentence about it needs. */
function outcomeVerb(outcome: string | null | undefined): string {
  switch (outcome) {
    case 'failure':
    case 'failed':
    case 'error':
      return 'failed';
    case 'timeout':
      return 'timed out';
    case 'skipped':
      return 'was skipped';
    default:
      return 'did not succeed';
  }
}

/**
 * `/ready` is public and exists on every deployment, so it is the floor this
 * page stands on. It reports the database, the connection pool and the
 * watchdog's age (apps/api/src/routes/health.ts), which is most of what this
 * page is asked for — the three are read by name and given the units and
 * thresholds they deserve; anything else it grows falls through to a defensive
 * reading, because a console that throws on an unexpected payload is a console
 * that is down exactly when it is needed.
 */
function checksFromReady(ready: Readiness | null): HealthCheck[] {
  if (!ready) return [];
  const checks: HealthCheck[] = [...apiCheck(ready)];
  for (const [key, raw] of Object.entries(ready.checks ?? {})) {
    checks.push(knownCheck(key, raw) ?? normaliseCheck(key, raw));
  }
  return checks;
}

/** The round trip to `/ready` itself, as a tile. */
function apiCheck(ready: Readiness | null): HealthCheck[] {
  if (!ready) return [];
  return [
    {
      key: 'api',
      label: 'API',
      status: ready.ok ? (ready.status === 'ready' ? 'ok' : 'warn') : 'down',
      value: millis(ready.roundTripMs),
      detail: `/ready answered ${ready.status}`,
    },
  ];
}

/** The three `/ready` reports today, each read for what it actually means. */
function knownCheck(key: string, raw: unknown): HealthCheck | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;

  if (key === 'database' && typeof obj.ok === 'boolean') {
    return {
      key,
      label: 'Database',
      status: obj.ok ? 'ok' : 'down',
      value: typeof obj.latencyMs === 'number' ? obj.latencyMs : null,
      unit: 'ms',
      detail: obj.ok ? null : 'the probe did not answer',
    };
  }

  if (key === 'pool' && typeof obj.total === 'number') {
    const waiting = typeof obj.waiting === 'number' ? obj.waiting : 0;
    const max = typeof obj.max === 'number' ? obj.max : null;
    return {
      key,
      label: 'Connection pool',
      // Something waiting for a connection is not yet a fault, but it is the
      // first sign of one, and it is invisible in every other number here.
      status: waiting > 0 ? 'warn' : 'ok',
      value: max ? `${obj.total}/${max}` : String(obj.total),
      detail: `${typeof obj.idle === 'number' ? obj.idle : 0} idle, ${waiting} waiting`,
    };
  }

  if (key === 'jobs') {
    const configured = obj.configured === true;
    const ageS = typeof obj.watchdogAgeS === 'number' ? obj.watchdogAgeS : null;
    const staleAfterS = typeof obj.staleAfterS === 'number' ? obj.staleAfterS : null;
    return {
      key,
      label: 'Watchdog',
      status: !configured ? 'unknown' : obj.stale === true ? 'warn' : 'ok',
      value: ageS === null ? null : elapsed(ageS),
      detail: !configured
        ? 'the job runner has never reported here'
        : staleAfterS
          ? `late after ${elapsed(staleAfterS)}`
          : null,
    };
  }

  return null;
}

function normaliseCheck(key: string, raw: unknown): HealthCheck {
  if (typeof raw === 'boolean') return { key, status: raw ? 'ok' : 'down' };
  if (typeof raw === 'number') return { key, status: 'unknown', value: raw };
  if (typeof raw === 'string') return { key, status: toStatus(raw), detail: raw };
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const value = obj.value ?? obj.latencyMs ?? obj.ms ?? obj.ageSeconds;
    return {
      key,
      label: typeof obj.label === 'string' ? obj.label : undefined,
      status: toStatus(typeof obj.status === 'string' ? obj.status : obj.ok === true ? 'ok' : undefined),
      value: typeof value === 'number' || typeof value === 'string' ? value : undefined,
      unit: typeof obj.unit === 'string' ? obj.unit : undefined,
      detail: typeof obj.detail === 'string' ? obj.detail : undefined,
    };
  }
  return { key, status: 'unknown' };
}

function toStatus(value: string | undefined): HealthState {
  const tone = toneForHealth(value);
  return tone === 'idle' ? 'unknown' : tone;
}

/** The named things that are wrong, in the order someone would act on them. */
function listProblems(
  ready: Readiness | null,
  checks: HealthCheck[],
  jobs: JobStatus[],
  alerts: AlertRow[],
): string[] {
  const problems: string[] = [];
  if (ready && !ready.ok) problems.push(`The API answered ${ready.status} — it is not taking traffic.`);
  else if (ready && ready.status !== 'ready') {
    // 200 with a status of its own: serving, but telling us something is off.
    problems.push(`The API reports itself ${ready.status}.`);
  }
  for (const check of checks) {
    if (check.key === 'api') continue;
    if (check.status === 'down') problems.push(`${check.label ?? prettify(check.key)} is failing.`);
    else if (check.status === 'warn')
      problems.push(`${check.label ?? prettify(check.key)} is degraded${check.detail ? ` — ${check.detail}` : ''}.`);
  }
  for (const job of jobs) {
    if (job.status !== 'down' && job.status !== 'warn') continue;
    // Two different complaints wear the same status, and conflating them sends
    // someone to look at a schedule when the job is running fine and throwing.
    const stale =
      job.expectedEverySeconds &&
      job.ageSeconds !== null &&
      job.ageSeconds !== undefined &&
      job.ageSeconds > job.expectedEverySeconds;
    if (stale) {
      problems.push(
        `${job.name} has not run for ${elapsed(job.ageSeconds)} (expected every ${elapsed(job.expectedEverySeconds)}).`,
      );
    } else {
      problems.push(
        `${job.name} ${outcomeVerb(job.lastOutcome)}${job.lastRunAt ? ` ${timeAgo(job.lastRunAt)}` : ''}.`,
      );
    }
  }
  const open = alerts.filter((a) => !a.acknowledgedAt);
  const only = open.length === 1 ? open[0] : undefined;
  if (only) problems.push(`Alert: ${only.title}`);
  else if (open.length > 1) problems.push(`${open.length} alerts are open and nobody has taken them.`);
  return problems;
}

/**
 * One tone for the whole page. "Down" is reserved for something that is
 * actually broken — the API refusing traffic, a dependency failing, a critical
 * alert — so that the loudest state stays worth reacting to. Everything else
 * that merely needs attention is a warning, and warnings are still named
 * individually in the banner.
 */
function overallTone(
  ready: Readiness | null,
  checks: HealthCheck[],
  jobs: JobStatus[],
  alerts: AlertRow[],
  problems: string[],
): Tone {
  if (!ready) return 'idle';
  if (!ready.ok) return 'down';
  if (checks.some((c) => c.status === 'down')) return 'down';
  if (jobs.some((j) => j.status === 'down')) return 'down';
  if (alerts.some((a) => a.severity === 'critical' && !a.acknowledgedAt)) return 'down';
  // Weighed last, so a 200 that calls itself degraded never masks something
  // underneath it that is actually broken.
  if (ready.status !== 'ready') return 'warn';
  return problems.length === 0 ? 'ok' : 'warn';
}
