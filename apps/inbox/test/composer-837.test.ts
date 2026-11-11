// @vitest-environment jsdom
//
// SCRUM-837 — the reply box grows with what it holds, and the simulator's
// "Show simulator" button no longer floats over it. The pure rules (the
// box's height for its words, the key that sends), and the composer in a DOM:
// it holds several lines, Enter sends and Shift+Enter does not, the height
// follows the words to the cap and scrolls past it, and dictated words still
// land at the caret of a reply of several lines.
//
// jsdom lays nothing out, so the words' height is a stubbed `scrollHeight`.
//
// FICTIONAL TEST DATA: every reply is made-up "ZZ TEST" words.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRow, InboxMe } from '@/api/inbox';
import { Composer } from '@/components/Composer';
import { COMPOSER_LINE_PX, COMPOSER_MAX_ROWS, composerBox, sendsOnKey } from '@/lib/composer';

const CONV = '0192f0a0-1234-7abc-8def-0123456789ab';
const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const T_CENTRAL = '00000000-0000-7000-8000-0000000000r1';

const me: InboxMe = {
  accountId: '00000000-0000-7000-8000-00000000009a',
  name: 'Demo Tom',
  roles: ['owner'],
  tabs: ['team', 'handled'],
  teams: [{ id: T_CENTRAL, kind: 'reception', name: 'Reception · Central Floresta', colour: 'sky', branchId: CENTRAL, member: true }],
  people: [],
  defaultReceptionBranchId: CENTRAL,
  capabilities: { writes: true, dashboard: true, assign: true, move: true, reopen: true, templates: true, kb: true, ai: true },
  dictation: { available: true, maxSeconds: 180 },
  simulator: null,
};

const conv: ConversationRow = {
  id: CONV,
  channel: 'whatsapp',
  channelAccountId: '0192f0a0-1234-7abc-8def-0123456789ad',
  channelAccountName: 'Reception · Central Floresta',
  canReply: true,
  contact: { id: '0192f0a0-1234-7abc-8def-0123456789ac', channel: 'whatsapp', handle: '66900000001', displayName: 'ZZ TEST Liam', phone: null, language: 'en', erased: false },
  category: 'general',
  intent: 'pricing',
  language: 'en',
  branchId: null,
  teamId: T_CENTRAL,
  status: 'active',
  handledAt: null,
  handledByKind: null,
  lastMessageAt: '2026-11-11T03:00:00.000Z',
  lastMessagePreview: 'Thanks',
  unanswered: true,
  unread: 1,
  mine: false,
  assignments: [],
  createdAt: '2026-11-11T02:00:00.000Z',
};

describe('the pure rules', () => {
  it('the box is one line at least, as tall as its words to five lines, and scrolls only past that', () => {
    expect(COMPOSER_MAX_ROWS).toBe(5);
    const line = COMPOSER_LINE_PX;
    expect(composerBox(0)).toEqual({ heightPx: line, scrolls: false });
    expect(composerBox(line)).toEqual({ heightPx: line, scrolls: false });
    expect(composerBox(line * 3)).toEqual({ heightPx: line * 3, scrolls: false });
    expect(composerBox(line * 5)).toEqual({ heightPx: line * 5, scrolls: false });
    expect(composerBox(line * 5 + 1)).toEqual({ heightPx: line * 5, scrolls: true });
    expect(composerBox(line * 40)).toEqual({ heightPx: line * 5, scrolls: true });
    // A part of a pixel is rounded up, never cut; no measure is the one line.
    expect(composerBox(40.4)).toEqual({ heightPx: 41, scrolls: false });
    expect(composerBox(Number.NaN)).toEqual({ heightPx: line, scrolls: false });
  });

  it('Enter sends; Shift+Enter, another key, and an input method’s confirming Enter do not', () => {
    expect(sendsOnKey({ key: 'Enter', shiftKey: false })).toBe(true);
    expect(sendsOnKey({ key: 'Enter', shiftKey: false, composing: false })).toBe(true);
    expect(sendsOnKey({ key: 'Enter', shiftKey: true })).toBe(false);
    expect(sendsOnKey({ key: 'Enter', shiftKey: false, composing: true })).toBe(false);
    expect(sendsOnKey({ key: 'a', shiftKey: false })).toBe(false);
  });
});

/** The browser's recorder, stubbed: a stop hands over one chunk and fires `stop`. */
class FakeRecorder {
  static isTypeSupported = (type: string): boolean => type === 'audio/webm;codecs=opus';
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(_stream: unknown, options?: { mimeType?: string }) {
    this.mimeType = options?.mimeType ?? 'audio/webm';
  }
  start(): void {
    this.state = 'recording';
  }
  stop(): void {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['ZZ TEST clip bytes'], { type: this.mimeType }) });
    this.onstop?.();
  }
}

type Fetched = { url: string; method: string; body: unknown };

describe('the reply box in the composer', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  const sent = vi.fn();
  const fetched: Fetched[] = [];
  /** What the box's words need, in px: the layout jsdom does not have. */
  let wordsPx = COMPOSER_LINE_PX;
  const scrollHeight = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'scrollHeight');

  beforeEach(() => {
    fetched.length = 0;
    sent.mockReset();
    wordsPx = COMPOSER_LINE_PX;
    Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', { configurable: true, get: () => wordsPx });
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        fetched.push({ url, method: init?.method ?? 'GET', body: init?.body });
        const body = url.endsWith('/dictation') ? { text: 'ZZ TEST spoken words', language: 'en' } : { ok: true };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      }),
    );
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      value: { getUserMedia: async () => ({ getTracks: () => [{ stop: () => undefined }] }) },
      configurable: true,
    });
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    host?.remove();
    host = null;
    vi.unstubAllGlobals();
    if (scrollHeight) Object.defineProperty(HTMLTextAreaElement.prototype, 'scrollHeight', scrollHeight);
    else delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
  });

  const settle = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  const render = (row: ConversationRow = conv) =>
    act(async () => {
      root!.render(
        createElement(Composer, { conv: row, me, inserted: null, onOpenTemplates: () => undefined, onSent: sent, onReopen: () => undefined, reopening: false }),
      );
    });
  const box = () => document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Reply"]')!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
  /** Typed (or pasted) words, as React hears them; `px` is the height they need. */
  const type = (value: string, px: number = COMPOSER_LINE_PX) =>
    act(async () => {
      wordsPx = px;
      setValue.call(box(), value);
      box().dispatchEvent(new Event('input', { bubbles: true }));
    });
  /** A key pressed in the box; true when the box took it for itself (no new line is made). */
  const press = async (key: string, init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    await act(async () => {
      box().dispatchEvent(event);
    });
    await settle();
    return event.defaultPrevented;
  };
  const replies = () => fetched.filter((f) => f.url.endsWith(`/inbox/conversations/${CONV}/messages`));

  it('is a one-line box that keeps its label, its placeholder and its place in the row', async () => {
    await render();
    expect(box().tagName).toBe('TEXTAREA');
    expect(box().rows).toBe(1);
    expect(box().placeholder).toBe('Reply as Demo Tom…');
    expect(box().disabled).toBe(false);
    expect(box().className).toContain('resize-none');
    expect(box().style.lineHeight).toBe(`${COMPOSER_LINE_PX}px`);
    expect(box().style.height).toBe(`${COMPOSER_LINE_PX}px`);
    expect(box().style.overflowY).toBe('hidden');
    // Still inside the row's form, between the microphone and Send.
    const form = box().closest('form')!;
    expect(form.querySelector('[data-testid="dictation-start"]')).not.toBeNull();
    expect(form.querySelector('button[aria-label="Send"]')).not.toBeNull();
  });

  it('holds a reply of several lines, whole', async () => {
    await render();
    const reply = 'ZZ TEST line one\nZZ TEST line two\nZZ TEST line three';
    await type(reply, COMPOSER_LINE_PX * 3);
    expect(box().value).toBe(reply);
    expect(box().value.split('\n')).toHaveLength(3);
  });

  it('grows with its words to five lines, then scrolls, and is one line again once sent', async () => {
    await render();
    await type('ZZ TEST two lines of words', COMPOSER_LINE_PX * 2);
    expect(box().style.height).toBe(`${COMPOSER_LINE_PX * 2}px`);
    expect(box().style.overflowY).toBe('hidden');

    await type('ZZ TEST five lines of words', COMPOSER_LINE_PX * 5);
    expect(box().style.height).toBe(`${COMPOSER_LINE_PX * 5}px`);
    expect(box().style.overflowY).toBe('hidden');

    await type('ZZ TEST a long dictated reply of twelve lines', COMPOSER_LINE_PX * 12);
    expect(box().style.height).toBe(`${COMPOSER_LINE_PX * COMPOSER_MAX_ROWS}px`);
    expect(box().style.overflowY).toBe('auto');

    // Words taken away: the box comes back down.
    await type('ZZ TEST short', COMPOSER_LINE_PX);
    expect(box().style.height).toBe(`${COMPOSER_LINE_PX}px`);
    expect(box().style.overflowY).toBe('hidden');

    // Sent: empty, and one line.
    await type('ZZ TEST three lines', COMPOSER_LINE_PX * 3);
    expect(box().style.height).toBe(`${COMPOSER_LINE_PX * 3}px`);
    wordsPx = COMPOSER_LINE_PX;
    await press('Enter');
    expect(box().value).toBe('');
    expect(box().style.height).toBe(`${COMPOSER_LINE_PX}px`);
  });

  it('Enter sends the reply as written; Shift+Enter sends nothing and leaves the new line to the box', async () => {
    await render();
    const reply = 'ZZ TEST line one\nZZ TEST line two';
    await type(reply, COMPOSER_LINE_PX * 2);

    expect(await press('Enter', { shiftKey: true })).toBe(false);
    expect(replies()).toHaveLength(0);
    expect(sent).not.toHaveBeenCalled();
    expect(box().value).toBe(reply);

    // A letter is the box's own, too.
    expect(await press('a')).toBe(false);
    expect(replies()).toHaveLength(0);

    expect(await press('Enter')).toBe(true);
    expect(replies()).toHaveLength(1);
    expect(replies()[0]!.method).toBe('POST');
    expect(JSON.parse(String(replies()[0]!.body))).toMatchObject({ text: reply });
    expect(sent).toHaveBeenCalledTimes(1);
    expect(box().value).toBe('');
  });

  it('Enter in an empty box sends nothing and makes no line', async () => {
    await render();
    expect(await press('Enter')).toBe(true);
    expect(replies()).toHaveLength(0);
    expect(sent).not.toHaveBeenCalled();
    expect(box().value).toBe('');
    await type('   \n  ', COMPOSER_LINE_PX * 2);
    expect(await press('Enter')).toBe(true);
    expect(replies()).toHaveLength(0);
  });

  it('the Send button still sends a reply of several lines', async () => {
    await render();
    await type('ZZ TEST one\nZZ TEST two', COMPOSER_LINE_PX * 2);
    await act(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click();
    });
    await settle();
    expect(replies()).toHaveLength(1);
    expect(JSON.parse(String(replies()[0]!.body))).toMatchObject({ text: 'ZZ TEST one\nZZ TEST two' });
  });

  it('dictated words land at the caret of a reply of several lines, and the box grows for them', async () => {
    await render();
    await type('ZZ TEST first line\nZZ TEST second line', COMPOSER_LINE_PX * 2);
    // The caret at the end of the first line.
    box().focus();
    box().setSelectionRange('ZZ TEST first line'.length, 'ZZ TEST first line'.length);
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="dictation-start"]')!.click();
    });
    await settle();
    wordsPx = COMPOSER_LINE_PX * 4;
    await act(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="dictation-stop"]')!.click();
    });
    await settle();
    expect(box().value).toBe('ZZ TEST first line ZZ TEST spoken words\nZZ TEST second line');
    expect(box().selectionStart).toBe('ZZ TEST first line ZZ TEST spoken words'.length);
    expect(document.activeElement).toBe(box());
    expect(box().style.height).toBe(`${COMPOSER_LINE_PX * 4}px`);
    // Nothing is sent by the dictation.
    expect(replies()).toHaveLength(0);
    expect(sent).not.toHaveBeenCalled();
  });

  it('a handled thread and a thread that takes no reply still show no box', async () => {
    await render({ ...conv, status: 'handled' });
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.body.textContent).toContain('Handled — composer disabled');
    await render({ ...conv, canReply: false });
    expect(document.querySelector('textarea')).toBeNull();
    expect(document.body.textContent).toContain('this thread cannot take a reply');
  });
});

describe('the "Show simulator" button', () => {
  const workspace = readFileSync(path.resolve(import.meta.dirname, '../src/components/Workspace.tsx'), 'utf8');

  it('is in the header’s bar of controls, never floating over the page', () => {
    expect(workspace.match(/Show simulator/g)).toHaveLength(1);
    const header = workspace.slice(workspace.indexOf('<header'), workspace.indexOf('</header>'));
    expect(header).toContain('Show simulator');
    const at = header.indexOf('Show simulator');
    const button = header.slice(header.lastIndexOf('<button', at), at);
    expect(button).toContain('toggleSimPane(true)');
    expect(button).not.toMatch(/\bfixed\b|\babsolute\b|\bsticky\b/);
    // Nothing in the workspace floats at the page's lower right any more.
    expect(workspace).not.toMatch(/fixed bottom-\d+ right-\d+/);
  });
});
