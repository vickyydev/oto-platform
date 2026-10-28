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
import type { ApiBody, ApiResponse, paths } from '@oto/api-types';
import { api, ApiError, idemKey, qs } from './client';

// ---------------------------------------------------------------------------
// Activity — the audit log
// ---------------------------------------------------------------------------

export type AuditPage = ApiResponse<'/audit/', 'get'>;

export type AuditEntry = AuditPage['entries'][number] & {
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
};

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
  /** SCRUM-644: `data_access` and `denial` are answered on the server for every row. */
  category?: 'data_access' | 'denial';
  /** SCRUM-644: the producer's app label, and the app a Console action reached into. */
  app?: string;
  targetApp?: string;
}

/** The filters an export carries: the read's own, without its paging. */
export type ActivityExportFilters = Omit<AuditFilters, 'limit' | 'cursor' | 'requestId'>;

/** One downloaded export page, and whether the trail holds more past it. */
export interface ActivityExportFile {
  blob: Blob;
  filename: string | null;
  rows: number | null;
  masked: boolean | null;
  /** Set when the page was full: the next page is a second, separately recorded export. */
  nextCursor: string | null;
}

export const activityApi = {
  list: (filters: AuditFilters) => api.get<ApiResponse<'/audit/', 'get'>>(`/audit${qs({ ...filters })}`),
  /**
   * SCRUM-644: one bounded page of the trail as CSV or NDJSON, masked exactly
   * as the list is. Every export is recorded against the person downloading.
   */
  exportFile: async (
    filters: ActivityExportFilters,
    format: 'csv' | 'ndjson',
    opts: { limit?: number; cursor?: string } = {},
  ): Promise<ActivityExportFile> => {
    const file = await api.getFile(`/audit/export${qs({ ...filters, format, limit: opts.limit, cursor: opts.cursor })}`);
    const rows = file.headers?.get('x-oto-export-rows');
    const masked = file.headers?.get('x-oto-export-masked');
    return {
      blob: file.blob,
      filename: file.filename,
      rows: rows === null || rows === undefined ? null : Number(rows),
      masked: masked === null || masked === undefined ? null : masked === 'true',
      nextCursor: file.headers?.get('x-oto-next-cursor') ?? null,
    };
  },
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
// Alert mutes and recipients (SCRUM-644, planner ruling Q25)
// ---------------------------------------------------------------------------

export type AlertMutePage = ApiResponse<'/ops/alert-mutes', 'get'>;
export type AlertMute = AlertMutePage['mutes'][number];
export type AlertRecipientPage = ApiResponse<'/ops/alert-recipients', 'get'>;
export type AlertRecipient = AlertRecipientPage['recipients'][number];
export type NewAlertRecipient = ApiBody<'/ops/alert-recipients', 'post'>;

export const alertRoutingApi = {
  /** The mutes in force. The Failures read door (`admin:health:read`). */
  mutes: () => api.get<ApiResponse<'/ops/alert-mutes', 'get'>>('/ops/alert-mutes'),
  /** Mute a fingerprint: reason required, at most 24 hours. `console:alert:manage`. */
  mute: (body: ApiBody<'/ops/alert-mutes', 'post'>) =>
    api.post<ApiResponse<'/ops/alert-mutes', 'post'>>('/ops/alert-mutes', body, { idempotencyKey: idemKey() }),
  lift: (muteId: string) =>
    api.post<ApiResponse<'/ops/alert-mutes/{muteId}/lift', 'post'>>(
      `/ops/alert-mutes/${encodeURIComponent(muteId)}/lift`, undefined, { idempotencyKey: idemKey() }),
  recipients: () => api.get<ApiResponse<'/ops/alert-recipients', 'get'>>('/ops/alert-recipients'),
  addRecipient: (body: NewAlertRecipient) =>
    api.post<ApiResponse<'/ops/alert-recipients', 'post'>>('/ops/alert-recipients', body, { idempotencyKey: idemKey() }),
  updateRecipient: (id: string, body: ApiBody<'/ops/alert-recipients/{recipientId}', 'patch'>) =>
    api.patch<ApiResponse<'/ops/alert-recipients/{recipientId}', 'patch'>>(
      `/ops/alert-recipients/${encodeURIComponent(id)}`, body, { idempotencyKey: idemKey() }),
  archiveRecipient: (id: string) =>
    api.post<ApiResponse<'/ops/alert-recipients/{recipientId}/archive', 'post'>>(
      `/ops/alert-recipients/${encodeURIComponent(id)}/archive`, undefined, { idempotencyKey: idemKey() }),
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
