import { useEffect, useState } from 'react';
import { CheckCircle2, Loader2, RefreshCw } from 'lucide-react';
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
import { Button } from '@/components/ui/button';
import { BoothSummary } from '@/components/health/BoothSummary';
import { FleetSummary } from '@/components/devices/FleetSummary';
import { EmptyState, ErrorNote, Panel, RouteUnavailable } from '@/components/Panel';
import {
  StatusMark,
  StatusPill,
  toneForHealth,
  toneForOutcome,
  toneForSeverity,
  type Tone,
} from '@/components/Status';
import { useSession } from '@/auth/SessionContext';
import { boxStoreAlertNote } from '@/lib/fleetWords';
import { usePlatformStatus } from '@/lib/platformStatus';
import { isEstateWide, readReach, reachLabel } from '@/lib/reach';
import { elapsed, formatWhen, millis, timeAgo } from '@/lib/time';

/**
 * Health answers one question — is anything wrong right now — and it answers it
 * in the first screenful.
 *
 * So the page opens with a verdict and, when the verdict is bad, the names of
 * the things that are bad. The tiles, the job list and the alerts underneath
 * are where someone goes AFTER they know there is something to look at. A table
 * of green rows is not an answer; it is a reading exercise handed to somebody
 * who is already in a hurry.
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
   * The banner, the dependency tiles and the job register are the DEPLOYMENT's
   * state. A park manager cannot act on any of them — acknowledging an alert
   * or retrying a run asks for `admin:ops:manage` at the row's own branch, and
   * a platform row has no branch — so her page used to open on "2 things need
   * attention", one of which was a deployment failure that was never hers. The
   * API now answers her without them, and this is where the page stops drawing
   * them: what is left is her boxes and her alerts, which are hers to act on.
   */
  const reach = readReach(snapshot);
  const estateWide = isEstateWide(reach);

  // The API tile comes from /ready either way: "is it answering, and how fast"
  // is the one reading this page should never lose, and the richer snapshot
  // reports on dependencies rather than on the round trip to itself.
  const checks = [...apiCheck(ready), ...(snapshot?.checks ?? checksFromReady(ready).slice(1))];
  const jobs = snapshot?.jobs ?? [];
  const alerts = (snapshot?.alerts ?? []).filter((a) => !a.resolvedAt);
  const problems = listProblems(ready, checks, jobs, alerts);
  const verdict = overallTone(ready, checks, jobs, alerts, problems);

  return (
    <div className="flex flex-col gap-4">
      {error && <ErrorNote message={error} onRetry={() => void refresh()} />}

      {estateWide ? (
        <Verdict
          tone={verdict}
          problems={problems}
          partial={snapshotMissing}
          checkedAt={lastCheckedAt}
          loading={loading}
          onRefresh={() => void refresh()}
        />
      ) : (
        // The park's own heading: which park, when it was last read, and the
        // refresh button — which lives inside the verdict above and would
        // otherwise have gone with it.
        <ParkHeading
          label={reachLabel(reach)}
          checkedAt={lastCheckedAt}
          loading={loading}
          onRefresh={() => void refresh()}
        />
      )}

      {estateWide && (
        <Panel
          title="Services"
          description={
            snapshotMissing
              ? 'From /ready, which every deployment answers. The fuller set of checks arrives with the observability API.'
              : 'What each dependency reported on the last check.'
          }
        >
          {checks.length === 0 ? (
            <EmptyState title="No checks reported" detail="The API answered without naming any dependency." />
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {checks.map((check) => (
                <CheckTile key={check.key} check={check} />
              ))}
            </div>
          )}
        </Panel>
      )}

      <FleetSummary timezone={timezone} />

      {/*
        Under the boxes, because a booth IS one of them and the panel above is
        where a reader has just seen it go quiet. This adds the half of a booth
        that a box-shaped row cannot carry: the wheel it is running, whether
        anybody is signed in, and the two conditions that belong to the booth
        rather than to the machine under it. It renders nothing at all where no
        box drives a booth.
      */}
      <BoothSummary boxes={snapshot?.boxes} alerts={alerts} timezone={timezone} />

      {estateWide && (
        <Panel
          title="Scheduled jobs"
          description="Each job the platform expects to run, and how long it has been since it last did."
        >
          {snapshotMissing ? (
            <RouteUnavailable
              what="The job register"
              detail="Jobs appear here once the runner and its expectations are deployed to this environment."
            />
          ) : jobs.length === 0 ? (
            <EmptyState
              title="No jobs registered"
              detail="Nothing has declared an expectation yet, so there is nothing to be late."
            />
          ) : (
            <ul className="flex flex-col divide-y">
              {jobs.map((job) => (
                <JobRow key={job.name} job={job} timezone={timezone} />
              ))}
            </ul>
          )}
        </Panel>
      )}

      <Panel
        title="Open alerts"
        description="Raised by the watchdog and kept open until someone takes them."
      >
        {snapshotMissing ? (
          <RouteUnavailable what="Alerting" />
        ) : alerts.length === 0 ? (
          <EmptyState title="No open alerts" detail="Nothing has been raised that is still outstanding." />
        ) : (
          <ul className="flex flex-col divide-y">
            {alerts.map((alert) => (
              <AlertItem
                key={alert.id}
                alert={alert}
                timezone={timezone}
                canManage={canManage}
                onAcknowledged={() => void refresh()}
              />
            ))}
          </ul>
        )}
      </Panel>

      <TestControls canManage={canManage} onRan={() => void refresh()} />
    </div>
  );
}

// ---------------------------------------------------------------------------

function Verdict({
  tone,
  problems,
  partial,
  checkedAt,
  loading,
  onRefresh,
}: {
  tone: Tone;
  problems: string[];
  /** Only /ready is reporting: say what is known, not "everything is fine". */
  partial: boolean;
  checkedAt: number | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const headline =
    tone === 'idle'
      ? 'Nothing is reporting yet'
      : tone === 'ok'
        ? partial
          ? 'The API is answering'
          : 'Everything is healthy'
        : problems.length === 1
          ? 'One thing needs attention'
          : `${problems.length} things need attention`;

  return (
    <section
      className="rounded-2xl border p-5 sm:p-6"
      style={{
        borderColor: `hsl(var(--status-${tone}) / 0.4)`,
        backgroundColor: `hsl(var(--status-${tone}) / 0.08)`,
      }}
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4 min-w-0">
          <span
            className="flex h-12 w-12 items-center justify-center rounded-2xl shrink-0"
            style={{ backgroundColor: `hsl(var(--status-${tone}) / 0.15)` }}
          >
            {tone === 'ok' ? (
              <CheckCircle2 className="w-6 h-6" style={{ color: `hsl(var(--status-ok))` }} />
            ) : (
              <StatusMark tone={tone} className="w-6 h-6" />
            )}
          </span>
          <div className="min-w-0">
            <h2 className="text-2xl font-black tracking-tight" style={{ color: `hsl(var(--status-${tone}))` }}>
              {headline}
            </h2>
            {problems.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1">
                {problems.map((p) => (
                  <li key={p} className="flex items-start gap-2 text-sm text-foreground/80">
                    <StatusMark tone={tone} className="w-2.5 h-2.5 mt-1.5" />
                    <span className="min-w-0">{p}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-1 text-sm text-foreground/60">
                {partial
                  ? 'Only /ready is reporting on this deployment, so this is not yet a verdict on the jobs, the alerts or anything else.'
                  : 'The API is answering, and nothing it reports is outside its thresholds.'}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 shrink-0">
          <span className="text-xs text-muted-foreground tabular-nums">
            {checkedAt ? `checked ${timeAgo(new Date(checkedAt).toISOString())}` : 'checking…'}
          </span>
          <Button variant="outline" size="sm" className="h-9 gap-2" onClick={onRefresh} disabled={loading}>
            {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Refresh
          </Button>
        </div>
      </div>
    </section>
  );
}

/**
 * What a park manager's Health page opens on instead of the platform verdict:
 * which park is being reported on, when it was last read, and the refresh.
 *
 * Deliberately not a verdict of its own. "Everything is healthy" from a page
 * that has been told nothing about the database or the job runner would be a
 * claim this page cannot make; the boxes and alerts below say what is known.
 */
function ParkHeading({
  label,
  checkedAt,
  loading,
  onRefresh,
}: {
  label: string | null;
  checkedAt: number | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <p className="text-sm text-muted-foreground min-w-0">{label ?? ''}</p>
      <div className="flex items-center gap-3 shrink-0">
        <span className="text-xs text-muted-foreground tabular-nums">
          {checkedAt ? `checked ${timeAgo(new Date(checkedAt).toISOString())}` : 'checking…'}
        </span>
        <Button variant="outline" size="sm" className="h-9 gap-2" onClick={onRefresh} disabled={loading}>
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Refresh
        </Button>
      </div>
    </div>
  );
}

function CheckTile({ check }: { check: HealthCheck }) {
  const tone = toneForHealth(check.status);
  return (
    <div className="rounded-xl border bg-background/40 p-3.5">
      <div className="flex items-center gap-2">
        <StatusMark tone={tone} />
        <span className="text-sm font-semibold truncate">{check.label ?? prettify(check.key)}</span>
      </div>
      <p className="mt-2 text-xl font-black tracking-tight tabular-nums">
        {check.value === null || check.value === undefined ? (
          <span className="text-base font-bold text-muted-foreground">{statusWord(check.status)}</span>
        ) : (
          <>
            {check.value}
            {check.unit && <span className="ml-1 text-sm font-semibold text-muted-foreground">{check.unit}</span>}
          </>
        )}
      </p>
      {check.detail && <p className="mt-1 text-xs text-muted-foreground break-words">{check.detail}</p>}
    </div>
  );
}

function JobRow({ job, timezone }: { job: JobStatus; timezone?: string | null }) {
  const tone = toneForHealth(job.status);
  const late =
    job.expectedEverySeconds && job.ageSeconds && job.ageSeconds > job.expectedEverySeconds * 2;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 py-3 first:pt-0 last:pb-0">
      <StatusMark tone={tone} />
      <span className="font-mono text-sm font-semibold min-w-0 break-all">{job.name}</span>
      {job.lastOutcome && <StatusPill tone={toneForOutcome(job.lastOutcome)}>{job.lastOutcome}</StatusPill>}
      <span className="text-sm text-muted-foreground">
        {job.lastRunAt ? `last ran ${formatWhen(job.lastRunAt, timezone)}` : 'never run'}
      </span>
      <span className="text-sm text-muted-foreground ml-auto tabular-nums">
        {job.ageSeconds !== null && job.ageSeconds !== undefined ? elapsed(job.ageSeconds) : '—'}
        {job.expectedEverySeconds ? ` / every ${elapsed(job.expectedEverySeconds)}` : ''}
        {late ? ' · late' : ''}
      </span>
      {job.lastError && (
        <p className="w-full text-xs break-words" style={{ color: 'hsl(var(--status-down))' }}>
          {job.lastError}
        </p>
      )}
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
    <li className="py-3 first:pt-0 last:pb-0">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <StatusPill tone={toneForSeverity(alert.severity)}>{alert.severity}</StatusPill>
        <span className="font-semibold min-w-0 break-words">{alert.title}</span>
        {alert.count && alert.count > 1 && (
          <span className="text-xs text-muted-foreground tabular-nums">×{alert.count}</span>
        )}
        <span className="text-sm text-muted-foreground">
          open since {formatWhen(alert.openedAt, timezone)}
        </span>
        <div className="ml-auto shrink-0">
          {alert.acknowledgedAt ? (
            <span className="text-xs text-muted-foreground">
              taken {timeAgo(alert.acknowledgedAt)}
              {alert.acknowledgedBy ? ` by ${alert.acknowledgedBy}` : ''}
            </span>
          ) : canManage ? (
            <Button variant="outline" size="sm" onClick={() => void acknowledge()} disabled={busy}>
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
              Acknowledge
            </Button>
          ) : null}
        </div>
      </div>
      {alert.detail && <p className="mt-1 text-sm text-muted-foreground break-words">{alert.detail}</p>}
      {note && <p className="mt-1 text-sm text-muted-foreground break-words">{note}</p>}
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
    <Panel
      title="Test controls"
      description="This deployment is a playground. These make something fail on purpose, so the alerting can be watched doing its job."
    >
      <div className="flex flex-wrap gap-2">
        {controls.map((control) => (
          <Button
            key={control.key}
            variant="outline"
            size="sm"
            title={control.description ?? undefined}
            disabled={busyKey !== null}
            onClick={() => void run(control)}
          >
            {busyKey === control.key ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
            {control.label}
          </Button>
        ))}
      </div>
      {note && <p className="mt-3 text-sm text-muted-foreground">{note}</p>}
    </Panel>
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
