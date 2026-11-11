// @vitest-environment jsdom
//
// SCRUM-835 — a customer's voice note recorded in the simulator: beside the
// file picker, a Record button through the composer's shared recorder
// (`useRecorder`, SCRUM-834). In a DOM with a stubbed MediaRecorder,
// microphone and fetch: the button absent where the browser cannot record;
// Record asks the microphone and shows Stop with the clock; Stop makes the
// clip the voice note ("Recorded clip · 0:12", a discard) and Send carries it
// to the existing simulator route under the recorder's own type; the ceiling
// stops the clip at a minute; a clip over 1 MB and a blocked microphone are
// said; the discard clears it; and the file picker works as before.
//
// FICTIONAL TEST DATA: every clip is a few bytes; every name is "ZZ TEST".
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxMe } from '@/api/inbox';
import { SIMULATOR_VOICE_MAX_BYTES, SIMULATOR_VOICE_MAX_SECONDS, SimulatorBody } from '@/components/Simulator';

const ACCOUNT = '0192f0a0-1234-7abc-8def-0123456789ad';
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
  // A deployment running the simulator, with one channel account laid by the demo.
  simulator: { channelAccounts: [{ id: ACCOUNT, channel: 'whatsapp', displayName: 'ZZ TEST Reception', branchId: CENTRAL }] },
};

/** The browser's recorder, stubbed as the dictation tests stub it: a stop hands over one chunk and fires `stop`. */
class FakeRecorder {
  static instances: FakeRecorder[] = [];
  static chunk: BlobPart = 'ZZ TEST clip bytes';
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
    this.ondataavailable?.({ data: new Blob([FakeRecorder.chunk], { type: this.mimeType }) });
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

/** What the simulator route answers a played message with. */
const received = {
  outcome: 'processed',
  receiptId: null,
  messages: 1,
  duplicates: 0,
  statuses: 0,
  conversationsCreated: 1,
  reopened: 0,
  outOfHours: [],
  conversationIds: [],
  externalMessageId: 'ZZ-TEST-1',
};
type Fetched = { url: string; method: string; body: unknown };
const fetched: Fetched[] = [];
const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
  fetched.push({ url: String(input), method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body });
  return new Response(JSON.stringify(received), { status: 200, headers: { 'content-type': 'application/json' } });
});

describe('the simulator’s microphone', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  let root: Root | null = null;
  let host: HTMLElement | null = null;

  beforeEach(() => {
    FakeRecorder.instances = [];
    FakeRecorder.chunk = 'ZZ TEST clip bytes';
    fetched.length = 0;
    stoppedTracks.length = 0;
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

  const render = () =>
    act(async () => {
      root!.render(createElement(SimulatorBody, { me, onChanged: async () => undefined, onReloadMe: async () => undefined }));
    });
  /** Lets the microphone's promise, the recorder and the FileReader (two immediates) land under fake timers. */
  const flush = () =>
    act(async () => {
      await vi.runAllTimersAsync();
    });
  /** The same under real timers, where nothing is recorded: a turn of the loop. */
  const settle = () =>
    act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  const byId = <T extends HTMLElement>(testId: string) => document.querySelector<T>(`[data-testid="${testId}"]`);
  const click = (testId: string) =>
    act(async () => {
      byId<HTMLButtonElement>(testId)!.click();
    });
  const fileInput = () => byId<HTMLInputElement>('simulator-voice')!;
  const voiceLabel = () => fileInput().closest('label')!;
  const sendButton = () => document.querySelector<HTMLButtonElement>('button[type="submit"]')!;
  const clip = () => byId<HTMLElement>('simulator-voice-name');
  const clock = () => byId<HTMLElement>('simulator-record-clock');
  const errorLine = () => byId<HTMLElement>('simulator-voice-error');

  it('without a MediaRecorder there is no Record button; the file picker is there and the label names a file only', async () => {
    vi.stubGlobal('MediaRecorder', undefined);
    await render();
    expect(byId('simulator-record')).toBeNull();
    expect(byId('simulator-record-stop')).toBeNull();
    expect(fileInput()).not.toBeNull();
    expect(fileInput().disabled).toBe(false);
    expect(voiceLabel().textContent).toContain('Voice note (optional): an audio file, played as a WhatsApp voice message');
    expect(voiceLabel().textContent).not.toContain('recording');
    expect(sendButton().textContent).toContain('Send as the customer');
  });

  it('Record asks the microphone and shows Stop with the clock; Stop makes the clip the voice note, and Send plays it under the recorder’s type', async () => {
    vi.useFakeTimers();
    try {
      await render();
      const record = byId<HTMLButtonElement>('simulator-record')!;
      expect(record.textContent).toContain('Record');
      expect(record.disabled).toBe(false);
      expect(voiceLabel().textContent).toContain('an audio file or a recording');
      expect(clock()).toBeNull();
      expect(sendButton().disabled).toBe(true);

      await click('simulator-record');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
      expect(FakeRecorder.instances).toHaveLength(1);
      expect(FakeRecorder.instances[0]!.state).toBe('recording');
      expect(FakeRecorder.instances[0]!.mimeType).toBe('audio/webm;codecs=opus');
      expect(byId('simulator-record')).toBeNull();
      expect(byId<HTMLButtonElement>('simulator-record-stop')!.textContent).toContain('Stop');
      const recording = clock()!;
      expect(recording.getAttribute('role')).toBe('status');
      expect(recording.querySelector('.bg-rose-500.animate-pulse')).not.toBeNull();
      expect(recording.textContent).toContain('Recording · 0:00 / 1:00');
      // Neither the file picker nor Send while the clip is being spoken.
      expect(fileInput().disabled).toBe(true);
      expect(sendButton().disabled).toBe(true);
      expect(fetched).toHaveLength(0);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(12_000);
      });
      expect(clock()!.textContent).toContain('Recording · 0:12 / 1:00');

      await click('simulator-record-stop');
      await flush();
      expect(FakeRecorder.instances[0]!.state).toBe('inactive');
      expect(stoppedTracks).toHaveLength(1);
      expect(clock()).toBeNull();
      expect(byId<HTMLButtonElement>('simulator-record')!.disabled).toBe(false);
      expect(fileInput().disabled).toBe(false);
      expect(clip()!.textContent).toContain('Recorded clip · 0:12');
      expect(clip()!.querySelector('button[aria-label="Discard the voice note"]')).not.toBeNull();
      expect(errorLine()).toBeNull();
      expect(sendButton().disabled).toBe(false);

      await act(async () => {
        sendButton().click();
      });
      await flush();
      expect(fetched).toHaveLength(1);
      expect(fetched[0]).toMatchObject({ url: '/api/inbox/simulator/inbound', method: 'POST' });
      const body = fetched[0]!.body as { channelAccountId: string; text?: string; voice: { contentType: string; dataBase64: string } };
      expect(body.channelAccountId).toBe(ACCOUNT);
      expect(body.text).toBeUndefined();
      expect(body.voice).toEqual({ contentType: 'audio/webm;codecs=opus', dataBase64: btoa('ZZ TEST clip bytes') });
      // The route's rule on the type takes what the recorder reports.
      expect(body.voice.contentType).toMatch(/^audio\/[A-Za-z0-9.+-]+(;[ -~]{0,80})?$/);
      // Played: the clip is cleared for the next press, and the status line says so.
      expect(clip()).toBeNull();
      expect(document.querySelector('[role="status"]')!.textContent).toContain('Received: a new conversation, routed.');
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops itself at the ceiling: a minute, and the clip reads 1:00', async () => {
    vi.useFakeTimers();
    try {
      await render();
      await click('simulator-record');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(FakeRecorder.instances[0]!.state).toBe('recording');
      await act(async () => {
        await vi.advanceTimersByTimeAsync((SIMULATOR_VOICE_MAX_SECONDS - 1) * 1000);
      });
      expect(FakeRecorder.instances[0]!.state).toBe('recording');
      expect(clock()!.textContent).toContain('Recording · 0:59 / 1:00');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(FakeRecorder.instances[0]!.state).toBe('inactive');
      await flush();
      expect(stoppedTracks).toHaveLength(1);
      expect(clock()).toBeNull();
      expect(clip()!.textContent).toContain('Recorded clip · 1:00');
      expect(sendButton().disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the discard clears the clip, and Send is off again with nothing to play', async () => {
    vi.useFakeTimers();
    try {
      await render();
      await click('simulator-record');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      await click('simulator-record-stop');
      await flush();
      expect(clip()!.textContent).toContain('Recorded clip · 0:03');
      expect(sendButton().disabled).toBe(false);
      await act(async () => {
        clip()!.querySelector<HTMLButtonElement>('button[aria-label="Discard the voice note"]')!.click();
      });
      expect(clip()).toBeNull();
      expect(sendButton().disabled).toBe(true);
      expect(fetched).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a clip over 1 MB is refused with the file picker’s own line, and nothing is kept', async () => {
    FakeRecorder.chunk = new Uint8Array(SIMULATOR_VOICE_MAX_BYTES + 1);
    await render();
    await click('simulator-record');
    await settle();
    await click('simulator-record-stop');
    await settle();
    expect(FakeRecorder.instances[0]!.state).toBe('inactive');
    expect(stoppedTracks).toHaveLength(1);
    expect(errorLine()!.textContent).toBe('A voice note here is at most 1 MB.');
    expect(clip()).toBeNull();
    expect(sendButton().disabled).toBe(true);
  });

  it('a blocked microphone is said beside the button, with nothing recorded', async () => {
    await render();
    getUserMedia.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'NotAllowedError' }));
    await click('simulator-record');
    await settle();
    expect(FakeRecorder.instances).toHaveLength(0);
    expect(errorLine()!.getAttribute('role')).toBe('alert');
    expect(errorLine()!.textContent).toBe('The microphone is blocked for this site. Allow it in the browser and try again.');
    expect(byId<HTMLButtonElement>('simulator-record')!.disabled).toBe(false);
    expect(clip()).toBeNull();
    expect(fetched).toHaveLength(0);
  });

  it('the file picker still works as before: an audio file is named, discardable, and sent under its own type', async () => {
    vi.useFakeTimers();
    try {
      await render();
      const file = new File(['ZZ TEST ogg bytes'], 'ZZ-TEST-note.ogg', { type: 'audio/ogg' });
      Object.defineProperty(fileInput(), 'files', { value: [file], configurable: true });
      await act(async () => {
        fileInput().dispatchEvent(new Event('change', { bubbles: true }));
      });
      await flush();
      expect(clip()!.textContent).toContain('ZZ-TEST-note.ogg');
      expect(clip()!.querySelector('button[aria-label="Discard the voice note"]')).not.toBeNull();
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(sendButton().disabled).toBe(false);

      await act(async () => {
        sendButton().click();
      });
      await flush();
      expect(fetched).toHaveLength(1);
      const body = fetched[0]!.body as { voice: { contentType: string; dataBase64: string } };
      expect(body.voice).toEqual({ contentType: 'audio/ogg', dataBase64: btoa('ZZ TEST ogg bytes') });
      expect(clip()).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
