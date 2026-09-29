import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settle } from './support/fixtures';
import { renderHook, type RenderedHook } from './support/hooks';
import type { StationSessionDocument } from '@oto/shared';
import { displayRequest, DisplayError, newDisplayCredential, newerDisplaySession, type DisplaySession } from '@/api/display';
import { readDisplayAnswer, ticketDisplayPresentation, useTicketDisplay, type TicketDisplayState } from '@/lib/displaySession';
import {
  readProductScan,
  readVoucherScan,
  useStationScans,
  type StationScanEvent,
} from '@/lib/scanChannel';

/**
 * THE STATION CHANNEL, FOR SCANS — `lib/scanChannel.ts`.
 *
 * `useStationScans` is a React hook; it runs on the harness in place of React
 * (support/hooks.ts). Everything else it touches is stubbed here and nothing
 * more: `fetch` (the poll), `EventSource` (the stream), `document` (whether the
 * screen is shown) and the clock.
 *
 * The figures are the library's own, which it does not export:
 * `STREAM_OPEN_TIMEOUT_MS` 4 s, `POLL_INTERVAL_MS` 1.5 s, `POLL_TIMEOUT_MS` 10 s.
 */
vi.mock('react', () => import('./support/hooks'));

describe('SCRUM-201 — separate display transport and station presentation', () => {
  let displayHook: RenderedHook<void, ReturnType<typeof useTicketDisplay>> | undefined;
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { displayHook?.unmount(); displayHook = undefined; vi.useRealTimers(); vi.unstubAllGlobals(); });

  const state = (overrides: Partial<TicketDisplayState> = {}): TicketDisplayState => ({
    stage:'identify', step:1, sessionKey:'visit-1', tier:'tourist', phone:'', nickname:'', contactChannel:'whatsapp', member:null, ...overrides,
  });
  const document = (overrides: Partial<StationSessionDocument> = {}): StationSessionDocument => ({
    stationId:'station-1', boxId:'box-1', schemaVersion:1, sequence:0, stage:'identify', language:'en', lease:null,
    takeoverCount:0, updatedAt:'2026-09-29T12:00:00.000Z', ...overrides,
  });
  const reply = (data: unknown, status = 200) => ({ ok:status >= 200 && status < 300, status, json:async () => data }) as Response;

  it('uses a display bearer without staff cookies or staff lock events', async () => {
    const dispatch = vi.fn();
    vi.stubGlobal('window', { dispatchEvent:dispatch });
    const bearer = newDisplayCredential();
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      expect(init?.credentials).toBe('omit');
      expect(init?.cache).toBe('no-store');
      expect((init?.headers as Record<string,string>).authorization === `Bearer ${bearer}`).toBe(true);
      return reply({error:{code:'DISPLAY_UNPAIRED',message:'Pair this display again.'}},401);
    });
    vi.stubGlobal('fetch', request);
    await expect(displayRequest(bearer,'GET','/session')).rejects.toMatchObject({status:401,code:'DISPLAY_UNPAIRED'});
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('bounds an unanswered device request and keeps the refusal free of credentials', async () => {
    const bearer = newDisplayCredential();
    vi.stubGlobal('fetch', vi.fn((_path: string, init?: RequestInit) => new Promise<Response>((_resolve,reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted','AbortError')));
    })));
    const result = displayRequest(bearer,'GET','/session').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(8_000);
    const failure = await result;
    expect(failure).toBeInstanceOf(DisplayError);
    expect((failure as DisplayError).status).toBe(0);
    expect(String(failure).includes(bearer)).toBe(false);
  });

  it('publishes only identification fields and keeps unsupported steps on the inline screen', () => {
    const input = state({member:{id:'member-1',phone:'private-phone',nickname:'Visitor',savedChildren:[{
      id:'child-1', childName:'Private child', childAge:5, allergiesMedical:'Private medical note', savedAt:'', updatedAt:'',
    }]}});
    const view = ticketDisplayPresentation(input,'prompt-1');
    expect(view.member).toEqual({id:'member-1',nickname:'Visitor',tier:'tourist'});
    expect(JSON.stringify(view)).not.toMatch(/Private child|Private medical|private-phone|savedChildren/);
    expect(ticketDisplayPresentation(state({stage:'payment',step:5}),'prompt-1').cart.supported).toBe(false);
    expect(ticketDisplayPresentation(state({stage:'welcome',step:7}),'prompt-1').prompt).toBeNull();
  });

  it('refuses a response from an older visitor or a different stage', () => {
    const doc = document({prompt:{requestId:'prompt-old',answer:{type:'identify',phone:'number',actionId:'tap-1'}}});
    expect(readDisplayAnswer(doc,'prompt-new')).toBeNull();
    expect(readDisplayAnswer({...doc,stage:'payment'},'prompt-old')).toBeNull();
    expect(readDisplayAnswer(doc,'prompt-old')?.actionId).toBe('tap-1');
  });

  it('ignores a delayed poll or intent response after the next visitor snapshot', () => {
    const current: DisplaySession = {station:{id:'station-1',name:'T1',kind:'till'},device:{id:'display-1',name:'Screen'},
      document:document({sequence:8,prompt:{requestId:'new-visitor'}})};
    const late = {...current,document:document({sequence:7,prompt:{requestId:'old-visitor',answer:{actionId:'old-answer'}}})};
    expect(newerDisplaySession(current,late)).toBe(current);
    expect(newerDisplaySession(late,current)).toBe(current);
  });

  it('delivers one display answer once and keeps the publish under the held lease', async () => {
    const onAnswer = vi.fn();
    let doc = document();
    const intents: Record<string,unknown>[] = [];
    vi.stubGlobal('fetch', vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/displays')) return reply({displays:[{id:'display-1',name:'Ticket display',connected:true}]});
      if (path.endsWith('/session')) return reply({document:doc});
      if (path.endsWith('/lease')) {
        doc = {...doc,lease:{leaseId:'lease-1',holder:'till',holderKind:'till',accountId:'account-1',startedAt:doc.updatedAt,heartbeatAt:doc.updatedAt,expiresAt:'2026-09-29T12:01:00.000Z'}};
        return reply({document:doc,lease:doc.lease});
      }
      if (path.endsWith('/intents')) {
        const body = JSON.parse(String(init?.body)) as Record<string,unknown>;
        intents.push(body);
        expect(body.leaseId).toBe('lease-1');
        doc = {...doc,...body.payload as Partial<StationSessionDocument>,sequence:doc.sequence+1};
        return reply({document:doc});
      }
      return reply({released:true});
    }));
    displayHook = renderHook(() => useTicketDisplay('station-1',state(),onAnswer));
    await settle();
    expect(intents).toHaveLength(1);
    doc = {...doc,sequence:doc.sequence+1,prompt:{...doc.prompt,answer:{type:'identify',phone:'number',actionId:'tap-1'}}};
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(onAnswer).toHaveBeenCalledTimes(1);
    expect(onAnswer.mock.calls[0]?.[0].type).toBe('identify');
    expect(intents).toHaveLength(1);
  });

  it('pauses staff requests and answer adoption during lock, then resumes the same prompt once', async () => {
    let active = true;
    let doc = document();
    let finishRead: ((response: Response) => void) | undefined;
    const onAnswer = vi.fn();
    const intents: Record<string, unknown>[] = [];
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.endsWith('/displays')) return reply({ displays: [{ id: 'display-1', name: 'Ticket display', connected: true }] });
      if (path.endsWith('/session')) return new Promise<Response>((resolve) => { finishRead = resolve; });
      if (path.endsWith('/lease')) {
        doc = { ...doc, lease: { leaseId: 'lease-locked', holder: 'till', holderKind: 'till', accountId: 'account-1',
          startedAt: doc.updatedAt, heartbeatAt: doc.updatedAt, expiresAt: '2026-09-29T12:01:00.000Z' } };
        return reply({ document: doc, lease: doc.lease });
      }
      if (path.endsWith('/lease/renew')) return reply({ document: doc });
      if (path.endsWith('/intents')) {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        intents.push(body);
        doc = { ...doc, ...body.payload as Partial<StationSessionDocument>, sequence: doc.sequence + 1 };
        return reply({ document: doc });
      }
      return reply({ released: true });
    });
    vi.stubGlobal('fetch', request);
    displayHook = renderHook(() => useTicketDisplay('station-locked', state(), onAnswer, active));
    await settle();
    const promptId = doc.prompt?.requestId;
    expect(typeof promptId).toBe('string');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(finishRead).toBeTypeOf('function');

    active = false;
    displayHook.rerender();
    doc = { ...doc, sequence: doc.sequence + 1,
      prompt: { ...doc.prompt, answer: { type: 'identify', phone: 'number', actionId: 'answer-while-locked' } } };
    finishRead?.(reply({ document: doc }));
    await settle();
    expect(onAnswer).not.toHaveBeenCalled();
    const pausedRequests = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request.mock.calls).toHaveLength(pausedRequests);
    expect(displayHook.result.current.connected).toHaveLength(1);
    expect(request.mock.calls.some(([path]) => path.endsWith('/lease/release'))).toBe(false);

    active = true;
    displayHook.rerender();
    await settle();
    expect(doc.prompt?.requestId).toBe(promptId);
    expect(onAnswer).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ actionId: 'answer-while-locked' }));
    expect(intents).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_500);
    finishRead?.(reply({ document: doc }));
    await settle();
    expect(onAnswer).toHaveBeenCalledTimes(1);

    displayHook.unmount();
    expect(request.mock.calls.filter(([path]) => path.endsWith('/lease/release'))).toHaveLength(1);
    displayHook = renderHook(() => useTicketDisplay('station-locked', state(), onAnswer));
    await settle();
    expect(doc.prompt?.requestId === promptId).toBe(false);
    expect(doc.prompt?.answer).toBeUndefined();
    expect(onAnswer).toHaveBeenCalledTimes(1);
  });
});

const STREAM_OPEN_TIMEOUT_MS = 4_000;
const POLL_INTERVAL_MS = 1_500;
const POLL_TIMEOUT_MS = 10_000;

function scan(overrides: Partial<StationScanEvent> = {}): StationScanEvent {
  return {
    kind: 'scan',
    source: 'box-scanner',
    codeKind: 'voucher',
    codeFingerprint: 'fp-1',
    outcome: 'handled',
    handler: 'voucher',
    errorCode: null,
    detail: { code: 'B1RT7KMQ4XW' },
    actionId: null,
    scannedAt: '2026-09-25T03:00:00.000Z',
    ...overrides,
  };
}

/** One `GET /stations/:id/scans`, held open until the test answers it. */
interface Poll {
  path: string;
  /** The cursor it carried; null when it asked for the tape's number afresh. */
  after: string | null;
  signal: AbortSignal;
  answer: (body: unknown, status?: number) => Promise<void>;
  /** A 200 whose body is not JSON — a proxy's page: `res.json()` rejects, as a real body's does. */
  answerUnreadable: () => Promise<void>;
  fail: (error?: unknown) => Promise<void>;
}

function stubFetch() {
  const polls: Poll[] = [];
  const fetchMock = vi.fn(
    (input: string, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const url = new URL(input, 'http://till.test');
        const signal = init?.signal ?? new AbortController().signal;
        // As a real fetch does: an abort rejects the request.
        signal.addEventListener(
          'abort',
          () => reject(new DOMException('This operation was aborted', 'AbortError')),
          { once: true },
        );
        polls.push({
          path: `${url.pathname}${url.search}`,
          after: url.searchParams.get('after'),
          signal,
          answer: async (body, status = 200) => {
            resolve({
              status,
              ok: status >= 200 && status < 300,
              json: async () => body,
            } as Response);
            await settle();
          },
          answerUnreadable: async () => {
            const unreadable: Pick<Response, 'status' | 'ok' | 'json'> = {
              status: 200,
              ok: true,
              json: () => Promise.reject(new SyntaxError('Unexpected token < in JSON')),
            };
            resolve(unreadable as Response);
            await settle();
          },
          fail: async (error = new TypeError('Failed to fetch')) => {
            reject(error);
            await settle();
          },
        });
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, polls };
}

/** Enough of `document` for the hook: its visibility, and the event that says it changed. */
class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  show(state: DocumentVisibilityState): void {
    this.visibilityState = state;
    this.dispatchEvent(new Event('visibilitychange'));
  }
}

/** The stream, driven by the test: whether it opens, what it carries, whether the browser gives up. */
class FakeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static made: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  constructor(readonly url: string) {
    super();
    FakeEventSource.made.push(this);
  }
  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.dispatchEvent(new Event('open'));
  }
  send(type: string, data: string): void {
    this.dispatchEvent(new MessageEvent(type, { data }));
  }
  /** A dropped connection: the browser reconnects by itself. */
  drop(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.dispatchEvent(new Event('error'));
  }
  /** An answer that was not a stream: the browser never tries this one again. */
  giveUp(): void {
    this.readyState = FakeEventSource.CLOSED;
    this.dispatchEvent(new Event('error'));
  }
}

let doc: FakeDocument;
let fetchMock: ReturnType<typeof stubFetch>['fetchMock'];
let polls: Poll[];
const mounted: RenderedHook<string | null, void>[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  doc = new FakeDocument();
  vi.stubGlobal('document', doc);
  // No stream in this "browser" unless a test puts one there.
  vi.stubGlobal('EventSource', undefined);
  FakeEventSource.made = [];
  ({ fetchMock, polls } = stubFetch());
});

afterEach(() => {
  for (const hook of mounted.splice(0)) hook.unmount();
  vi.useRealTimers();
});

/** A screen at `stationId`, recording every scan handed to it. */
function listen(stationId: string | null = 'station-1') {
  const heard: StationScanEvent[] = [];
  const hook = renderHook(
    (id: string | null) => useStationScans(id, (event) => heard.push(event)),
    stationId,
  );
  mounted.push(hook);
  return { heard, hook };
}

describe('useStationScans — the poll (SCRUM-392)', () => {
  it('takes the tape number first and replays nothing scanned before the screen listened', async () => {
    const { heard } = listen();
    expect(polls).toHaveLength(1);
    expect(polls[0]!.path).toBe('/api/stations/station-1/scans?view=staff');

    await polls[0]!.answer({ next: 7, scans: [scan({ detail: { code: 'BEFORE-THE-SCREEN' } })] });
    expect(heard).toEqual([]);

    // The next poll goes out one interval after the answer, from that number on.
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS - 1);
    expect(polls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toHaveLength(2);
    expect(polls[1]!.path).toBe('/api/stations/station-1/scans?view=staff&after=7');

    const fresh = scan();
    await polls[1]!.answer({ next: 8, scans: [fresh] });
    expect(heard).toEqual([fresh]);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls[2]!.after).toBe('8');
  });

  it('never overlaps two polls: the next one waits for an answer', async () => {
    listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS - 1);
    expect(polls).toHaveLength(2);
  });

  it('gives a hung poll up at ten seconds and sends the next with the same cursor, so the gap is still heard (SCRUM-424, L39)', async () => {
    const { heard } = listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const hung = polls[1]!;

    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS - 1);
    expect(hung.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(hung.signal.aborted).toBe(true);
    await settle();

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls).toHaveLength(3);
    expect(polls[2]!.after).toBe('7');
    const meanwhile = scan({ detail: { code: 'SCANNED-DURING-THE-HANG' } });
    await polls[2]!.answer({ next: 8, scans: [meanwhile] });
    expect(heard).toEqual([meanwhile]);
  });

  it.each([
    ['a locked session (423)', 423],
    ["a proxy's 502 while the api redeploys", 502],
    ['a 503', 503],
    ['a 500', 500],
  ])('keeps the interval and the cursor after %s', async (_label, status) => {
    const { heard } = listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await polls[1]!.answer({ error: { code: 'X', message: 'no' } }, status);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls).toHaveLength(3);
    expect(polls[2]!.after).toBe('7');
    const later = scan();
    await polls[2]!.answer({ next: 8, scans: [later] });
    expect(heard).toEqual([later]);
  });

  it('keeps the interval and the cursor after a dropped connection or an answer that does not read', async () => {
    listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await polls[1]!.fail();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls[2]!.after).toBe('7');

    await polls[2]!.answerUnreadable();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls).toHaveLength(4);
    expect(polls[3]!.after).toBe('7');
  });

  it.each([
    ['a malformed request (400)', 400],
    ['no session (401)', 401],
    ['a session not allowed to watch this station (403)', 403],
    ['no such station (404)', 404],
    ['no box behind it (409)', 409],
  ])('stops polling after a refusal: %s', async (_label, status) => {
    listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await polls[1]!.answer({ error: { code: 'REFUSED', message: 'no' } }, status);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls).toHaveLength(2);
  });

  it('asks nothing without a station', async () => {
    listen(null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('useStationScans — a hidden screen does not act on scans (SCRUM-424)', () => {
  it('stops polling while hidden, and shown again takes the number afresh: a scan made while it was away never lands', async () => {
    const { heard } = listen();
    await polls[0]!.answer({ next: 7, scans: [] });

    doc.show('hidden');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls).toHaveLength(1); // the poll that was due is not sent

    doc.show('visible');
    expect(polls).toHaveLength(2); // at once, not an interval later
    expect(polls[1]!.after).toBeNull();
    await polls[1]!.answer({ next: 12, scans: [scan({ detail: { code: 'SCANNED-WHILE-AWAY' } })] });
    expect(heard).toEqual([]);

    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls[2]!.after).toBe('12');
    const now = scan();
    await polls[2]!.answer({ next: 13, scans: [now] });
    expect(heard).toEqual([now]);
  });

  it('shown again while a poll is out: that poll takes the number afresh and delivers nothing', async () => {
    const { heard } = listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls).toHaveLength(2);

    doc.show('hidden');
    doc.show('visible');
    expect(polls).toHaveLength(2); // the one in flight answers for it

    await polls[1]!.answer({ next: 12, scans: [scan({ detail: { code: 'SCANNED-WHILE-AWAY' } })] });
    expect(heard).toEqual([]);
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    expect(polls[2]!.after).toBe('12');
  });

  it('leaves a poll in flight to answer when hidden, schedules none after it, and polls the moment it is shown', async () => {
    listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    doc.show('hidden');
    expect(polls[1]!.signal.aborted).toBe(false);
    await polls[1]!.answer({ next: 8, scans: [] });

    // Shown again before an interval has passed: no poll was left waiting, so
    // one goes out at once, and it takes the number afresh.
    doc.show('visible');
    expect(polls).toHaveLength(3);
    expect(polls[2]!.after).toBeNull();
  });

  it('reads being away from visibility alone: a failed poll resets no cursor', async () => {
    const { heard } = listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    await polls[1]!.fail();
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const gap = scan({ detail: { code: 'SCANNED-DURING-THE-FAILURE' } });
    await polls[2]!.answer({ next: 8, scans: [gap] });
    expect(heard).toEqual([gap]);
  });
});

describe('useStationScans — leaving', () => {
  it('on unmount aborts the poll in flight, delivers nothing more and sends no other', async () => {
    const { heard, hook } = listen();
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const inFlight = polls[1]!;

    hook.unmount();
    expect(inFlight.signal.aborted).toBe(true);
    doc.show('hidden');
    doc.show('visible');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(polls).toHaveLength(2);
    expect(heard).toEqual([]);
  });

  it('on a change of station leaves the old one and takes the new one from its current number', async () => {
    const { heard, hook } = listen('station-1');
    await polls[0]!.answer({ next: 7, scans: [] });
    await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
    const old = polls[1]!;

    hook.rerender('station-2');
    expect(old.signal.aborted).toBe(true);
    expect(polls[2]!.path).toBe('/api/stations/station-2/scans?view=staff');
    await polls[2]!.answer({ next: 40, scans: [scan()] });
    expect(heard).toEqual([]);
  });
});

describe('useStationScans — the stream first', () => {
  beforeEach(() => {
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  it('listens on the channel; a stream that opens is heard and nothing polls', async () => {
    const { heard } = listen();
    const source = FakeEventSource.made[0]!;
    expect(source.url).toBe('/api/stations/station-1/channel?view=staff');
    source.open();

    const heardOnStream = scan();
    source.send('scan', JSON.stringify(heardOnStream));
    source.send('scan', 'not json'); // a message that is not JSON is not a scan
    source.send('scan', JSON.stringify({ kind: 'lease' })); // nor is one of another kind
    expect(heard).toEqual([heardOnStream]);

    // A dropped connection is the browser's to retry; the stream is kept.
    source.drop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('closes a stream that has not opened in four seconds and polls instead, from the current number (SCRUM-392)', async () => {
    const { heard } = listen();
    const source = FakeEventSource.made[0]!;

    await vi.advanceTimersByTimeAsync(STREAM_OPEN_TIMEOUT_MS - 1);
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    expect(polls).toHaveLength(1);
    expect(polls[0]!.after).toBeNull();

    // The closed stream is no longer listened to, so nothing is heard twice.
    source.send('scan', JSON.stringify(scan()));
    expect(heard).toEqual([]);
  });

  it('polls at once when the browser has given the stream up', () => {
    listen();
    FakeEventSource.made[0]!.giveUp();
    expect(polls).toHaveLength(1);
  });
});

describe('readVoucherScan', () => {
  it('reads the code a voucher handler claimed', () => {
    expect(readVoucherScan(scan({ detail: { code: 'B1RT7KMQ4XW' } }))).toBe('B1RT7KMQ4XW');
  });

  it.each([
    ['another kind of code', scan({ codeKind: 'band' })],
    ['a code no handler claimed', scan({ outcome: 'unhandled', handler: null })],
    ['a code another handler claimed', scan({ handler: 'product-barcode' })],
    ['an empty code', scan({ detail: { code: '' } })],
    ['no code at all', scan({ detail: null })],
  ])('answers null for %s', (_label, event) => {
    expect(readVoucherScan(event)).toBeNull();
  });
});

describe('readProductScan', () => {
  const product = (add: Record<string, unknown>, overrides: Partial<StationScanEvent> = {}) =>
    scan({ codeKind: 'product', handler: 'product-barcode', detail: { add }, ...overrides });

  it('reads the line the box asks the shop to add, size and all', () => {
    expect(
      readProductScan(
        product({
          kind: 'product',
          productId: 'p-socks',
          name: 'Grip Socks',
          label: 'Grip Socks M',
          variant: { id: 'v-m', label: 'M' },
          quantity: 2,
        }),
      ),
    ).toEqual({
      kind: 'add',
      line: {
        productId: 'p-socks',
        name: 'Grip Socks',
        label: 'Grip Socks M',
        variant: { id: 'v-m', label: 'M' },
        quantity: 2,
      },
    });
  });

  it('adds one of the item, under its own name, when the box says no more', () => {
    const read = readProductScan(
      product({ kind: 'product', productId: 'p-cup', name: 'Cup', variant: 'L', quantity: 0 }),
    );
    expect(read).toEqual({
      kind: 'add',
      line: { productId: 'p-cup', name: 'Cup', label: 'Cup', variant: null, quantity: 1 },
    });
  });

  it("says Unknown barcode in the box's words, adding nothing", () => {
    const refused = { outcome: 'refused', handler: null, errorCode: 'UNKNOWN_BARCODE' };
    expect(readProductScan(scan({ codeKind: 'product', ...refused, detail: { message: 'Not sold here' } }))).toEqual({
      kind: 'unknown',
      message: 'Not sold here',
    });
    expect(readProductScan(scan({ codeKind: 'product', ...refused, detail: null }))).toEqual({
      kind: 'unknown',
      message: 'Unknown barcode',
    });
  });

  it("answers null for another screen's scan or an add it cannot read", () => {
    expect(readProductScan(scan())).toBeNull();
    expect(readProductScan(product({ kind: 'product', productId: 'p-1' }, { handler: 'voucher' }))).toBeNull();
    expect(readProductScan(product({ kind: 'ticket', productId: 'p-1' }))).toBeNull();
    expect(readProductScan(product({ kind: 'product' }))).toBeNull();
  });
});
