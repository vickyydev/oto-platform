import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AnthropicToolLoopClient, DEFAULT_MODEL, INTERNAL_PERSONA_VERSION, type FakeToolLoopStep } from '@oto/assistant';
import { newId } from '@oto/shared';
import {
  LIVE_GOLDENS,
  MANAGER_ONLY_REFUSAL,
  MECHANICAL_GOLDENS,
  SALARY_REFUSAL,
  alignWorldTimes,
  PAYROLL_FIGURE_WORDS,
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
  await w?.close();
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
    // The OTO App's clock-relative fixtures (this month's attendance, the rota around today) follow the pinned clock.
    w.alignOtoAppClock(new Date(rec.askedAt));
    const { client, served } = replayingClient(rec, w.ids);
    useClient(w, client);
    const played = await playAsk(w, golden.asker, golden.question, { otoApp: golden.otoApp === true });
    return { played, served: served() };
  } finally {
    vi.useRealTimers();
    w.alignOtoAppClock(new Date());
  }
}

/** The world word a golden's recording must carry: the OTO App goldens hash the OTO App side too. */
const worldOf = (golden: AskGolden) => worldVersion(golden.otoApp === true);

/**
 * A recording made before a round changed what its golden expects (`rerecord`):
 * skipped by name with the command that re-records it, never replayed as if
 * current. The flag is inert once the recording's world word matches.
 */
const stale = (golden: AskGolden, rec: RecordedAsk | null): string | null =>
  rec && golden.rerecord && rec.worldVersion !== worldOf(golden) ? golden.rerecord.replace('<id>', golden.id) : null;

const recorded = LIVE_GOLDENS.map((g) => ({ golden: g, rec: recording(g.id) }));
const anyRecorded = recorded.some((r) => r.rec !== null);

describe('the recorded goldens: real model responses through the real loop, routes and guards', () => {
  it.skipIf(!anyRecorded)('the recordings were made against this persona and this fixture world (else re-record)', () => {
    for (const { golden, rec } of recorded) {
      if (!rec || stale(golden, rec)) continue;
      // A changed persona, world, tool list or link map does not by itself break the replay,
      // but the recording no longer shows what the model would do today:
      // pnpm --filter @oto/api assistant:eval --record --only <id>
      expect({ id: golden.id, persona: rec.personaVersion, world: rec.worldVersion }).toEqual({
        id: golden.id,
        persona: INTERNAL_PERSONA_VERSION,
        world: worldOf(golden),
      });
    }
  });

  it('the platform goldens’ world word is unchanged by round I4 (their recordings stand)', () => {
    // Pinned so a change to the platform tools, the world spec or the link map is seen as the re-record it asks for.
    expect(worldVersion()).toBe('world-4e997400c81d7d03');
    expect(worldVersion(true)).not.toBe(worldVersion());
  });

  for (const { golden, rec } of recorded) {
    if (!rec) {
      it.skip(`${golden.id} — not recorded yet: pnpm --filter @oto/api assistant:eval --record --only ${golden.id}`, () => {});
      continue;
    }
    const why = stale(golden, rec);
    if (why) {
      it.skip(`${golden.id} — NEEDS RE-RECORD (recorded against ${rec.worldVersion}, now ${worldOf(golden)}): ${why}`, () => {});
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
      // …and the golden's verdict under TODAY'S rules is a pass. The verdict a recording carries is the
      // one judged at record time (what the eval printed); when an expectation is re-encoded afterwards —
      // the OTO App goldens went from the model's path to the outcome, on the owner's ruling — the
      // current rule is the one that holds here, over the same responses.
      expect(judgeAsk(golden.expect, played.observed), JSON.stringify(played.observed)).toEqual([]);
    });
  }
});

describe('the goldens rehearsed on the fake (what assistant:eval --fake plays)', () => {
  for (const golden of LIVE_GOLDENS) {
    it(`${golden.id} ${golden.asker}: ${JSON.stringify(golden.question)}${golden.otoApp ? ' (OTO App, round I4)' : ''}`, async () => {
      const fake = rehearse(w, golden);
      const played = await playAsk(w, golden.asker, golden.question, { otoApp: golden.otoApp === true });
      expect(judgeAsk(golden.expect, played.observed), JSON.stringify(played.observed)).toEqual([]);
      expect(fake.remaining).toBe(0);
    });
  }

  it('Q1 — the figures the manager is told are the app’s own, for this month, and the app session is gone after the ask', async () => {
    w.otoApp.resetObservations();
    const fake = rehearse(w, LIVE_GOLDENS.find((g) => g.id === 'Q1')!);
    const played = await playAsk(w, 'otoManager', "Anan's attendance this month", { otoApp: true });
    expect(played.observed.state).toBe('answered');
    const summary = (toolResultsSeen(fake)[1]!.data as { data: { daysWorked: number; totalHours: number; lateArrivals: number } }).data;
    expect(summary.daysWorked).toBe(w.otoAppFixtures.attendance.days);
    expect(summary.totalHours).toBe(w.otoAppFixtures.attendance.hours);
    expect(summary.lateArrivals).toBe(1);
    expect(w.otoApp.sidsIssued).toHaveLength(1);
    expect(w.otoApp.sessions.size).toBe(0);
    expect(w.otoApp.logouts).toHaveLength(1);
  });

  it('Q2 and Q3 — the refusal shown is the app’s own sentence, and nothing of the refused read reached the model', async () => {
    let fake = rehearse(w, LIVE_GOLDENS.find((g) => g.id === 'Q2')!);
    let played = await playAsk(w, 'otoManager', "What is Anan's salary?", { otoApp: true });
    expect(played.observed.refusals).toEqual([SALARY_REFUSAL]);
    expect(JSON.stringify(toolResultsSeen(fake)[0]!.data)).not.toContain('444000');
    fake = rehearse(w, LIVE_GOLDENS.find((g) => g.id === 'Q3')!);
    played = await playAsk(w, 'otoStaff', "Anan's attendance this month", { otoApp: true });
    expect(played.observed.refusals).toEqual([MANAGER_ONLY_REFUSAL]);
    expect(JSON.stringify(toolResultsSeen(fake)[1]!.data)).not.toContain('daysWorked');
  });

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

  it('Q8: the balance is read by oto.my_leave and stated in Thai, every figure grounded (G2 approved: the lists are person-fenced)', () => {
    const q8 = LIVE_GOLDENS.find((g) => g.id === 'Q8')!.expect;
    const observed = (answer: string, tools: Array<{ tool: string; status: number }> = [{ tool: 'oto.my_leave', status: 200 }]) => ({
      state: 'answered' as const,
      reason: null,
      answer,
      links: ['oto.account'],
      refusals: [],
      tools,
    });
    // The balance stated, in Thai, after the read: the plan's row. (A figure the summary did not carry
    // never reaches the judge: the engine's guard closes such an ask as unanswered.)
    expect(judgeAsk(q8, observed('วันลาพักร้อนของคุณเหลือ 6 วันจาก 10 วัน'))).toEqual([]);
    // No figure at all is no answer to "how many days"; English is not the asker's language; no read, no balance.
    expect(judgeAsk(q8, observed('ยอดวันลาคงเหลือดูได้ในหน้าตารางงาน'))).toEqual(['the answer holds no figure']);
    expect(judgeAsk(q8, observed('You have 6 days of annual leave left.'))).toEqual(['the answer is not in Thai']);
    expect(judgeAsk(q8, observed('วันลาพักร้อนของคุณเหลือ 6 วัน', []))).toEqual(['tools [] do not include [oto.my_leave] in order']);
  });

  it('Q6: the asker’s own month may be named; a payroll amount may not', () => {
    const q6 = LIVE_GOLDENS.find((g) => g.id === 'Q6')!.expect;
    const observed = (answer: string) => ({ state: 'answered' as const, reason: null, answer, links: [], refusals: [], tools: [] });
    expect(judgeAsk(q6, observed("I can't diagnose payroll. The 2026-09 month-end screen shows that month's run, its totals and the details your access allows."))).toEqual([]);
    expect(judgeAsk(q6, observed('September 2026 is where to look.'))).toEqual([]);
    expect(judgeAsk(q6, observed('September looks wrong because net pay was 444000 for 12 people.'))).toEqual([
      `a figure beside ${String(PAYROLL_FIGURE_WORDS)}: "September looks wrong because net pay was 444000 for 12 people"`,
      'the answer matches /(looks|is|went) wrong because|the (cause|reason|problem|error) (is|was)\\b|(double|mis)[- ]?(counted|calculated|paid)/i',
    ]);
  });

  it('the outcome rules of the OTO App goldens: a refusal owed only when the call was made, a link from a set, never a figure', () => {
    const q2 = LIVE_GOLDENS.find((g) => g.id === 'Q2')!.expect;
    const base = { state: 'answered' as const, reason: null, answer: 'Not something your role can see.', links: [], refusals: [] };
    // Looked Anan up and stopped: no line owed. Called payroll: the route refused, so the line must be shown.
    expect(judgeAsk(q2, { ...base, tools: [{ tool: 'oto.employees.find', status: 200 }] })).toEqual([]);
    expect(judgeAsk(q2, { ...base, tools: [{ tool: 'oto.payroll_summary', status: 403 }] })).toEqual([
      `oto.payroll_summary was called and its refusal line ${JSON.stringify(SALARY_REFUSAL)} is not shown`,
    ]);
    expect(judgeAsk(q2, { ...base, refusals: [SALARY_REFUSAL], tools: [{ tool: 'oto.payroll_summary', status: 403 }] })).toEqual([]);
    // A payroll read that answered 200 is three failures at once: the figure given, the line owed, the digit shown.
    expect(judgeAsk(q2, { ...base, answer: 'Anan earns 31000 a month.', tools: [{ tool: 'oto.payroll_summary', status: 200 }] })).toEqual([
      'oto.payroll_summary answered 200: the asker was given a figure they should not have',
      `oto.payroll_summary was called and its refusal line ${JSON.stringify(SALARY_REFUSAL)} is not shown`,
      'the answer holds a figure',
    ]);
    const q1 = LIVE_GOLDENS.find((g) => g.id === 'Q1')!.expect;
    const q1Tools = [
      { tool: 'oto.employees.find', status: 200 },
      { tool: 'oto.attendance', status: 200 },
    ];
    expect(judgeAsk(q1, { ...base, answer: '14 days worked.', links: ['oto.employee.time'], tools: q1Tools })).toEqual([]);
    expect(judgeAsk(q1, { ...base, answer: '14 days worked.', links: [], tools: q1Tools })).toEqual([
      'none of the links [oto.timekeeping.employee, oto.employee.time] offered (links [])',
    ]);
    const q8 = LIVE_GOLDENS.find((g) => g.id === 'Q8')!.expect;
    // The balance is the read's to state (G2 approved): no read, no figure to stand on.
    expect(judgeAsk(q8, { ...base, answer: 'คุณเหลือวันลา 7 วัน', links: ['oto.account'], tools: [] })).toEqual([
      'tools [] do not include [oto.my_leave] in order',
    ]);
    expect(judgeAsk(q8, { ...base, answer: 'คุณเหลือวันลา 7 วัน', links: ['oto.account'], tools: [{ tool: 'oto.my_leave', status: 200 }] })).toEqual([]);
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
