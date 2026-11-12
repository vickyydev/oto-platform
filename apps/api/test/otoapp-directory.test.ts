import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@oto/shared';
import {
  DIRECTORY_NOT_CONFIGURED,
  DIRECTORY_UNREACHABLE,
  buildOtoAppDirectory,
  type DirectoryAttendeeBody,
  type DirectoryKitchenPlanEditBody,
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
const seen: Array<{ method: string; url: string; auth: string | undefined; type: string | undefined; body: unknown }> = [];

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let data = '';
    req.on('data', (chunk: Buffer) => (data += chunk.toString('utf8')));
    req.on('end', () => resolve(data));
  });

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const text = await readBody(req);
    seen.push({
      method: req.method!,
      url: req.url!,
      auth: req.headers.authorization,
      type: req.headers['content-type'],
      body: JSON.parse(text || 'null'),
    });
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

/**
 * SCRUM-907 — the till's kitchen plan door as this platform calls it: the
 * write (`POST .../kitchen-plan`) and the set menu's choices (`GET
 * .../kitchen-plan/choices`), each under the key as a bearer token; a write is
 * taken only when the app answers the edit by the id it was sent under.
 */
describe("the OTO App directory client: a party's kitchen plan", () => {
  const edit = (): DirectoryKitchenPlanEditBody => ({
    id: newId(),
    editedAt: '2026-11-18T06:30:00.000Z',
    by: { name: 'ZZ TEST Noi', role: 'Manager' },
    changes: [{ op: 'set', lineId: 'm1', qty: 3 }],
  });

  it("posts the changes to the party's kitchen plan door with the key as a bearer token, and takes the edit back by its id", async () => {
    const sent = edit();
    const eventId = newId();
    // The app's id in its own case is still this edit.
    answer = { status: 200, body: { edit: { id: sent.id.toUpperCase(), eventId, changes: 1 }, replayed: false } };
    const out = await buildOtoAppDirectory(env()).editKitchenPlan!(eventId, sent);
    expect(out).toMatchObject({ ok: true, status: 200, body: { edit: { eventId, changes: 1 }, replayed: false } });
    const last = seen.at(-1)!;
    expect(last).toMatchObject({
      method: 'POST',
      url: `/api/directory/events/${eventId}/kitchen-plan`,
      auth: `Bearer ${KEY}`,
      type: 'application/json',
    });
    expect(last.body).toEqual(sent);
  });

  it('an answer naming another edit, or none, is not taken as written and is worth sending again', async () => {
    const eventId = newId();
    answer = { status: 200, body: { edit: { id: newId(), eventId, changes: 1 }, replayed: false } };
    expect(await buildOtoAppDirectory(env()).editKitchenPlan!(eventId, edit())).toMatchObject({
      ok: false,
      status: 200,
      code: 'OTOAPP_UNREADABLE_ANSWER',
      retryable: true,
    });
    answer = { status: 200, body: { replayed: false } };
    expect(await buildOtoAppDirectory(env()).editKitchenPlan!(eventId, edit())).toMatchObject({ ok: false, code: 'OTOAPP_UNREADABLE_ANSWER', retryable: true });
  });

  it("the app's refusals in its own words, never retried by themselves; a fault is worth a retry", async () => {
    answer = { status: 404, body: { error: 'event_not_found', message: 'Event not found' } };
    expect(await buildOtoAppDirectory(env()).editKitchenPlan!(newId(), edit())).toEqual({
      ok: false,
      status: 404,
      code: 'OTOAPP_EVENT_NOT_FOUND',
      message: 'Event not found',
      retryable: false,
    });
    const gone = 'A line of the kitchen plan was changed in the BEO since the till read it (m1). Read the party again and make the change once more.';
    answer = { status: 409, body: { error: 'line_not_found', message: gone } };
    expect(await buildOtoAppDirectory(env()).editKitchenPlan!(newId(), edit())).toEqual({
      ok: false,
      status: 409,
      code: 'OTOAPP_LINE_NOT_FOUND',
      message: gone,
      retryable: false,
    });
    // An app released before its door: a 404 without the app's own code.
    answer = { status: 404, body: {} };
    expect(await buildOtoAppDirectory(env()).editKitchenPlan!(newId(), edit())).toMatchObject({ ok: false, status: 404, code: 'OTOAPP_HTTP_404', retryable: false });
    answer = { status: 503, body: { error: 'Service Unavailable' } };
    expect(await buildOtoAppDirectory(env()).editKitchenPlan!(newId(), edit())).toMatchObject({ ok: false, status: 503, retryable: true });
  });

  it("reads the set menu's choices with a GET under the key, and reads its answers as a write's", async () => {
    const eventId = newId();
    const setMenu = { templateName: 'ZZ TEST Floresta', groups: [{ label: 'Fried rice', options: ['Veggie', 'Chicken'], allowMultiple: false }] };
    answer = { status: 200, body: { setMenu } };
    const directory = buildOtoAppDirectory(env());
    expect(await directory.kitchenPlanChoices!(eventId)).toEqual({ ok: true, status: 200, body: { setMenu } });
    const last = seen.at(-1)!;
    expect(last).toMatchObject({ method: 'GET', url: `/api/directory/events/${eventId}/kitchen-plan/choices`, auth: `Bearer ${KEY}`, body: null });
    // A party with no set menu template: no choices, still an answer.
    answer = { status: 200, body: { setMenu: null } };
    expect(await directory.kitchenPlanChoices!(eventId)).toEqual({ ok: true, status: 200, body: { setMenu: null } });
    answer = { status: 200, body: { nothing: true } };
    expect(await directory.kitchenPlanChoices!(eventId)).toMatchObject({ ok: false, code: 'OTOAPP_UNREADABLE_ANSWER', retryable: true });
    answer = { status: 404, body: { error: 'event_not_found', message: 'Event not found' } };
    expect(await directory.kitchenPlanChoices!(eventId)).toEqual({
      ok: false,
      status: 404,
      code: 'OTOAPP_EVENT_NOT_FOUND',
      message: 'Event not found',
      retryable: false,
    });
    answer = { status: 503, body: { error: 'Service Unavailable' } };
    expect(await directory.kitchenPlanChoices!(eventId)).toMatchObject({ ok: false, status: 503, retryable: true });
  });

  it('nothing listening is unreachable, and a deployment with no directory makes neither call; neither says the key', async () => {
    const closed = buildOtoAppDirectory(env({ url: 'http://127.0.0.1:1' }));
    const outs = [await closed.editKitchenPlan!(newId(), edit()), await closed.kitchenPlanChoices!(newId())];
    for (const out of outs) expect(out).toMatchObject({ ok: false, status: null, code: DIRECTORY_UNREACHABLE, retryable: true });
    const before = seen.length;
    const none = buildOtoAppDirectory(env({ key: '' }));
    outs.push(await none.editKitchenPlan!(newId(), edit()), await none.kitchenPlanChoices!(newId()));
    for (const out of outs.slice(2)) expect(out).toMatchObject({ ok: false, code: DIRECTORY_NOT_CONFIGURED, retryable: true });
    expect(seen.length).toBe(before);
    expect(JSON.stringify(outs)).not.toContain(KEY);
  });
});
