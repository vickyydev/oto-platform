import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@oto/shared';
import {
  DIRECTORY_NOT_CONFIGURED,
  DIRECTORY_UNREACHABLE,
  buildOtoAppDirectory,
  type DirectoryAttendeeBody,
} from '../src/services/otoapp-directory';

/**
 * S2-20 E2 — the OTO App directory client, against a stand-in for the app's
 * HTTP surface (no database): what it sends — the route, the tenant-bound key
 * as a bearer token, the body — and how each kind of answer comes back to the
 * write-back (ok, refused, unavailable). The real app's write code is run end
 * to end in `events-e2.test.ts`.
 */

const KEY = 'odk_test_key_value';
let server: Server;
let origin: string;
let answer: { status: number; body: unknown } | 'hang' = { status: 201, body: {} };
const seen: Array<{ method: string; url: string; auth: string | undefined; body: unknown }> = [];

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
    req.on('end', () => resolve(data));
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const text = await readBody(req);
    seen.push({ method: req.method!, url: req.url!, auth: req.headers.authorization, body: JSON.parse(text || 'null') });
    if (answer === 'hang') return; // never answers: the client's own time limit decides
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(answer.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections?.();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const body = (): DirectoryAttendeeBody => ({
  id: newId(),
  childFullName: 'Lin',
  parentName: 'May',
  parentAttending: false,
  attendanceDays: [],
  notes: 'Walk-up added by Som (today only)',
  source: 'pos',
  createdBy: 'Som',
});

const env = (o: Partial<{ url: string; key: string; timeout: number }> = {}) => ({
  OTOAPP_DIRECTORY_URL: o.url ?? `${origin}/`,
  OTOAPP_DIRECTORY_KEY: o.key ?? KEY,
  OTOAPP_DIRECTORY_TIMEOUT_MS: o.timeout ?? 2000,
});

describe('the OTO App directory client', () => {
  it("posts the child to the event's attendees route with the key as a bearer token, and reads the attendee back", async () => {
    const sent = body();
    const eventId = newId();
    answer = {
      status: 201,
      body: {
        attendee: { id: sent.id, eventId, recordKind: 'event_attendee', childName: 'Lin', parentName: 'May', parentPhone: null, parentAttending: false, attendanceDays: [], createdAt: new Date().toISOString() },
        replayed: false,
        merged: false,
      },
    };
    const directory = buildOtoAppDirectory(env());
    expect(directory.configured).toBe(true);
    const out = await directory.addAttendee(eventId, sent);
    expect(out).toMatchObject({ ok: true, status: 201, body: { attendee: { id: sent.id }, replayed: false } });
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ method: 'POST', url: `/api/directory/events/${eventId}/attendees`, auth: `Bearer ${KEY}` });
    expect(last.body).toEqual(sent);
  });

  it("a refusal the app chose is said in the app's own words and is not retried by itself", async () => {
    answer = { status: 409, body: { error: 'id_in_use', message: 'This id already belongs to another attendee' } };
    const out = await buildOtoAppDirectory(env()).addAttendee(newId(), body());
    expect(out).toEqual({
      ok: false,
      status: 409,
      code: 'OTOAPP_ID_IN_USE',
      message: 'This id already belongs to another attendee',
      retryable: false,
    });
  });

  it('a fault, a busy app or an answer with no attendee is worth a retry', async () => {
    answer = { status: 503, body: { error: 'Service Unavailable' } };
    expect(await buildOtoAppDirectory(env()).addAttendee(newId(), body())).toMatchObject({ ok: false, status: 503, retryable: true });
    answer = { status: 429, body: { error: 'Too many requests', message: 'Rate limit exceeded.' } };
    expect(await buildOtoAppDirectory(env()).addAttendee(newId(), body())).toMatchObject({ ok: false, code: 'OTOAPP_TOO_MANY_REQUESTS', retryable: true });
    answer = { status: 200, body: { nothing: true } };
    expect(await buildOtoAppDirectory(env()).addAttendee(newId(), body())).toMatchObject({ ok: false, code: 'OTOAPP_UNREADABLE_ANSWER', retryable: true });
  });

  it('no answer in time, and nothing listening, are both unreachable — and say nothing of the key', async () => {
    answer = 'hang';
    const hung = await buildOtoAppDirectory(env({ timeout: 500 })).addAttendee(newId(), body());
    expect(hung).toMatchObject({ ok: false, status: null, code: DIRECTORY_UNREACHABLE, retryable: true });
    const closed = await buildOtoAppDirectory(env({ url: 'http://127.0.0.1:1' })).addAttendee(newId(), body());
    expect(closed).toMatchObject({ ok: false, code: DIRECTORY_UNREACHABLE });
    expect(JSON.stringify([hung, closed])).not.toContain(KEY);
  });

  it('a deployment with no directory makes no call and says the child waits', async () => {
    const before = seen.length;
    for (const directory of [buildOtoAppDirectory(env({ url: '' })), buildOtoAppDirectory(env({ key: '' }))]) {
      expect(directory.configured).toBe(false);
      expect(await directory.addAttendee(newId(), body())).toMatchObject({ ok: false, code: DIRECTORY_NOT_CONFIGURED, retryable: true });
    }
    expect(seen.length).toBe(before);
  });
});
