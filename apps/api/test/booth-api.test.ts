import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { station } from '@oto/db';
import {
  BOOTH_ACTION_HEADER,
  BOOTH_IDEMPOTENCY_HEADER,
  BoothRefusal,
  createBoothHttp,
  type Booth,
  type BoothConfigBundle,
  type BoxAgent,
} from '@oto/box-agent';
import { BOOTH_DEVICE_HEADER } from '@oto/shared';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { BUNDLE, REPRINT, SPIN, attachStubBox, detachStubBoxes, newCalls, stubBooth } from './stub-booth';

/**
 * S2-07a — the cloud's booth surface.
 *
 * What this file is really for is the first test in it. `/booth/*` hands each
 * request to the booth's own contract function on the box in this process, and
 * the obvious shortcut — "the route can just draw, it has the bundle right
 * there" — would give the park two draws that disagree: one that wrote a spin
 * row and put paper in a visitor's hand, and one that did not. So the pin is
 * behavioural rather than structural: **with no in-process agent, a press is
 * answered 503 and never a prize.** Reimplement the draw up here and it fails
 * the same day it is written.
 *
 * The rest holds the same line from other sides: the api answers exactly what
 * the box's own surface answers for the same request; a refusal the box names
 * arrives with the box's code and status, not a cloud translation of it; a
 * reprint never draws; and nothing on the surface — answers and errors alike —
 * carries an id, a name or a word of server prose (D15).
 */

let ctx: TestContext;
let adminCookie: string;
let receptionCookie: string;
let boothStationId: string;
let boothBoxId: string;
let tillStationId: string;
/** The paired screen's credential, sent on every `/booth/*` call below (SCRUM-244). */
let deviceHeader: Record<string, string>;

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  const [booth] = await ctx.db.select().from(station).where(eq(station.name, 'Booth 1')).limit(1);
  boothStationId = booth!.id;
  boothBoxId = booth!.boxId!;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(eq(station.name, 'Reception Till 1'))
    .limit(1);
  tillStationId = till!.id;

  /**
   * SCRUM-244 — this file's television is now a PAIRED one.
   *
   * The six `/booth/*` routes used to be open and every request below was
   * anonymous. They are not open any more: a screen is paired once by an
   * administrator and sends its credential on every call. So the fixture pairs
   * one, through the two routes rather than by writing the row, and every
   * request in this file carries the header — which means the pass-through
   * assertions go on saying exactly what they said, about a caller that is
   * now entitled to be making them.
   *
   * What this file deliberately does NOT test is the pairing itself. That is
   * `booth-pairing.test.ts`: an anonymous press, a wrong code, a spent code, a
   * revoked screen, a screen paired to another booth.
   */
  const minted = await ctx.app.inject({
    method: 'POST',
    url: `/booths/${boothStationId}/pairing-codes`,
    headers: { cookie: adminCookie },
    payload: { label: 'booth-api.test' },
  });
  if (minted.statusCode !== 200) throw new Error(`pairing code mint failed: ${minted.body}`);
  const paired = await ctx.app.inject({
    method: 'POST',
    url: '/booth/pair',
    payload: { code: minted.json().pairingCode },
  });
  if (paired.statusCode !== 200) throw new Error(`pairing failed: ${paired.body}`);
  deviceHeader = { [BOOTH_DEVICE_HEADER]: paired.json().deviceSecret as string };
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

/** Nothing stays attached between tests: the map is process-wide. */
afterEach(() => detachStubBoxes());

/**
 * The stub booth is `./stub-booth`, shared with `booth-pairing.test.ts`: one
 * `Booth` written out in full against the box's interface, whose every default
 * answer is one the real booth gives for a booth with nobody signed in. A test
 * that needs another answer overrides that one member and says why.
 */

/** That booth, on a box said to be running in this process. */
const attachBooth = (booth: Booth, opts: { offline?: boolean } = {}): BoxAgent =>
  attachStubBox(boothBoxId, booth, opts);

/** A box that is here but has no booth module at all — an agent with no store. */
const attachBoxWithoutBooth = (): BoxAgent => attachStubBox(boothBoxId, null);

const press = (payload: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  ctx.app.inject({
    method: 'POST',
    url: '/booth/spin',
    payload,
    headers: { ...deviceHeader, ...headers },
  });

describe('the booth surface is a pass-through (S2-07a)', () => {
  it('with no in-process agent, a press is refused — 503, and not a prize', async () => {
    const res = await press();

    expect(res.statusCode).toBe(503);
    const body = res.json();
    expect(body.error.code).toBe('BOOTH_NOT_ON_THIS_BOX');
    // The whole point: no draw happened up here. Not a prize index, not a
    // prize id, not a code, not a spin row — nothing a television could
    // animate to and nothing reception could ever be handed on paper.
    expect(body).not.toHaveProperty('prizeIndex');
    expect(body).not.toHaveProperty('prizeId');
    expect(body).not.toHaveProperty('voucherCode');
    expect(body).not.toHaveProperty('spinId');
  });

  it('a box that is here but has no booth module is refused the same way', async () => {
    attachBoxWithoutBooth();
    const res = await press();
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe('BOOTH_NOT_ON_THIS_BOX');
  });

  it('every booth route is refused when the booth is not on this box', async () => {
    const routes: Array<[string, string]> = [
      ['GET', '/booth/config'],
      ['GET', '/booth/status'],
      ['POST', '/booth/spin'],
      ['POST', '/booth/staff/sign-in'],
      ['POST', '/booth/staff/sign-out'],
      ['POST', '/booth/reprint'],
    ];
    for (const [method, url] of routes) {
      const res = await ctx.app.inject({
        method: method as 'GET' | 'POST',
        url,
        headers: deviceHeader,
        ...(method === 'POST' ? { payload: url.endsWith('sign-in') ? { pin: '2468' } : {} } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(503);
      expect(res.json().error.code, `${method} ${url}`).toBe('BOOTH_NOT_ON_THIS_BOX');
    }
  });

  it('the press the box answers is the press the television gets, verbatim', async () => {
    const calls = newCalls();
    attachBooth(stubBooth(calls));

    const res = await press(
      {},
      { [BOOTH_IDEMPOTENCY_HEADER]: 'press-0199a0f0', [BOOTH_ACTION_HEADER]: 'act-0199a0f0' },
    );

    expect(res.statusCode).toBe(200);
    // Field for field, including the nulls: the route neither adds to the
    // box's answer nor drops from it. `prizeId` beside `prizeIndex` is what
    // lets the page refuse to animate to a slice from a wheel it is not
    // showing, and a serialiser that quietly dropped it would take that check
    // away without failing anything.
    expect(res.json()).toEqual(SPIN);
    expect(calls.spin).toEqual([
      { simulate: false, idempotencyKey: 'press-0199a0f0', actionId: 'act-0199a0f0' },
    ]);
  });

  it('a simulated press travels as one, and a press key in the body is not stripped', async () => {
    const calls = newCalls();
    attachBooth(stubBooth(calls));

    // The body schema names every field the box's surface reads, which is why
    // this one survives: a schema that named only `simulate` would drop the
    // key here and the box would mint its own, turning a retry into a second
    // spin with nothing failing anywhere.
    await press({ simulate: true, idempotencyKey: 'press-in-the-body' });

    expect(calls.spin).toEqual([
      { simulate: true, idempotencyKey: 'press-in-the-body', actionId: null },
    ]);
  });

  it('a press with no key at all still reaches the box, which mints one', async () => {
    const calls = newCalls();
    attachBooth(stubBooth(calls));

    await press();

    // D7 is the box's to keep, not this route's: the platform's idempotency
    // store keys on an account and a television has none. What this pins is
    // that the api invents nothing — the key the box saw is the box's own.
    expect(calls.spin[0]!.idempotencyKey).toMatch(/[0-9a-f-]{36}/);
    expect(calls.spin[0]!.actionId).toBeNull();
  });

  it('the same press key twice reaches the box twice — the api replays nothing (SCRUM-298)', async () => {
    const calls = newCalls();
    attachBooth(stubBooth(calls));

    const key = 'press-0199a0f0-retry';
    const first = await press({}, { [BOOTH_IDEMPOTENCY_HEADER]: key });
    const second = await press({}, { [BOOTH_IDEMPOTENCY_HEADER]: key });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    /**
     * This is the positive form of what the idempotency plugin does NOT do
     * here, and it is deliberate rather than a gap.
     *
     * A row in the platform's replay store is owned by an account
     * (`core.idempotency_key.account_id` references `core.account`), so a
     * television — which carries no session by D15, and now a paired device
     * credential rather than an account — cannot hold one. If the api DID
     * answer the second press from a store, it would be answering for a draw
     * it never made: the prize, the voucher code and the cap all belong to the
     * box that spun the wheel, and a second press arriving after the box has
     * gone offline must be the box's to refuse, not ours to invent.
     *
     * So both presses arrive at the box, carrying the key the page minted, and
     * the box decides which of the two is a retry.
     * `packages/box-agent/test/booth.test.ts` pins that decision: the second
     * bump of one key is refused `duplicate_press`, and the held answer is
     * returned rather than a second draw.
     */
    expect(calls.spin).toEqual([
      { simulate: false, idempotencyKey: key, actionId: null },
      { simulate: false, idempotencyKey: key, actionId: null },
    ]);
    // And nothing up here marked the second one as replayed, because nothing
    // up here could have known.
    expect(second.headers['x-oto-replay']).toBeUndefined();
  });

  it('a refusal the box names arrives with the box’s own code and status', async () => {
    // D5: nothing active, under cap and in stock, so the press is refused
    // rather than drawn from an empty set. The page matches this code
    // literally and shows "Booth not ready — please call staff".
    const calls = newCalls();
    attachBooth(
      stubBooth(calls, {
        spin: async () => {
          throw new BoothRefusal('booth_not_ready', 'nothing eligible');
        },
      }),
    );

    const res = await press();
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('booth_not_ready');
  });

  it('a box that cannot record refuses with its own 503, distinct from the cloud’s', async () => {
    const calls = newCalls();
    attachBooth(
      stubBooth(calls, {
        spin: async () => {
          throw new BoothRefusal('runtime_unavailable', 'no counter table');
        },
      }),
    );

    const res = await press();
    expect(res.statusCode).toBe(503);
    // Two different 503s, and the difference is readable: this is the booth
    // saying it cannot keep a daily count, not the api saying the booth is on
    // another machine.
    expect(res.json().error.code).toBe('runtime_unavailable');
    expect(res.json().error.code).not.toBe('BOOTH_NOT_ON_THIS_BOX');
  });

  it('an unexpected fault stays the box’s to describe, and describes nothing', async () => {
    const calls = newCalls();
    attachBooth(
      stubBooth(calls, {
        spin: async () => {
          throw new Error('duplicate key value violates unique constraint "spin_pkey"');
        },
      }),
    );

    const res = await press();
    expect(res.statusCode).toBe(500);
    expect(res.json().error.code).toBe('internal');
    expect(res.body).not.toContain('duplicate key');
  });

  it('the api answers exactly what the box’s own surface answers', async () => {
    // The drift pin. `createBoothHttp` is the `/booth/*` contract; the Pi
    // wires it to its own server and this api wires it to Fastify. Asking
    // both for the same request and comparing is what says there is one
    // implementation rather than two that happen to agree today.
    const calls = newCalls();
    const booth = stubBooth(calls);
    attachBooth(booth);
    const direct = createBoothHttp({ booth, online: () => true });

    for (const [method, path] of [
      ['GET', '/config'],
      ['POST', '/reprint'],
    ] as const) {
      const mine = await ctx.app.inject({
        method,
        url: `/booth${path}`,
        headers: deviceHeader,
        ...(method === 'POST' ? { payload: {} } : {}),
      });
      const theirs = await direct({ method, path, body: {} });
      expect(mine.statusCode, path).toBe(theirs.status);
      expect(mine.json(), path).toEqual(theirs.body);
    }
  });

  it('the config bundle is handed over as the box holds it, unstripped', async () => {
    // No response schema on these routes, deliberately: a zod object drops
    // keys it does not know about, and a bundle from a box newer than this api
    // would reach the television with a field missing and nothing failing.
    const calls = newCalls();
    const bundle = { ...BUNDLE, somethingNewerBoxesSend: { keepMe: true } } as BoothConfigBundle;
    attachBooth(stubBooth(calls, { config: () => ({ version: 7, bundle }) }));

    const res = await ctx.app.inject({ method: 'GET', url: '/booth/config', headers: deviceHeader });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ version: 7, bundle });
  });

  it('whether the box has the cloud is the agent’s answer, carried into the status', async () => {
    const calls = newCalls();
    attachBooth(stubBooth(calls), { offline: true });

    const res = await ctx.app.inject({ method: 'GET', url: '/booth/status', headers: deviceHeader });

    // The one field on this surface the booth module has no opinion about.
    // The offline toggle the demo flips lives on the agent, and it is what
    // lights the dot on the television.
    expect(calls.statusOnline).toEqual([false]);
    expect(res.json().online).toBe(false);
  });

  it('sign-in and sign-out are the box’s decisions, carried', async () => {
    const calls = newCalls();
    attachBooth(
      stubBooth(calls, {
        signIn: async (request) => {
          calls.signIn.push(request);
          return { ok: false, retryAfterMs: 30_000 };
        },
      }),
    );

    const refused = await ctx.app.inject({
      method: 'POST',
      url: '/booth/staff/sign-in',
      headers: deviceHeader,
      payload: { pin: '0000' },
    });
    // A refusal is 200 with `ok: false`: the panel shows a countdown somebody
    // can act on, and a booth whose sign-in is being retried is not a booth
    // that is broken — the wheel is still spinning.
    expect(refused.statusCode).toBe(200);
    expect(refused.json()).toEqual({ ok: false, retryAfterMs: 30_000 });
    expect(calls.signIn).toEqual([{ pin: '0000' }]);

    const out = await ctx.app.inject({
      method: 'POST',
      url: '/booth/staff/sign-out',
      headers: deviceHeader,
      payload: {},
    });
    expect(out.statusCode).toBe(204);
    expect(calls.signOut).toBe(1);
  });

  it('a reprint never draws — the box’s copy is relayed whole, and its refusal with nobody signed in is the box’s 403', async () => {
    // A box with somebody signed in: the same code goes onto new paper and the
    // box says what became of it (SCRUM-223). Every real booth has this path.
    const calls = newCalls();
    attachBooth(
      stubBooth(calls, {
        reprint: async (request) => {
          calls.reprint.push(request);
          return REPRINT;
        },
      }),
    );

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/booth/reprint',
      headers: { ...deviceHeader, [BOOTH_ACTION_HEADER]: 'act-reprint-0199a0f0' },
      payload: { spinId: SPIN.spinId },
    });

    // A reprint needs the voucher, the printer and the staff session, and all
    // three are on the box: the api hands the request over as it came — the
    // spin asked for and the action id — and hands the answer back unchanged.
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(REPRINT);
    expect(calls.reprint).toEqual([{ spinId: SPIN.spinId, actionId: 'act-reprint-0199a0f0' }]);
    // Nothing was drawn, printed anew or minted on the way: a copy, not a draw.
    expect(calls.spin).toEqual([]);

    // A box with nobody signed in — the stub's own state — refuses it with its
    // code, and the api carries that as the 403 the panel knows: "sign in
    // first", which is not a broken booth.
    const nobody = newCalls();
    detachStubBoxes();
    attachBooth(stubBooth(nobody));
    const refused = await ctx.app.inject({
      method: 'POST',
      url: '/booth/reprint',
      headers: deviceHeader,
      payload: {},
    });
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error.code).toBe('staff_required');
    expect(nobody.reprint).toEqual([{ actionId: null }]);
    expect(nobody.spin).toEqual([]);
  });

  it('nothing on the booth surface names a station, a box or a person (D15)', async () => {
    const refused = await press();
    // The refusal says the booth is not here; WHICH booth, and which box it is
    // on, go to the log. A television in a shopping centre gets a status code.
    expect(refused.body).not.toContain(boothStationId);
    expect(refused.body).not.toContain(boothBoxId);
    expect(refused.json().error).not.toHaveProperty('details');

    const calls = newCalls();
    attachBooth(stubBooth(calls));
    const status = await ctx.app.inject({ method: 'GET', url: '/booth/status', headers: deviceHeader });
    // The document is the box's; what this pins is that the api adds nothing
    // to it on the way past — no station, no box, no branch, no account. The
    // shape's own rule, that `staffSignedIn` is a boolean rather than a
    // person and `staff` a name and a staff code for the corner of the
    // television (null, as here, when nobody is), is kept where the shape is.
    expect(Object.keys(status.json()).sort()).toEqual([
      'configVersion',
      'dailyCapsReached',
      'lastSpinAt',
      'neverSynced',
      'online',
      'paperStatus',
      'printerReachable',
      'staff',
      'staffSignedIn',
      'vouchersPending',
    ]);
    expect(status.json().staff).toBeNull();

    // A sign-in the box accepts tells the box WHO it was, and the surface
    // tells the television only that it worked: the account id stops at the
    // box (`BoothSignInResult.accountId`, "never sent to the television").
    const signedIn = '0199a0f0-0000-7000-8000-00000000a001';
    detachStubBoxes();
    attachBooth(stubBooth(newCalls(), { signIn: async () => ({ ok: true, accountId: signedIn }) }));
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/booth/staff/sign-in',
      headers: deviceHeader,
      payload: { pin: '2468' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true });
    expect(ok.body).not.toContain(signedIn);
  });
});

describe('the booth surface declares its guards (S2-07a)', () => {
  /**
   * The open list, pinned here as well as in `routes-guarded.test.ts`.
   *
   * The television carries no cookie, no account and no key (D15), so these
   * six are genuinely open and say so. What keeps a stranger from minting
   * vouchers on the park's api is that a booth is served by ITS box: an
   * instance with no in-process agent answers 503, which is the first test in
   * this file. Anything ADDED to this list is a new open endpoint and has to
   * be a decision somebody made on purpose.
   */
  it('the booth routes carry the screen’s credential, and the Console route is not one of them', () => {
    // SCRUM-244: these six were `public` and are now `credential: 'booth'` —
    // the same six, guarded rather than open. The only open booth route left
    // is `POST /booth/pair`, which is where a screen with no credential goes.
    const television = ctx.app.routeRegistry
      .filter((r) => r.url.startsWith('/booth/') && r.config.credential && r.method !== 'HEAD')
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(television).toEqual([
      'GET /booth/config',
      'GET /booth/status',
      'POST /booth/reprint',
      'POST /booth/spin',
      'POST /booth/staff/sign-in',
      'POST /booth/staff/sign-out',
    ]);
    const open = ctx.app.routeRegistry
      .filter((r) => r.url.startsWith('/booth') && r.config.public && r.method !== 'HEAD')
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(open).toEqual(['POST /booth/pair']);

    const consoleRoute = ctx.app.routeRegistry.find(
      (r) => r.url === '/booths/:id/status' && r.method === 'GET',
    );
    expect(consoleRoute?.config.public).toBeUndefined();
    expect(consoleRoute?.config.dynamicPermission).toBe(true);
  });

  it('the Console’s booth status refuses an anonymous caller and one without the permission', async () => {
    const anonymous = await ctx.app.inject({
      method: 'GET',
      url: `/booths/${boothStationId}/status`,
    });
    expect(anonymous.statusCode).toBe(401);

    // Reception works the booth; reading the estate panel is a manager's job.
    const denied = await ctx.app.inject({
      method: 'GET',
      url: `/booths/${boothStationId}/status`,
      headers: { cookie: receptionCookie },
    });
    expect(denied.statusCode).toBe(403);
  });
});

describe('the Console’s booth status (S2-07a)', () => {
  const statusOf = (id: string) =>
    ctx.app.inject({ method: 'GET', url: `/booths/${id}/status`, headers: { cookie: adminCookie } });

  it('answers from cloud rows: the booth, its box, the published wheel and today', async () => {
    const res = await statusOf(boothStationId);
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.booth.id).toBe(boothStationId);
    expect(body.booth.name).toBe('Booth 1');
    expect(body.box.id).toBe(boothBoxId);
    // Seeded, never heartbeaten in this test, so: not online and not here.
    expect(body.box.online).toBe(false);
    expect(body.box.inProcess).toBe(false);
    // The seed publishes version 1 so the wheel is playable before anybody
    // opens the admin panel.
    expect(body.config.publishedVersion).toBe(1);
    // The box has not reported a booth block — which is not evidence that it
    // is running nothing, and the field says so by being null rather than 0.
    expect(body.config.runningVersion).toBeNull();
    expect(body.today).toMatchObject({ spins: 0, unattributed: 0, dailyCapsReached: [] });
    expect(body.today.businessDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(body.lastSpinAt).toBeNull();
    // The booth's own printer, from the device row the box's heartbeat keeps
    // current — no round trip to the box to draw this panel.
    expect(body.printer).not.toBeNull();
  });

  it('says when the booth’s box is running in this process', async () => {
    attachBooth(stubBooth(newCalls()));
    const res = await statusOf(boothStationId);
    expect(res.json().box.inProcess).toBe(true);
  });

  it('a till is not a booth', async () => {
    const res = await statusOf(tillStationId);
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('BOOTH_NOT_FOUND');
  });
});
