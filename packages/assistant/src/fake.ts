/**
 * `FakeAssistantClient` (PLAN §F.1): scripted decisions and every failure
 * shape, with no network. Each step is turned into the SDK object the real
 * API would produce (a reply, or a thrown SDK error) and then classified by
 * the same `interpretReply` / `interpretError` the real client uses, so a
 * test that passes on the fake exercises the real classification.
 *
 * The real Anthropic API is never called by `pnpm test`; the api's suites
 * inject this.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  DEFAULT_MODEL,
  interpretError,
  interpretReply,
  type AssistantClient,
  type AssistantOutcome,
  type AssistantRequest,
  type ModelReply,
  type TurnUsage,
} from './client';
import type { AiDecision } from './decision';
import type { AiIntent } from './intents';
import {
  interpretReviewReply,
  type CoherenceReviewer,
  type ReviewDecision,
  type ReviewJoiner,
  type ReviewOutcome,
  type ReviewRequest,
} from './review';

export type FakeStep =
  | { kind: 'decision'; decision: AiDecision }
  /** Valid JSON that does not match the decision schema. */
  | { kind: 'invalid_shape'; value: unknown }
  /** Text that is not JSON at all. */
  | { kind: 'malformed'; text?: string }
  | { kind: 'refusal' }
  | { kind: 'max_tokens' }
  | { kind: 'timeout' }
  | { kind: 'connection' }
  | { kind: 'rate_limit' }
  | { kind: 'server_error'; status?: number }
  | { kind: 'bad_request' }
  /** Throws exactly this value from inside the call. */
  | { kind: 'throw'; error: unknown }
  /** A raw reply, for shapes the named steps do not cover. */
  | { kind: 'raw'; reply: ModelReply };

export type FakeScriptEntry = FakeStep & {
  /** Runs before the call returns: lets a test act while the "model is thinking". */
  during?: () => void | Promise<void>;
  /** Simulated latency reported on the outcome. */
  latencyMs?: number;
};

export const FAKE_USAGE: TurnUsage = {
  inputTokens: 1500,
  outputTokens: 300,
  cacheReadTokens: 12000,
  cacheWriteTokens: 0,
};
export const FAKE_REQUEST_ID = 'req_fake_0001';

function reply(model: string, stop_reason: string, text: string): ModelReply {
  return {
    model,
    stop_reason,
    content: [{ type: 'text', text }],
    usage: {
      input_tokens: FAKE_USAGE.inputTokens,
      output_tokens: FAKE_USAGE.outputTokens,
      cache_read_input_tokens: FAKE_USAGE.cacheReadTokens,
      cache_creation_input_tokens: FAKE_USAGE.cacheWriteTokens,
    },
    _request_id: FAKE_REQUEST_ID,
  };
}

function headers(): Headers {
  return new Headers({ 'request-id': FAKE_REQUEST_ID });
}

/** The SDK object the real API would produce for a step: a reply, or an error to throw. */
export function materialise(
  step: FakeStep,
  model: string,
): { reply: ModelReply } | { error: unknown } {
  switch (step.kind) {
    case 'decision':
      return { reply: reply(model, 'end_turn', JSON.stringify(step.decision)) };
    case 'invalid_shape':
      return { reply: reply(model, 'end_turn', JSON.stringify(step.value)) };
    case 'malformed':
      return {
        reply: reply(model, 'end_turn', step.text ?? 'Sorry, I cannot produce JSON for this.'),
      };
    case 'refusal':
      return { reply: reply(model, 'refusal', '') };
    case 'max_tokens':
      return {
        reply: reply(model, 'max_tokens', '{"language":"th","intent":"hours","certainty":"su'),
      };
    case 'timeout':
      return { error: new Anthropic.APIConnectionTimeoutError() };
    case 'connection':
      return { error: new Anthropic.APIConnectionError({ message: 'Connection error.' }) };
    case 'rate_limit':
      return {
        error: Anthropic.APIError.generate(
          429,
          { type: 'error', error: { type: 'rate_limit_error' } },
          undefined,
          headers(),
        ),
      };
    case 'server_error': {
      const status = step.status ?? 500;
      return {
        error: Anthropic.APIError.generate(
          status,
          { type: 'error', error: { type: 'api_error' } },
          undefined,
          headers(),
        ),
      };
    }
    case 'bad_request':
      return {
        error: Anthropic.APIError.generate(
          400,
          { type: 'error', error: { type: 'invalid_request_error' } },
          undefined,
          headers(),
        ),
      };
    case 'throw':
      return { error: step.error };
    case 'raw':
      return { reply: step.reply };
  }
}

// ---------------------------------------------------------------------------
// The coherence reviewer's fake (SCRUM-677)
// ---------------------------------------------------------------------------

/**
 * A scripted review: operations, keep-everything, a reply that answers
 * something else (SCRUM-678), an answer that never comes (the deadline's
 * case), or any failure shape the decision's fake has — played through the
 * same interpretation as the real reviewer's reply.
 */
export type FakeReviewStep =
  | { kind: 'review'; decision: ReviewDecision }
  | { kind: 'keep_all' }
  | { kind: 'wrong_topic'; reading: string; suggestedIntent?: AiIntent | null }
  | { kind: 'hang' }
  | Exclude<FakeStep, { kind: 'decision' }>;

export type FakeReviewScriptEntry = FakeReviewStep & {
  /** Runs before the review returns: lets a test act while the "reviewer is reading". */
  during?: () => void | Promise<void>;
  latencyMs?: number;
};

/** A review verdict from plain lists: the indices to drop, the merges to make; the reply on topic. */
export function reviewOps(ops: { drop?: readonly number[]; merge?: ReadonlyArray<{ index: number; joiner: ReviewJoiner }> }): ReviewDecision {
  return {
    items: (ops.drop ?? []).map((index) => ({ index, keep: false })),
    merges: [...(ops.merge ?? [])],
    topic: 'answers',
    reading: null,
    suggestedIntent: null,
  };
}

export class FakeCoherenceReviewer implements CoherenceReviewer {
  readonly model: string;
  /** Every request received, in order (held in memory only, never logged). */
  readonly requests: ReviewRequest[] = [];
  private readonly script: FakeReviewScriptEntry[];

  constructor(script: FakeReviewScriptEntry[] = [], model: string = DEFAULT_MODEL) {
    this.script = [...script];
    this.model = model;
  }

  push(...steps: FakeReviewScriptEntry[]): this {
    this.script.push(...steps);
    return this;
  }

  get remaining(): number {
    return this.script.length;
  }

  /** Plays the next step. An exhausted script throws: a test-authoring error, which the deadline turns into fail-open. */
  async review(request: ReviewRequest): Promise<ReviewOutcome> {
    this.requests.push(request);
    const step = this.script.shift();
    if (!step) throw new Error('FakeCoherenceReviewer: the script has no step left for this call');
    if (step.during) await step.during();
    if (step.kind === 'hang') return new Promise<ReviewOutcome>(() => undefined);
    const latency = step.latencyMs ?? 400;
    if (step.kind === 'review' || step.kind === 'keep_all' || step.kind === 'wrong_topic') {
      const decision: ReviewDecision =
        step.kind === 'review'
          ? step.decision
          : step.kind === 'keep_all'
            ? reviewOps({})
            : { ...reviewOps({}), topic: 'wrong_topic', reading: step.reading, suggestedIntent: step.suggestedIntent ?? null };
      return interpretReviewReply(reply(this.model, 'end_turn', JSON.stringify(decision)), latency);
    }
    const made = materialise(step, this.model);
    return 'reply' in made ? interpretReviewReply(made.reply, latency) : interpretError(made.error, latency);
  }
}

export class FakeAssistantClient implements AssistantClient {
  readonly model: string;
  /** Every request received, in order (held in memory only, never logged). */
  readonly requests: AssistantRequest[] = [];
  private readonly script: FakeScriptEntry[];

  constructor(script: FakeScriptEntry[] = [], model: string = DEFAULT_MODEL) {
    this.script = [...script];
    this.model = model;
  }

  /** Appends steps to the script. */
  push(...steps: FakeScriptEntry[]): this {
    this.script.push(...steps);
    return this;
  }

  get remaining(): number {
    return this.script.length;
  }

  /**
   * Plays the next step. An exhausted script is a test-authoring error and
   * throws; it is the one way this class departs from "never throws".
   */
  async decide(request: AssistantRequest): Promise<AssistantOutcome> {
    this.requests.push(request);
    const step = this.script.shift();
    if (!step) throw new Error('FakeAssistantClient: the script has no step left for this call');
    if (step.during) await step.during();
    const latency = step.latencyMs ?? 1200;
    const made = materialise(step, this.model);
    return 'reply' in made
      ? interpretReply(made.reply, latency)
      : interpretError(made.error, latency);
  }
}
