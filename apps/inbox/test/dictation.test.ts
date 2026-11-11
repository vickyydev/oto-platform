// @vitest-environment jsdom
//
// SCRUM-834 — a reply dictated into the composer, the shell side: the pure
// rules (where the words land, the formats, the clock, the ceiling, the error
// words), and the composer in a DOM with a stubbed MediaRecorder, microphone
// and fetch: the microphone button's states, the red dot and clock with the
// privacy line while recording, "Transcribing…", the words landing in the
// input with nothing sent, the api's refusal in the composer's own words, and
// the button absent where the browser cannot record.
//
// FICTIONAL TEST DATA: every clip is a few bytes, every transcript is made-up
// "ZZ TEST" words.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConversationRow, InboxMe } from '@/api/inbox';
import { Composer } from '@/components/Composer';
import {
  DICTATION_MAX_SECONDS,
  DICTATION_MIME_TYPES,
  DICTATION_PRIVACY_LINE,
  DICTATION_TOOLTIP,
  clockOf,
  dictationErrorLine,
  dictationSupported,
  insertAtCaret,
  microphoneErrorLine,
  reachedCeiling,
  recorderMimeType,
} from '@/lib/dictation';

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
  it('places the words at the caret, with a space where they would touch what is there, and the caret after them', () => {
    expect(insertAtCaret('', null, null, ' ZZ TEST hello ')).toEqual({ text: 'ZZ TEST hello', caret: 13 });
    expect(insertAtCaret('Hello', 5, 5, 'there')).toEqual({ text: 'Hello there', caret: 11 });
    expect(insertAtCaret('Hello world', 5, 5, 'big')).toEqual({ text: 'Hello big world', caret: 9 });
    expect(insertAtCaret('Hello  world', 6, 6, 'big')).toEqual({ text: 'Hello big world', caret: 9 });
    // A selection is replaced.
    expect(insertAtCaret('Hello world', 6, 11, 'Phuket')).toEqual({ text: 'Hello Phuket', caret: 12 });
    // No caret: appended at the end; a caret past the end is the end.
    expect(insertAtCaret('Hi', null, null, 'there')).toEqual({ text: 'Hi there', caret: 8 });
    expect(insertAtCaret('Hi', 40, 40, 'there')).toEqual({ text: 'Hi there', caret: 8 });
    // Nothing spoken changes nothing.
    expect(insertAtCaret('Hi', 1, 1, '   ')).toEqual({ text: 'Hi', caret: 1 });
  });

  it('records in the first format the browser offers, Opus in WebM first', () => {
    expect(DICTATION_MIME_TYPES[0]).toBe('audio/webm;codecs=opus');
    expect(recorderMimeType((t) => t === 'audio/webm;codecs=opus' || t === 'audio/webm')).toBe('audio/webm;codecs=opus');
    expect(recorderMimeType((t) => t === 'audio/mp4')).toBe('audio/mp4');
    expect(recorderMimeType(() => false)).toBeNull();
    expect(recorderMimeType(undefined)).toBeNull();
    expect(
      recorderMimeType(() => {
        throw new Error('no');
      }),
    ).toBeNull();
  });

  it('the clock, the ceiling (the api’s default), and the browser door', () => {
    expect(clockOf(0)).toBe('0:00');
    expect(clockOf(7.9)).toBe('0:07');
    expect(clockOf(165)).toBe('2:45');
    expect(DICTATION_MAX_SECONDS).toBe(180);
    expect(reachedCeiling(179)).toBe(false);
    expect(reachedCeiling(180)).toBe(true);
    expect(dictationSupported({})).toBe(false);
    expect(dictationSupported({ MediaRecorder: class {} })).toBe(false);
    expect(dictationSupported({ MediaRecorder: class {}, navigator: { mediaDevices: { getUserMedia: () => undefined } } })).toBe(true);
  });

  it('says each refusal in the composer’s own words, and the privacy line names the provider', () => {
    expect(dictationErrorLine({ code: 'DICTATION_NOT_AVAILABLE', message: 'x' })).toBe('Dictation is not available on this deployment.');
    expect(dictationErrorLine({ code: 'DICTATION_TOO_LONG', message: 'x', details: { maxSeconds: 180 } })).toBe(
      'The recording was too long (at most 3:00). Speak the reply in parts.',
    );
    expect(dictationErrorLine({ code: 'DICTATION_TOO_LONG', message: 'x' })).toBe('The recording was too long. Speak the reply in parts.');
    expect(dictationErrorLine({ code: 'DICTATION_UNSUPPORTED_FORMAT', message: 'x' })).toMatch(/format/);
    expect(dictationErrorLine({ code: 'DICTATION_NOTHING_HEARD', message: 'x' })).toBe('Nothing was heard. Try again, closer to the microphone.');
    expect(dictationErrorLine({ code: 'DICTATION_FAILED', message: 'x' })).toBe('The transcription did not come back. Try again.');
    expect(dictationErrorLine({ code: 'FORBIDDEN', message: 'x' })).toBe('You cannot reply in this conversation.');
    expect(dictationErrorLine({ code: 'CONVERSATION_HANDLED', message: 'This conversation is handled.' })).toBe('This conversation is handled.');
    expect(dictationErrorLine(new TypeError('network'))).toBe('network');
    expect(dictationErrorLine(null)).toBe('The dictation could not be sent.');
    expect(microphoneErrorLine({ name: 'NotAllowedError' })).toMatch(/blocked/);
    expect(microphoneErrorLine({ name: 'NotFoundError' })).toBe('No microphone was found.');
    expect(microphoneErrorLine(new Error('odd'))).toBe('The recording could not be started.');
    expect(DICTATION_PRIVACY_LINE).toMatch(/transcription provider/);
    expect(DICTATION_PRIVACY_LINE).toMatch(/not kept/);
    expect(DICTATION_TOOLTIP).toContain(DICTATION_PRIVACY_LINE);
  });
});

// --- The composer in a DOM --------------------------------------------------------------------

/** The browser's recorder, stubbed: a stop hands over one chunk and fires `stop`. */
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static isTypeSupported = (type: string): boolean => type === 'audio/webm;codecs=opus';
  state: 'inactive' | 'recording' = 'inactive';
  mimeType: string;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  constructor(
    public stream: unknown,
    options?: { mimeType?: string },
  ) {
    this.mimeType = options?.mimeType ?? 'audio/webm';
    FakeRecorder.instances.push(this);
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

const stoppedTracks: number[] = [];
const getUserMedia = vi.fn(async () => ({
  getTracks: () => [
    {
      stop: () => {
        stoppedTracks.push(1);
      },
    },
  ],
}));

type Fetched = { url: string; method: string; body: unknown; contentType: string | undefined };
const fetched: Fetched[] = [];
let answer: () => Promise<Response> = async () => new Response(JSON.stringify({ text: 'ZZ TEST hello from the mic', language: 'en' }), { status: 200, headers: { 'content-type': 'application/json' } });
const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  fetched.push({ url: String(input), method: init?.method ?? 'GET', body: init?.body, contentType: headers['content-type'] });
  return answer();
});

describe('the composer’s microphone', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | null = null;
  let host: HTMLElement | null = null;
  const sent = vi.fn();

  beforeEach(() => {
    FakeRecorder.instances = [];
    fetched.length = 0;
    stoppedTracks.length = 0;
    sent.mockReset();
    getUserMedia.mockClear();
    vi.stubGlobal('MediaRecorder', FakeRecorder);
    vi.stubGlobal('fetch', fetchStub);
    Object.defineProperty(globalThis.navigator, 'mediaDevices', { value: { getUserMedia }, configurable: true });
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
  });

  const settle = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  const render = () =>
    act(async () => {
      root!.render(
        createElement(Composer, {
          conv,
          me,
          inserted: null,
          onOpenTemplates: () => undefined,
          onSent: sent,
          onReopen: () => undefined,
          reopening: false,
        }),
      );
    });
  const button = (testId: string) => document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  const click = (testId: string) =>
    act(async () => {
      button(testId)!.click();
    });
  const input = () => document.querySelector<HTMLInputElement>('input[aria-label="Reply"]')!;
  const line = () => document.querySelector<HTMLElement>('[data-testid="dictation-line"]');

  it('records on press, shows the red dot, the clock and the privacy line, and lands the words at the caret — sending nothing', async () => {
    await render();
    const mic = button('dictation-start')!;
    expect(mic.getAttribute('aria-label')).toBe('Dictate a reply');
    expect(mic.getAttribute('title')).toContain('transcription provider');
    expect(line()).toBeNull();

    await click('dictation-start');
    await settle();
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(FakeRecorder.instances).toHaveLength(1);
    expect(FakeRecorder.instances[0]!.state).toBe('recording');
    expect(FakeRecorder.instances[0]!.mimeType).toBe('audio/webm;codecs=opus');
    expect(button('dictation-start')).toBeNull();
    expect(button('dictation-stop')!.getAttribute('aria-label')).toBe('Stop dictating');
    const recording = line()!;
    expect(recording.getAttribute('role')).toBe('status');
    expect(recording.querySelector('.bg-rose-500.animate-pulse')).not.toBeNull();
    expect(recording.textContent).toContain('Recording · 0:00 / 3:00');
    expect(recording.textContent).toContain(DICTATION_PRIVACY_LINE);
    expect(fetched).toHaveLength(0);

    // The answer is held back so the wait can be seen.
    let release!: () => void;
    answer = () =>
      new Promise<Response>((resolve) => {
        release = () => resolve(new Response(JSON.stringify({ text: ' ZZ TEST hello from the mic ', language: 'en' }), { status: 200, headers: { 'content-type': 'application/json' } }));
      });
    await click('dictation-stop');
    await settle();
    expect(FakeRecorder.instances[0]!.state).toBe('inactive');
    expect(stoppedTracks).toHaveLength(1);
    expect(line()!.textContent).toContain('Transcribing…');
    expect(button('dictation-start')!.disabled).toBe(true);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toMatchObject({ url: `/api/inbox/conversations/${CONV}/dictation`, method: 'POST', contentType: 'audio/webm;codecs=opus' });
    expect(fetched[0]!.body).toBeInstanceOf(Blob);
    expect((fetched[0]!.body as Blob).type).toBe('audio/webm;codecs=opus');

    await act(async () => release());
    await settle();
    expect(input().value).toBe('ZZ TEST hello from the mic');
    expect(line()).toBeNull();
    expect(button('dictation-start')!.disabled).toBe(false);
    expect(document.activeElement).toBe(input());
    expect(input().selectionStart).toBe('ZZ TEST hello from the mic'.length);

    // A second dictation lands after the first, spaced; nothing was ever sent.
    answer = async () => new Response(JSON.stringify({ text: 'ZZ TEST and more', language: 'en' }), { status: 200, headers: { 'content-type': 'application/json' } });
    await click('dictation-start');
    await settle();
    await click('dictation-stop');
    await settle();
    expect(input().value).toBe('ZZ TEST hello from the mic ZZ TEST and more');
    expect(fetched.every((f) => f.url.endsWith('/dictation'))).toBe(true);
    expect(sent).not.toHaveBeenCalled();
    // The Send button is live with the words in place, and still the person's to press.
    expect(document.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.disabled).toBe(false);
  });

  it('says the api’s refusal in its own words, leaves the input as it was, and can be dismissed', async () => {
    await render();
    answer = async () =>
      new Response(JSON.stringify({ error: { code: 'DICTATION_NOT_AVAILABLE', message: 'Dictation is not available on this deployment: no transcription provider is configured.' } }), {
        status: 409,
        headers: { 'content-type': 'application/json' },
      });
    await click('dictation-start');
    await settle();
    await click('dictation-stop');
    await settle();
    expect(input().value).toBe('');
    const refused = line()!;
    expect(refused.getAttribute('role')).toBe('alert');
    expect(refused.textContent).toContain('Dictation is not available on this deployment.');
    expect(button('dictation-start')!.disabled).toBe(false);
    await act(async () => {
      refused.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]')!.click();
    });
    expect(line()).toBeNull();
    expect(sent).not.toHaveBeenCalled();
  });

  it('a blocked microphone is said, with nothing recorded and nothing fetched', async () => {
    await render();
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await click('dictation-start');
    await settle();
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(fetched).toHaveLength(0);
    expect(line()!.textContent).toContain('The microphone is blocked for this site.');
    expect(button('dictation-start')!.disabled).toBe(false);
  });

  it('stops itself at the ceiling', async () => {
    vi.useFakeTimers();
    try {
      await render();
      await click('dictation-start');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(FakeRecorder.instances[0]!.state).toBe('recording');
      await act(async () => {
        await vi.advanceTimersByTimeAsync((DICTATION_MAX_SECONDS - 1) * 1000);
      });
      expect(FakeRecorder.instances[0]!.state).toBe('recording');
      expect(line()!.textContent).toContain(`Recording · ${clockOf(DICTATION_MAX_SECONDS - 1)}`);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(FakeRecorder.instances[0]!.state).toBe('inactive');
      expect(fetched).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('without a MediaRecorder the microphone is not shown; the rest of the composer is', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    await render();
    expect(button('dictation-start')).toBeNull();
    expect(button('dictation-stop')).toBeNull();
    expect(line()).toBeNull();
    expect(document.querySelector('button[aria-label="Templates"]')).not.toBeNull();
    expect(document.querySelector('button[aria-label="Send"]')).not.toBeNull();
    expect(input()).not.toBeNull();
  });
});
