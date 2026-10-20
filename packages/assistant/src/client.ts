/**
 * The model call (PLAN §B.1, §D.1).
 *
 * `AssistantClient.decide` never throws and never returns text other than the
 * parsed decision: every failure is an outcome with a reason word, and an
 * error surfaces as its class, HTTP status and request id only. The SDK's
 * own error message can echo request content, so it is never kept, logged or
 * returned.
 *
 * The real implementation and the fake share `interpretReply` and
 * `interpretError`, so every failure shape the fake produces is classified by
 * exactly the code that classifies the real API's.
 */

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { AiDecisionSchema, type AiDecision } from './decision';
import type { BuiltPrompt } from './prompt';

export const AI_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type AiEffort = (typeof AI_EFFORTS)[number];

/** §B.1 parameters. */
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const DEFAULT_EFFORT: AiEffort = 'low';
export const DEFAULT_TIMEOUT_MS = 20_000;
export const DEFAULT_MAX_RETRIES = 1;
export const MAX_OUTPUT_TOKENS = 2_000;
/** §B.7: the server-side refusal fallback, routed by refusal category. */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

/**
 * Whether the model accepts `fallbacks: "default"`. Claude Haiku has no
 * server-side fallback and would reject the parameter, so a cheaper
 * `INBOX_AI_MODEL` (G3) must not send it.
 */
export function supportsServerFallback(model: string): boolean {
  return /^claude-(?:opus|sonnet|fable)-/.test(model);
}

export const PROVIDER_FAILURES = [
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_ERROR',
  'REFUSAL',
  'MALFORMED',
  'MAX_TOKENS',
] as const;
export type ProviderFailure = (typeof PROVIDER_FAILURES)[number];

/** Everything an error may contribute to a log line or an ops row. */
export interface ProviderErrorInfo {
  errorClass: string;
  status: number | null;
  requestId: string | null;
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export type AssistantOutcome =
  | {
      ok: true;
      decision: AiDecision;
      usage: TurnUsage;
      /** The model that served the turn (a fallback may differ from the one asked). */
      model: string;
      requestId: string | null;
      latencyMs: number;
    }
  | {
      ok: false;
      reason: ProviderFailure;
      error: ProviderErrorInfo | null;
      usage: TurnUsage | null;
      model: string | null;
      requestId: string | null;
      latencyMs: number;
    };

export interface AssistantRequest {
  prompt: BuiltPrompt;
}

export interface AssistantClient {
  readonly model: string;
  decide(request: AssistantRequest): Promise<AssistantOutcome>;
}

// ---------------------------------------------------------------------------
// Shared interpretation
// ---------------------------------------------------------------------------

/** The part of a Messages API reply the interpretation reads. A `BetaMessage` satisfies it. */
export interface ModelReply {
  model: string;
  stop_reason: string | null;
  content: ReadonlyArray<{ type: string; text?: string }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
  _request_id?: string | null;
}

function usageOf(reply: ModelReply): TurnUsage {
  return {
    inputTokens: reply.usage.input_tokens,
    outputTokens: reply.usage.output_tokens,
    cacheReadTokens: reply.usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: reply.usage.cache_creation_input_tokens ?? 0,
  };
}

/**
 * Stop reason first: a refused or truncated reply is never parsed, so a
 * truncated JSON is MAX_TOKENS, not MALFORMED.
 */
export function interpretReply(reply: ModelReply, latencyMs: number): AssistantOutcome {
  const usage = usageOf(reply);
  const requestId = reply._request_id ?? null;
  const fail = (reason: ProviderFailure): AssistantOutcome => ({
    ok: false,
    reason,
    error: null,
    usage,
    model: reply.model,
    requestId,
    latencyMs,
  });
  if (reply.stop_reason === 'refusal') return fail('REFUSAL');
  if (reply.stop_reason === 'max_tokens') return fail('MAX_TOKENS');
  if (reply.stop_reason !== 'end_turn') return fail('MALFORMED');
  const text = reply.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail('MALFORMED');
  }
  const parsed = AiDecisionSchema.safeParse(json);
  if (!parsed.success) return fail('MALFORMED');
  return { ok: true, decision: parsed.data, usage, model: reply.model, requestId, latencyMs };
}

function errorClassOf(err: unknown): string {
  if (err instanceof Error) return err.constructor.name || 'Error';
  return 'NonError';
}

/** Class, status, request id: nothing else of the error is read. */
export function errorInfo(err: unknown): ProviderErrorInfo {
  if (err instanceof Anthropic.APIError) {
    return {
      errorClass: errorClassOf(err),
      status: typeof err.status === 'number' ? err.status : null,
      requestId: err.requestID ?? null,
    };
  }
  return { errorClass: errorClassOf(err), status: null, requestId: null };
}

export function classifyError(err: unknown): ProviderFailure {
  if (err instanceof Anthropic.APIConnectionTimeoutError) return 'PROVIDER_TIMEOUT';
  if (err instanceof Anthropic.APIUserAbortError) return 'PROVIDER_TIMEOUT';
  if (err instanceof Anthropic.APIConnectionError) return 'PROVIDER_UNAVAILABLE';
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    if (status === 429) return 'PROVIDER_RATE_LIMIT';
    if (typeof status === 'number' && status >= 500) return 'PROVIDER_UNAVAILABLE';
    return 'PROVIDER_ERROR';
  }
  return 'PROVIDER_ERROR';
}

export function interpretError(err: unknown, latencyMs: number): AssistantOutcome {
  const error = errorInfo(err);
  return {
    ok: false,
    reason: classifyError(err),
    error,
    usage: null,
    model: null,
    requestId: error.requestId,
    latencyMs,
  };
}

// ---------------------------------------------------------------------------
// The real client
// ---------------------------------------------------------------------------

/** The SDK's logger, silenced: nothing the SDK knows reaches a log line. */
export const SILENT_LOGGER = {
  error: () => undefined,
  warn: () => undefined,
  info: () => undefined,
  debug: () => undefined,
};

export interface AnthropicAssistantClientOptions {
  apiKey: string;
  baseURL?: string | undefined;
  model?: string | undefined;
  effort?: AiEffort | undefined;
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  /** Tests inject a fetch so the network is never reached. */
  fetch?: typeof fetch | undefined;
  now?: () => number;
}

const DECISION_FORMAT = betaZodOutputFormat(AiDecisionSchema);

export class AnthropicAssistantClient implements AssistantClient {
  readonly model: string;
  private readonly effort: AiEffort;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly sdk: Anthropic;
  private readonly now: () => number;

  constructor(options: AnthropicAssistantClientOptions) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.effort = options.effort ?? DEFAULT_EFFORT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.now = options.now ?? Date.now;
    this.sdk = new Anthropic({
      apiKey: options.apiKey,
      ...(options.baseURL ? { baseURL: options.baseURL } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      timeout: this.timeoutMs,
      maxRetries: this.maxRetries,
      logLevel: 'off',
      logger: SILENT_LOGGER,
    });
  }

  /**
   * One structured-output call. `beta.messages.create` with the zod-derived
   * JSON schema, not `messages.parse`: `parse` validates before the caller
   * can read `stop_reason`, so a reply cut off at max_tokens would surface as
   * a parse error. Here the stop reason is read first (`interpretReply`).
   */
  async decide({ prompt }: AssistantRequest): Promise<AssistantOutcome> {
    const started = this.now();
    const fallback = supportsServerFallback(this.model);
    try {
      const reply = await this.sdk.beta.messages.create(
        {
          model: this.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: prompt.system,
          messages: prompt.messages,
          output_config: { effort: this.effort, format: DECISION_FORMAT },
          ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
        },
        { timeout: this.timeoutMs, maxRetries: this.maxRetries },
      );
      return interpretReply(reply, this.now() - started);
    } catch (err) {
      return interpretError(err, this.now() - started);
    }
  }
}
