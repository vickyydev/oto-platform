/**
 * THE INTERNAL ASSISTANT'S LIVE EVAL (SCRUM-591 round I5; plan
 * `docs/progress/plans/internal-assistant-build/PLAN.md` §F.3 "recorded
 * fixtures and live eval", §F.4, G8).
 *
 *   pnpm --filter @oto/api assistant:eval                 the goldens against the real model
 *   pnpm --filter @oto/api assistant:eval --record        …and write every model response of each
 *                                                         ask to test/fixtures/assistant/<id>.json
 *   pnpm --filter @oto/api assistant:eval --model claude-sonnet-5-5
 *                                                         the same suite on another tier (G8)
 *   pnpm --filter @oto/api assistant:eval --only Q4,Q9    a subset
 *   pnpm --filter @oto/api assistant:eval --fake          rehearse the script on FakeToolLoopClient
 *                                                         with scripted steps: no key, no API call
 *
 * BY HAND, NEVER IN CI: it spends real money (Q1–Q10 and Q9R are eleven asks,
 * each one to six model calls). Under CI it refuses unless `--fake`.
 *
 * It builds the fixture world (`test/assistant-golden.ts`, fictional ZZ
 * people, families and customer lines) in an embedded database and plays each
 * model golden through the REAL ask route as the golden's asker: the engine,
 * the tool executor calling each screen's own route as that person, the
 * guards, the links. Live, the model is the REAL `AnthropicToolLoopClient`.
 * The OTO App goldens (Q1–Q3, Q6–Q8; round I4) sign the asker into a FAKE
 * OTO App on a loopback port (`test/fake-otoapp.ts`) through the real
 * hand-off, with INTERNAL_AI_OTOAPP_TOOLS on for those asks only.
 * Q11–Q16 are mechanical and always run on the fake.
 *
 * THE KEY. `ANTHROPIC_API_KEY` from the environment, else from `apps/api/.env`.
 * It is handed to the client's constructor and nowhere else: never printed,
 * never put in `process.env`, never written to a fixture. A recording holds
 * the response bodies only — no request, no header.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';
import { AnthropicToolLoopClient, DEFAULT_MODEL, INTERNAL_PERSONA_VERSION } from '@oto/assistant';
import { teardownAll } from '../test/helpers';
import {
  LIVE_GOLDENS,
  MECHANICAL_GOLDENS,
  buildAskGoldenWorld,
  capturingFetch,
  judgeAsk,
  playAsk,
  playMechanical,
  recordingOf,
  rehearse,
  useClient,
  worldVersion,
} from '../test/assistant-golden';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '..', 'test', 'fixtures', 'assistant');

interface Args {
  record: boolean;
  fake: boolean;
  model: string;
  only: Set<string> | null;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { record: false, fake: false, model: DEFAULT_MODEL, only: null };
  const ids = (v: string) => new Set(v.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean));
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    if (a === '--') continue;
    else if (a === '--record') args.record = true;
    else if (a === '--fake') args.fake = true;
    else if (a === '--model') args.model = argv[++i] ?? '';
    else if (a.startsWith('--model=')) args.model = a.slice('--model='.length);
    else if (a === '--only') args.only = ids(argv[++i] ?? '');
    else if (a.startsWith('--only=')) args.only = ids(a.slice('--only='.length));
    else throw new Error(`assistant:eval does not know the option ${a}`);
  }
  if (!/^claude-[a-z0-9-]+$/.test(args.model)) throw new Error('--model takes a model id, e.g. claude-sonnet-5-5');
  if (args.record && args.fake) throw new Error('--record records the real model; it cannot be combined with --fake');
  if (args.only) {
    const known = new Set([...LIVE_GOLDENS.map((g) => g.id), ...MECHANICAL_GOLDENS.map((m) => m.id)]);
    const unknown = [...args.only].filter((id) => !known.has(id));
    if (unknown.length > 0) throw new Error(`--only names goldens that do not exist: ${unknown.join(', ')}`);
  }
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

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Usage summed from the recorded bodies (all four counts, the cache write included). */
function usageOf(bodies: unknown[]): Usage {
  const u: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const b of bodies) {
    const usage = b && typeof b === 'object' ? (b as { usage?: Record<string, unknown> }).usage : undefined;
    if (!usage) continue;
    const n = (k: string) => (typeof usage[k] === 'number' ? (usage[k] as number) : 0);
    u.input += n('input_tokens');
    u.output += n('output_tokens');
    u.cacheRead += n('cache_read_input_tokens');
    u.cacheWrite += n('cache_creation_input_tokens');
  }
  return u;
}

/** $ per million tokens (input, output, cache read); a one-hour cache write is twice the input rate. */
const PRICES: Array<[RegExp, { input: number; output: number; cacheRead: number }]> = [
  [/^claude-opus-5-5/, { input: 4, output: 20, cacheRead: 0.2 }],
  [/^claude-sonnet-5-5/, { input: 2, output: 10, cacheRead: 0.2 }],
  [/^claude-haiku-5-5/, { input: 0.1, output: 0.5, cacheRead: 0.01 }],
];

function costOf(model: string, u: Usage): number | null {
  const p = PRICES.find(([re]) => re.test(model))?.[1];
  if (!p) return null;
  return (u.input * p.input + u.output * p.output + u.cacheRead * p.cacheRead + u.cacheWrite * p.input * 2) / 1_000_000;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.fake && process.env['CI']) {
    console.error('assistant:eval calls the real Anthropic API and never runs under CI. To rehearse the script, add --fake.');
    process.exitCode = 1;
    return;
  }
  const key = args.fake ? '' : readKey();
  if (!args.fake && !key) {
    console.error(
      'assistant:eval calls the real Anthropic API and needs ANTHROPIC_API_KEY (in the environment or apps/api/.env).\n' +
        'None was found, so nothing was run. To rehearse the script without a key, add --fake.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `assistant:eval  model ${args.model}  ${args.fake ? 'REHEARSAL (FakeToolLoopClient, scripted steps, no API call)' : 'LIVE'}${args.record ? '  RECORDING' : ''}`,
  );
  console.log('building the fixture world (embedded database, migrations, seed, ZZ fixtures)…');
  const w = await buildAskGoldenWorld();
  const cfg = w.ctx.app.internalAi.config;
  console.log(
    `persona ${INTERNAL_PERSONA_VERSION}  ${worldVersion()} (OTO App goldens: ${worldVersion(true)})  effort ${cfg.effort}  tool cap ${cfg.maxToolCalls}  wall ${cfg.wallMs / 1000} s\n`,
  );

  const capture = capturingFetch();
  const live = args.fake
    ? null
    : new AnthropicToolLoopClient({
        apiKey: key,
        model: args.model,
        effort: cfg.effort,
        timeoutMs: cfg.timeoutMs,
        fetch: capture.fetch,
      });

  const results: Array<{ id: string; pass: boolean; why: string[] }> = [];
  const totals: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let cost = 0;
  let modelCalls = 0;
  try {
    for (const golden of LIVE_GOLDENS) {
      if (args.only && !args.only.has(golden.id)) continue;
      console.log(`${golden.id}  ${golden.asker}  ${JSON.stringify(golden.question)}${golden.otoApp ? '  [OTO App: the fake app, INTERNAL_AI_OTOAPP_TOOLS on]' : ''}`);
      console.log(`  plan       ${golden.plan}`);
      if (golden.note) console.log(`  encoded    ${golden.note}`);
      let fakeCalls = 0;
      if (live) {
        capture.take();
        useClient(w, live);
      }
      const fake = live ? null : rehearse(w, golden);
      const askedAt = new Date();
      let played;
      try {
        played = await playAsk(w, golden.asker, golden.question, { otoApp: golden.otoApp === true });
      } catch (err) {
        const why = [err instanceof Error ? err.message : 'the ask failed'];
        console.log(`  FAIL: ${why[0]}\n`);
        results.push({ id: golden.id, pass: false, why });
        continue;
      }
      const bodies = live ? capture.take() : [];
      fakeCalls = fake ? fake.calls.length : bodies.length;
      modelCalls += fakeCalls;
      const usage: Usage = live
        ? usageOf(bodies)
        : { input: played.tokens.input, output: played.tokens.output, cacheRead: played.tokens.cacheRead, cacheWrite: 0 };
      totals.input += usage.input;
      totals.output += usage.output;
      totals.cacheRead += usage.cacheRead;
      totals.cacheWrite += usage.cacheWrite;
      const askCost = live ? (costOf(args.model, usage) ?? 0) : 0;
      cost += askCost;

      const o = played.observed;
      console.log(`  tools      ${o.tools.length === 0 ? 'none' : o.tools.map((t) => `${t.tool}:${t.status ?? 'invalid'}`).join(' → ')}`);
      console.log(`  state      ${o.state}${o.reason ? `/${o.reason}` : ''}`);
      console.log(`  answer     ${JSON.stringify(o.answer)}`);
      if (o.links.length) console.log(`  links      ${o.links.join(', ')}`);
      for (const r of o.refusals) console.log(`  refusal    ${JSON.stringify(r)}`);
      console.log(
        `  tokens     in ${usage.input}  out ${usage.output}  cache read ${usage.cacheRead}  cache write ${usage.cacheWrite}` +
          `  model calls ${fakeCalls}  latency ${(played.wallMs / 1000).toFixed(1)} s${live ? `  ~$${askCost.toFixed(4)}` : ''}`,
      );
      const failures = judgeAsk(golden.expect, o);
      const pass = failures.length === 0;
      console.log(`  ${golden.id} ${pass ? 'PASS' : `FAIL: ${failures.join('; ')}`}\n`);
      results.push({ id: golden.id, pass, why: failures });

      if (args.record && live) {
        if (bodies.length === 0 || bodies.some((b) => b === null)) {
          console.log(`  ${golden.id}: not recorded (a model call has no response body)\n`);
        } else {
          mkdirSync(FIXTURE_DIR, { recursive: true });
          const file = recordingOf(golden, w, played, bodies, args.model, askedAt);
          writeFileSync(join(FIXTURE_DIR, `${golden.id}.json`), `${JSON.stringify(file, null, 2)}\n`);
          console.log(`  recorded   test/fixtures/assistant/${golden.id}.json (${bodies.length} responses)\n`);
        }
      }
    }

    for (const m of MECHANICAL_GOLDENS) {
      if (args.only && !args.only.has(m.id)) continue;
      const run = await playMechanical(w, m.id);
      console.log(`${m.id}  ${m.setup} (mechanical, fake client)\n  expected   ${m.expected}`);
      for (const n of run.notes) console.log(`  observed   ${n}`);
      const pass = run.failures.length === 0;
      console.log(`  ${m.id} ${pass ? 'PASS' : `FAIL: ${run.failures.join('; ')}`}\n`);
      results.push({ id: m.id, pass, why: run.failures });
    }
  } finally {
    await w.close();
    await teardownAll();
  }

  console.log('summary');
  for (const r of results) console.log(`  ${r.id.padEnd(4)} ${r.pass ? 'PASS' : `FAIL  ${r.why.join(' | ')}`}`);
  const passed = results.filter((r) => r.pass).length;
  console.log(`  ${passed}/${results.length} PASS${args.fake ? '  (scripted steps: proves the script, not the model)' : ''}`);
  console.log(
    `  model calls ${modelCalls}  tokens in ${totals.input} out ${totals.output} cache read ${totals.cacheRead} cache write ${totals.cacheWrite}` +
      (args.fake ? '' : `  rough cost $${cost.toFixed(3)}`),
  );
  if (passed !== results.length) process.exitCode = 1;
}

main().catch((err: unknown) => {
  // A class and a message of our own making; an SDK error never reaches here (the client never throws).
  console.error(err instanceof Error ? `${err.name}: ${err.message}` : 'assistant:eval failed');
  process.exitCode = 1;
});
