// The ask panel's state machine (SCRUM-591 I3a; plan §D.1, §D.4, §F.3): sending
// to each terminal state, the replay, a 409 followed to its end, feedback once,
// and the link rules. Node, a fake api, a clock that does not wait.
import { describe, expect, it } from 'vitest';
import { INTERNAL_LINES } from '@oto/assistant/internal-lines';
import { ApiError } from '@/api/client';
import type { AskFeedbackBody, AskLink, AskView } from '@/api/assistant';
import {
  POLL_LIMIT_MS,
  POLL_MS,
  canGiveFeedback,
  giveFeedback,
  idForSend,
  isSmallTalk,
  mergeAsks,
  runAsk,
  shownAnswer,
  type AskDeps,
  type AskPhase,
} from '@/assistant/ask';
import { resolveLink } from '@/assistant/links';
import type { SuiteApp } from '@/suite/apps';

const ID = '01928f6e-0000-7000-8000-000000000001';

function view(over: Partial<AskView> & { smallTalk?: boolean } = {}): AskView {
  const base = {
    id: ID,
    state: 'answered' as const,
    reason: null,
    question: 'How many children are inside at Central?',
    answer: '42 children are inside at Central.',
    links: [],
    refusals: [],
    toolCalls: [],
    feedback: null,
    correction: null,
    createdAt: '2026-10-20T08:00:00.000Z',
    updatedAt: '2026-10-20T08:00:01.000Z',
    // The api's additive mark (the test-night round), set here so the fixture
    // typechecks whether or not the api's description carries it yet.
    smallTalk: false,
  };
  return { ...base, ...over };
}

/** A fake api and clock: `sleep` advances time instead of waiting. */
function deps(over: Partial<AskDeps> & { polls?: AskView[] } = {}) {
  let clock = 0;
  const phases: AskPhase[] = [];
  const polls = [...(over.polls ?? [])];
  let pollCount = 0;
  const d: AskDeps = {
    ask: over.ask ?? (async () => ({ view: view(), replayed: false })),
    one:
      over.one ??
      (async () => {
        pollCount += 1;
        return polls.shift() ?? view({ state: 'asking', answer: null });
      }),
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    onPhase: (p) => phases.push(p),
  };
  return { d, phases, pollCount: () => pollCount, clock: () => clock };
}

const inFlight = () => new ApiError(409, 'ASK_IN_FLIGHT', 'This question is still being answered');

describe('runAsk: sending to a terminal state', () => {
  for (const state of ['answered', 'refused', 'link_only', 'failed', 'capped', 'off'] as const) {
    it(`ends in done for ${state}`, async () => {
      const { d, phases } = deps({ ask: async () => ({ view: view({ state }), replayed: false }) });
      const end = await runAsk(ID, '  How many?  ', d);
      expect(phases[0]).toEqual({ kind: 'sending', id: ID, question: 'How many?' });
      expect(end).toMatchObject({ kind: 'done', replayed: false, ask: { state } });
      expect(phases.at(-1)).toBe(end);
    });
  }

  it('marks an answer that came back from the ask row (x-oto-replay)', async () => {
    const { d } = deps({ ask: async () => ({ view: view(), replayed: true }) });
    expect(await runAsk(ID, 'q', d)).toMatchObject({ kind: 'done', replayed: true });
  });
});

describe('runAsk: a 409 in flight is followed until it ends', () => {
  it('shows still-answering, polls GET /assistant/asks/:id, and ends on the terminal state', async () => {
    const answered = view({ state: 'refused', refusals: [] });
    const { d, phases, pollCount, clock } = deps({
      ask: async () => {
        throw inFlight();
      },
      polls: [view({ state: 'asking', answer: null }), view({ state: 'asking', answer: null }), answered],
    });
    const end = await runAsk(ID, 'q', d);
    expect(phases.map((p) => p.kind)).toEqual(['sending', 'still-answering', 'done']);
    expect(end).toMatchObject({ kind: 'done', ask: { state: 'refused' } });
    expect(pollCount()).toBe(3);
    expect(clock()).toBe(3 * POLL_MS);
  });

  it('keeps polling through a dropped poll', async () => {
    let n = 0;
    const { d } = deps({
      ask: async () => {
        throw inFlight();
      },
      one: async () => {
        n += 1;
        if (n === 1) throw new TypeError('Failed to fetch');
        return view();
      },
    });
    expect(await runAsk(ID, 'q', d)).toMatchObject({ kind: 'done' });
    expect(n).toBe(2);
  });

  it('gives up with the failure line, keeping the id and question, after the limit', async () => {
    const { d, clock } = deps({
      ask: async () => {
        throw inFlight();
      },
    });
    const end = await runAsk(ID, 'q', d);
    expect(end).toEqual({ kind: 'unreachable', id: ID, question: 'q', line: INTERNAL_LINES.failed.en });
    expect(clock()).toBeGreaterThanOrEqual(POLL_LIMIT_MS);
  });

  it('follows an ask the POST itself answered as still asking', async () => {
    const { d } = deps({ ask: async () => ({ view: view({ state: 'asking', answer: null }), replayed: true }), polls: [view()] });
    expect(await runAsk(ID, 'q', d)).toMatchObject({ kind: 'done', ask: { state: 'answered' } });
  });
});

describe('runAsk: failures keep the question', () => {
  it('a network failure shows the fixed failure line in the question’s language', async () => {
    const { d } = deps({
      ask: async () => {
        throw new TypeError('Failed to fetch');
      },
    });
    expect(await runAsk(ID, 'วันลาของฉันเหลือกี่วัน', d)).toEqual({
      kind: 'unreachable',
      id: ID,
      question: 'วันลาของฉันเหลือกี่วัน',
      line: INTERNAL_LINES.failed.th,
    });
  });

  it('a 5xx is the same failure line', async () => {
    const { d } = deps({
      ask: async () => {
        throw new ApiError(502, 'UNKNOWN', 'Bad Gateway');
      },
    });
    expect(await runAsk(ID, 'q', d)).toMatchObject({ kind: 'unreachable', line: INTERNAL_LINES.failed.en });
  });

  it('a 403 shows the api’s own sentence', async () => {
    const { d } = deps({
      ask: async () => {
        throw new ApiError(403, 'FORBIDDEN', 'Missing permission assistant:ask:use');
      },
    });
    expect(await runAsk(ID, 'q', d)).toEqual({
      kind: 'refused-access',
      id: ID,
      question: 'q',
      message: 'Missing permission assistant:ask:use',
    });
  });

  it('asking the same question again resends the same id; an edited one is a new ask', () => {
    const failed: AskPhase = { kind: 'unreachable', id: ID, question: 'q', line: 'x' };
    expect(idForSend(failed, ' q ', () => 'new')).toBe(ID);
    expect(idForSend(failed, 'q2', () => 'new')).toBe('new');
    expect(idForSend({ kind: 'done', ask: view({ question: 'q' }), replayed: false }, 'q', () => 'new')).toBe('new');
    expect(idForSend({ kind: 'idle' }, 'q', () => 'new')).toBe('new');
  });
});

describe('what an ask shows', () => {
  it('shows the server’s line as given, falling back to the fixed lines', () => {
    expect(shownAnswer(view({ state: 'capped', answer: 'You have reached today’s limit.' }))).toBe(
      'You have reached today’s limit.',
    );
    expect(shownAnswer(view({ state: 'off', answer: null }))).toBe(INTERNAL_LINES.off.en);
    expect(shownAnswer(view({ state: 'failed', answer: null, question: 'Сколько детей?' }))).toBe(
      INTERNAL_LINES.failed.ru,
    );
  });
});

describe('feedback, once per ask', () => {
  it('is offered on an answer, a refusal or a link, never on a switch, a cap or a failure', () => {
    expect(canGiveFeedback(view({ state: 'answered' }))).toBe(true);
    expect(canGiveFeedback(view({ state: 'refused' }))).toBe(true);
    expect(canGiveFeedback(view({ state: 'link_only' }))).toBe(true);
    for (const state of ['failed', 'capped', 'off', 'asking'] as const) {
      expect(canGiveFeedback(view({ state }))).toBe(false);
    }
  });

  it('is never offered on chit-chat, or a question back, that the api marked as small talk', () => {
    expect(isSmallTalk(view())).toBe(false);
    expect(isSmallTalk(view({ smallTalk: true }))).toBe(true);
    expect(canGiveFeedback(view({ state: 'answered', smallTalk: true }))).toBe(false);
    expect(canGiveFeedback(view({ state: 'answered', smallTalk: false }))).toBe(true);
  });

  it('sends nothing to the api for an ask marked as small talk', async () => {
    let sent = 0;
    const send = async () => {
      sent += 1;
      return { id: ID, feedback: 'good' as const, hasCorrection: false, updatedAt: 'later' };
    };
    const chat = view({ answer: 'Hello! What can I help you with?', smallTalk: true });
    expect(await giveFeedback(chat, 'good', '', { send, mint: () => 'k' })).toBe(chat);
    expect(sent).toBe(0);
  });

  it('sends once; the ask comes back rated and is not offered again', async () => {
    const sent: Array<{ id: string; body: AskFeedbackBody; key: string }> = [];
    const send = async (id: string, body: AskFeedbackBody, key: string) => {
      sent.push({ id, body, key });
      return { id, feedback: body.feedback, hasCorrection: body.correction !== undefined, updatedAt: 'later' };
    };
    const rated = await giveFeedback(view(), 'wrong', '  It was 41.  ', { send, mint: () => 'k1' });
    expect(sent).toEqual([{ id: ID, body: { feedback: 'wrong', correction: 'It was 41.' }, key: 'k1' }]);
    expect(rated).toMatchObject({ feedback: 'wrong', correction: 'It was 41.' });
    expect(canGiveFeedback(rated)).toBe(false);
    // A second press is a no-op: nothing goes to the api.
    expect(await giveFeedback(rated, 'good', '', { send, mint: () => 'k2' })).toBe(rated);
    expect(sent).toHaveLength(1);
  });

  it('sends "good" without a correction, and "wrong" with an empty box without one', async () => {
    const bodies: AskFeedbackBody[] = [];
    const send = async (id: string, body: AskFeedbackBody) => {
      bodies.push(body);
      return { id, feedback: body.feedback, hasCorrection: false, updatedAt: 'later' };
    };
    await giveFeedback(view(), 'good', 'ignored', { send, mint: () => 'k' });
    await giveFeedback(view(), 'wrong', '   ', { send, mint: () => 'k' });
    expect(bodies).toEqual([{ feedback: 'good' }, { feedback: 'wrong' }]);
  });
});

describe('My questions', () => {
  it('keeps one row per ask, newest first, the fresh copy winning', () => {
    const a = view({ id: 'a', createdAt: '2026-10-20T08:00:00.000Z' });
    const b = view({ id: 'b', createdAt: '2026-10-20T09:00:00.000Z' });
    const aRated = { ...a, feedback: 'good' as const };
    expect(mergeAsks([a], [b, aRated]).map((x) => [x.id, x.feedback])).toEqual([
      ['b', null],
      ['a', 'good'],
    ]);
  });
});

describe('links', () => {
  const console: SuiteApp = {
    key: 'console',
    name: 'Console',
    purpose: '',
    icon: (() => null) as unknown as SuiteApp['icon'],
    permission: 'app:console:access',
    origin: 'http://localhost:25743',
    milestone: '',
    arriving: '',
  };
  const link = (over: Partial<AskLink>): AskLink => ({
    key: 'console.health',
    app: 'console',
    path: '/health',
    shows: 'Platform health',
    ...over,
  });

  it('opens an app on the launcher at the target path', () => {
    expect(resolveLink(link({}), [console])).toEqual({ kind: 'app', app: console, path: '/health' });
  });

  it('notes, without a button, an app that is not on the launcher', () => {
    expect(resolveLink(link({ app: 'oto_app', path: '/core/rota', shows: 'My rota' }), [console])).toEqual({
      kind: 'not-on-launcher',
      note: 'My rota is in OTO App, which is not on your launcher.',
    });
  });

  it('notes an app on the launcher with no address on this deployment', () => {
    expect(resolveLink(link({}), [{ ...console, origin: undefined }])).toMatchObject({ kind: 'not-deployed' });
  });

  it('opens a launcher page by the router', () => {
    expect(resolveLink(link({ app: 'launcher', path: '/account' }), [])).toEqual({ kind: 'launcher', path: '/account' });
  });

  it('opens the OTO App at the validated path: its receiver honours `to=`', () => {
    const otoApp: SuiteApp = {
      ...console,
      key: 'oto_app',
      name: 'OTO App',
      permission: 'app:oto_app:access',
      origin: 'http://localhost:5000',
    };
    expect(
      resolveLink(
        link({ key: 'oto.employee.time', app: 'oto_app', path: '/employees/e-123?tab=time', shows: 'Time & leave' }),
        [otoApp],
      ),
    ).toEqual({ kind: 'app', app: otoApp, path: '/employees/e-123?tab=time' });
  });

  it('notes, without a button, a path that is not a same-app path — never a button to the app’s home', () => {
    for (const path of ['//evil.example/x', 'https://evil.example/x', '/a/../b', '']) {
      expect(resolveLink(link({ path }), [console])).toEqual({
        kind: 'unsafe-path',
        note: 'Platform health: this link cannot be opened from here.',
      });
    }
    expect(resolveLink(link({ app: 'launcher', path: '//evil.example/x' }), [])).toMatchObject({ kind: 'unsafe-path' });
  });
});
