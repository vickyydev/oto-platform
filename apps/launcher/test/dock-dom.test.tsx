// @vitest-environment jsdom
//
// The chat popup's behaviour (SCRUM-591, the chat-popup round), in a DOM:
// the floating button opens it and takes focus back when it closes; Esc and
// the close control close it, a click outside does not; the thread is oldest
// first and scrolled to the bottom on open and on each new item; a sent
// question is appended at once and its answer fills in; "Show older" keeps
// the scroll position; the typed draft survives closing. A fake api, React's
// own act.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { INTERNAL_LINES } from '@oto/assistant/internal-lines';
import type { AskList, AskView } from '@/api/assistant';
import { AssistantDock } from '@/components/assistant/AssistantDock';
import type { LinkOpeners } from '@/components/assistant/AskAnswer';
import type { ThreadApi } from '@/components/assistant/useAskThread';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const openers: LinkOpeners = { openApp: async () => {}, navigate: () => {} };

function view(over: Partial<AskView> = {}): AskView {
  return {
    id: '01928f6e-0000-7000-8000-000000000001',
    state: 'answered',
    reason: null,
    question: 'q',
    answer: 'a',
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

const OLDER = view({ id: '01928f6e-0000-7000-8000-00000000000a', question: 'Older question', answer: 'Older answer', createdAt: '2026-10-20T08:00:00.000Z' });
const NEWER = view({ id: '01928f6e-0000-7000-8000-00000000000b', question: 'Newer question', answer: 'Newer answer', createdAt: '2026-10-20T09:00:00.000Z' });
const OLDEST = view({ id: '01928f6e-0000-7000-8000-000000000009', question: 'Oldest question', answer: 'Oldest answer', createdAt: '2026-10-20T07:00:00.000Z' });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A fake api: every ask waits on a deferred the test settles; the list is two pages. */
function fakeClient(pages: Record<string, AskList> = { '': { asks: [NEWER, OLDER], nextCursor: null } }) {
  const asks: Array<{ id: string; question: string; done: ReturnType<typeof deferred<{ view: AskView; replayed: boolean }>> }> = [];
  const client: ThreadApi = {
    ask: vi.fn(async (id: string, question: string) => {
      const done = deferred<{ view: AskView; replayed: boolean }>();
      asks.push({ id, question, done });
      return done.promise;
    }),
    one: vi.fn(async () => {
      throw new Error('not followed in this suite');
    }),
    mine: vi.fn(async (cursor: string | null) => pages[cursor ?? ''] ?? { asks: [], nextCursor: null }),
    feedback: vi.fn(async () => {
      throw new Error('not given in this suite');
    }),
  };
  return { client, asks };
}

// jsdom lays nothing out: a scroll height that grows with the thread, and a
// scroll top that remembers what it was set to, stand in for the browser's.
const tops = new WeakMap<Element, number>();
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return 1000 + this.querySelectorAll('article').length * 100;
    },
  });
  Object.defineProperty(HTMLElement.prototype, 'scrollTop', {
    configurable: true,
    get(this: HTMLElement) {
      return tops.get(this) ?? 0;
    },
    set(this: HTMLElement, value: number) {
      tops.set(this, value);
    },
  });
});

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.documentElement.classList.remove('assistant-docked');
});

async function mount(client: ThreadApi, has: (p: string) => boolean = (p) => p === 'assistant:ask:use') {
  await act(async () => {
    root.render(<AssistantDock has={has as never} tiles={[]} openers={openers} client={client} />);
  });
}

const button = () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');
const log = () => dialog()?.querySelector<HTMLElement>('[role="log"]') ?? null;
const textarea = () => dialog()?.querySelector<HTMLTextAreaElement>('textarea') ?? null;
const articles = () => [...(dialog()?.querySelectorAll('article') ?? [])].map((a) => a.textContent ?? '');

const click = (el: Element) => act(async () => void el.dispatchEvent(new MouseEvent('click', { bubbles: true })));
const press = (el: Element, key: string, init: KeyboardEventInit = {}) =>
  act(async () => void el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })));
const type = (el: HTMLTextAreaElement, text: string) =>
  act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(el, text);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  });

describe('the floating button', () => {
  it('is there only with assistant:ask:use, and marks the document while it is', async () => {
    await mount(fakeClient().client, () => false);
    expect(button()).toBeNull();
    expect(document.documentElement.classList.contains('assistant-docked')).toBe(false);
    await mount(fakeClient().client);
    expect(button()).not.toBeNull();
    expect(dialog()).toBeNull();
    expect(document.documentElement.classList.contains('assistant-docked')).toBe(true);
  });
});

describe('opening and closing', () => {
  it('opens on the button with focus in the composer, and Esc closes it with focus back on the button', async () => {
    await mount(fakeClient().client);
    await click(button()!);
    expect(dialog()).not.toBeNull();
    expect(button()!.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(textarea());
    await press(textarea()!, 'Escape');
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it('closes on the close control', async () => {
    await mount(fakeClient().client);
    await click(button()!);
    await click(dialog()!.querySelector('button[aria-label="Close"]')!);
    expect(dialog()).toBeNull();
    expect(document.activeElement).toBe(button());
  });

  it('does not close on a click outside', async () => {
    await mount(fakeClient().client);
    await click(button()!);
    await click(document.body);
    await click(container);
    expect(dialog()).not.toBeNull();
  });

  it('keeps the typed draft across closing and opening again', async () => {
    await mount(fakeClient().client);
    await click(button()!);
    await type(textarea()!, 'How many are in?');
    await press(textarea()!, 'Escape');
    expect(dialog()).toBeNull();
    await click(button()!);
    expect(textarea()!.value).toBe('How many are in?');
  });
});

describe('the thread', () => {
  it('loads the history on first open, oldest at the top, and scrolls to the bottom', async () => {
    const { client } = fakeClient();
    await mount(client);
    await click(button()!);
    expect(client.mine).toHaveBeenCalledWith(null);
    const texts = articles();
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain('Older question');
    expect(texts[0]).toContain('Older answer');
    expect(texts[1]).toContain('Newer question');
    expect(log()!.scrollTop).toBe(log()!.scrollHeight);
  });

  it('appends the question at once on Enter, clears the composer, then fills the answer in and stays at the bottom', async () => {
    const { client, asks } = fakeClient();
    await mount(client);
    await click(button()!);
    await type(textarea()!, 'Who is in today?');
    await press(textarea()!, 'Enter');
    expect(asks).toHaveLength(1);
    expect(asks[0]!.question).toBe('Who is in today?');
    expect(textarea()!.value).toBe('');
    let texts = articles();
    expect(texts).toHaveLength(3);
    expect(texts[2]).toContain('Who is in today?');
    expect(texts[2]).toContain('Answering…');
    expect(log()!.scrollTop).toBe(log()!.scrollHeight);

    await act(async () => {
      asks[0]!.done.resolve({
        view: view({ id: asks[0]!.id, question: 'Who is in today?', answer: '42 children.', createdAt: '2026-10-20T10:00:00.000Z' }),
        replayed: false,
      });
    });
    texts = articles();
    expect(texts).toHaveLength(3);
    expect(texts[2]).toContain('42 children.');
    expect(texts[2]).not.toContain('Answering…');
    expect(log()!.scrollTop).toBe(log()!.scrollHeight);
  });

  it('puts a newline on Shift+Enter and sends nothing', async () => {
    const { client, asks } = fakeClient();
    await mount(client);
    await click(button()!);
    await type(textarea()!, 'Two');
    await press(textarea()!, 'Enter', { shiftKey: true });
    expect(asks).toHaveLength(0);
    expect(articles()).toHaveLength(2);
  });

  it('keeps the question in its bubble with the fixed failure line when the api cannot be reached, and hands the words back', async () => {
    const { client, asks } = fakeClient();
    await mount(client);
    await click(button()!);
    await type(textarea()!, 'Who is in today?');
    await press(textarea()!, 'Enter');
    await act(async () => asks[0]!.done.reject(new TypeError('Failed to fetch')));
    const texts = articles();
    expect(texts).toHaveLength(3);
    expect(texts[2]).toContain('Who is in today?');
    expect(texts[2]).toContain(INTERNAL_LINES.failed.en);
    expect(textarea()!.value).toBe('Who is in today?');
  });

  it('loads the older page above on "Show older" and keeps what was on screen where it was', async () => {
    const { client } = fakeClient({
      '': { asks: [NEWER, OLDER], nextCursor: 'c1' },
      c1: { asks: [OLDEST], nextCursor: null },
    });
    await mount(client);
    await click(button()!);
    expect(articles()).toHaveLength(2);
    const before = log()!.scrollHeight;
    log()!.scrollTop = 500;
    const older = [...dialog()!.querySelectorAll('button')].find((b) => b.textContent?.includes('Show older'))!;
    await click(older);
    expect(client.mine).toHaveBeenLastCalledWith('c1');
    const texts = articles();
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('Oldest question');
    expect(log()!.scrollTop).toBe(500 + (log()!.scrollHeight - before));
    expect(dialog()!.textContent).not.toContain('Show older');
  });
});
