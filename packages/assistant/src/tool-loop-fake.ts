/**
 * `FakeToolLoopClient` (Phase 3 PLAN §D.1, §F.3): scripted multi-step runs
 * with no network. A script is the model's side of an ask: tool calls, then
 * a final answer, or any Phase 2 failure at any step.
 *
 * Each step is turned into the reply (or the thrown SDK error) the real API
 * would produce, and handed to the SAME `runToolLoop` the real client runs:
 * the same interpretation, caps, wall time, executor calls and tool-result
 * envelope. Phase 2's failure steps are materialised by Phase 2's own
 * `materialise`, so every failure shape keeps its Phase 2 reason word.
 *
 * Time is virtual: each step advances the fake's clock by its `latencyMs`
 * (default 1,200), and `advance(ms)` moves it from a test or an executor, so
 * the wall time is tested without waiting.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODEL, DEFAULT_TIMEOUT_MS } from './client';
import { FAKE_REQUEST_ID, FAKE_USAGE, materialise, type FakeStep } from './fake';
import type { InternalAnswer } from './internal-answer';
import {
  runToolLoop,
  type ToolLoopBlock,
  type ToolLoopClient,
  type ToolLoopOutcome,
  type ToolLoopReply,
  type ToolLoopRequest,
  type ToolLoopTransport,
  type TransportResult,
} from './tool-loop';

type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaContentBlockParam = Anthropic.Beta.BetaContentBlockParam;
type BetaTool = Anthropic.Beta.BetaTool;

export type FakeToolLoopStep =
  /** The model calls one or more tools (several = parallel calls in one turn). */
  | { kind: 'tool_use'; calls: Array<{ name: string; input: unknown; id?: string }> }
  /** The model's final structured answer. */
  | { kind: 'final'; answer: InternalAnswer }
  /** Every Phase 2 step but the customer decision: failures, invalid shapes, raw replies. */
  | Exclude<FakeStep, { kind: 'decision' }>;

export type FakeToolLoopEntry = FakeToolLoopStep & {
  /** Runs before the step's reply: lets a test act while the "model is thinking". */
  during?: () => void | Promise<void>;
  /** Virtual time the step takes. */
  latencyMs?: number;
};

/** One model call as the fake received it (held in memory only, never logged). */
export interface FakeToolLoopCall {
  system: readonly { type: 'text'; text: string }[];
  tools: BetaTool[];
  messages: BetaMessageParam[];
  timeoutMs: number;
}

function fakeReply(model: string, stop_reason: string, content: ToolLoopBlock[]): ToolLoopReply {
  return {
    model,
    stop_reason,
    content,
    usage: {
      input_tokens: FAKE_USAGE.inputTokens,
      output_tokens: FAKE_USAGE.outputTokens,
      cache_read_input_tokens: FAKE_USAGE.cacheReadTokens,
      cache_creation_input_tokens: FAKE_USAGE.cacheWriteTokens,
    },
    _request_id: FAKE_REQUEST_ID,
  };
}

/** The assistant turn the real client would echo: the reply's text and tool_use blocks. */
function echoOf(reply: ToolLoopReply): BetaContentBlockParam[] {
  const out: BetaContentBlockParam[] = [];
  for (const b of reply.content) {
    if (b.type === 'text') out.push({ type: 'text', text: b.text ?? '' });
    else if (b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string') {
      out.push({ type: 'tool_use', id: b.id, name: b.name, input: b.input ?? {} });
    }
  }
  return out;
}

/** The reply or error the real API would produce for a step. */
export function materialiseToolLoopStep(
  step: FakeToolLoopStep,
  model: string,
  nextToolUseId: () => string,
): { reply: ToolLoopReply } | { error: unknown } {
  switch (step.kind) {
    case 'tool_use':
      return {
        reply: fakeReply(
          model,
          'tool_use',
          step.calls.map((c) => ({
            type: 'tool_use',
            id: c.id ?? nextToolUseId(),
            name: c.name,
            input: c.input,
          })),
        ),
      };
    case 'final':
      return {
        reply: fakeReply(model, 'end_turn', [{ type: 'text', text: JSON.stringify(step.answer) }]),
      };
    default:
      return materialise(step, model);
  }
}

export class FakeToolLoopClient implements ToolLoopClient {
  readonly model: string;
  /** Every model call received, in order. */
  readonly calls: FakeToolLoopCall[] = [];
  private readonly script: FakeToolLoopEntry[];
  private clock = 0;
  private toolUseCounter = 0;

  constructor(script: FakeToolLoopEntry[] = [], model: string = DEFAULT_MODEL) {
    this.script = [...script];
    this.model = model;
  }

  push(...steps: FakeToolLoopEntry[]): this {
    this.script.push(...steps);
    return this;
  }

  get remaining(): number {
    return this.script.length;
  }

  /** The virtual clock, in ms. */
  get now(): number {
    return this.clock;
  }

  /** Moves the virtual clock (from a test, or from inside an executor). */
  advance(ms: number): void {
    this.clock += ms;
  }

  /**
   * Plays the script through the real loop. An exhausted script is a
   * test-authoring error and rejects; it is the one way this class departs
   * from "never throws".
   */
  converse(request: ToolLoopRequest): Promise<ToolLoopOutcome> {
    const transport: ToolLoopTransport = {
      send: async ({ system, tools, messages }, timeoutMs): Promise<TransportResult> => {
        this.calls.push({ system, tools, messages, timeoutMs });
        const step = this.script.shift();
        if (!step) {
          throw new Error('FakeToolLoopClient: the script has no step left for this call');
        }
        if (step.during) await step.during();
        this.clock += step.latencyMs ?? 1200;
        const made = materialiseToolLoopStep(step, this.model, () => {
          this.toolUseCounter += 1;
          return `toolu_fake_${String(this.toolUseCounter).padStart(4, '0')}`;
        });
        return 'reply' in made ? { reply: made.reply, echo: echoOf(made.reply) } : made;
      },
    };
    return runToolLoop(transport, request, {
      now: () => this.clock,
      timeoutMs: DEFAULT_TIMEOUT_MS,
    });
  }
}
