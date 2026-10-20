/**
 * THE LIVE COMBINE CHECK (SCRUM-591 round I1, lane ia-1a; Phase 3 PLAN §D.1,
 * §F.1 I1a row). It runs the real `AnthropicToolLoopClient` over one
 * fictional tool in both answer modes, in this order:
 *
 *   1. combined       THE PACKAGE DEFAULT: tools AND the structured answer
 *                     format in one request. The first live runs (2026-10-20,
 *                     claude-opus-5-5) got a 400 in both modes: the dotted
 *                     tool name, now mapped to its wire name; three re-runs
 *                     held in both modes.
 *   2. trailing_json  the plan's fallback, tested and one option away: tools
 *                     with no format; a plain-text final turn ending in one
 *                     JSON block (links, language) that the server parses.
 *
 * It prints which mode held. The exit is green when at least one mode holds
 * (the closing line says which answerMode to run), and red when neither does.
 *
 *   pnpm --filter @oto/assistant tool-loop:check
 *   pnpm --filter @oto/assistant tool-loop:check --model claude-sonnet-5-5
 *
 * BY HAND, NEVER IN CI: it calls the real API (up to about six small calls a
 * run). It refuses when `CI` is set, and refuses politely without a key.
 *
 * DIAGNOSTICS, THIS SCRIPT ONLY. On an HTTP error it prints the status, the
 * SDK error class and the first 200 characters of the API's own error
 * message, read from the response by a fetch wrapper here. The request
 * carries fixture text only (ZZ), so the message cannot hold customer
 * content. The library never reads or logs an error message.
 *
 * THE KEY. `ANTHROPIC_API_KEY` from the environment, else from
 * `apps/api/.env`. It is handed to the client's constructor and nowhere else:
 * never printed, never put in `process.env`, never written anywhere.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnthropicToolLoopClient,
  buildInternalSystem,
  DEFAULT_MODEL,
  internalAnswerGuard,
  type InternalAnswerMode,
  wireToolName,
  type ToolCallResult,
  type ToolDefinition,
} from '../src/index';

const HERE = dirname(fileURLToPath(import.meta.url));
const API_ENV = join(HERE, '..', '..', '..', 'apps', 'api', '.env');

function readKey(): string {
  const fromEnv = process.env['ANTHROPIC_API_KEY']?.trim();
  if (fromEnv) return fromEnv;
  if (!existsSync(API_ENV)) return '';
  for (const line of readFileSync(API_ENV, 'utf8').split(/\r?\n/)) {
    const m = /^\s*ANTHROPIC_API_KEY\s*=\s*(.*)\s*$/.exec(line);
    if (m) return m[1]!.replace(/^(['"])(.*)\1$/, '$2').trim();
  }
  return '';
}

function parseModel(argv: string[]): string {
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--model') return argv[i + 1] ?? DEFAULT_MODEL;
    if (a.startsWith('--model=')) return a.slice('--model='.length);
  }
  return DEFAULT_MODEL;
}

const TOOL: ToolDefinition = {
  // Dotted like every registry name (members.lookup, occupancy.now): the live check
  // proves the wire-name mapping (visitors.today travels as visitors_today).
  name: 'visitors.today',
  description:
    "Today's visitor counts for one branch: children and adults checked in so far. Use it for any question about how many visitors a branch has had today.",
  inputSchema: {
    type: 'object',
    properties: { branch: { type: 'string', description: 'The branch name, e.g. "ZZ Central".' } },
    required: ['branch'],
    additionalProperties: false,
  },
};

const RESULT: ToolCallResult = {
  ok: true,
  data: { branch: 'ZZ Central', date: '2026-10-20', children: 41, adults: 29, truncated: false },
};

/** The last HTTP error the API returned in this run: status and the API's message, cut to 200. */
interface ApiErrorNote {
  status: number;
  message: string;
}

/** A fetch that notes the API's error message. Script-only diagnostics; the body is fixture text. */
function notingFetch(note: { last: ApiErrorNote | null }): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init);
    if (res.status >= 400) {
      let message = '';
      try {
        const body = (await res.clone().json()) as { error?: { message?: unknown } };
        message = typeof body.error?.message === 'string' ? body.error.message : '';
      } catch {
        message = '(no JSON error body)';
      }
      note.last = { status: res.status, message: message.slice(0, 200) };
    }
    return res;
  };
}

type ModeVerdict = 'HELD' | 'FAILED' | 'NO_TOOL_CALL';

async function runMode(
  apiKey: string,
  model: string,
  mode: InternalAnswerMode,
): Promise<ModeVerdict> {
  const note: { last: ApiErrorNote | null } = { last: null };
  const client = new AnthropicToolLoopClient({
    apiKey,
    model,
    timeoutMs: 60_000,
    answerMode: mode,
    fetch: notingFetch(note),
  });
  const built = buildInternalSystem({
    links: [
      { key: 'zz.visitors.screen', shows: "today's visitors at a branch", params: ['branch'] },
    ],
    asker: { name: 'ZZ Check', seatBranch: 'ZZ Central', tiles: ['pos'] },
    now: new Date(),
    answerMode: client.answerMode,
  });
  const toolCalls: string[] = [];
  const question = 'How many children have visited ZZ Central today?';
  const out = await client.converse({
    system: built.system,
    answerMode: built.answerMode,
    question,
    tools: [TOOL],
    wallMs: 120_000,
    execute: async (call) => {
      toolCalls.push(`${call.seq}:${call.name} ${JSON.stringify(call.input)}`);
      return RESULT;
    },
  });

  console.log(`\n== ${mode} ==`);
  console.log(`model served:  ${out.model ?? '-'}`);
  console.log(`turns:         ${out.turns}`);
  console.log(`tool on wire:  ${TOOL.name} -> ${wireToolName(TOOL.name)}`);
  console.log(`tool calls:    ${toolCalls.length === 0 ? '(none)' : toolCalls.join(' | ')}`);
  console.log(`latency:       ${out.latencyMs} ms`);
  if (out.usage) {
    const u = out.usage;
    console.log(
      `tokens:        in ${u.inputTokens}, out ${u.outputTokens}, cache read ${u.cacheReadTokens}, cache write ${u.cacheWriteTokens}`,
    );
  }

  if (!out.ok) {
    const err = out.error ? `, ${out.error.errorClass} ${out.error.status ?? ''}`.trimEnd() : '';
    console.log(`verdict:       FAILED (${out.reason}${err})`);
    if (note.last) {
      console.log(`api status:    ${note.last.status}`);
      console.log(`api message:   ${note.last.message || '(empty)'}`);
    }
    return 'FAILED';
  }
  const guard = internalAnswerGuard(out.answer, out.groundingTexts, question);
  console.log(`answer (${out.answer.language}): ${out.answer.answer}`);
  console.log(`links:         ${out.answer.links.map((l) => l.key).join(', ') || '(none)'}`);
  console.log(`guard:         ${guard.ok ? 'ok' : `${guard.reason} (${guard.rule})`}`);
  if (toolCalls.length === 0) {
    console.log('verdict:       NO TOOL CALL (a valid answer, but the loop was not exercised)');
    return 'NO_TOOL_CALL';
  }
  console.log('verdict:       HELD (a tool call, then a schema-valid answer)');
  return 'HELD';
}

async function main(): Promise<void> {
  if (process.env['CI']) {
    console.error('tool-loop:check calls the real Anthropic API and never runs in CI. Skipped.');
    process.exitCode = 1;
    return;
  }
  const apiKey = readKey();
  if (!apiKey) {
    console.error(
      'tool-loop:check calls the real Anthropic API and needs ANTHROPIC_API_KEY (in the environment or apps/api/.env).\n' +
        'Nothing was called. Set the key and run it again by hand.',
    );
    process.exitCode = 1;
    return;
  }
  const model = parseModel(process.argv.slice(2));
  console.log(`model asked:   ${model}`);
  const combined = await runMode(apiKey, model, 'combined');
  const fallback = await runMode(apiKey, model, 'trailing_json');

  console.log('\n== result ==');
  console.log(`combined:      ${combined}  (the package default)`);
  console.log(`trailing_json: ${fallback}  (the tested fallback)`);
  if (combined === 'HELD' && fallback === 'HELD') {
    console.log(
      'RESULT: both modes hold. combined is the default; trailing_json is the tested fallback.',
    );
  } else if (combined === 'HELD') {
    console.log(
      'RESULT: combined (the default) holds; the trailing_json fallback did not. The default is safe, but the fallback needs a look before it is relied on.',
    );
  } else if (fallback === 'HELD') {
    console.log(
      'RESULT: combined (the default) did not hold; the fallback does. Run with answerMode trailing_json until combined holds again.',
    );
  } else {
    console.log(
      'RESULT: neither mode held. Do not run the assistant on this model until one does.',
    );
    process.exitCode = 1;
  }
}

main().catch(() => {
  // Nothing of the error is printed: it may echo the request.
  console.error('tool-loop:check failed unexpectedly.');
  process.exitCode = 1;
});
