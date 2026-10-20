import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeAssistantClient, PERSONA_VERSION } from '@oto/assistant';
import { loadTurnKnowledge } from '../src/services/inbox/ai-knowledge';
import { teardownAll } from './helpers';
import {
  LIVE_GOLDENS,
  MECHANICAL_GOLDENS,
  buildGoldenWorld,
  fixtureKnowledge,
  gateDecision,
  judgeVerdict,
  playMechanical,
  replayingClient,
  type GoldenWorld,
  type RecordedGolden,
} from './inbox-ai-golden';

/**
 * SCRUM-590 round A4 — THE GOLDEN CONVERSATIONS, REPLAYED (plan
 * `docs/progress/plans/inbox-ai-build/PLAN.md` §F.3 "recorded-fixture suite",
 * §F.4).
 *
 *   - G1–G9: the REAL model's responses, recorded once by hand with
 *     `pnpm --filter @oto/api ai:eval --record` (fixtures in
 *     `test/fixtures/inbox-ai/`), fed through the real client (the SDK over
 *     an injected fetch: no network), `interpretReply`, the decision schema
 *     and `applyGates` with the fixture grounding. A schema or guard change
 *     that breaks a real response fails here, without calling the API.
 *   - G10–G16: the mechanical goldens, through the real turn engine with the
 *     fake client.
 *
 * Fictional fixture data throughout (`inbox-ai-golden.ts`).
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'inbox-ai');

function recording(id: string): RecordedGolden {
  return JSON.parse(readFileSync(join(FIXTURES, `${id}.json`), 'utf8')) as RecordedGolden;
}

describe('the recorded goldens: real model responses through the real parser and gates', () => {
  const knowledge = fixtureKnowledge();

  it('the fixtures were recorded against this fixture knowledge and this persona', () => {
    for (const g of LIVE_GOLDENS) {
      const r = recording(g.id);
      expect(r.turns, g.id).toHaveLength(g.turns.length);
      // A changed KB or persona does not fail the replay by itself (the gates
      // decide that), but it means the recording no longer shows what the
      // model would say today: re-record with `ai:eval --record`.
      expect({ id: g.id, kb: r.kbVersion, persona: r.personaVersion }).toEqual({
        id: g.id,
        kb: knowledge.version,
        persona: PERSONA_VERSION,
      });
    }
  });

  for (const golden of LIVE_GOLDENS) {
    for (const [i, turn] of golden.turns.entries()) {
      it(`${golden.id}.${i + 1} ${golden.setup}: ${JSON.stringify(turn.says)} -> ${turn.expect.action} ${turn.expect.intent ?? ''}`, async () => {
        const r = recording(golden.id);
        const rec = r.turns[i]!;
        expect(rec.says).toBe(turn.says);
        const outcome = await replayingClient(rec.response, r.requestedModel).decide({
          // The replaying fetch ignores the request; the prompt is the fixture world's.
          prompt: {
            system: [
              { type: 'text', text: 'replay' },
              { type: 'text', text: knowledge.text },
            ],
            messages: [{ role: 'user', content: 'replay' }],
            personaVersion: PERSONA_VERSION,
            kbVersion: knowledge.version,
            grounding: knowledge.grounding,
            systemTokens: 0,
          },
        });
        expect(outcome.ok, outcome.ok ? '' : outcome.reason).toBe(true);
        if (!outcome.ok) return;
        const verdict = gateDecision(outcome.decision, golden, turn, knowledge);
        // The verdict the live run recorded still holds…
        expect({ action: verdict.action, reason: verdict.reason, intent: verdict.intent }).toEqual({
          action: rec.recorded.action,
          reason: rec.recorded.reason,
          intent: rec.recorded.intent,
        });
        // …and meets the golden's expectation (a recorded FAIL stays pinned as the finding it was).
        expect(judgeVerdict(turn.expect, verdict, outcome.decision)).toEqual(rec.recorded.pass ? [] : rec.recorded.failures);
      });
    }
  }
});

describe('the mechanical goldens through the turn engine (fake client)', () => {
  let w: GoldenWorld;

  beforeAll(async () => {
    w = await buildGoldenWorld(null);
  }, 300_000);

  afterAll(async () => {
    await w?.ctx.close();
    await teardownAll();
  });

  it('the database world renders exactly the fixture knowledge the replay uses', async () => {
    const loaded = await loadTurnKnowledge(w.ctx.db, w.oto, new Date());
    expect(loaded.knowledge.text).toBe(fixtureKnowledge().text);
    expect(loaded.knowledge.version).toBe(fixtureKnowledge().version);
  });

  for (const m of MECHANICAL_GOLDENS) {
    it(`${m.id} ${m.setup}: ${m.expected}`, async () => {
      const fake = new FakeAssistantClient();
      const run = await playMechanical(w, m.id, fake);
      expect(run.failures).toEqual([]);
      expect(fake.remaining).toBe(0);
    });
  }
});
