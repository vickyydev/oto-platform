/**
 * THE ASSISTANT'S LIVE EVAL (SCRUM-590 round A4; plan
 * `docs/progress/plans/inbox-ai-build/PLAN.md` §F.3 "live eval", §F.4).
 *
 *   pnpm --filter @oto/api ai:eval                      the goldens against the real model
 *   pnpm --filter @oto/api ai:eval --record             …and write each model response to
 *                                                       test/fixtures/inbox-ai/<golden>.json
 *   pnpm --filter @oto/api ai:eval --model claude-sonnet-5-5
 *                                                       the same suite on another tier (G3)
 *   pnpm --filter @oto/api ai:eval --only G3,G9         a subset
 *   pnpm --filter @oto/api ai:eval --fake               rehearse the script with scripted
 *                                                       decisions: no key, no API call
 *
 * BY HAND, NEVER IN CI: it spends real money (G1–G9 are ten calls a run).
 *
 * It builds the fixture world (`test/inbox-ai-golden.ts`, fictional park
 * content) in an embedded database, and plays every golden through the REAL
 * turn engine: the webhook, the ingest's turn, `job:inbox.ai`, the prompt
 * builder, the real `AnthropicAssistantClient`, the gates and the commit. G10
 * needs no model; G11–G16 are mechanical and run on the fake client.
 *
 * THE KEY. `ANTHROPIC_API_KEY` from the environment, else from `apps/api/.env`.
 * It is handed to the client's constructor and nowhere else: it is never
 * printed, never put in `process.env`, never written to a fixture. A
 * recording holds the response body only — no request, no header.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';
import {
  AnthropicAssistantClient,
  DEFAULT_MODEL,
  FakeAssistantClient,
  PERSONA_VERSION,
  type GateVerdict,
  type TurnUsage,
} from '@oto/assistant';
import { loadTurnKnowledge } from '../src/services/inbox/ai-knowledge';
import { teardownAll } from '../test/helpers';
import {
  CapturingClient,
  FIXTURE_NOTE,
  LIVE_GOLDENS,
  MECHANICAL_GOLDENS,
  buildGoldenWorld,
  capturingFetch,
  customerSays,
  fixtureKnowledge,
  gateDecision,
  gateReport,
  goldenPhone,
  judgeThread,
  judgeVerdict,
  playMechanical,
  threadState,
  tickAt,
  type RecordedGolden,
  type RecordedTurn,
} from '../test/inbox-ai-golden';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '..', 'test', 'fixtures', 'inbox-ai');

interface Args {
  record: boolean;
  fake: boolean;
  model: string;
  only: Set<string> | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { record: false, fake: false, model: DEFAULT_MODEL, only: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--') continue;
    else if (a === '--record') args.record = true;
    else if (a === '--fake') args.fake = true;
    else if (a === '--model') args.model = argv[++i] ?? '';
    else if (a.startsWith('--model=')) args.model = a.slice('--model='.length);
    else if (a === '--only') args.only = new Set((argv[++i] ?? '').split(',').map((x) => x.trim().toUpperCase()));
    else if (a.startsWith('--only=')) args.only = new Set(a.slice('--only='.length).split(',').map((x) => x.trim().toUpperCase()));
    else throw new Error(`ai:eval does not know the option ${a}`);
  }
  if (!/^claude-[a-z0-9-]+$/.test(args.model)) throw new Error('--model takes a model id, e.g. claude-sonnet-5-5');
  if (args.record && args.fake) throw new Error('--record records the real model; it cannot be combined with --fake');
  return args;
}

/** The key, read into a local only: from the environment, else from `apps/api/.env`. */
function readKey(): string {
  const fromEnv = process.env['ANTHROPIC_API_KEY']?.trim();
  if (fromEnv) return fromEnv;
  const file = join(HERE, '..', '.env');
  if (!existsSync(file)) return '';
  return parseDotenv(readFileSync(file))['ANTHROPIC_API_KEY']?.trim() ?? '';
}

/** $ per million tokens (input, output, cache read); a one-hour cache write is twice the input rate. */
const PRICES: Array<[RegExp, { input: number; output: number; cacheRead: number }]> = [
  [/^claude-opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/^claude-sonnet-5-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/^claude-haiku-5-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
];

function costOf(model: string, u: TurnUsage): number | null {
  const p = PRICES.find(([re]) => re.test(model))?.[1];
  if (!p) return null;
  return (
    (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.input * 2) /
    1_000_000
  );
}

/**
 * The turn state the engine closes a verdict with (`ai-engine.ts` commitTurn):
 * an answer the table follows with a hand-over — a `birthday_brochure`, or a
 * mixed burst since the test night (2026-10-21, W2) — closes as `handed_over`
 * with `action 'answer'`, because the thread is then the team's. G18 found
 * the eval reading the action alone.
 */
function stateOf(v: GateVerdict): string {
  if (v.action === 'answer') return v.thenHandover ? 'handed_over' : 'answered';
  return v.action === 'handover' ? 'handed_over' : 'silent';
}

function verdictWords(v: GateVerdict): string {
  // The burst's parts beside the primary (test night 2026-10-21, D1a), when there are any.
  const parts = v.intents.length > 1 ? ` parts=[${v.intents.join(', ')}]` : '';
  if (v.action === 'answer') {
    const then = v.thenHandover ? ` then ${v.thenHandover.templateKey}/${v.thenHandover.route}${v.thenHandover.brochure ? ' +brochure' : ''}` : '';
    return `answer ${v.intent}/${v.language}${parts} grounding=[${v.groundingKeys.join(', ')}] askBranch=${v.askBranch} brochure=${v.sendBrochure}${then}`;
  }
  if (v.action === 'handover') {
    return `handover ${v.intent}/${v.language}${parts} ${v.reason} -> ${v.plan.templateKey}/${v.plan.route}${v.plan.brochure ? ' +brochure' : ''}`;
  }
  return `silent ${v.reason}${v.rule ? `/${v.rule}` : ''} (intent ${v.intent ?? 'none'}${parts})`;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const key = args.fake ? '' : readKey();
  if (!args.fake && !key) {
    console.error(
      'ai:eval calls the real Anthropic API and needs ANTHROPIC_API_KEY (in the environment or apps/api/.env).\n' +
        'None was found, so nothing was run. To rehearse the script without a key, add --fake.',
    );
    process.exitCode = 1;
    return;
  }

  const capture = capturingFetch();
  const rehearsal = new FakeAssistantClient([], args.model);
  const inner = args.fake ? rehearsal : new AnthropicAssistantClient({ apiKey: key, model: args.model, fetch: capture.fetch });
  const client = new CapturingClient(inner, args.fake ? () => null : capture.take);

  console.log(`ai:eval  model ${args.model}  effort low (the engine default)  ${args.fake ? 'REHEARSAL (fake client, no API call)' : 'LIVE'}${args.record ? '  RECORDING' : ''}`);
  console.log('building the fixture world (embedded database, migrations, seed, fixture KB)…');
  const w = await buildGoldenWorld(client);
  const results: Array<{ id: string; pass: boolean; why: string[] }> = [];
  const totals: TurnUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let cost = 0;
  let calls = 0;
  try {
    // The world must render exactly the knowledge the replay suite rebuilds with no database.
    const loaded = await loadTurnKnowledge(w.ctx.db, w.oto, new Date());
    const pure = fixtureKnowledge();
    if (loaded.knowledge.text !== pure.text) {
      throw new Error('the database renders different knowledge from fixtureKnowledgeInput(): the fixture world is not deterministic');
    }
    console.log(`knowledge ${pure.version}  persona ${PERSONA_VERSION}  ${pure.grounding.size} citable sources\n`);

    for (const golden of LIVE_GOLDENS) {
      if (args.only && !args.only.has(golden.id)) continue;
      console.log(`${golden.id}  ${golden.setup}`);
      const phone = goldenPhone();
      let startTeam: string | null = null;
      let convId = '';
      const why: string[] = [];
      const recorded: RecordedTurn[] = [];
      let served: string | null = null;
      for (const [i, turn] of golden.turns.entries()) {
        if (args.fake) rehearsal.push({ kind: 'decision', decision: turn.rehearsal, latencyMs: 0 });
        const before = client.calls.length;
        const conv = await customerSays(w, golden.account, phone, turn.says);
        if (i === 0) startTeam = conv.teamId;
        convId = conv.id;
        await tickAt(w, new Date());
        const call = client.calls[before];
        const row = (await threadState(w, conv.id)).turns.at(-1);
        console.log(`  customer   ${JSON.stringify(turn.says)}`);
        if (!call) {
          why.push(`turn ${i + 1}: no model call (turn ${row?.state}/${row?.reason})`);
          console.log(`  no model call: turn ${row?.state}/${row?.reason}`);
          continue;
        }
        calls += 1;
        const o = call.outcome;
        if (o.usage) {
          totals.inputTokens += o.usage.inputTokens;
          totals.outputTokens += o.usage.outputTokens;
          totals.cacheReadTokens += o.usage.cacheReadTokens;
          totals.cacheWriteTokens += o.usage.cacheWriteTokens;
          cost += costOf(o.model ?? args.model, o.usage) ?? 0;
        }
        served = o.model ?? served;
        const usage = o.usage
          ? `in ${o.usage.inputTokens}  out ${o.usage.outputTokens}  cache read ${o.usage.cacheReadTokens}  cache write ${o.usage.cacheWriteTokens}`
          : 'no usage';
        if (!o.ok) {
          const fail = `turn ${i + 1}: the model call failed: ${o.reason}${o.error ? ` (${o.error.errorClass} ${o.error.status ?? ''})` : ''}`;
          why.push(fail);
          console.log(`  ${fail}\n  tokens     ${usage}  latency ${(o.latencyMs / 1000).toFixed(1)} s`);
          continue;
        }
        const dcs = o.decision;
        console.log(
          `  decision   intent=${dcs.intent} action=${dcs.action} certainty=${dcs.certainty} lang=${dcs.language} reason=${dcs.reason} ` +
            `grounding=[${dcs.grounding.join(', ')}] askBranch=${dcs.askBranch} brochure=${dcs.sendBrochure} branchNamed=${dcs.branchNamed ?? '-'}`,
        );
        for (const b of dcs.bubbles) console.log(`  bubble     ${JSON.stringify(b)}`);
        console.log(
          `  gates      ${gateReport(dcs, call.request.prompt.grounding)
            .map((g) => `${g.gate}: ${g.result}${g.detail ? ` (${g.detail})` : ''}`)
            .join(' | ')}`,
        );
        const verdict = gateDecision(dcs, golden, turn);
        const failures = judgeVerdict(turn.expect, verdict, dcs);
        if (row?.state !== stateOf(verdict) || row.reason !== verdict.reason) {
          failures.push(`the engine closed the turn ${row?.state}/${row?.reason}; the replayed gates say ${stateOf(verdict)}/${verdict.reason}`);
        }
        console.log(`  verdict    ${verdictWords(verdict)}`);
        console.log(`  engine     turn ${row?.state}/${row?.reason}`);
        console.log(`  tokens     ${usage}  latency ${(o.latencyMs / 1000).toFixed(1)} s  model ${o.model}`);
        console.log(`  turn ${i + 1}     ${failures.length === 0 ? 'PASS' : `FAIL: ${failures.join('; ')}`}`);
        why.push(...failures.map((f) => `turn ${i + 1}: ${f}`));
        recorded.push({
          says: turn.says,
          response: call.raw,
          recorded: { action: verdict.action, reason: verdict.reason, intent: verdict.intent, pass: failures.length === 0, failures },
        });
      }
      if (golden.thread && convId) {
        const threadFails = await judgeThread(w, golden.thread, convId, startTeam);
        if (threadFails.length > 0) console.log(`  thread     FAIL: ${threadFails.join('; ')}`);
        why.push(...threadFails.map((f) => `thread: ${f}`));
      }
      const pass = why.length === 0;
      results.push({ id: golden.id, pass, why });
      console.log(`  ${golden.id} ${pass ? 'PASS' : 'FAIL'}\n`);

      if (args.record) {
        if (recorded.length !== golden.turns.length || recorded.some((r) => r.response === null)) {
          console.log(`  ${golden.id}: not recorded (a turn has no response body)\n`);
        } else {
          mkdirSync(FIXTURE_DIR, { recursive: true });
          const file: RecordedGolden = {
            golden: golden.id,
            note: FIXTURE_NOTE,
            requestedModel: args.model,
            servedModel: served,
            personaVersion: PERSONA_VERSION,
            kbVersion: fixtureKnowledge().version,
            recordedOn: new Date().toISOString().slice(0, 10),
            turns: recorded,
          };
          writeFileSync(join(FIXTURE_DIR, `${golden.id}.json`), `${JSON.stringify(file, null, 2)}\n`);
        }
      }
    }

    for (const m of MECHANICAL_GOLDENS) {
      if (args.only && !args.only.has(m.id)) continue;
      const run = await playMechanical(w, m.id, new FakeAssistantClient([], args.model));
      console.log(`${m.id}  ${m.setup} (mechanical, fake client)\n  expected   ${m.expected}`);
      for (const n of run.notes) console.log(`  observed   ${n}`);
      const pass = run.failures.length === 0;
      if (!pass) console.log(`  FAIL: ${run.failures.join('; ')}`);
      console.log(`  ${m.id} ${pass ? 'PASS' : 'FAIL'}\n`);
      results.push({ id: m.id, pass, why: run.failures });
    }
  } finally {
    await w.ctx.close();
    await teardownAll();
  }

  console.log('summary');
  for (const r of results) console.log(`  ${r.id.padEnd(4)} ${r.pass ? 'PASS' : `FAIL  ${r.why.join(' | ')}`}`);
  const passed = results.filter((r) => r.pass).length;
  console.log(`  ${passed}/${results.length} PASS`);
  console.log(
    `  model calls ${calls}  tokens in ${totals.inputTokens} out ${totals.outputTokens} cache read ${totals.cacheReadTokens} cache write ${totals.cacheWriteTokens}` +
      (args.fake ? '' : `  rough cost $${cost.toFixed(3)}`),
  );
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  // A class and a message of our own making; an SDK error never reaches here (the client never throws).
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'ai:eval failed');
  process.exitCode = 1;
});
