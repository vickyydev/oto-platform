import { and, eq, sql } from 'drizzle-orm';
import { setting, type Db } from '@oto/db';
import { z } from 'zod';
import { errors } from '../lib/errors';
import { audit } from './audit';
import { withTx, type Exec, type OpContext } from './tx';

export const ASSISTANT_SETTINGS_KEY = 'assistant_settings';
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const internal = z.object({
  personDailyCap: count, dailyAskCap: count, dailyTokenCap: count,
  concurrentPerPerson: z.number().int().min(1).max(100),
  concurrentPerOperator: z.number().int().min(1).max(1000),
}).strict();
const inbox = z.object({
  dailyTurnCap: count, dailyTokenCap: count,
  debounceSeconds: z.number().int().min(0).max(600),
  debounceMaxSeconds: z.number().int().min(0).max(3600),
  firstBubbleMs: z.number().int().min(0).max(120000),
  bubbleGapMs: z.number().int().min(0).max(60000),
  // SCRUM-677: the coherence review of a mixed reply; native default on.
  coherenceReview: z.boolean(),
}).strict();
export const AssistantOverridesSchema = z.object({ internal: internal.partial(), inbox: inbox.partial() }).strict();
export type AssistantOverrides = z.infer<typeof AssistantOverridesSchema>;
export const AssistantDefaultsSchema = z.object({ internal, inbox }).strict();
export type AssistantDefaults = z.infer<typeof AssistantDefaultsSchema>;
const utcDate = z.string().datetime().refine(value => {
  const parsed = new Date(value);
  // PostgreSQL has no year zero; reject it before immutable pricing history is saved.
  return Number.isFinite(parsed.getTime()) && parsed.getUTCFullYear() >= 1
    && parsed.toISOString().slice(0, 10) === value.slice(0, 10);
}, 'Choose a real UTC date and time');
const usdRate = z.number().finite().min(0).max(Number.MAX_SAFE_INTEGER);
export const AssistantRateVersionSchema = z.object({
  model: z.string().trim().min(1).max(200), effectiveFrom: utcDate,
  inputUsdPerMillion: usdRate, outputUsdPerMillion: usdRate, cacheReadUsdPerMillion: usdRate,
}).strict();
export type RateVersion = z.infer<typeof AssistantRateVersionSchema>;
const versions = z.array(AssistantRateVersionSchema).max(1000).superRefine((rates, ctx) => {
  const seen = new Set<string>();
  for (const rate of rates) {
    const key = rateKey(rate);
    if (seen.has(key)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Each model and effective time must be unique' });
    seen.add(key);
  }
});
const documentFields = { schemaVersion: z.literal(1), overrides: AssistantOverridesSchema, rates: versions };
export const AssistantSettingsDocumentSchema = z.object(documentFields).strict();
export type AssistantSettingsDocument = z.infer<typeof AssistantSettingsDocumentSchema>;
export const AssistantSettingsWriteSchema = z.object({ expectedRevision: count, ...documentFields }).strict();
export type AssistantSettingsWrite = z.infer<typeof AssistantSettingsWriteSchema>;
export const AssistantSettingsReadSchema = z.object({
  operatorId: z.string().uuid(), ...documentFields,
  effective: AssistantDefaultsSchema,
  source: z.enum(['environment', 'operator', 'invalid']), revision: count,
  updatedAt: z.string().datetime().nullable(), updatedBy: z.string().uuid().nullable(),
}).strict();
export type AssistantSettingsRead = z.infer<typeof AssistantSettingsReadSchema>;
type SettingRow = typeof setting.$inferSelect;

const empty = (): AssistantSettingsDocument => ({ schemaVersion: 1, overrides: { internal: {}, inbox: {} }, rates: [] });
function rateKey(rate: RateVersion): string { return JSON.stringify([rate.model, Date.parse(rate.effectiveFrom)]); }
async function rowOf(exec: Exec, operatorId: string): Promise<SettingRow | undefined> {
  return (await exec.select().from(setting).where(and(eq(setting.operatorId, operatorId), eq(setting.key, ASSISTANT_SETTINGS_KEY))).limit(1))[0];
}
function validDocument(value: unknown): AssistantSettingsDocument | null {
  const parsed = AssistantSettingsDocumentSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** Fresh per operation; invalid documents cannot partially change native policy. DB failures remain failures. */
export async function assistantSettingOverridesOf(exec: Exec, operatorId: string): Promise<AssistantOverrides> {
  const row = await rowOf(exec, operatorId);
  return (row && validDocument(row.value)?.overrides) || empty().overrides;
}

/** Pricing uses the same validated document in its caller's read-only snapshot, never a global config cache. */
export async function assistantSettingRatesOf(exec: Exec, operatorId: string): Promise<RateVersion[]> {
  const row = await rowOf(exec, operatorId);
  return (row && validDocument(row.value)?.rates) || [];
}

function viewOf(row: SettingRow | undefined, operatorId: string, defaults: AssistantDefaults): AssistantSettingsRead {
  const parsed = row ? validDocument(row.value) : null;
  const document = parsed ?? empty();
  const effective = {
    internal: { ...defaults.internal, ...document.overrides.internal },
    inbox: { ...defaults.inbox, ...document.overrides.inbox },
  };
  // Native scheduling permits a lower raw max and normalizes it after fallback.
  effective.inbox.debounceMaxSeconds = Math.max(effective.inbox.debounceSeconds, effective.inbox.debounceMaxSeconds);
  return {
    operatorId, ...document, effective, source: row ? parsed ? 'operator' : 'invalid' : 'environment',
    revision: row?.revision ?? 0, updatedAt: row ? row.updatedAt.toISOString() : null, updatedBy: row?.updatedBy ?? null,
  };
}

export async function readAssistantSettings(exec: Exec, operatorId: string, defaults: AssistantDefaults): Promise<AssistantSettingsRead> {
  return viewOf(await rowOf(exec, operatorId), operatorId, defaults);
}

function preserveRateHistory(previous: readonly RateVersion[], incoming: readonly RateVersion[]): void {
  const supplied = new Map(incoming.map(rate => [rateKey(rate), rate]));
  const latest = new Map<string, number>();
  const sameVersion = (a: RateVersion, b: RateVersion): boolean => a.model === b.model && a.effectiveFrom === b.effectiveFrom
    && a.inputUsdPerMillion === b.inputUsdPerMillion && a.outputUsdPerMillion === b.outputUsdPerMillion
    && a.cacheReadUsdPerMillion === b.cacheReadUsdPerMillion;
  for (const rate of previous) {
    const next = supplied.get(rateKey(rate));
    if (!next || !sameVersion(rate, next)) throw errors.conflict('ASSISTANT_RATE_HISTORY_IMMUTABLE', 'Saved rate versions cannot be edited or removed');
    latest.set(rate.model, Math.max(latest.get(rate.model) ?? -Infinity, Date.parse(rate.effectiveFrom)));
  }
  const existing = new Set(previous.map(rateKey));
  for (const rate of incoming) {
    if (!existing.has(rateKey(rate)) && Date.parse(rate.effectiveFrom) <= (latest.get(rate.model) ?? -Infinity)) {
      throw errors.conflict('ASSISTANT_RATE_HISTORY_IMMUTABLE', 'A new rate version must start after the existing versions for that model');
    }
  }
}

/** Whole-document optimistic save, atomic with its sanitized success audit and idempotent response. */
export async function saveAssistantSettings(db: Db, ctx: OpContext, input: {
  operatorId: string; accountId: string; document: AssistantSettingsWrite; defaults: AssistantDefaults;
}): Promise<AssistantSettingsRead> {
  const { operatorId, accountId, defaults } = input;
  const request = AssistantSettingsWriteSchema.parse(input.document);
  return withTx(db, { ...ctx, operatorId, actorAccountId: accountId, branchId: null }, 'assistant_settings.update', async tx => {
    // A missing row cannot be row-locked: serialize the same owned key before
    // reading so two first saves cannot both accept revision zero.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${operatorId + ':' + ASSISTANT_SETTINGS_KEY},638))`);
    const previous = await rowOf(tx, operatorId);
    const revision = previous?.revision ?? 0;
    if (request.expectedRevision !== revision) throw errors.conflict('ASSISTANT_SETTINGS_REVISION', 'Settings changed. Reload and review before saving');
    if (revision >= 2147483647) throw errors.conflict('ASSISTANT_SETTINGS_REVISION', 'The settings revision cannot be advanced');
    const previousDocument = previous && validDocument(previous.value);
    preserveRateHistory(previousDocument?.rates ?? [], request.rates);
    const value: AssistantSettingsDocument = { schemaVersion: 1, overrides: request.overrides, rates: request.rates };
    let saved: SettingRow | undefined;
    if (previous) {
      [saved] = await tx.update(setting).set({ value, revision: revision + 1, updatedBy: accountId, updatedAt: new Date() })
        .where(and(eq(setting.operatorId, operatorId), eq(setting.key, ASSISTANT_SETTINGS_KEY), eq(setting.revision, revision))).returning();
    } else {
      [saved] = await tx.insert(setting).values({ operatorId, key: ASSISTANT_SETTINGS_KEY, value, revision: 1, updatedBy: accountId }).returning();
    }
    if (!saved) throw errors.conflict('ASSISTANT_SETTINGS_REVISION', 'Settings changed. Reload and review before saving');
    const answer = viewOf(saved, operatorId, defaults);
    await audit.record(tx, {
      actorAccountId: accountId, operatorId, branchId: null, requestId: ctx.requestId,
      action: 'assistant_settings.update', entityType: 'setting', entityId: operatorId,
      // Never audit the unvalidated raw document, even when repairing it.
      before: viewOf(previous, operatorId, defaults), after: answer,
    });
    return answer;
  });
}
