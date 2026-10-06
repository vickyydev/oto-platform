/**
 * Everything the console reads about how the platform is running: the audit
 * log, failed operation runs, health and the outside services we depend on.
 *
 * WHY IT IS ALL IN ONE FILE. The API half of S2-03 is being built beside this
 * app, so these paths and shapes are the contract rather than a description of
 * something already deployed. Keeping them in one module means retargeting a
 * path is one edit here, not a hunt through four pages — and every field the
 * API has not grown yet is optional, so the console renders correctly against
 * today's API and fills in as the routes land.
 *
 * Two rules the pages depend on:
 *   - a 404 means "this deployment does not have that route yet" and the page
 *     says so (see isMissingRoute); anything else is a real failure;
 *   - personal data arrives MASKED unless the caller holds
 *     `admin:audit:read_sensitive` and deliberately asks for it. Unmasking is
 *     an action with a record of its own, never a page load.
 */
import { api, ApiError, qs } from './client';

// ---------------------------------------------------------------------------
// Activity — the audit log
// ---------------------------------------------------------------------------

export interface AuditEntry {
  id: string;
  action: string;
  entityType: string | null;
  entityId: string | null;
  actorAccountId: string | null;
  branchId: string | null;
  requestId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
  /** S2-03 classification columns. Absent on rows written before they landed. */
  category?: string | null;
  app?: string | null;
  outcome?: string | null;
  origin?: string | null;
  actorType?: string | null;
  sessionId?: string | null;
  stationId?: string | null;
  boxId?: string | null;
  occurredAt?: string | null;
  /** True when this row's personal fields were masked on the way out. */
  masked?: boolean;
}

export interface AuditFilters {
  action?: string;
  outcome?: 'success' | 'failure';
  actorAccountId?: string;
  branchId?: string;
  entityType?: string;
  entityId?: string;
  from?: string;
  to?: string;
  limit?: number;
  cursor?: string;
  /**
   * The two filters the ticket asks for that `GET /audit` does not carry yet.
   * Sent regardless: an unknown query key is stripped by the route's schema,
   * so this is harmless today and starts working the day the column lands. The
   * page checks whether the answer honoured them and says so if it did not,
   * rather than showing a filtered-looking list that is not filtered.
   */
  requestId?: string;
  category?: string;
}

export interface AuditPage {
  entries: AuditEntry[];
  /** Keyset pagination. Absent or null means this is the last page. */
  nextCursor?: string | null;
  /**
   * Whether the API masked personal fields in these rows. It masks for every
   * caller without `admin:audit:read_sensitive`; for a caller with it the rows
   * arrive in the clear and the API records an `audit.read_sensitive` row of
   * its own against that read.
   */
  masked?: boolean;
}

export const activityApi = {
  list: (filters: AuditFilters) => api.get<AuditPage>(`/audit${qs({ ...filters })}`),
};

// ---------------------------------------------------------------------------
// Failures — ops_run rows whose outcome was not success
// ---------------------------------------------------------------------------

/** The kinds of thing that can fail quietly and therefore write an ops_run. */
export type OpsKind = 'job' | 'http' | 'client' | 'device' | 'integration' | 'process' | 'sync';

export interface FailureGroup {
  /** Stable hash of the error's shape — what makes sixty failures one problem. */
  fingerprint: string;
  kind: OpsKind | string;
  /** The operation that failed: a job name, a route pattern, an adapter. */
  name: string;
  count: number;
  firstSeenAt: string;
  lastSeenAt: string;
  lastError: string | null;
  /** The newest run in the group — what a retry re-runs. */
  lastRunId: string | null;
  /** False for anything whose re-run is not safe to start from here. */
  retryable?: boolean;
  branchId?: string | null;
  stationId?: string | null;
  actionId?: string | null;
  requestId?: string | null;
}

export interface FailurePage {
  groups: FailureGroup[];
  nextCursor?: string | null;
  /** Failures in the window whose group could not be worked out. */
  ungrouped?: number;
}

export interface OpsRun {
  id: string;
  kind: OpsKind | string;
  name: string;
  outcome: string;
  startedAt: string;
  finishedAt: string | null;
  durationMs?: number | null;
  error: string | null;
  fingerprint?: string | null;
  requestId?: string | null;
  actionId?: string | null;
  branchId?: string | null;
  stationId?: string | null;
  attempt?: number | null;
}

export const failuresApi = {
  groups: (params: { windowHours?: number; kind?: string; cursor?: string; limit?: number }) =>
    api.get<FailurePage>(`/ops/failures${qs({ ...params })}`),
  runs: (fingerprint: string, limit = 20) =>
    api.get<{ runs: OpsRun[] }>(`/ops/runs${qs({ fingerprint, limit })}`),
  /** Re-runs one failed operation. `admin:ops:manage`. */
  retry: (runId: string) =>
    api.post<{ ok: true; runId?: string }>(`/ops/runs/${encodeURIComponent(runId)}/retry`),
};

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export type HealthState = 'ok' | 'warn' | 'down' | 'unknown';

export interface HealthCheck {
  key: string;
  label?: string;
  status: HealthState;
  /** A number worth showing on the tile — latency, an age, a queue depth. */
  value?: number | string | null;
  unit?: string | null;
  detail?: string | null;
}

export interface JobStatus {
  name: string;
  status: HealthState;
  lastRunAt: string | null;
  lastOutcome?: string | null;
  /** How often this job is expected to run, from its ops_expectation row. */
  expectedEverySeconds?: number | null;
  /** Seconds since it last finished. The watchdog's whole argument. */
  ageSeconds?: number | null;
  lastError?: string | null;
}

export interface AlertRow {
  id: string;
  key: string;
  severity: 'critical' | 'warning' | 'info' | string;
  title: string;
  detail?: string | null;
  openedAt: string;
  acknowledgedAt?: string | null;
  acknowledgedBy?: string | null;
  resolvedAt?: string | null;
  count?: number | null;
}

/** What a booth's box measured about itself on its last heartbeat (S2-07a). */
export interface BoothReport {
  /** The published wheel it is running. **Null means it has never synced one.** */
  configVersion: number | null;
  /** Tri-state: `unknown` is "the box could not ask", which is not "unreachable". */
  printerReachable: string;
  paperStatus: string;
  /** The box's whole outbox depth, which is what the booth module reports. */
  vouchersPending: number | null;
  lastSpinAt: string | null;
  /** Whether somebody is signed in. Never who. */
  staffSignedIn: boolean;
  /** `booth.booth_prize` ids at their cap today — configuration, not people. */
  dailyCapsReached: string[];
}

/** One booth on a box, as `/ops/health` reports it. */
export interface BoothHealth {
  stationId: string;
  name: string;
  codePrefix: string | null;
  /** Null where the box has sent no booth block — NOT evidence it runs nothing. */
  reported: BoothReport | null;
  /** Vouchers issued today with nobody signed in. **Null means it could not be counted.** */
  unattributedToday: number | null;
  businessDate: string;
}

export interface HealthBoxDevice {
  id: string;
  kind: string;
  label: string;
  reachability: string;
  paperStatus: string;
  lastError: string | null;
  lastSeenAt: string | null;
}

/**
 * One box on the Health snapshot.
 *
 * Only the fields the booth section reads are named — the API answers with
 * more, and the Devices pages read those from `@/api/fleet` instead.
 */
export interface HealthBox {
  id: string;
  name: string;
  slot: string;
  status: string;
  state: HealthState;
  branchName: string;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds?: number | null;
  outboxDepth?: number | null;
  /** Read for its ids, which is how a `device.paper` alert is tied to a box. */
  devices?: HealthBoxDevice[];
  /** The alert keys true about this box right now. */
  conditions: string[];
  /** Empty on every till; that is what the booth section filters on. */
  booths?: BoothHealth[];
}

export interface HealthSnapshot {
  status: HealthState;
  checks: HealthCheck[];
  jobs: JobStatus[];
  /**
   * Every box of this operator with what it last reported. Optional because a
   * deployment older than S2-04 answers without it — and the Devices pages read
   * the fleet from `@/api/fleet`, so only the booth section reads this.
   */
  boxes?: HealthBox[];
  alerts: AlertRow[];
  /** Seconds since the watchdog last ran — the check that checks the checks. */
  watchdogAgeSeconds?: number | null;
  generatedAt?: string;
  /**
   * S2-15b round 3: when the analytics rollup last brought each park in the
   * caller's reach up to date. Optional: an older API answers without it.
   */
  rollups?: RollupFreshness[];
}

/** One park's line on Health: its business date in progress and its last rollup. */
export interface RollupFreshness {
  branchId: string;
  name: string;
  today: string;
  /** ISO, or null when the rollup has never brought this park up to date. */
  lastRolledUpAt: string | null;
  /**
   * S2-15b round 5: when the booth figures (`job:rollup.booth`) were last
   * brought up to date here. Optional: an older API answers without it.
   */
  boothLastRolledUpAt?: string | null;
  /**
   * S2-15b round 6: when the Reports panels' rows (written by the daily
   * rollup with the day) were last brought up to date here. Optional: an older
   * API answers without it.
   */
  reportsLastRolledUpAt?: string | null;
}

/** What `/ready` answers. Public, and the one call that works on every deployment. */
export interface Readiness {
  status: string;
  ok: boolean;
  checks?: Record<string, unknown>;
  /** How long the round trip took from here, when the API reports nothing itself. */
  roundTripMs: number;
}

export const healthApi = {
  /**
   * Read `/ready` without treating its 503 as a transport failure: a 503 IS the
   * answer, and the page needs the body that came with it.
   */
  ready: async (): Promise<Readiness> => {
    const started = performance.now();
    const res = await fetch('/api/ready', { credentials: 'same-origin' });
    const roundTripMs = Math.round(performance.now() - started);
    const body = (await res.json().catch(() => null)) as
      | { status?: string; checks?: Record<string, unknown> }
      | null;
    return {
      status: body?.status ?? (res.ok ? 'ready' : 'not_ready'),
      ok: res.ok,
      checks: body?.checks,
      roundTripMs,
    };
  },
  snapshot: () => api.get<HealthSnapshot>('/ops/health'),
  acknowledgeAlert: (id: string) =>
    api.post<{ ok: true }>(`/ops/alerts/${encodeURIComponent(id)}/acknowledge`),
};

// ---------------------------------------------------------------------------
// Integrations — outside services, by name and state only
// ---------------------------------------------------------------------------

export type IntegrationState = 'configured' | 'missing' | 'disabled' | 'degraded' | 'unknown';

export interface IntegrationProvider {
  key: string;
  name: string;
  /** What it does for us, in the API's own words. */
  purpose?: string | null;
  category?: string | null;
  state: IntegrationState | string;
  /** Which of its variables are unset. NAMES ONLY — never a value. */
  missingVars?: string[];
  /** Where it answers, when that is a public address (a webhook, an endpoint). */
  endpoint?: string | null;
  lastDeliveryAt?: string | null;
  lastDeliveryOutcome?: string | null;
  detail?: string | null;
}

export interface EnvVariable {
  name: string;
  present: boolean;
  required?: boolean;
  purpose?: string | null;
  provider?: string | null;
}

export interface IntegrationsSnapshot {
  providers: IntegrationProvider[];
  /** Generated from the API's env schema: what still has to be provisioned. */
  variables: EnvVariable[];
}

export const integrationsApi = {
  snapshot: () => api.get<IntegrationsSnapshot>('/ops/integrations'),
};

// ---------------------------------------------------------------------------
// Test controls — only on a deployment that admits to being a playground
// ---------------------------------------------------------------------------

/**
 * `OPS_TEST_CONTROLS` and a platform-wide caller, both. The API answers rather
 * than refuses (as `GET /ops/demo-reset` already does), so the console can hide
 * the section without every page load recording a denial against the staff who
 * will never see it.
 */
export interface TestControl {
  key: string;
  label: string;
  description?: string | null;
  /** True for anything whose effect outlives the press — stopping the watchdog. */
  sticky?: boolean;
}

export const testControlsApi = {
  list: () => api.get<{ available: boolean; controls: TestControl[] }>('/ops/test-controls'),
  run: (key: string) =>
    api.post<{ ok: true; message?: string }>(`/ops/test-controls/${encodeURIComponent(key)}`),
};

/** A refusal the console can act on, told apart from a route that is simply absent. */
export function isForbidden(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 403 || err.code === 'FORBIDDEN');
}
