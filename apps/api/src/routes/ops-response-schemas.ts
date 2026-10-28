import { z } from 'zod';
import { BUSINESS_DATE_SOURCES, SYNC_EVENT_RESULTS, SYNC_QUARANTINE_REASONS } from '@oto/shared';

// Describe the existing service projections without changing their inferred
// handler types, as the Health response schemas do. Generated clients still
// receive the complete runtime schema through the API description.
const NullableText = z.string().nullable();
const Reach = z.object({
  scope: z.enum(['operator', 'branch']),
  branches: z.array(z.object({ id: z.string(), name: z.string() })),
});
const FailureGroup = z.object({
  fingerprint: z.string(), kind: z.string(), name: z.string(), count: z.number(),
  firstSeenAt: z.string(), lastSeenAt: z.string(), lastError: NullableText, lastRunId: NullableText,
  retryable: z.boolean(), branchId: NullableText, stationId: NullableText,
  actionId: NullableText, requestId: NullableText,
});
const Run = z.object({
  id: z.string(), kind: z.string(), name: z.string(), outcome: z.string(), startedAt: z.string(),
  finishedAt: NullableText, durationMs: z.number().nullable(), error: NullableText,
  fingerprint: NullableText, requestId: NullableText, actionId: NullableText,
  branchId: NullableText, stationId: NullableText,
});
const QuarantineEvent = z.object({
  id: z.string(), boxId: z.string(), boxName: z.string(), slot: z.string(), eventId: z.string(),
  journalEpoch: z.number(), boxSeq: z.number(), type: NullableText, schemaVersion: z.number().nullable(),
  reason: z.string(), status: z.string(), errorCode: NullableText, errorMessage: NullableText,
  payloadHash: NullableText, existingPayloadHash: NullableText, occurredAt: NullableText,
  receivedAt: z.string(), actionId: NullableText, batchId: NullableText, alertKey: NullableText,
  resolvedAt: NullableText, resolvedByAccountId: NullableText, resolutionNote: NullableText,
  replayedEventId: NullableText,
});
const Anomaly = z.object({
  id: z.string(), boxId: z.string(), boxName: NullableText, kind: z.string(),
  eventId: NullableText, relatedEventId: NullableText,
  detail: z.record(z.unknown()).nullable(), actionId: NullableText, detectedAt: z.string(),
});
const SyncOutcome = z.object({
  eventId: z.string(), boxSeq: z.number(), result: z.enum(SYNC_EVENT_RESULTS),
  reason: z.enum(SYNC_QUARANTINE_REASONS).optional(), businessDate: z.string().optional(),
  businessDateSource: z.enum(BUSINESS_DATE_SOURCES).optional(), errorCode: z.string().optional(),
});

export const AlertAcknowledgedResponse: z.ZodType<unknown> = z.object({ ok: z.literal(true) });
export const FailuresResponse: z.ZodType<unknown> = z.object({
  groups: z.array(FailureGroup), nextCursor: NullableText, ungrouped: z.number().optional(), reach: Reach,
});
export const RunsResponse: z.ZodType<unknown> = z.object({ runs: z.array(Run) });
export const RunRetryResponse: z.ZodType<unknown> = z.union([
  // Strict members stop the shorter job shape from stripping an integration's
  // sync result, even when both have the same ok/outcome pair.
  z.object({
    ok: z.literal(true), outcome: z.enum(['ok', 'failed']),
    syncState: z.enum(['synced', 'pending', 'failed']),
    sent: z.number(), synced: z.number(), waiting: z.number(),
  }).strict(),
  z.object({ ok: z.literal(true), outcome: z.enum(['ok', 'failed', 'not_due']) }).strict(),
]);
export const QuarantineResponse: z.ZodType<unknown> = z.object({
  events: z.array(QuarantineEvent), nextCursor: NullableText, openCount: z.number().nullable(),
});
export const AnomaliesResponse: z.ZodType<unknown> = z.object({
  anomalies: z.array(Anomaly), nextCursor: NullableText, reach: Reach,
});
export const QuarantineReplayResponse: z.ZodType<unknown> = z.object({
  ok: z.boolean(), status: z.enum(['replayed', 'open']), eventId: z.string(), errorCode: NullableText,
  errorMessage: NullableText, result: z.enum(SYNC_EVENT_RESULTS), outcome: SyncOutcome, message: z.string(),
});
export const QuarantineDiscardResponse: z.ZodType<unknown> = z.object({
  ok: z.literal(true), status: z.literal('discarded'),
});
export const TestControlsResponse: z.ZodType<unknown> = z.object({
  available: z.boolean(), controls: z.array(z.object({
    key: z.string(), label: z.string(), description: z.string(), sticky: z.boolean(),
  })),
});
export const TestControlRunResponse: z.ZodType<unknown> = z.object({ ok: z.literal(true), message: z.string() });
export const DemoResetStatusResponse: z.ZodType<unknown> = z.object({
  available: z.boolean(), confirmationPhrase: z.string(), playground: z.boolean(),
});
export const DemoResetResponse: z.ZodType<unknown> = z.object({ deleted: z.record(z.number()) });
