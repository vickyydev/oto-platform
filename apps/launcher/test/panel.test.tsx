// The ask panel's markup (SCRUM-591 I3a): the capability gate (the panel, or
// nothing), the label, the answer as plain prose, refusal lines verbatim, and
// the note for a link into an app not on this launcher. Rendered to markup
// with react-dom/server; no DOM.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { AskView } from '@/api/assistant';
import { AssistantSection } from '@/components/assistant/AssistantPanel';
import { AskAnswer, type LinkOpeners } from '@/components/assistant/AskAnswer';
import type { SuiteApp } from '@/suite/apps';

const openers: LinkOpeners = { openApp: async () => {}, navigate: () => {} };
const noFeedback = async () => {};

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

function view(over: Partial<AskView> = {}): AskView {
  return {
    id: '01928f6e-0000-7000-8000-000000000001',
    state: 'answered',
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
    ...over,
  };
}

describe('the capability gate', () => {
  it('renders the labelled panel for a holder of assistant:ask:use', () => {
    const html = renderToStaticMarkup(
      <AssistantSection has={(p) => p === 'assistant:ask:use'} tiles={[]} openers={openers} />,
    );
    expect(html).toContain('OTO assistant');
    expect(html).toContain('My questions');
    expect(html).toContain('maxLength="2000"');
  });

  it('renders nothing at all without it — no disabled stub', () => {
    const html = renderToStaticMarkup(<AssistantSection has={() => false} tiles={[]} openers={openers} />);
    expect(html).toBe('');
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
});
