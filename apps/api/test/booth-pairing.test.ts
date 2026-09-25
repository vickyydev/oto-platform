import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, deviceCredential, spin, station } from '@oto/db';
import type { BoxAgent } from '@oto/box-agent';
import { BOOTH_DEVICE_HEADER, newId } from '@oto/shared';
import {
  ADMIN,
  RECEPTION,
  SECOND_OPERATOR_ADMIN,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { SPIN, attachStubBox, detachStubBoxes, newCalls, stubBooth, type BoothCalls } from './stub-booth';

/**
 * SCRUM-244 — the booth television is a PAIRED screen.
 *
 * `booth-api.test.ts` pins that the api decides nothing about a spin. This
 * file pins the thing that was missing underneath it: **who is allowed to ask
 * for one.** Until this ticket the six `/booth/*` routes were open, and on a
 * deployment running the virtual box — staging — `POST /booth/spin` was a URL
 * a stranger could press to mint a voucher the park would honour. It is the
 * same shape as the flaw the intake recorded against the outgoing game, where
 * `POST /api/wins` was open to anybody who found it.
 *
 * D15 is untouched and is why the credential is PAIRED rather than bundled:
 * nothing ships a token to a screen in a shopping centre. A member of staff
 * mints six digits in the Console, types them into the booth once, and the
 * browser keeps what those digits buy.
 *
 * The first test in this file is the one that matters. Everything after it
 * closes a way round it: a code that is wrong, a code that is spent, a screen
 * that was unpaired, a screen paired to a different booth, and an
 * administrator of another operator trying to mint a code for this one.
 */

let ctx: TestContext;
let adminCookie: string;
let receptionCookie: string;
let foreignAdminCookie: string;
let boothStationId: string;
let boothBoxId: string;
/** A second booth, with no box — so this process still serves exactly one. */
let otherBoothId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  receptionCookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  foreignAdminCookie = await signInAs(
    ctx.app,
    SECOND_OPERATOR_ADMIN.phone,
    SECOND_OPERATOR_ADMIN.password,
  );

  const [booth] = await ctx.db.select().from(station).where(eq(station.name, 'Booth 1')).limit(1);
  boothStationId = booth!.id;
  boothBoxId = booth!.boxId!;

  /**
   * A second booth at the same branch, deliberately with NO box.
   *
   * `resolveInProcessBooth` refuses to guess between two booths whose boxes
   * are both in this process, so a second booth with a box would break every
   * other test here. With none, it is passed over and this process still
   * serves Booth 1 — which is exactly the shape needed to ask the question
   * this booth exists for: a screen legitimately paired to ANOTHER booth
   * must not be able to press this one's button.
   */
  otherBoothId = newId();
  await ctx.db.insert(station).values({
    id: otherBoothId,
    operatorId: booth!.operatorId,
    branchId: booth!.branchId,
    name: 'Booth 2 (unboxed)',
    kind: 'booth',
  });
});

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

afterEach(() => detachStubBoxes());

// --- A booth on a box in this process ---------------------------------------

/**
 * The draws this stub was asked for, read off what it recorded.
 *
 * It is the sharpest assertion in the file. "No spin row was written" is true
 * of a refusal and also true of a box that was never asked, and only one of
 * those is the guarantee: the box is what records a spin and puts paper in
 * somebody's hand, so what has to be shown is that **the refusal happened
 * before the box heard about it.**
 *
 * The stub is `./stub-booth`, the same one `booth-api.test.ts` drives: a
 * `Booth` written out in full against the box's interface, answering every
 * press with `SPIN` and everything else as a booth with nobody signed in does.
 */
let calls: BoothCalls;
const drawsAsked = (): number => calls.spin.length;

function attachStubBooth(): BoxAgent {
  calls = newCalls();
  return attachStubBox(boothBoxId, stubBooth(calls));
}

// --- Pairing, as the Console and the booth do it ----------------------------

async function mintCode(
  boothId: string = boothStationId,
  cookie: string = adminCookie,
  extra: Record<string, unknown> = {},
) {
  return ctx.app.inject({
    method: 'POST',
    url: `/booths/${boothId}/pairing-codes`,
    headers: { cookie },
    payload: { label: 'television', ...extra },
  });
}

async function pair(code: string) {
  return ctx.app.inject({ method: 'POST', url: '/booth/pair', payload: { code } });
}

/** Mint, redeem, and hand back the header a paired screen sends. */
async function pairedScreen(boothId: string = boothStationId): Promise<Record<string, string>> {
  const minted = await mintCode(boothId);
  expect(minted.statusCode, minted.body).toBe(200);
  // Who authorised this screen is recorded at the MINT: the person who types
  // the code in is anonymous by design, so the administrator who issued it is
  // the only accountable party there is.
  expect(minted.json().credential.pairedByAccountId).not.toBeNull();
  const paired = await pair(minted.json().pairingCode as string);
  expect(paired.statusCode, paired.body).toBe(200);
  return { [BOOTH_DEVICE_HEADER]: paired.json().deviceSecret as string };
}

const press = (headers: Record<string, string> = {}) =>
  ctx.app.inject({ method: 'POST', url: '/booth/spin', payload: {}, headers });

const spinRows = async (): Promise<number> =>
  (await ctx.db.select({ id: spin.id }).from(spin)).length;

// --- The hole this ticket closes --------------------------------------------

describe('an unpaired screen cannot press the button (SCRUM-244)', () => {
  it('an anonymous press is refused before the box is ever asked, and writes no spin', async () => {
    attachStubBooth();
    const before = await spinRows();

    const res = await press();

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('BOOTH_UNPAIRED');
    // The box was never asked to draw. This is the assertion the ticket is
    // about: before it, this same request returned a prize index, a voucher
    // code and an expiry to whoever sent it.
    expect(drawsAsked()).toBe(0);
    expect(await spinRows()).toBe(before);
    // And nothing a television could animate to came back either.
    expect(res.body).not.toContain('prizeIndex');
    expect(res.body).not.toContain('voucherCode');
  });

  it('every television route refuses a caller with no credential', async () => {
    attachStubBooth();
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
        ...(method === 'POST' ? { payload: url.endsWith('sign-in') ? { pin: '2468' } : {} } : {}),
      });
      expect(res.statusCode, `${method} ${url}`).toBe(401);
      expect(res.json().error.code, `${method} ${url}`).toBe('BOOTH_UNPAIRED');
    }
    expect(drawsAsked()).toBe(0);
  });

  it('a made-up credential is refused, and so is a well-formed one nobody minted', async () => {
    attachStubBooth();
    for (const secret of ['', 'not-a-secret', 'f'.repeat(64), '0'.repeat(64)]) {
      const res = await press({ [BOOTH_DEVICE_HEADER]: secret });
      expect(res.statusCode, secret.slice(0, 8)).toBe(401);
      expect(res.json().error.code).toBe('BOOTH_UNPAIRED');
    }
    expect(drawsAsked()).toBe(0);
  });

  it('the refusal names no booth, no box and no station (D15)', async () => {
    const res = await press();
    expect(res.body).not.toContain(boothStationId);
    expect(res.body).not.toContain(boothBoxId);
    expect(res.json().error).not.toHaveProperty('details');
  });
});

describe('a paired screen presses the button (SCRUM-244)', () => {
  it('pairs with the six digits, and the next press reaches the box', async () => {
    attachStubBooth();
    const device = await pairedScreen();

    const res = await press(device);

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SPIN);
    expect(drawsAsked()).toBe(1);
  });

  it('the credential is the screen’s own, and is never handed back a second time', async () => {
    const minted = await mintCode();
    const code = minted.json().pairingCode as string;
    expect(code).toMatch(/^\d{6}$/);

    const first = await pair(code);
    expect(first.statusCode).toBe(200);
    const secret = first.json().deviceSecret as string;
    expect(secret).toMatch(/^[0-9a-f]{64}$/);

    // Single use. A second screen typing the same digits gets nothing — which
    // is what stops one code pairing a row of televisions.
    const second = await pair(code);
    expect(second.statusCode).toBe(401);
    expect(second.json().error.code).toBe('BOOTH_UNPAIRED');
    expect(second.body).not.toContain(secret);
  });

  it('only the hash is stored — the code and the secret are in no row', async () => {
    const minted = await mintCode();
    const code = minted.json().pairingCode as string;
    const paired = await pair(code);
    const secret = paired.json().deviceSecret as string;

    const rows = await ctx.db.select().from(deviceCredential).where(eq(deviceCredential.kind, 'booth'));
    for (const row of rows) {
      expect(row.pairingCodeHash).not.toBe(code);
      expect(row.secretHash).not.toBe(secret);
    }
    // And the redeemed row keeps no code at all: the hash is nulled, which is
    // what makes the single-use guard a property of the database.
    const [redeemed] = await ctx.db
      .select()
      .from(deviceCredential)
      .where(and(eq(deviceCredential.kind, 'booth'), eq(deviceCredential.secretHash, sha256(secret))));
    expect(redeemed?.pairingCodeHash).toBeNull();
    expect(redeemed?.pairedAt).not.toBeNull();
  });
});

describe('a code that should not work (SCRUM-244)', () => {
  it('a wrong code is refused and leaves the real one usable', async () => {
    attachStubBooth();
    const minted = await mintCode();
    const good = minted.json().pairingCode as string;
    // Anything but the minted one. Six digits, so it reaches the lookup rather
    // than being turned away by the shape check.
    const wrong = good === '000000' ? '111111' : '000000';

    const bad = await pair(wrong);
    expect(bad.statusCode).toBe(401);
    expect(bad.json().error.code).toBe('BOOTH_UNPAIRED');

    // The guess spent nothing: the outstanding code is still outstanding.
    const good2 = await pair(good);
    expect(good2.statusCode).toBe(200);
    const res = await press({ [BOOTH_DEVICE_HEADER]: good2.json().deviceSecret as string });
    expect(res.statusCode).toBe(200);
  });

  it('two screens racing on the same code produce one credential, not two', async () => {
    /**
     * Two sends at once — a member of staff pressing twice, or one code read
     * out loud to two screens — yield one credential.
     *
     * **What refuses the loser here, measured rather than assumed.** The
     * redemption nulls `pairing_code_hash`, so a second send finds no row at
     * the LOOKUP and never reaches the update; that is what this test
     * observes, and it observes it on this harness even when the two calls
     * are started together, because `app.inject` did not interleave them
     * across the lookup.
     *
     * The predicate on the UPDATE — `pairing_code_hash = <hash>` in its WHERE
     * clause — is the backstop for the interleave that this harness could not
     * force: two requests both past the lookup, the second's update blocking
     * on the first's row lock and then re-evaluating against a row whose hash
     * is now null. **Deleting that predicate was planted and this file stayed
     * green**, so nothing here covers it. It is kept because the failure it
     * prevents is two televisions holding credentials for one booth, of which
     * the Console could see only the second — and covering it needs a hook
     * between the read and the write that the service does not have.
     */
    const code = (await mintCode()).json().pairingCode as string;

    const [a, b] = await Promise.all([pair(code), pair(code)]);
    const answers = [a.statusCode, b.statusCode].sort();

    expect(answers).toEqual([200, 401]);
    const winner = a.statusCode === 200 ? a : b;
    expect((winner.json().deviceSecret as string)).toMatch(/^[0-9a-f]{64}$/);

    // And exactly one live credential came out of it, not two.
    const rows = await ctx.db
      .select()
      .from(deviceCredential)
      .where(
        and(
          eq(deviceCredential.kind, 'booth'),
          eq(deviceCredential.secretHash, sha256(winner.json().deviceSecret as string)),
        ),
      );
    expect(rows.length).toBe(1);
  });

  it('a malformed code is refused like a wrong one — the same 401 BOOTH_UNPAIRED with no hint of the shape — and only an empty one is the schema’s 400', async () => {
    // A code that is not six digits fails the shape check inside the service,
    // and what comes back is the refusal a wrong code gets: no details, and
    // nothing in it about what a real code looks like. Whether that check ran
    // before or instead of a lookup is not observable from here, and is not
    // claimed.
    for (const code of ['12', 'abcdef', '1234567']) {
      const res = await pair(code);
      expect(res.statusCode, code).toBe(401);
      expect(res.json().error.code, code).toBe('BOOTH_UNPAIRED');
      expect(res.json().error, code).not.toHaveProperty('details');
      expect(res.body, code).not.toMatch(/digit|six|\b6\b/i);
    }
    // An empty code never reaches the service: the body schema refuses it,
    // which is the platform's 400 — `min(1)` says only that something has to
    // be typed, which is no hint either.
    const empty = await pair('');
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe('VALIDATION');
  });

  it('minting again replaces the booth’s outstanding code rather than adding one', async () => {
    /**
     * The property that stands in for replay protection here.
     *
     * The answer carries a credential, so the route declares `secretResponse`
     * and the idempotency plugin claims no key — a double press on "Pair a
     * screen" genuinely mints twice. What makes that safe is this: the first
     * code is dead the moment the second exists, so the code a manager is
     * looking at is the only one that works and the one they pressed past is
     * not lying around for ten minutes.
     */
    const first = (await mintCode()).json().pairingCode as string;
    const second = (await mintCode()).json().pairingCode as string;
    expect(second).not.toBe(first);

    const stale = await pair(first);
    expect(stale.statusCode).toBe(401);

    const live = await pair(second);
    expect(live.statusCode).toBe(200);
  });
});

describe('unpairing a screen (SCRUM-244)', () => {
  it('a revoked screen is refused on its very next press', async () => {
    attachStubBooth();
    const device = await pairedScreen();
    expect((await press(device)).statusCode).toBe(200);

    const screens = await ctx.app.inject({
      method: 'GET',
      url: `/booths/${boothStationId}/screens`,
      headers: { cookie: adminCookie },
    });
    expect(screens.statusCode).toBe(200);
    const live = (screens.json().screens as Array<{ id: string; pairedAt: string | null; revokedAt: string | null }>)
      .find((s) => s.pairedAt !== null && s.revokedAt === null);
    expect(live).toBeTruthy();

    const revoked = await ctx.app.inject({
      method: 'POST',
      url: `/booths/${boothStationId}/screens/${live!.id}/revoke`,
      headers: { cookie: adminCookie },
      payload: { reason: 'television replaced' },
    });
    expect(revoked.statusCode, revoked.body).toBe(200);
    expect(revoked.json().screen.revokedAt).not.toBeNull();

    const after = await press(device);
    expect(after.statusCode).toBe(401);
    expect(after.json().error.code).toBe('BOOTH_UNPAIRED');
    // One draw for the press before the revoke, and none after it.
    expect(drawsAsked()).toBe(1);
  });
});

describe('a screen belongs to one booth (SCRUM-244)', () => {
  it('a screen paired to another booth cannot press this one’s button', async () => {
    attachStubBooth();
    // Legitimately paired — by the same administrator, at the same branch —
    // just not to the booth this process is serving.
    const elsewhere = await pairedScreen(otherBoothId);

    const res = await press(elsewhere);

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('BOOTH_UNPAIRED');
    expect(drawsAsked()).toBe(0);
    // The refusal does not say which booth it IS paired to, or which one is
    // here: a caller holding a lifted credential learns nothing from it.
    expect(res.body).not.toContain(otherBoothId);
    expect(res.body).not.toContain(boothStationId);
  });
});

describe('who may mint a pairing code (SCRUM-244)', () => {
  it('the second operator’s administrator cannot mint one for this booth', async () => {
    const res = await mintCode(boothStationId, foreignAdminCookie);
    // 404, not 403: an administrator of another tenant is not told that this
    // booth exists.
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe('BOOTH_NOT_FOUND');
  });

  it('reception works the booth and does not pair screens', async () => {
    const res = await mintCode(boothStationId, receptionCookie);
    expect(res.statusCode).toBe(403);
  });

  it('an anonymous caller cannot mint one', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/booths/${boothStationId}/pairing-codes`,
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('the mint is audited, and the audit row carries no code', async () => {
    const minted = await mintCode();
    const code = minted.json().pairingCode as string;

    const rows = await ctx.db
      .select()
      .from(auditLog)
      .where(eq(auditLog.action, 'booth.pairing_code_mint'));
    expect(rows.length).toBeGreaterThan(0);
    const latest = rows[rows.length - 1]!;
    expect(latest.entityType).toBe('device_credential');
    expect(latest.actorAccountId).not.toBeNull();
    expect(JSON.stringify(latest.after)).not.toContain(code);
    expect(JSON.stringify(latest.after)).toContain(boothStationId);

    // And the redemption is audited too, by nobody — there is no account at a
    // booth, which is the whole reason the code exists.
    await pair(code);
    const paired = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'booth.pair'));
    expect(paired.length).toBeGreaterThan(0);
    expect(paired[paired.length - 1]!.actorAccountId).toBeNull();
  });
});

/** The same digest the service stores, so a row can be found by its secret. */
function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
