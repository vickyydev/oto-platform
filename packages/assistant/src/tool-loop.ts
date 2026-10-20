/**
 * The internal assistant's tool-use loop (Phase 3 PLAN §B, §D.1, §E.3).
 *
 *   model -> tool_use -> executor -> tool_result -> model -> ... -> answer
 *
 * `ToolLoopClient.converse` never throws for anything the provider or a tool
 * does: every ending is an outcome with a reason word, and an error surfaces
 * as its class, HTTP status and request id only (Phase 2's `errorInfo`). The
 * provider failure words are Phase 2's, from Phase 2's `classifyError`, so the
 * same failure gets the same word in both assistants.
 *
 * ONE LOOP, TWO TRANSPORTS. `runToolLoop` holds everything: the caps, the
 * wall time, the interpretation of each reply (`interpretToolLoopReply`), the
 * tool-result envelope, the grounding. The real client and
 * `FakeToolLoopClient` differ only in their `ToolLoopTransport` (one model
 * call), so a test that passes on the fake has exercised the real loop and
 * the real interpretation (§F.3).
 *
 * The package does not know what a tool does. The engine (I2) passes the
 * definitions and an executor that validates the arguments and calls the
 * route as the person; the executor's result is DATA (§E.3): it reaches the
 * model only inside `{"data": ...}`, JSON-escaped so stored text can never
 * close a tag, and is never logged here.
 */

import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import {
  classifyError,
  DEFAULT_EFFORT,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MODEL,
  DEFAULT_TIMEOUT_MS,
  errorInfo,
  FALLBACK_BETA,
  SILENT_LOGGER,
  supportsServerFallback,
  type AiEffort,
  type ModelReply,
  type ProviderErrorInfo,
  type TurnUsage,
} from './client';
import { InternalAnswerSchema, type InternalAnswer, type ToolLoopFailure } from './internal-answer';
import { inertJson, type SystemBlock } from './prompt';

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
type BetaTool = Anthropic.Beta.BetaTool;

/** §E.2 defaults; the engine passes the `INTERNAL_AI_*` values. */
export const INTERNAL_DEFAULT_MAX_TOOL_CALLS = 6;
export const INTERNAL_DEFAULT_WALL_MS = 45_000;
/**
 * Per model call. Larger than Phase 2's 2,000: the model thinks before each
 * tool call and before the answer, and the answer may run to 1,200
 * characters of Thai.
 */
export const INTERNAL_MAX_OUTPUT_TOKENS = 4_000;

// ---------------------------------------------------------------------------
// Tools and the executor
// ---------------------------------------------------------------------------

/** What the model reads about one tool (the registry's `ToolDef`, §B.4, minus the server's half). */
export interface ToolDefinition {
  /** e.g. `members.lookup`. Unique in a request. */
  name: string;
  description: string;
  /** JSON schema of the tool's input, derived from the registry's zod schema. */
  inputSchema: BetaTool['input_schema'];
  /** Pass-through to the API's strict tool use when the schema allows it. */
  strict?: boolean;
}

export interface ToolCallRequest {
  /** 1-based order of the call within the ask: the audit `seq` and the `x-request-id` suffix. */
  seq: number;
  toolUseId: string;
  name: string;
  /** As the model sent it. UNVALIDATED: the executor validates before any call. */
  input: unknown;
  /** Wall time left in the ask, for the executor's own timeouts. */
  remainingMs: number;
}

/**
 * `ok: true` with the adapter's summary; `ok: false` with the refusal
 * envelope (401/403/404/423, verbatim) or a validation error. Both go back to
 * the model as data; only `ok: true` results ground figures.
 */
export interface ToolCallResult {
  ok: boolean;
  data: unknown;
}

export type ToolExecutor = (call: ToolCallRequest) => Promise<ToolCallResult>;

/** The loop's own record of a call. The input is held for the engine's audit; it is never logged here. */
export interface ToolCallRecord {
  seq: number;
  toolUseId: string;
  name: string;
  input: unknown;
  /** False when the model named a tool it was not given: the executor was not called. */
  known: boolean;
  ok: boolean;
}

/** The result the model gets when it names a tool it was not offered. */
export const UNKNOWN_TOOL_RESULT: ToolCallResult = {
  ok: false,
  data: { error: { code: 'UNKNOWN_TOOL', message: 'No such tool.' } },
};

/** The `tool_result` content: the executor's data in a `{data}` envelope, inert JSON. */
export function toolResultContent(result: ToolCallResult): string {
  return inertJson({ data: result.data });
}

/** Sorted by name (cache-stable, §D.2). A repeated name is a programming error and throws. */
export function toolsForRequest(tools: readonly ToolDefinition[]): BetaTool[] {
  const sorted = [...tools].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.name === sorted[i - 1]!.name) {
      throw new TypeError(`tool loop: the tool name ${sorted[i]!.name} is given twice`);
    }
  }
  return sorted.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    ...(t.strict === undefined ? {} : { strict: t.strict }),
  }));
}

// ---------------------------------------------------------------------------
// Shared interpretation of one reply
// ---------------------------------------------------------------------------

/** The blocks of a reply the loop reads. A `BetaContentBlock` satisfies it. */
export interface ToolLoopBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

/** A Messages API reply as the loop reads it. A `BetaMessage` satisfies it; so does Phase 2's `ModelReply`. */
export interface ToolLoopReply extends Omit<ModelReply, 'content'> {
  content: ReadonlyArray<ToolLoopBlock>;
}

export type ToolLoopStep =
  | { kind: 'tool_use'; calls: Array<{ id: string; name: string; input: unknown }> }
  | { kind: 'final'; answer: InternalAnswer }
  | { kind: 'fail'; reason: ToolLoopFailure };

/**
 * Stop reason first, as Phase 2's `interpretReply`: a refused or truncated
 * reply is never parsed, so a cut-off JSON is MAX_TOKENS, not MALFORMED.
 * A `tool_use` stop with no usable tool block, `pause_turn` (no server tools
 * are offered) and any other stop are MALFORMED.
 */
export function interpretToolLoopReply(reply: ToolLoopReply): ToolLoopStep {
  if (reply.stop_reason === 'refusal') return { kind: 'fail', reason: 'REFUSAL' };
  if (reply.stop_reason === 'max_tokens') return { kind: 'fail', reason: 'MAX_TOKENS' };
  if (reply.stop_reason === 'tool_use') {
    const calls: Array<{ id: string; name: string; input: unknown }> = [];
    for (const b of reply.content) {
      if (b.type !== 'tool_use') continue;
      if (typeof b.id !== 'string' || typeof b.name !== 'string') {
        return { kind: 'fail', reason: 'MALFORMED' };
      }
      calls.push({ id: b.id, name: b.name, input: b.input });
    }
    return calls.length === 0 ? { kind: 'fail', reason: 'MALFORMED' } : { kind: 'tool_use', calls };
  }
  if (reply.stop_reason !== 'end_turn') return { kind: 'fail', reason: 'MALFORMED' };
  const text = reply.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { kind: 'fail', reason: 'MALFORMED' };
  }
  const parsed = InternalAnswerSchema.safeParse(json);
  return parsed.success
    ? { kind: 'final', answer: parsed.data }
    : { kind: 'fail', reason: 'MALFORMED' };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export interface ToolLoopRequest {
  /** From `buildInternalSystem`: block 1 cached and identical for every asker, block 2 per asker. */
  system: readonly SystemBlock[];
  question: string;
  tools: readonly ToolDefinition[];
  execute: ToolExecutor;
  maxToolCalls?: number;
  wallMs?: number;
}

interface LoopTrace {
  calls: ToolCallRecord[];
  /** `JSON.stringify` of every `ok` result's data, in call order: the traceability guard's grounding. */
  groundingTexts: string[];
  /** Model calls made (including one that failed). */
  turns: number;
  requestIds: string[];
  latencyMs: number;
}

export type ToolLoopOutcome =
  | (LoopTrace & {
      ok: true;
      answer: InternalAnswer;
      usage: TurnUsage;
      /** The model that served the final turn (a fallback may differ from the one asked). */
      model: string;
    })
  | (LoopTrace & {
      ok: false;
      reason: ToolLoopFailure;
      error: ProviderErrorInfo | null;
      usage: TurnUsage | null;
      model: string | null;
    });

export interface ToolLoopClient {
  readonly model: string;
  converse(request: ToolLoopRequest): Promise<ToolLoopOutcome>;
}

/** One model call: a reply with what to echo back as the assistant turn, or what the SDK threw. */
export type TransportResult =
  { reply: ToolLoopReply; echo: BetaContentBlockParam[] } | { error: unknown };

export interface ToolLoopTransport {
  send(
    call: {
      system: readonly SystemBlock[];
      tools: BetaTool[];
      messages: BetaMessageParam[];
    },
    timeoutMs: number,
  ): Promise<TransportResult>;
}

function addUsage(total: TurnUsage | null, reply: ToolLoopReply): TurnUsage {
  const u = reply.usage;
  return {
    inputTokens: (total?.inputTokens ?? 0) + u.input_tokens,
    outputTokens: (total?.outputTokens ?? 0) + u.output_tokens,
    cacheReadTokens: (total?.cacheReadTokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    cacheWriteTokens: (total?.cacheWriteTokens ?? 0) + (u.cache_creation_input_tokens ?? 0),
  };
}

/**
 * The loop, shared by the real client and the fake. A transport that throws
 * (rather than returning `{error}`) is a programming error and propagates.
 */
export async function runToolLoop(
  transport: ToolLoopTransport,
  request: ToolLoopRequest,
  options: { now: () => number; timeoutMs: number },
): Promise<ToolLoopOutcome> {
  const tools = toolsForRequest(request.tools);
  const known = new Set(tools.map((t) => t.name));
  const maxToolCalls = request.maxToolCalls ?? INTERNAL_DEFAULT_MAX_TOOL_CALLS;
  const wallMs = request.wallMs ?? INTERNAL_DEFAULT_WALL_MS;
  const { now } = options;
  const started = now();
  const elapsed = () => now() - started;

  const calls: ToolCallRecord[] = [];
  const groundingTexts: string[] = [];
  const requestIds: string[] = [];
  let turns = 0;
  let usage: TurnUsage | null = null;
  let model: string | null = null;
  const messages: BetaMessageParam[] = [{ role: 'user', content: request.question }];

  const trace = (): LoopTrace => ({
    calls,
    groundingTexts,
    turns,
    requestIds,
    latencyMs: elapsed(),
  });
  const fail = (
    reason: ToolLoopFailure,
    error: ProviderErrorInfo | null = null,
  ): ToolLoopOutcome => ({
    ...trace(),
    ok: false,
    reason,
    error,
    usage,
    model,
  });

  for (;;) {
    const remaining = wallMs - elapsed();
    if (remaining <= 0) return fail('WALL_TIME');
    const made = await transport.send(
      { system: request.system, tools, messages: [...messages] },
      Math.min(options.timeoutMs, remaining),
    );
    turns += 1;
    if ('error' in made) {
      const info = errorInfo(made.error);
      if (info.requestId) requestIds.push(info.requestId);
      // A call cut short by the ask's own wall time is the wall time, not the provider.
      if (elapsed() >= wallMs) return fail('WALL_TIME', info);
      return fail(classifyError(made.error), info);
    }
    const { reply, echo } = made;
    usage = addUsage(usage, reply);
    model = reply.model;
    if (reply._request_id) requestIds.push(reply._request_id);

    const step = interpretToolLoopReply(reply);
    if (step.kind === 'fail') return fail(step.reason);
    if (step.kind === 'final') {
      return { ...trace(), ok: true, answer: step.answer, usage, model: reply.model };
    }

    // tool_use: the whole step is refused when it would pass the cap (Q12).
    if (calls.length + step.calls.length > maxToolCalls) return fail('TOOL_CAP');
    messages.push({ role: 'assistant', content: echo });
    const results: BetaToolResultBlockParam[] = [];
    for (const call of step.calls) {
      const left = wallMs - elapsed();
      if (left <= 0) return fail('WALL_TIME');
      const seq = calls.length + 1;
      const isKnown = known.has(call.name);
      let result: ToolCallResult;
      if (!isKnown) {
        result = UNKNOWN_TOOL_RESULT;
      } else {
        try {
          result = await request.execute({
            seq,
            toolUseId: call.id,
            name: call.name,
            input: call.input,
            remainingMs: left,
          });
        } catch {
          // Nothing of the thrown value is read: it may carry a body.
          return fail('TOOL_ERROR');
        }
      }
      calls.push({
        seq,
        toolUseId: call.id,
        name: call.name,
        input: call.input,
        known: isKnown,
        ok: result.ok,
      });
      if (result.ok) groundingTexts.push(JSON.stringify(result.data) ?? 'null');
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        content: toolResultContent(result),
        ...(result.ok ? {} : { is_error: true }),
      });
    }
    // Every result of a step in ONE user message (parallel calls stay parallel).
    messages.push({ role: 'user', content: results });
  }
}

// ---------------------------------------------------------------------------
// The real client
// ---------------------------------------------------------------------------

export interface AnthropicToolLoopClientOptions {
  apiKey: string;
  baseURL?: string | undefined;
  model?: string | undefined;
  effort?: AiEffort | undefined;
  /** Per model call; the ask's wall time is the request's `wallMs`. */
  timeoutMs?: number | undefined;
  maxRetries?: number | undefined;
  maxOutputTokens?: number | undefined;
  /** Tests inject a fetch so the network is never reached. */
  fetch?: typeof fetch | undefined;
  now?: () => number;
}

const ANSWER_FORMAT = betaZodOutputFormat(InternalAnswerSchema);

export class AnthropicToolLoopClient implements ToolLoopClient {
  readonly model: string;
  private readonly effort: AiEffort;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxOutputTokens: number;
  private readonly sdk: Anthropic;
  private readonly now: () => number;

  constructor(options: AnthropicToolLoopClientOptions) {
    this.model = options.model ?? DEFAULT_MODEL;
    this.effort = options.effort ?? DEFAULT_EFFORT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.maxOutputTokens = options.maxOutputTokens ?? INTERNAL_MAX_OUTPUT_TOKENS;
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
   * Tools and the structured answer format in the same request: the model
   * may call tools, and its final text turn is constrained to the answer
   * schema. `create`, not `parse`, so the stop reason is read first (as
   * Phase 2). Thinking is the model's default (adaptive); the assistant
   * content is echoed back whole, thinking blocks included.
   */
  converse(request: ToolLoopRequest): Promise<ToolLoopOutcome> {
    const fallback = supportsServerFallback(this.model);
    const transport: ToolLoopTransport = {
      send: async ({ system, tools, messages }, timeoutMs) => {
        try {
          const reply = await this.sdk.beta.messages.create(
            {
              model: this.model,
              max_tokens: this.maxOutputTokens,
              system: [...system],
              tools,
              messages,
              output_config: { effort: this.effort, format: ANSWER_FORMAT },
              ...(fallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' as const } : {}),
            },
            { timeout: timeoutMs, maxRetries: this.maxRetries },
          );
          return { reply, echo: reply.content };
        } catch (error) {
          return { error };
        }
      },
    };
    return runToolLoop(transport, request, { now: this.now, timeoutMs: this.timeoutMs });
  }
}
