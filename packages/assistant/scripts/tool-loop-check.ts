/**
 * THE LIVE COMBINE CHECK (SCRUM-591 round I1, lane ia-1a; Phase 3 PLAN §D.1,
 * §F.1 I1a row): does the chosen model take tools AND the structured answer
 * format in the same request, call a tool, and then return a schema-valid
 * answer? It runs the real `AnthropicToolLoopClient` over one fictional tool.
 *
 *   pnpm --filter @oto/assistant tool-loop:check
 *   pnpm --filter @oto/assistant tool-loop:check --model claude-sonnet-5-5
 *
 * BY HAND, NEVER IN CI: it calls the real API (two or three small calls a
 * run). It refuses when `CI` is set, and refuses politely without a key.
 *
 * If the combination fails (a 400 naming the format, or a final turn that
 * is never schema-valid), the plan's fallback applies: a plain-text final
 * turn whose link keys travel in a trailing JSON block (§D.1).
 *
 * THE KEY. `ANTHROPIC_API_KEY` from the environment, else from
 * `apps/api/.env`. It is handed to the client's constructor and nowhere else:
 * never printed, never put in `process.env`, never written anywhere.
 *
 * All data here is fictional (ZZ).
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AnthropicToolLoopClient,
  buildInternalSystem,
  DEFAULT_MODEL,
  internalAnswerGuard,
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
  name: 'zz.visitors_today',
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
  const client = new AnthropicToolLoopClient({ apiKey, model, timeoutMs: 60_000 });
  const { system } = buildInternalSystem({
    links: [
      { key: 'zz.visitors.screen', shows: "today's visitors at a branch", params: ['branch'] },
    ],
    asker: { name: 'ZZ Check', seatBranch: 'ZZ Central', tiles: ['pos'] },
    now: new Date(),
  });
  const toolCalls: string[] = [];
  const out = await client.converse({
    system,
    question: 'How many children have visited ZZ Central today?',
    tools: [TOOL],
    wallMs: 120_000,
    execute: async (call) => {
      toolCalls.push(`${call.seq}:${call.name} ${JSON.stringify(call.input)}`);
      return RESULT;
    },
  });

  console.log(`model asked:   ${model}`);
  console.log(`model served:  ${out.model ?? '-'}`);
  console.log(`turns:         ${out.turns}`);
  console.log(`tool calls:    ${toolCalls.length === 0 ? '(none)' : toolCalls.join(' | ')}`);
  console.log(`latency:       ${out.latencyMs} ms`);
  if (out.usage) {
    const u = out.usage;
    console.log(
      `tokens:        in ${u.inputTokens}, out ${u.outputTokens}, cache read ${u.cacheReadTokens}, cache write ${u.cacheWriteTokens}`,
    );
  }

  if (!out.ok) {
    console.log(
      `RESULT:        FAILED (${out.reason}${out.error ? `, ${out.error.errorClass} ${out.error.status ?? ''}` : ''})`,
    );
    if (out.reason === 'MALFORMED' || out.error?.status === 400) {
      console.log(
        'The combination did not hold: apply the plan fallback (§D.1, plain-text final turn).',
      );
    }
    process.exitCode = 1;
    return;
  }
  const guard = internalAnswerGuard(out.answer, out.groundingTexts);
  console.log(`answer (${out.answer.language}): ${out.answer.answer}`);
  console.log(`links:         ${out.answer.links.map((l) => l.key).join(', ') || '(none)'}`);
  console.log(`guard:         ${guard.ok ? 'ok' : `${guard.reason} (${guard.rule})`}`);
  const combined = toolCalls.length > 0;
  console.log(
    combined
      ? 'RESULT:        COMBINED: a tool call, then a schema-valid structured answer.'
      : 'RESULT:        INCONCLUSIVE: a valid answer, but no tool was called.',
  );
  if (!combined) process.exitCode = 1;
}

main().catch(() => {
  // Nothing of the error is printed: it may echo the request.
  console.error('tool-loop:check failed unexpectedly.');
  process.exitCode = 1;
});
