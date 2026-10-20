// The chat popup's markup (SCRUM-591, the chat-popup round): the capability
// gate (the floating button, or nothing), the dialog and its parts, the
// sheet classes for phone width, the thread's order, the answer as plain
// prose, refusal lines verbatim, and the note for a link into an app not on
// this launcher. Rendered to markup with react-dom/server; no DOM. The
// interaction (open, close, send, scroll) is in dock-dom.test.tsx.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Permission } from '@oto/shared/permissions';
import type { AskView } from '@/api/assistant';
import type { AskPhase } from '@/assistant/ask';
import { EMPTY_THREAD_NEUTRAL_LINE } from '@/assistant/shell';
import { AssistantDock } from '@/components/assistant/AssistantDock';
import { ASSISTANT_SUBTITLE, AssistantPopup } from '@/components/assistant/AssistantPopup';
import { AskAnswer, type LinkOpeners } from '@/components/assistant/AskAnswer';
import type { AskThreadState } from '@/components/assistant/useAskThread';
import type { SuiteApp } from '@/suite/apps';

const openers: LinkOpeners = { openApp: async () => {}, navigate: () => {} };
const noFeedback = async () => {};
const nothing = () => false;

const consoleApp: SuiteApp = {
  key: 'console',
  name: 'Console',
  purpose: '',
  icon: (() => null) as unknown as SuiteApp['icon'],
  permission: 'app:console:access',
  origin: 'http://localhost:25743',
  milestone: '',
  arriving: '',
};

function view(over: Partial<AskView> & { smallTalk?: boolean } = {}): AskView {
  const base = {
    id: '01928f6e-0000-7000-8000-000000000001',
    state: 'answered' as const,
    reason: null,
    question: 'q',
    answer: '**42** children inside.\nSee the board.',
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

/** A thread at rest, as the hook would hand it over. */
function thread(over: Partial<AskThreadState> = {}): AskThreadState {
  const phase: AskPhase = { kind: 'idle' };
  return {
    phase,
    sentAt: '',
    mine: { asks: [], cursor: null },
    mineBusy: false,
    mineError: null,
    busy: false,
    send: async () => phase,
    feedbackFor: () => noFeedback,
    loadMine: async () => {},
    ...over,
  };
}

function popup(over: Partial<AskThreadState> = {}, tiles: SuiteApp[] = [], has: (p: Permission) => boolean = nothing) {
  return renderToStaticMarkup(
    <AssistantPopup
      thread={thread(over)}
      draft=""
      onDraft={() => {}}
      onClose={() => {}}
      has={has}
      tiles={tiles}
      openers={openers}
    />,
  );
}

describe('the capability gate', () => {
  it('renders the floating button, and no popup, for a holder of assistant:ask:use', () => {
    const html = renderToStaticMarkup(
      <AssistantDock has={(p) => p === 'assistant:ask:use'} tiles={[]} openers={openers} />,
    );
    expect(html).toContain('OTO assistant');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
  });

  it('renders nothing at all without it — no disabled stub', () => {
    const html = renderToStaticMarkup(<AssistantDock has={() => false} tiles={[]} openers={openers} />);
    expect(html).toBe('');
  });
});

describe('the popup', () => {
  it('is a labelled dialog with the name, the subtitle, a close control, a log and the composer', () => {
    const html = popup();
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-label="OTO assistant"');
    expect(html).toContain(ASSISTANT_SUBTITLE);
    expect(html).toContain('aria-label="Close"');
    expect(html).toContain('role="log"');
    expect(html).toContain('maxLength="2000"');
    expect(html).toContain('0 / 2000');
  });

  it('is a full-height sheet at phone width and a card above the button otherwise', () => {
    const html = popup();
    expect(html).toContain('sheet:inset-0');
    expect(html).toContain('h-[min(70vh,640px)]');
    expect(html).toContain('w-[min(400px,calc(100vw_-_2rem))]');
  });

  it('shows one quiet line when the thread is empty, with examples only from what this person can use', () => {
    const otoApp: SuiteApp = { ...consoleApp, key: 'oto_app', name: 'OTO App', permission: 'app:oto_app:access' };
    // Someone with the Inbox alone is offered the queue, not members or payslips.
    const inboxOnly = (p: Permission) => p === 'inbox:conversation:read' || p === 'app:inbox:access';
    const hana = popup({}, [], inboxOnly);
    expect(hana).toContain('Ask about the unanswered queue…');
    expect(hana).not.toContain('members');
    expect(hana).not.toContain('the rota');
    // A manager with everything: four, in order; the rota and payslips do not fit.
    expect(popup({}, [consoleApp, otoApp], () => true)).toContain(
      'Ask about members, today&#x27;s check-ins, the unanswered queue, recent activity…',
    );
    // The OTO App's examples come from its tile.
    expect(popup({}, [otoApp], nothing)).toContain('Ask about the rota, your payslips…');
    // Nobody: the neutral line, never an example.
    const nobody = popup({}, [], nothing);
    expect(nobody).toContain(EMPTY_THREAD_NEUTRAL_LINE);
    expect(nobody).not.toContain('Ask about');
  });

  it('lays the thread out oldest at the top and newest at the bottom, the question in flight last', () => {
    const older = view({ id: '01928f6e-0000-7000-8000-00000000000a', question: 'Older question', createdAt: '2026-10-20T08:00:00.000Z' });
    const newer = view({ id: '01928f6e-0000-7000-8000-00000000000b', question: 'Newer question', createdAt: '2026-10-20T09:00:00.000Z' });
    const html = popup({
      mine: { asks: [newer, older], cursor: 'more' },
      phase: { kind: 'sending', id: 'x', question: 'In flight' },
      sentAt: '2026-10-20T10:00:00.000Z',
      busy: true,
    });
    const at = (s: string) => html.indexOf(s);
    expect(at('Show older')).toBeLessThan(at('Older question'));
    expect(at('Older question')).toBeLessThan(at('Newer question'));
    expect(at('Newer question')).toBeLessThan(at('In flight'));
    expect(at('In flight')).toBeLessThan(at('Answering…'));
    expect(html).not.toContain('check-ins…');
  });

  it('keeps a question that could not be sent in its bubble with the fixed failure line', () => {
    const html = popup({
      phase: { kind: 'unreachable', id: 'x', question: 'Who is in?', line: "I couldn't answer just now." },
    });
    expect(html).toContain('Who is in?');
    expect(html).toContain('I couldn&#x27;t answer just now.');
  });
});

describe('an answer', () => {
  it('is plain prose: markdown is shown as typed, not rendered', () => {
    const html = renderToStaticMarkup(
      <AskAnswer ask={view()} tiles={[]} openers={openers} onFeedback={noFeedback} />,
    );
    expect(html).toContain('**42** children inside.');
    expect(html).not.toContain('<strong>');
    expect(html).toContain('whitespace-pre-wrap');
  });

  it('shows each refusal line exactly as given', () => {
    const line = 'Platform: You hold pos:checkin:read, but not at Robinson Chalong';
    const html = renderToStaticMarkup(
      <AskAnswer
        ask={view({
          state: 'refused',
          refusals: [
            { tool: 'occupancy.now', system: 'platform', status: 403, code: 'FORBIDDEN', message: 'x', line },
          ],
        })}
        tiles={[]}
        openers={openers}
        onFeedback={noFeedback}
      />,
    );
    expect(html).toContain(line);
  });

  it('offers "Take me there" for an app on the launcher, and a plain note for one that is not', () => {
    const html = renderToStaticMarkup(
      <AskAnswer
        ask={view({
          links: [
            { key: 'console.health', app: 'console', path: '/health', shows: 'Platform health' },
            { key: 'oto.rota', app: 'oto_app', path: '/core/rota', shows: 'My rota' },
          ],
        })}
        tiles={[consoleApp]}
        openers={openers}
        onFeedback={noFeedback}
      />,
    );
    expect(html.match(/Take me there/g)).toHaveLength(1);
    expect(html).toContain('My rota is in OTO App, which is not on your launcher.');
  });

  it('offers feedback until it is given, then says what was given', () => {
    const open = renderToStaticMarkup(<AskAnswer ask={view()} tiles={[]} openers={openers} onFeedback={noFeedback} />);
    expect(open).toContain('Was this right?');
    const given = renderToStaticMarkup(
      <AskAnswer
        ask={view({ feedback: 'wrong', correction: 'It was 41.' })}
        tiles={[]}
        openers={openers}
        onFeedback={noFeedback}
      />,
    );
    expect(given).not.toContain('Was this right?');
    expect(given).toContain('You marked this wrong.');
    expect(given).toContain('It was 41.');
  });

  it('shows the in-flight line, and nothing to rate, for an ask still asking', () => {
    const html = renderToStaticMarkup(
      <AskAnswer
        ask={view({ state: 'asking', answer: null, question: 'Who is in today?' })}
        showQuestion
        tiles={[]}
        openers={openers}
        onFeedback={noFeedback}
      />,
    );
    expect(html).toContain('Who is in today?');
    expect(html).toContain('Still answering…');
    expect(html).not.toContain('Was this right?');
  });

  it('offers no "Take me there" for a link whose path is not a same-app path', () => {
    const html = renderToStaticMarkup(
      <AskAnswer
        ask={view({ links: [{ key: 'console.health', app: 'console', path: '//evil.example/x', shows: 'Platform health' }] })}
        tiles={[consoleApp]}
        openers={openers}
        onFeedback={noFeedback}
      />,
    );
    expect(html).not.toContain('Take me there');
    expect(html).toContain('Platform health: this link cannot be opened from here.');
  });

  it('offers no feedback on a switched-off ask', () => {
    const html = renderToStaticMarkup(
      <AskAnswer
        ask={view({ state: 'off', answer: 'The assistant is switched off right now.' })}
        tiles={[]}
        openers={openers}
        onFeedback={noFeedback}
      />,
    );
    expect(html).toContain('The assistant is switched off right now.');
    expect(html).not.toContain('Was this right?');
  });

  it('shows no feedback row at all on chit-chat the api marked as small talk (the test-night round, S10)', () => {
    const html = renderToStaticMarkup(
      <AskAnswer
        ask={view({ question: 'hello', answer: 'Hello! What can I help you with?', smallTalk: true })}
        tiles={[]}
        openers={openers}
        onFeedback={noFeedback}
      />,
    );
    expect(html).toContain('Hello! What can I help you with?');
    expect(html).not.toContain('Was this right?');
    expect(html).not.toContain('lucide-thumbs-up');
    expect(html).not.toContain('lucide-thumbs-down');
    // An ordinary answer is unchanged.
    const ordinary = renderToStaticMarkup(
      <AskAnswer ask={view({ smallTalk: false })} tiles={[]} openers={openers} onFeedback={noFeedback} />,
    );
    expect(ordinary).toContain('Was this right?');
    expect(ordinary).toContain('lucide-thumbs-up');
  });

  it('renders the clarification line a follow-up gets as a normal answer bubble, feedback hidden (the test-night round, D2)', () => {
    const line = 'I answer each question on its own — which figure do you mean?';
    const html = renderToStaticMarkup(
      <AskAnswer
        ask={view({ question: 'and last week?', answer: line, smallTalk: true })}
        tiles={[]}
        openers={openers}
        onFeedback={noFeedback}
      />,
    );
    expect(html).toContain(line);
    // The plain-prose style, not the quiet one a failure or a cap gets.
    expect(html).toContain('text-base whitespace-pre-wrap');
    expect(html).not.toContain('text-foreground/70');
    expect(html).not.toContain('lucide-triangle-alert');
    expect(html).not.toContain('Was this right?');
  });
});
