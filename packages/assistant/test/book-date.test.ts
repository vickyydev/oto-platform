/**
 * SCRUM-821, BOOK DATE'S READER's pure core: the prompt, the checks a
 * proposal passes before anyone sees it, the fake that scripts it, and the
 * real client over a stub fetch. The real Anthropic API is never reached.
 */

import { describe, expect, it } from 'vitest';
import {
  AnthropicBookDateReader,
  BOOK_DATE_READER_VERSION,
  BOOK_DATE_SYSTEM_TEXT,
  EMPTY_BOOK_DATE_READING,
  buildBookDatePrompt,
  readBookDateProposal,
  type BookDateRequest,
} from '../src/book-date';
import { FakeBookDateReader } from '../src/fake';

const CENTRAL = '00000000-0000-7000-8000-00000000000c';
const request: BookDateRequest = {
  lines: [
    { by: 'family', at: '2026-11-09 10:12', text: 'hi! 12 kds and 4 adust, sat 21 novmber 2pm, for Emma turning 7' },
    { by: 'team', at: '2026-11-09 10:20', text: 'Confirmed: Saturday 21 November at 15:00 at Central Floresta, 12 kids and 4 adults' },
  ],
  today: '2026-11-10',
  timeZone: 'Asia/Bangkok',
  parks: [{ id: CENTRAL, name: 'Central Floresta', code: 'hkt-central' }],
};

describe('the prompt', () => {
  it('the fixed rules in the system text; today, the parks and the numbered chat as data in the user turn', () => {
    expect(BOOK_DATE_SYSTEM_TEXT).toContain('"kds" is kids');
    expect(BOOK_DATE_SYSTEM_TEXT).toContain("The team's confirmation wins");
    const prompt = buildBookDatePrompt(request);
    expect(prompt.system).toBe(BOOK_DATE_SYSTEM_TEXT);
    const content = prompt.messages[0].content;
    expect(content).toContain('Today at the park is 2026-11-10, a Tuesday (Asia/Bangkok).');
    expect(content).toContain('{"line":1,"by":"family","at":"2026-11-09 10:12"');
    expect(content).toContain('{"line":2,"by":"team"');
    expect(content).toContain(`{"id":"${CENTRAL}","name":"Central Floresta","code":"hkt-central"}`);
  });

  it('a misspelling in each of the park’s three languages, read by meaning; the words versioned', () => {
    // English and Russian.
    expect(BOOK_DATE_SYSTEM_TEXT).toContain('"adust" and "adlts" are adults');
    expect(BOOK_DATE_SYSTEM_TEXT).toContain('"novmber" is November');
    expect(BOOK_DATE_SYSTEM_TEXT).toContain('"детй" is детей');
    expect(BOOK_DATE_SYSTEM_TEXT).toContain('"ноабря" is ноября');
    // Thai: a dropped tone or vowel mark, and the month's short forms.
    expect(BOOK_DATE_SYSTEM_TEXT).toContain('"เดก" is เด็ก');
    expect(BOOK_DATE_SYSTEM_TEXT).toContain('"ผูใหญ่" is ผู้ใหญ่');
    expect(BOOK_DATE_SYSTEM_TEXT).toContain('"ธันวา" and "ธ.ค." are ธันวาคม');
    expect(BOOK_DATE_READER_VERSION).toBe('book-date-2026-11-10.2');
  });
});

describe('a proposal is checked against the chat', () => {
  it('each value names its line: the source is that line’s author, the words its own', () => {
    const read = readBookDateProposal(
      {
        ...EMPTY_BOOK_DATE_READING,
        date: { value: '2026-11-21', line: 2, said: 'Saturday 21 November' },
        startTime: { value: '15:00', line: 2, said: 'at 15:00' },
        kids: { value: 12, line: 1, said: '12 kds' },
        adults: { value: 4, line: 1, said: '4 ADUST' },
        childName: { value: ' Emma ', line: 1, said: 'Emma' },
        park: { parkId: CENTRAL, line: 2, said: 'Central Floresta' },
      },
      request,
    );
    expect(read).toEqual({
      date: { value: '2026-11-21', text: 'Saturday 21 November', source: 'team', line: 1 },
      startTime: { value: '15:00', text: 'at 15:00', source: 'team', line: 1 },
      kids: { value: 12, text: '12 kds', source: 'family', line: 0 },
      // The quote is found whatever its case.
      adults: { value: 4, text: '4 ADUST', source: 'family', line: 0 },
      childName: { value: 'Emma', text: 'Emma', source: 'family', line: 0 },
      childAge: null,
      park: { value: CENTRAL, text: 'Central Floresta', source: 'team', line: 1 },
    });
  });

  it('out of bounds, gone by, no line, or another operator’s park: left out (a park named but not ours keeps its words)', () => {
    const read = readBookDateProposal(
      {
        date: { value: '2026-11-09', line: 1, said: 'yesterday' },
        startTime: { value: '2 pm', line: 1, said: '2pm' },
        kids: { value: 12.5, line: 1, said: '12 kds' },
        adults: { value: 4, line: 0, said: '4 adust' },
        childName: { value: 'x'.repeat(81), line: 1, said: 'Emma' },
        childAge: { value: 31, line: 1, said: 'turning 7' },
        park: { parkId: 'not-ours', line: 1, said: 'Bangna' },
      },
      request,
    );
    expect(read).toMatchObject({ date: null, startTime: null, kids: null, adults: null, childName: null, childAge: null });
    // "Bangna" is not in line 1: the line itself is quoted.
    expect(read.park).toMatchObject({ value: null, source: 'family', line: 0 });
    expect(read.park?.text).toBe(request.lines[0]!.text);
    // A dotted time is a clock time.
    expect(
      readBookDateProposal({ ...EMPTY_BOOK_DATE_READING, startTime: { value: '9.30', line: 1, said: '2pm' } }, request).startTime?.value,
    ).toBe('09:30');
  });
});

describe('FakeBookDateReader', () => {
  it('plays a reading through the real interpretation, records the request, and scripts every failure', async () => {
    const fake = new FakeBookDateReader([
      { kind: 'reading', reading: { kids: { value: 12, line: 1, said: '12 kds' } } },
      { kind: 'refusal' },
      { kind: 'invalid_shape', value: { kids: 'twelve' } },
    ]);
    expect(await fake.read(request)).toMatchObject({ ok: true, reading: { kids: { value: 12 }, adults: null } });
    expect(await fake.read(request)).toMatchObject({ ok: false, reason: 'REFUSAL' });
    expect(await fake.read(request)).toMatchObject({ ok: false, reason: 'MALFORMED' });
    expect(fake.requests).toHaveLength(3);
    await expect(fake.read(request)).rejects.toThrow(/no step left/);
  });
});

describe('AnthropicBookDateReader (stub fetch, never the network)', () => {
  function stub(respond: () => Response) {
    const bodies: Array<Record<string, unknown>> = [];
    const fn = async (_input: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return respond();
    };
    return { fetch: fn as typeof fetch, bodies };
  }
  const reply = (text: string) =>
    new Response(
      JSON.stringify({
        id: 'msg_stub',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 900, output_tokens: 120, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
      { status: 200, headers: { 'content-type': 'application/json', 'request-id': 'req_stub_bd' } },
    );

  it('one structured call at low effort, no retry; the reading parsed', async () => {
    const s = stub(() => reply(JSON.stringify({ ...EMPTY_BOOK_DATE_READING, adults: { value: 4, line: 1, said: '4 adust' } })));
    const r = new AnthropicBookDateReader({ apiKey: 'sk-test-not-a-key', baseURL: 'http://anthropic.stub.invalid', fetch: s.fetch });
    const out = await r.read(request);
    expect(out).toMatchObject({ ok: true, reading: { adults: { value: 4 } }, usage: { inputTokens: 900, outputTokens: 120 }, requestId: 'req_stub_bd' });
    expect(s.bodies).toHaveLength(1);
    const body = s.bodies[0] as { model: string; system: string; output_config: { effort: string; format: { type: string } }; fallbacks?: unknown };
    expect(body.model).toBe('claude-opus-5-5');
    expect(body.system).toBe(BOOK_DATE_SYSTEM_TEXT);
    expect(body.output_config).toMatchObject({ effort: 'low', format: { type: 'json_schema' } });
    expect(body.fallbacks).toBe('default');
  });

  it('a server error is a failure word, never a throw, and is not retried', async () => {
    const s = stub(() => new Response(JSON.stringify({ type: 'error', error: { type: 'api_error' } }), { status: 500, headers: { 'content-type': 'application/json' } }));
    const r = new AnthropicBookDateReader({ apiKey: 'sk-test-not-a-key', baseURL: 'http://anthropic.stub.invalid', fetch: s.fetch });
    expect(await r.read(request)).toMatchObject({ ok: false, reason: 'PROVIDER_UNAVAILABLE' });
    expect(s.bodies).toHaveLength(1);
  });
});
