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
import type { ApiResponse, paths } from '@oto/api-types';
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

type NativeHealthSnapshot = ApiResponse<'/ops/health', 'get'>;
export type HealthState = NativeHealthSnapshot['status'];
type NativeHealthCheck = NativeHealthSnapshot['checks'][number];
/** Public readiness fallbacks may supply only a key for the displayed label. */
export type HealthCheck = Omit<NativeHealthCheck, 'label'> & Partial<Pick<NativeHealthCheck, 'label'>>;
type NativeJobStatus = NativeHealthSnapshot['jobs'][number];
/** Older deployments omit the newer job outcome and expectation fields. */
export type JobStatus = Pick<NativeJobStatus, 'name' | 'status' | 'lastRunAt'> &
  Partial<Omit<NativeJobStatus, 'name' | 'status' | 'lastRunAt'>>;
/** Retain the existing optional display field; the native read does not supply it. */
export type AlertRow = NativeHealthSnapshot['alerts'][number] & { acknowledgedBy?: string | null };
export type HealthBox = NativeHealthSnapshot['boxes'][number];
export type HealthBoxDevice = HealthBox['devices'][number];
export type BoothHealth = HealthBox['booths'][number];
export type BoothReport = NonNullable<BoothHealth['reported']>;
type NativeRollupFreshness = NativeHealthSnapshot['rollups'][number];
/** Earlier deployments omit the later booth and Reports rollup timestamps. */
export type RollupFreshness = Omit<NativeRollupFreshness, 'boothLastRolledUpAt' | 'reportsLastRolledUpAt'> &
  Partial<Pick<NativeRollupFreshness, 'boothLastRolledUpAt' | 'reportsLastRolledUpAt'>>;
/** Keep the established older-deployment omissions visible to the screens. */
export type HealthSnapshot = Omit<NativeHealthSnapshot,
  'jobs' | 'boxes' | 'watchdogAgeSeconds' | 'generatedAt' | 'rollups' | 'evidence'> & {
    jobs: JobStatus[];
    rollups?: RollupFreshness[];
  } & Partial<Pick<NativeHealthSnapshot, 'boxes' | 'watchdogAgeSeconds' | 'generatedAt' | 'evidence'>>;
/** SCRUM-645 / Q26: one evidence read's verdict. Absent on deployments before it. */
export type HealthEvidence = NonNullable<NativeHealthSnapshot['evidence']>[number];

type ReadyAnswer = ApiResponse<'/ready', 'get'> |
  paths['/ready']['get']['responses'][503]['content']['application/json'];

/** What `/ready` answers. Public, and the one call that works on every deployment. */
export interface Readiness {
  status: ReadyAnswer['status'];
  ok: boolean;
  checks?: ReadyAnswer['checks'];
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
      | { status?: unknown; checks?: ReadyAnswer['checks'] }
      | null;
    if (!body || Array.isArray(body) ||
      (body.status !== 'ready' && body.status !== 'degraded' && body.status !== 'not_ready')) {
      throw new Error('The API returned an unreadable readiness response.');
    }
    return {
      status: body.status,
      ok: res.ok,
      checks: body?.checks,
      roundTripMs,
    };
  },
  snapshot: () => api.get<ApiResponse<'/ops/health', 'get'>>('/ops/health'),
  acknowledgeAlert: (id: string) =>
    api.post<{ ok: true }>(`/ops/alerts/${encodeURIComponent(id)}/acknowledge`),
};

// ---------------------------------------------------------------------------
// Integrations — outside services, by name and state only
// ---------------------------------------------------------------------------

export type IntegrationsSnapshot = ApiResponse<'/ops/integrations', 'get'>;
export type IntegrationProvider = IntegrationsSnapshot['providers'][number];
export type IntegrationState = IntegrationProvider['state'];
export type EnvVariable = IntegrationsSnapshot['variables'][number];

/** SCRUM-645 / Q26: the owner's credential expiry dates and the integration test seams. */
export type CredentialExpiryList = ApiResponse<'/ops/integrations/credentials', 'get'>;
export type CredentialExpiry = CredentialExpiryList['credentials'][number];
export type IntegrationTests = ApiResponse<'/ops/integrations/tests', 'get'>;
export type IntegrationTestRow = IntegrationTests['tests'][number];
export type IntegrationTestResult = ApiResponse<'/ops/integrations/{key}/test', 'post'>;

export const integrationsApi = {
  snapshot: () => api.get<ApiResponse<'/ops/integrations', 'get'>>('/ops/integrations'),
  credentials: () => api.get<ApiResponse<'/ops/integrations/credentials', 'get'>>('/ops/integrations/credentials'),
  /** `console:integration:manage` at operator scope. Null clears the date. */
  setExpiry: (key: CredentialExpiry['integration'], expiresOn: string | null, idempotencyKey: string) =>
    api.put<ApiResponse<'/ops/integrations/{key}/expiry', 'put'>>(
      `/ops/integrations/${encodeURIComponent(key)}/expiry`,
      { expiresOn },
      { idempotencyKey },
    ),
  tests: () => api.get<ApiResponse<'/ops/integrations/tests', 'get'>>('/ops/integrations/tests'),
  /** `OPS_TEST_CONTROLS` and `console:integration:test`. Every adapter is a local fake. */
  runTest: (key: IntegrationTestRow['integration'], idempotencyKey: string) =>
    api.post<ApiResponse<'/ops/integrations/{key}/test', 'post'>>(
      `/ops/integrations/${encodeURIComponent(key)}/test`,
      undefined,
      { idempotencyKey },
    ),
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
