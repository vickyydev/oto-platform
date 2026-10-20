/**
 * The model call. The real Anthropic API is never reached: the fake is
 * scripted, and the real client is given a stub `fetch` that answers from
 * memory. No test here writes message text through any logger; the console
 * is spied on and must stay silent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AnthropicAssistantClient,
  FALLBACK_BETA,
  PROVIDER_FAILURES,
  supportsServerFallback,
  type AssistantOutcome,
  type ProviderFailure,
} from '../src/client';
import { FakeAssistantClient, FAKE_REQUEST_ID, type FakeStep } from '../src/fake';
import { buildPrompt } from '../src/prompt';
import { context, decision, fixtureKnowledge, NOW, SENTINEL } from './support';

function prompt(text = `${SENTINEL} what time do you open?`) {
  const r = buildPrompt({
    knowledge: fixtureKnowledge(),
    episode: [{ from: 'customer', at: NOW, text }],
    context: context(),
  });
  if (!r.ok) throw new Error(r.reason);
  return r.prompt;
}

const consoleSpies: Array<ReturnType<typeof vi.spyOn>> = [];
beforeEach(() => {
  for (const m of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    consoleSpies.push(vi.spyOn(console, m).mockImplementation(() => undefined));
  }
});
afterEach(() => {
  for (const s of consoleSpies) {
    expect(s).not.toHaveBeenCalled();
    s.mockRestore();
  }
  consoleSpies.length = 0;
});

describe('FakeAssistantClient covers every failure shape', () => {
  const shapes: Array<[FakeStep, ProviderFailure]> = [
    [{ kind: 'timeout' }, 'PROVIDER_TIMEOUT'],
    [{ kind: 'rate_limit' }, 'PROVIDER_RATE_LIMIT'],
    [{ kind: 'server_error' }, 'PROVIDER_UNAVAILABLE'],
    [{ kind: 'server_error', status: 529 }, 'PROVIDER_UNAVAILABLE'],
    [{ kind: 'connection' }, 'PROVIDER_UNAVAILABLE'],
    [{ kind: 'bad_request' }, 'PROVIDER_ERROR'],
    [{ kind: 'throw', error: new TypeError(`${SENTINEL} boom`) }, 'PROVIDER_ERROR'],
    [{ kind: 'refusal' }, 'REFUSAL'],
    [{ kind: 'malformed' }, 'MALFORMED'],
    [{ kind: 'invalid_shape', value: { ...decision(), intent: 'weather' } }, 'MALFORMED'],
    [
      { kind: 'invalid_shape', value: { ...decision(), bubbles: ['a', 'b', 'c', 'd'] } },
      'MALFORMED',
    ],
    [{ kind: 'max_tokens' }, 'MAX_TOKENS'],
  ];

  it.each(shapes)('%o is %s, with no decision', async (step, reason) => {
    const fake = new FakeAssistantClient([step]);
    const out = await fake.decide({ prompt: prompt() });
    expect(out).toMatchObject({ ok: false, reason });
    expect(out).not.toHaveProperty('decision');
  });

  it('reaches every provider failure word', () => {
    expect([...new Set(shapes.map(([, r]) => r))].sort()).toEqual([...PROVIDER_FAILURES].sort());
  });

  it('an HTTP failure carries class, status and request id only', async () => {
    const out = await new FakeAssistantClient([{ kind: 'rate_limit' }]).decide({
      prompt: prompt(),
    });
    expect(out).toMatchObject({
      ok: false,
      error: { errorClass: 'RateLimitError', status: 429, requestId: FAKE_REQUEST_ID },
    });
    if (!out.ok)
      expect(Object.keys(out.error ?? {}).sort()).toEqual(['errorClass', 'requestId', 'status']);
  });

  it('an error whose message carries the sentinel never surfaces it', async () => {
    const out = await new FakeAssistantClient([
      { kind: 'throw', error: new Error(`echo: ${SENTINEL}`) },
    ]).decide({
      prompt: prompt(),
    });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it('returns scripted decisions in order with usage, and lets a test act during the call', async () => {
    const seen: string[] = [];
    const fake = new FakeAssistantClient([
      { kind: 'decision', decision: decision(), during: () => void seen.push('thinking') },
      { kind: 'decision', decision: decision({ intent: 'thanks_closing', reason: 'CLOSING' }) },
    ]);
    const a = await fake.decide({ prompt: prompt() });
    const b = await fake.decide({ prompt: prompt() });
    expect(seen).toEqual(['thinking']);
    expect(a).toMatchObject({
      ok: true,
      decision: { intent: 'greeting' },
      usage: { cacheReadTokens: 12000 },
    });
    expect(b).toMatchObject({ ok: true, decision: { intent: 'thanks_closing' } });
    expect(fake.requests).toHaveLength(2);
    await expect(fake.decide({ prompt: prompt() })).rejects.toThrow('script has no step left');
  });
});

// ---------------------------------------------------------------------------
// The real client against a stub fetch
// ---------------------------------------------------------------------------

interface Captured {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function stubFetch(
  respond: (call: Captured, signal: AbortSignal | null) => Response | Promise<Response>,
) {
  const calls: Captured[] = [];
  const fn = async (input: string | URL | Request, init?: RequestInit) => {
    const call: Captured = {
      url: String(input instanceof Request ? input.url : input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    };
    calls.push(call);
    return respond(call, init?.signal ?? null);
  };
  return { fetch: fn as typeof fetch, calls };
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'request-id': 'req_stub_1' },
  });
}

function message(text: string, stop_reason = 'end_turn') {
  return {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: 1400,
      output_tokens: 250,
      cache_read_input_tokens: 11000,
      cache_creation_input_tokens: 0,
    },
  };
}

function client(f: typeof fetch, model?: string, timeoutMs?: number) {
  return new AnthropicAssistantClient({
    apiKey: 'sk-test-not-a-key',
    baseURL: 'http://anthropic.stub.invalid',
    fetch: f,
    maxRetries: 0,
    ...(model ? { model } : {}),
    ...(timeoutMs ? { timeoutMs } : {}),
  });
}

describe('AnthropicAssistantClient (stub fetch, never the network)', () => {
  it('sends the plan’s request shape and parses the decision', async () => {
    const s = stubFetch(() => json(200, message(JSON.stringify(decision()))));
    const out = await client(s.fetch).decide({ prompt: prompt() });
    expect(out).toMatchObject({
      ok: true,
      decision: { intent: 'greeting' },
      model: 'claude-opus-5-5',
      usage: { inputTokens: 1400, outputTokens: 250, cacheReadTokens: 11000, cacheWriteTokens: 0 },
    });

    const [call] = s.calls;
    expect(call!.url).toContain('/v1/messages');
    expect(call!.headers.get('anthropic-beta')).toContain(FALLBACK_BETA);
    const body = call!.body as {
      model: string;
      max_tokens: number;
      fallbacks: string;
      output_config: { effort: string; format: { type: string } };
      system: Array<{ text: string; cache_control?: unknown }>;
      messages: Array<{ content: string }>;
    };
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.max_tokens).toBe(2000);
    expect(body.fallbacks).toBe('default');
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body).not.toHaveProperty('thinking');
    expect(body.system).toHaveLength(2);
    expect(body.system[1]!.cache_control).toEqual({ type: 'ephemeral', ttl: '1h' });
    expect(JSON.stringify(body.system)).not.toContain(SENTINEL);
    expect(body.messages[0]!.content).toContain(SENTINEL);
  });

  it('a model without a server-side fallback is not sent one', async () => {
    expect(supportsServerFallback('claude-haiku-5-5')).toBe(false);
    expect(supportsServerFallback('claude-sonnet-5-5')).toBe(true);
    const s = stubFetch(() => json(200, message(JSON.stringify(decision()))));
    await client(s.fetch, 'claude-haiku-5-5').decide({ prompt: prompt() });
    expect(s.calls[0]!.body).not.toHaveProperty('fallbacks');
    expect(s.calls[0]!.headers.get('anthropic-beta') ?? '').not.toContain('server-side-fallback');
  });

  it('a 500 whose body echoes the prompt surfaces class, status and request id only', async () => {
    const s = stubFetch(() =>
      json(500, { type: 'error', error: { type: 'api_error', message: `echo ${SENTINEL}` } }),
    );
    const out = await client(s.fetch).decide({ prompt: prompt() });
    expect(out).toMatchObject({
      ok: false,
      reason: 'PROVIDER_UNAVAILABLE',
      error: { errorClass: 'InternalServerError', status: 500, requestId: 'req_stub_1' },
    });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it.each([
    [429, 'PROVIDER_RATE_LIMIT'],
    [400, 'PROVIDER_ERROR'],
    [529, 'PROVIDER_UNAVAILABLE'],
  ] as const)('HTTP %i is %s', async (status, reason) => {
    const s = stubFetch(() =>
      json(status, { type: 'error', error: { type: 'x', message: SENTINEL } }),
    );
    const out = await client(s.fetch).decide({ prompt: prompt() });
    expect(out).toMatchObject({ ok: false, reason });
    expect(JSON.stringify(out)).not.toContain(SENTINEL);
  });

  it('a hung request is PROVIDER_TIMEOUT', async () => {
    // Never answers; settles only when the SDK aborts it on its own timeout.
    const s = stubFetch(
      (_call, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    );
    const out: AssistantOutcome = await client(s.fetch, undefined, 50).decide({ prompt: prompt() });
    expect(out).toMatchObject({ ok: false, reason: 'PROVIDER_TIMEOUT' });
  });

  it.each([
    ['refusal', '', 'REFUSAL'],
    ['max_tokens', '{"language":"th","inte', 'MAX_TOKENS'],
    ['end_turn', 'not json at all', 'MALFORMED'],
    ['end_turn', JSON.stringify({ ...decision(), certainty: 0.9 }), 'MALFORMED'],
  ] as const)('stop_reason %s with %j is %s', async (stop, text, reason) => {
    const s = stubFetch(() => json(200, message(text, stop)));
    const out = await client(s.fetch).decide({ prompt: prompt() });
    expect(out).toMatchObject({ ok: false, reason, usage: { inputTokens: 1400 } });
  });
});
