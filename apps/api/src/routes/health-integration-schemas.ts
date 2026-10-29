import { z } from 'zod';

// Type-only output annotations preserve the native handlers' inferred types;
// the runtime schemas describe their existing projections without coercion.
const HealthState = z.enum(['ok', 'warn', 'down', 'unknown']);
const NullableText = z.string().nullable();
const NullableNumber = z.number().nullable();
const ReadinessChecks = z.object({
  database: z.object({ ok: z.boolean(), latencyMs: z.number() }),
  pool: z.object({ total: z.number(), idle: z.number(), waiting: z.number(), max: NullableNumber }).nullable(),
  jobs: z.object({ configured: z.boolean(), watchdogAgeS: NullableNumber, staleAfterS: z.number(), stale: z.boolean() }),
  stationChannels: z.object({ stations: z.number(), connections: z.number(), perStation: z.record(z.number()) }),
});

export const LivenessResponse: z.ZodType<unknown> = z.object({ status: z.literal('ok') });
export const ReadyResponse: z.ZodType<unknown> = z.object({ status: z.enum(['ready', 'degraded']), checks: ReadinessChecks });
export const NotReadyResponse: z.ZodType<unknown> = z.object({ status: z.literal('not_ready'), checks: ReadinessChecks });

const HealthCheck = z.object({
  key: z.string(), label: z.string(), status: HealthState,
  value: z.union([z.number(), z.string(), z.null()]).optional(),
  unit: NullableText.optional(), detail: NullableText.optional(),
});
const JobStatus = z.object({
  name: z.string(), status: HealthState, lastRunAt: NullableText, lastOutcome: NullableText,
  expectedEverySeconds: NullableNumber, ageSeconds: NullableNumber, lastError: NullableText, waitingOn: z.array(z.string()),
});
const DeviceHealth = z.object({
  id: z.string().uuid(), kind: z.string(), label: z.string(), reachability: z.string(), paperStatus: z.string(),
  lastError: NullableText, lastSeenAt: NullableText,
});
// These fields are projected from native heartbeat JSON. In particular, reported
// times/cap ids are strings and finite numbers need not be positive integers.
const BoothReport = z.object({
  configVersion: NullableNumber, printerReachable: z.string(), paperStatus: z.string(), vouchersPending: NullableNumber,
  pendingUnit: z.enum(['vouchers', 'events']), lastSpinAt: NullableText, rostered: z.boolean().nullable(),
  dailyCapsReached: z.array(z.string()),
  today: z.object({ businessDate: z.string(), spins: z.number(), vouchers: z.number() }).nullable(),
  pointerPresent: z.boolean().nullable(),
});
const BoothHealth = z.object({
  stationId: z.string().uuid(), name: z.string(), codePrefix: NullableText, reported: BoothReport.nullable(),
  unattributedToday: NullableNumber, businessDate: z.string(),
});
const BoxHealth = z.object({
  id: z.string().uuid(), name: z.string(), slot: z.string(), role: z.string(), status: z.string(), state: HealthState,
  branchId: z.string().uuid(), branchName: z.string(), openingHours: z.enum(['open', 'closed', 'not_set']),
  agentVersion: NullableText, minAgentVersion: z.string(), agentBelowMinimum: z.boolean(),
  lastHeartbeatAt: NullableText, heartbeatAgeSeconds: NullableNumber, uptimeSeconds: NullableNumber,
  outboxDepth: NullableNumber, oldestUnackedAgeS: NullableNumber, quarantineOpen: z.number(), lastSyncAt: NullableText,
  clockOffsetMs: NullableNumber, tempC: NullableNumber, currentEpoch: z.number(), configVersion: NullableText,
  devices: z.array(DeviceHealth), booths: z.array(BoothHealth), conditions: z.array(z.string()), detail: NullableText,
});
const AlertRow = z.object({
  id: z.string().uuid(), key: z.string(), severity: z.enum(['info', 'warning', 'critical']), title: z.string(),
  detail: NullableText, openedAt: z.string(), acknowledgedAt: NullableText, resolvedAt: NullableText, count: z.number(),
});
const Reach = z.object({ scope: z.enum(['operator', 'branch']), branches: z.array(z.object({ id: z.string().uuid(), name: z.string() })) });
const RollupFreshness = z.object({
  branchId: z.string().uuid(), name: z.string(), today: z.string(), lastRolledUpAt: NullableText,
  boothLastRolledUpAt: NullableText, reportsLastRolledUpAt: NullableText,
});

/** SCRUM-645 / Q26: whether each evidence read behind the answer actually answered. */
const ReadAvailability = z.enum(['ok', 'failed', 'denied', 'unknown']);
const HealthEvidence = z.object({
  source: z.enum(['jobs', 'fleet', 'alerts', 'watchdog', 'occupancy']), label: z.string(),
  availability: ReadAvailability, detail: NullableText,
});

export const HealthSnapshotResponse: z.ZodType<unknown> = z.object({
  status: HealthState, checks: z.array(HealthCheck), jobs: z.array(JobStatus), boxes: z.array(BoxHealth), alerts: z.array(AlertRow),
  watchdogAgeSeconds: NullableNumber, generatedAt: z.string(), reach: Reach, rollups: z.array(RollupFreshness),
  evidence: z.array(HealthEvidence),
});

const IntegrationProvider = z.object({
  key: z.string(), name: z.string(), purpose: z.string(), category: z.string(),
  state: z.enum(['configured', 'missing', 'disabled', 'degraded', 'unknown']),
  missingVars: z.array(z.string()).optional(), endpoint: NullableText.optional(), lastDeliveryAt: NullableText.optional(),
  lastDeliveryOutcome: NullableText.optional(), detail: NullableText.optional(),
  // SCRUM-645 / Q26: this read's availability, and the row's integration history.
  availability: ReadAvailability, lastOkAt: NullableText, lastFailedAt: NullableText,
});
const EnvVariable = z.object({ name: z.string(), present: z.boolean(), required: z.boolean(), purpose: z.string(), provider: NullableText });
export const IntegrationsResponse: z.ZodType<unknown> = z.object({ providers: z.array(IntegrationProvider), variables: z.array(EnvVariable) });
