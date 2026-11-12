// SCRUM-908 — the WhatsApp test line in the inbox. Node, no DOM: the rail's
// named inboxes and the Start over gate as the pure functions the rail and
// ChatPanel call, and the confirmation rendered with react-dom/server on its
// first paint.
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { InboxMe } from '@/api/inbox';
import { START_OVER_LABEL, StartOverConfirm } from '@/components/confirms';
import { applyView, currentView, mayStartOver, namedViews } from '@/lib/inboxes';
import { EMPTY_FILTERS } from '@/lib/query';

const LINE = '0192f0a0-1234-7abc-8def-0000000009a1';
const OTHER = '0192f0a0-1234-7abc-8def-0000000009a2';
const teams: InboxMe['teams'] = [];
const line = (startOver: boolean): NonNullable<InboxMe['testLines']>[number] => ({
  id: LINE,
  channel: 'whatsapp',
  displayName: 'WhatsApp test line',
  branchId: null,
  startOver,
});

describe('the test line is an inbox of its own', () => {
  it('comes last in the rail, as a saved Source chip, and only when the api names one', () => {
    expect(namedViews({ teams }).map((v) => v.key)).toEqual(['all', 'general']);
    const views = namedViews({ teams, testLines: [line(false)] });
    expect(views.at(-1)).toEqual({
      key: `line:${LINE}`,
      label: 'WhatsApp test line',
      kind: 'line',
      chips: { channelAccountId: LINE },
    });
  });

  it('opening it shows that number only, and the rail marks it', () => {
    const views = namedViews({ teams, testLines: [line(false)] });
    const opened = { ...EMPTY_FILTERS, ...applyView(views.at(-1)!) };
    expect(opened.channelAccountId).toBe(LINE);
    expect(opened.inbox).toBe('');
    expect(currentView(opened, views)).toEqual({ key: `line:${LINE}`, modified: false });
  });
});

describe('Start over', () => {
  it('is offered on the test line only, and only to a person who manages it', () => {
    expect(mayStartOver({ testLines: [line(true)] }, LINE)).toBe(true);
    expect(mayStartOver({ testLines: [line(false)] }, LINE)).toBe(false);
    expect(mayStartOver({ testLines: [line(true)] }, OTHER)).toBe(false);
    // An api from before the test line sends none: nothing is offered.
    expect(mayStartOver({}, LINE)).toBe(false);
  });

  it('says plainly what it does before the press, and shows the refusal as said', () => {
    expect(START_OVER_LABEL).toBe('Start over');
    const html = renderToStaticMarkup(
      createElement(StartOverConfirm, {
        open: true,
        busy: false,
        error: 'Start over clears a conversation of the WhatsApp test line only.',
        lineName: 'WhatsApp test line',
        onCancel: () => undefined,
        onConfirm: () => undefined,
      }),
    );
    expect(html).toContain('Start over with this number?');
    expect(html).toContain('WhatsApp test line');
    expect(html).toContain('the next message from it starts a new conversation, as from a new customer');
    expect(html).toContain('This cannot be undone.');
    expect(html).toContain('Yes, start over');
    expect(html).toContain('role="alert"');
    expect(renderToStaticMarkup(createElement(StartOverConfirm, { open: false, busy: false, error: null, lineName: 'x', onCancel: () => undefined, onConfirm: () => undefined }))).toBe('');
  });
});
