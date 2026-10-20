import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AnthropicToolLoopClient, DEFAULT_MODEL, INTERNAL_PERSONA_VERSION, type FakeToolLoopStep } from '@oto/assistant';
import { newId } from '@oto/shared';
import {
  LIVE_GOLDENS,
  MECHANICAL_GOLDENS,
  alignWorldTimes,
  buildAskGoldenWorld,
  capturingFetch,
  judgeAsk,
  playAsk,
  playMechanical,
  recordedTimes,
  recordingOf,
  rehearse,
  replayingClient,
  scriptedFetch,
  useClient,
  worldVersion,
  type AskGolden,
  type GoldenAskWorld,
  type RecordedAsk,
} from './assistant-golden';
import { call, mintSession, toolResultsSeen } from './assistant-support';
import { teardownAll } from './helpers';

/**
 * SCRUM-591 round I5 — THE GOLDEN ASKS, REPLAYED (plan
 * `docs/progress/plans/internal-assistant-build/PLAN.md` §F.3 "recorded
 * fixtures and live eval", §F.4). The goldens, their expectations and the
 * fixture world are in `assistant-golden.ts`.
 *
 *   - RECORDED: Q1–Q10 (and Q9R) as the REAL model answered them, recorded by
 *     hand with `pnpm --filter @oto/api assistant:eval --record` into
 *     `test/fixtures/assistant/<id>.json`, fed back through the real
 *     `AnthropicToolLoopClient` (an injected fetch: no network), the real loop,
 *     the real tool routes as the asker and the real guards. A golden with no
 *     recording yet is SKIPPED, by name, with the command that records it.
 *     A recording made against another persona or another fixture world fails
 *     the pin: re-record.
 *   - REHEARSED: the same goldens on `FakeToolLoopClient`, scripted as a model
 *     could reasonably act — what `assistant:eval --fake` plays. It proves the
 *     expectations and the script, not the model.
 *   - PLUMBING: a scripted ask recorded through the real client and replayed,
 *     with its ids moved, so the record → replay path is proven without a key.
 *   - MECHANICAL: Q11–Q16 on the fake, always.
 */

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'assistant');

function recording(id: string): RecordedAsk | null {
  const file = join(FIXTURES, `${id}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as RecordedAsk) : null;
}

let w: GoldenAskWorld;

beforeAll(async () => {
  w = await buildAskGoldenWorld();
}, 300_000);

afterAll(async () => {
  await w?.ctx.close();
  await teardownAll();
});

/**
 * A recording through the real client, in the recording's time: the world's
 * threads take the instants the recording world's had, and the ask runs at
 * the clock it was made at, so every time a summary renders is the one the
 * model read and stays grounded. Only `Date` is pinned.
 */
async function replay(golden: AskGolden, rec: RecordedAsk) {
  await alignWorldTimes(w, rec);
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(rec.askedAt) });
  try {
    const { client, served } = replayingClient(rec, w.ids);
    useClient(w, client);
    const played = await playAsk(w, golden.asker, golden.question);
    return { played, served: served() };
  } finally {
    vi.useRealTimers();
  }
}

const recorded = LIVE_GOLDENS.map((g) => ({ golden: g, rec: recording(g.id) }));
const anyRecorded = recorded.some((r) => r.rec !== null);

describe('the recorded goldens: real model responses through the real loop, routes and guards', () => {
  it.skipIf(!anyRecorded)('the recordings were made against this persona and this fixture world (else re-record)', () => {
    for (const { golden, rec } of recorded) {
      if (!rec) continue;
      // A changed persona, world, tool list or link map does not by itself break the replay,
      // but the recording no longer shows what the model would do today:
      // pnpm --filter @oto/api assistant:eval --record --only <id>
      expect({ id: golden.id, persona: rec.personaVersion, world: rec.worldVersion }).toEqual({
        id: golden.id,
        persona: INTERNAL_PERSONA_VERSION,
        world: worldVersion(),
      });
    }
  });

  for (const { golden, rec } of recorded) {
    if (!rec) {
      it.skip(`${golden.id} — not recorded yet: pnpm --filter @oto/api assistant:eval --record --only ${golden.id}`, () => {});
      continue;
    }
    it(`${golden.id} ${golden.asker}: ${JSON.stringify(golden.question)} replays as recorded`, async () => {
      const { played, served } = await replay(golden, rec);
      // Every recorded response was asked for, and nothing more.
      expect(served).toBe(rec.responses.length);
      // The engine closes the ask as it did live…
      expect({ state: played.observed.state, reason: played.observed.reason, tools: played.observed.tools.map((t) => t.tool) }).toEqual({
        state: rec.recorded.state,
        reason: rec.recorded.reason,
        tools: rec.recorded.tools,
      });
      // …and the golden's verdict holds (a recorded FAIL stays pinned as the finding it was).
      expect(judgeAsk(golden.expect, played.observed)).toEqual(rec.recorded.pass ? [] : rec.recorded.failures);
    });
  }
});

describe('the goldens rehearsed on the fake (what assistant:eval --fake plays)', () => {
  for (const golden of LIVE_GOLDENS) {
    it(`${golden.id} ${golden.asker}: ${JSON.stringify(golden.question)}${golden.pendingI4 ? ' (OTO App: pending round I4)' : ''}`, async () => {
      const fake = rehearse(w, golden);
      const played = await playAsk(w, golden.asker, golden.question);
      expect(judgeAsk(golden.expect, played.observed), JSON.stringify(played.observed)).toEqual([]);
      expect(fake.remaining).toBe(0);
    });
  }

  it('Q4 — the branch list is itself fenced: a Central manager is not told Chalong exists', async () => {
    const fake = rehearse(w, LIVE_GOLDENS.find((g) => g.id === 'Q4')!);
    const played = await playAsk(w, 'manager', 'How many children are inside at Chalong right now?');
    const listed = (toolResultsSeen(fake)[0]!.data as { data: { branches: Array<{ id: string }> } }).data.branches.map((b) => b.id);
    expect(listed).toEqual([w.central]);
    expect(played.observed.tools).toEqual([
      { tool: 'branches.list', status: 200 },
      { tool: 'occupancy.now', status: 403 },
    ]);
  });

  it('Q5 — the E.164 record from a Thai local number; the allergy text only when the question is about it', async () => {
    const fake = rehearse(w, LIVE_GOLDENS.find((g) => g.id === 'Q5')!);
    await playAsk(w, 'reception', 'Find the member 081 234 5678 and their kids');
    const data = (toolResultsSeen(fake)[0]!.data as { data: { found: boolean; member: Record<string, unknown> } }).data;
    expect(data.member).toMatchObject({
      id: w.members.mali,
      name: 'ZZ Mali Family',
      childCount: 2,
      children: expect.arrayContaining([
        { name: 'ZZ Ploy', age: 6, medicalAlert: true, hasAllergies: true },
        { name: 'ZZ Tonkla', age: 4, medicalAlert: false, hasAllergies: false },
      ]),
    });
    expect(JSON.stringify(data)).not.toContain('peanuts');
  });

  it('Q10 — the count the agent is told is the count the Inbox route gives the agent', async () => {
    const fake = rehearse(w, LIVE_GOLDENS.find((g) => g.id === 'Q10')!);
    const played = await playAsk(w, 'inboxAgent', 'How many unanswered threads in my team?');
    const { cookie } = await mintSession(w, w.askers.inboxAgent.accountId, null);
    const direct = await call<{ conversations: unknown[] }>(w, cookie, 'GET', '/inbox/conversations?tab=team&unanswered=true&limit=100');
    const data = (toolResultsSeen(fake)[0]!.data as { data: { unanswered: number } }).data;
    expect(data.unanswered).toBe(direct.body.conversations.length);
    expect(JSON.stringify(toolResultsSeen(fake)[0]!.data)).not.toContain('grip socks');
    expect(played.view.links).toEqual([{ key: 'inbox.queue', app: 'inbox', path: '/?unanswered=1', shows: 'The unanswered queue' }]);
  });
});

describe('record → replay with no key: a scripted ask through the real client, recorded and replayed', () => {
  it('Q9 is recorded from the HTTP bodies and replays identically, its ids moved to another world', async () => {
    const golden = LIVE_GOLDENS.find((g) => g.id === 'Q9')!;
    const capture = capturingFetch(scriptedFetch(golden.rehearsal(w) as FakeToolLoopStep[], DEFAULT_MODEL));
    useClient(w, new AnthropicToolLoopClient({ apiKey: 'script-no-key', model: DEFAULT_MODEL, maxRetries: 0, fetch: capture.fetch }));
    const askedAt = new Date();
    const live = await playAsk(w, golden.asker, golden.question);
    const rec = recordingOf(golden, w, live, capture.take(), DEFAULT_MODEL, askedAt);
    expect(rec.responses).toHaveLength(3);
    expect(rec.recorded).toMatchObject({ state: 'answered', tools: ['members.search', 'members.get'], pass: true });

    // As if recorded in another world: the member's id there was a different one.
    const elsewhere = newId();
    const moved: RecordedAsk = {
      ...rec,
      ids: { ...rec.ids, 'member:somchai': elsewhere },
      responses: JSON.parse(JSON.stringify(rec.responses).split(w.members.somchai!).join(elsewhere)) as unknown[],
    };
    expect(JSON.stringify(moved.responses)).toContain(elsewhere);
    const { played, served } = await replay(golden, moved);
    expect(served).toBe(3);
    expect(played.observed).toEqual(live.observed);
    expect(judgeAsk(golden.expect, played.observed)).toEqual([]);
  });
});

describe('the recording world’s times', () => {
  it('a recording without kept times reads each thread’s instant from its UUIDv7 id', () => {
    const id = newId();
    const minted = recordedTimes({ ids: { 'conversation:1': id, operator: newId() } });
    expect(Object.keys(minted)).toEqual(['conversation:1']);
    expect(Math.abs(minted['conversation:1']!.getTime() - Date.now())).toBeLessThan(60_000);
    const kept = recordedTimes({ ids: { 'conversation:1': id }, times: { 'conversation:1': '2026-10-20T08:02:53.900Z' } });
    expect(kept['conversation:1']!.toISOString()).toBe('2026-10-20T08:02:53.900Z');
  });
});

describe('the judge fails what it should', () => {
  it('a Chalong figure, an unexpected refusal, a missing link and an invented figure are each named', () => {
    const q4 = LIVE_GOLDENS.find((g) => g.id === 'Q4')!.expect;
    expect(
      judgeAsk(q4, {
        state: 'answered',
        reason: null,
        answer: 'There are 12 children inside.',
        links: [],
        refusals: ['Platform: Not allowed'],
        tools: [
          { tool: 'branches.list', status: 200 },
          { tool: 'occupancy.now', status: 200 },
          { tool: 'members.search', status: 200 },
        ],
      }),
    ).toEqual([
      'called members.search, which this golden does not allow',
      'occupancy.now answered 200: the asker was given a figure they should not have',
      'an unexpected refusal "Platform: Not allowed"',
      'the answer holds a figure',
    ]);
    const q10 = LIVE_GOLDENS.find((g) => g.id === 'Q10')!.expect;
    expect(judgeAsk(q10, { state: 'link_only', reason: 'GUARD_NUMBER', answer: '', links: [], refusals: [], tools: [] })).toEqual([
      'state link_only/GUARD_NUMBER, expected answered',
      'tools [] do not include [inbox.queue] in order',
      'the answer does not mention "2"',
      'no link inbox.queue (links [])',
    ]);
  });
});

describe('the mechanical goldens (fake client, always)', () => {
  for (const m of MECHANICAL_GOLDENS) {
    it(`${m.id} ${m.setup}: ${m.expected}`, async () => {
      const run = await playMechanical(w, m.id);
      expect(run.failures, run.notes.join(' | ')).toEqual([]);
    });
  }
});
