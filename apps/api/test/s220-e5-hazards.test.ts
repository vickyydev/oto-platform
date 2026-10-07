import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { branch, deviceCredential, station } from '@oto/db';
import { BOOTH_DEVICE_HEADER, KIOSK_DEVICE_SCOPES, newId } from '@oto/shared';
import { CENTRAL_BRANCH_CODE, createTestContext, teardownAll, type TestContext } from './helpers';

/**
 * S2-20 E5 — THE EVENTS STORY'S CLOSING REGISTER (SCRUM-217; the E5 row of
 * docs/progress/plans/events-kiosk/PLAN.md §9, and §12's hazards).
 *
 *   1. EVERY HAZARD H1-H21 IS NAMED TO A TEST THAT RUNS. The register below
 *      names, for each hazard, the test that holds it — by its file and its
 *      title — and this suite checks each one is there and is a plain test:
 *      not pinned to fail (`it.fails`), not skipped, not a todo. The hazards
 *      are the plan's own (§12, read from PLAN.md), so a hazard added there
 *      and not named here fails. The tests themselves run in their own files
 *      (the s220 / events / kiosk / g17 suites).
 *   2. NO WIRED SCREEN IS LEFT ON A MOCK PATH: the screens the events story
 *      wired read the platform, never `mockApi`'s event functions or the
 *      prototype's in-browser event mutators.
 *   3. EVERY EVENTS ROUTE IS GUARDED: each route of the events story — the
 *      events and party routes, the walk-up prices, the kiosk's own routes
 *      and the analytics that read them — declares its guard, and the open
 *      one (the booking site's event passes) is the one that should be.
 *   4. H18 on the platform: a kiosk's credential opens no booth route, a
 *      booth's credential no kiosk route, and a kiosk credential bound to a
 *      booth station serves no self-service redemption.
 */

const TEST_DIR = fileURLToPath(new URL('.', import.meta.url));
const POS_SRC = fileURLToPath(new URL('../../pos/src', import.meta.url));

/** Each hazard, and the tests that hold it: [file, a fragment of the test's title]. */
const REGISTER: Record<string, Array<[string, string]>> = {
  H1: [
    ['otoapp-events-seam.test.ts', 'no file in src names an OTO App event table'],
    ['s220-e1-review.test.ts', 'only the read-only repository names otoapp_v'],
  ],
  H2: [
    ['events-e2.test.ts', 'check 2 — no tender, no child (H2)'],
    ['s220-e5-acceptance.test.ts', 'cancelled at payment — a paid pass with no tender'],
  ],
  H3: [
    ['events-e2.test.ts', 'a second retry and a till replay change nothing'],
    ['events-e5.test.ts', 'the app down at payment: the money stands, the pass waits pending'],
  ],
  H4: [
    ['events-e3.test.ts', 'H4 — two tills check the same child in at once'],
    ['events-e3-offline.test.ts', 'H4 offline — the second check-in of one child-day resolves to the first'],
    ['events-e5-audit.test.ts', 'is that day’s second check-in — filed, not quarantined'],
  ],
  H5: [
    ['events-e3.test.ts', 'H5 — a camp child is not checked in on a day they are not registered'],
    ['s220-e3-review.test.ts', 'the edge child is in on each edge day and refused between (H5)'],
  ],
  H6: [['events-e3.test.ts', 'no supervision gate appears at any point (H6)']],
  H7: [['events-e3.test.ts', 'H7 — History finds the band and names no sale']],
  H8: [['events-e3.test.ts', 'H8 — at the gate the kid band is denied and the parent band admitted']],
  H9: [['events-e3.test.ts', 'H9 — the kid band at F&B returns the allergy and diet lines']],
  H10: [
    ['events-e4.test.ts', 'End of Day: the payment is on party_prepay, not on a card line (H10)'],
    ['s220-e5-acceptance.test.ts', 'the payment is on party_prepay, not under card (H10)'],
  ],
  H11: [['events-e4.test.ts', 'H11 — two tills paying the whole balance at once']],
  H12: [['events-e4.test.ts', 'the protected fields (H12)']],
  H13: [
    ['kiosk-k1.test.ts', 'leaves the booking paid and unredeemed, records no hand-off, and sends the guest to the desk'],
    ['events-e5.test.ts', 'the pass’s check-in included — is called off (H13)'],
  ],
  H14: [
    ['kiosk-k1.test.ts', 'a booking that is all drop-off issues nothing and shows the staff desk'],
    ['s220-k2-kiosk-surface.test.ts', 'a drop-off booking goes to the staff desk'],
  ],
  H15: [
    ['kiosk-k1.test.ts', 'issues its bands and wallet credit once, printed on the kiosk box before anything is committed'],
    ['events-e5.test.ts', 'issues the tickets’ bands and the pass’s bands, printed on the kiosk before anything commits'],
  ],
  H16: [['kiosk-k1.test.ts', 'H16 — the kiosk scope is a device’s, and no person holds it']],
  H17: [['kiosk-k1.test.ts', 'H17 — the same press sent again issues nothing twice']],
  H18: [['s220-e5-hazards.test.ts', 'H18 — a kiosk credential opens no booth route']],
  H19: [
    ['events-e1.test.ts', 'H19 — a missed refresh raises the expectation alert'],
    ['s220-e1-review.test.ts', 'H19 — its expectation raises ops.missing when the refresh stops running'],
  ],
  H20: [['s220-e3-review.test.ts', "00:30 on the day after the camp is the branch's business date"]],
  H21: [
    ['g17-round0-review.test.ts', "an id another tenant's attendee holds is refused"],
    ['g17-round0-review.test.ts', "tenant B's key on tenant A's event is 404 and writes nothing"],
  ],
};

/** The hazards of the plan's §12 table, in its order. */
function planHazards(): string[] {
  const plan = readFileSync(join(TEST_DIR, '../../../docs/progress/plans/events-kiosk/PLAN.md'), 'utf8');
  return [...plan.matchAll(/^\| (H\d+) \|/gm)].map((m) => m[1]!);
}

/** The title of every `it`/`describe`/`test` in a file, with how it is declared (`it`, `it.fails`, …). */
function titlesOf(file: string): Array<{ call: string; title: string }> {
  const text = readFileSync(join(TEST_DIR, file), 'utf8');
  const found: Array<{ call: string; title: string }> = [];
  const re = /\b((?:it|describe|test)(?:\.\w+)?)\(\s*(['"`])((?:\\.|(?!\2)[\s\S])*?)\2/g;
  for (const m of text.matchAll(re)) found.push({ call: m[1]!, title: m[3]! });
  return found;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('every hazard H1-H21 is named to a test that runs', () => {
  it('the register covers every hazard of the plan, H1 to H21, each with at least one test', () => {
    expect(planHazards()).toEqual(Array.from({ length: 21 }, (_, i) => `H${i + 1}`));
    expect(Object.keys(REGISTER)).toEqual(planHazards());
    for (const [hazard, tests] of Object.entries(REGISTER)) expect(tests.length, hazard).toBeGreaterThan(0);
  });

  it('each named test is there, and is a plain test — not pinned to fail, skipped or left a todo', () => {
    const problems: string[] = [];
    for (const [hazard, tests] of Object.entries(REGISTER)) {
      for (const [file, fragment] of tests) {
        let titles: Array<{ call: string; title: string }>;
        try {
          titles = titlesOf(file);
        } catch {
          problems.push(`${hazard}: ${file} is not there`);
          continue;
        }
        const hits = titles.filter((t) => t.title.includes(fragment));
        if (hits.length === 0) problems.push(`${hazard}: no test in ${file} titled "${fragment}"`);
        for (const hit of hits) {
          if (!['it', 'describe', 'test'].includes(hit.call)) problems.push(`${hazard}: ${file} "${fragment}" is ${hit.call}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it('no event or kiosk suite still carries a test pinned to fail, but the R3-1 clock pin the owner kept', () => {
    const suites = readdirSync(TEST_DIR).filter((f) => /^(events-|s220-|kiosk-|otoapp-events)/.test(f) && f.endsWith('.test.ts'));
    const pinned = suites.flatMap((file) =>
      titlesOf(file)
        .filter((t) => /\.(fails|skip|todo)$/.test(t.call))
        .map((t) => `${file}: ${t.call}(${t.title.slice(0, 80)})`),
    );
    // R3-1 — a box whose clock the envelope calls untrusted: a pin by the owner's ruling, kept as one.
    expect(pinned).toEqual([
      expect.stringContaining("s220-e3-review-3-offline.test.ts: it.fails(the platform knows the box's clock is untrusted"),
    ]);
  });
});

describe('no wired screen is left on a mock path', () => {
  /** The prototype's event functions and in-browser event mutators. */
  const MOCK_EVENT_CALLS = /\b(getEventsForDate|getEventById|getActiveEventPasses|addEventAttendee|checkInEventAttendee|checkOutEventAttendee|updateParty|addPartyExtraCharge|addPartyPayment|getEventDropInPricing|updateEventDropInPricing|sellEventPass|checkInSoldPass|dispatchEventBracelets)\s*\(/;

  it('the screens of the events story call none of the prototype’s event functions', () => {
    const offenders = sourceFiles(POS_SRC)
      .map((f) => relative(POS_SRC, f).split('\\').join('/'))
      // The prototype's own copies are kept as reference beside the platform's
      // (`lib/eventPass.ts`, `mockApi.ts`); every screen below must not call them.
      .filter((rel) => !/^(mockApi\.ts|lib\/eventPass\.ts|lib\/eventRoster\.ts|lib\/party\.ts)$/.test(rel))
      .filter((rel) => {
        const src = readFileSync(join(POS_SRC, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
        return MOCK_EVENT_CALLS.test(src);
      });
    expect(offenders).toEqual([]);
  });

  it('the booking site offers passes from the platform and pays for them there', () => {
    const book = readFileSync(join(POS_SRC, 'pages/Book.tsx'), 'utf8');
    expect(book).toContain('publicApi');
    expect(book).toMatch(/\.eventPasses\(/);
    expect(book).not.toContain('Event passes are booked at reception');
  });
});

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
}, 300_000);
afterAll(async () => {
  await ctx?.close();
  await teardownAll();
});

describe('every events route is guarded', () => {
  const EVENTS_ROUTE = /^\/(events|parties|analytics|kiosk|kiosk-desk)(\/|$)|event-drop-in-pricing|\/kiosk\/|\/event-passes$/;

  it('each declares its guard; the one open route is the booking site’s offer of passes', () => {
    const routes = ctx.app.routeRegistry.filter((r) => EVENTS_ROUTE.test(r.url) && r.method !== 'HEAD' && r.method !== 'OPTIONS');
    expect(routes.length).toBeGreaterThan(20);
    const open = routes.filter((r) => r.config.public).map((r) => `${r.method} ${r.url}`);
    expect(open).toEqual(['GET /public/branches/:code/event-passes']);
    const unguarded = routes.filter(
      (r) => !r.config.public && !r.config.permission && !r.config.dynamicPermission && !r.config.platformWide && !r.config.credential,
    );
    expect(unguarded.map((r) => `${r.method} ${r.url}`)).toEqual([]);
  });

  it('the events and party routes take the events permissions, the walk-up prices the pricing one, the kiosk its own credential', () => {
    const wrong: string[] = [];
    for (const r of ctx.app.routeRegistry) {
      if (r.method === 'HEAD' || r.method === 'OPTIONS') continue;
      const permission = typeof r.config.permission === 'string' ? r.config.permission : '';
      const name = `${r.method} ${r.url}`;
      if (/^\/events(\/|$)/.test(r.url) && !permission.startsWith('pos:event:')) wrong.push(`${name}: ${permission}`);
      if (/^\/parties(\/|$)/.test(r.url) && !/^pos:(party|event):/.test(permission)) wrong.push(`${name}: ${permission}`);
      if (/event-drop-in-pricing/.test(r.url) && r.method !== 'GET' && permission !== 'admin:event_pricing:manage') {
        wrong.push(`${name}: ${permission}`);
      }
      if (/^\/box\/v1\/station\/:stationId\/kiosk\//.test(r.url) && !['kiosk', 'kiosk-pairing'].includes(String(r.config.credential))) {
        wrong.push(`${name}: credential ${String(r.config.credential)}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('a caller with no session is refused on every events read', async () => {
    const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
    for (const url of [
      `/events?branchId=${hkt!.id}`,
      `/events/passes?branchId=${hkt!.id}`,
      `/events/${newId()}?branchId=${hkt!.id}`,
      `/events/${newId()}/roster?branchId=${hkt!.id}`,
      `/parties/${newId()}?branchId=${hkt!.id}`,
      `/branches/${hkt!.id}/event-drop-in-pricing`,
    ]) {
      const res = await ctx.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });
});

describe('H18 — a kiosk credential opens no booth route, and a booth station serves no self-service', () => {
  const SECRET = randomBytes(32).toString('hex');
  const SHA = (value: string) => createHash('sha256').update(value).digest('hex');

  it('a kiosk credential bound to a booth station is no kiosk: its redemption, state and sessions are refused', async () => {
    const [booth] = await ctx.db.select().from(station).where(eq(station.kind, 'booth')).limit(1);
    expect(booth, 'the seed has a booth station').toBeDefined();
    await ctx.db.insert(deviceCredential).values({
      id: newId(),
      operatorId: booth!.operatorId,
      branchId: booth!.branchId,
      kind: 'kiosk',
      stationId: booth!.id,
      label: 'A kiosk credential on a booth',
      secretHash: SHA(SECRET),
      scopes: [...KIOSK_DEVICE_SCOPES],
      pairedAt: new Date(),
    });
    const headers = { authorization: `Bearer ${SECRET}` };
    const redeem = await ctx.app.inject({
      method: 'POST',
      url: `/box/v1/station/${booth!.id}/kiosk/redeem`,
      headers,
      payload: { actionId: newId(), qr: 'not-a-booking' },
    });
    expect(redeem.statusCode).toBe(401);
    expect(redeem.json().error.code).toBe('KIOSK_UNPAIRED');
    const state = await ctx.app.inject({ method: 'GET', url: `/box/v1/station/${booth!.id}/kiosk/state`, headers });
    expect(state.statusCode).toBe(401);
  });

  it('a kiosk’s credential, sent to the booth’s routes as a booth would send its own, opens none of them', async () => {
    const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, CENTRAL_BRANCH_CODE));
    const kioskId = newId();
    await ctx.db.insert(station).values({
      id: kioskId,
      operatorId: hkt!.operatorId,
      branchId: hkt!.id,
      name: 'Hazard kiosk',
      kind: 'kiosk',
      codePrefix: 'HK',
      capabilities: [],
      accessScope: 'all_staff',
    });
    const secret = randomBytes(32).toString('hex');
    await ctx.db.insert(deviceCredential).values({
      id: newId(),
      operatorId: hkt!.operatorId,
      branchId: hkt!.id,
      kind: 'kiosk',
      stationId: kioskId,
      label: 'Hazard kiosk screen',
      secretHash: SHA(secret),
      scopes: [...KIOSK_DEVICE_SCOPES],
      pairedAt: new Date(),
    });
    // The kiosk's own route answers it…
    const own = await ctx.app.inject({ method: 'GET', url: `/box/v1/station/${kioskId}/kiosk/state`, headers: { authorization: `Bearer ${secret}` } });
    expect(own.statusCode).toBe(200);
    // …and no booth route does, by either header.
    for (const url of ['/booth/config', '/booth/status']) {
      for (const headers of [{ authorization: `Bearer ${secret}` }, { [BOOTH_DEVICE_HEADER]: secret }]) {
        const res = await ctx.app.inject({ method: 'GET', url, headers });
        expect([401, 403], `${url} ${Object.keys(headers)[0]}`).toContain(res.statusCode);
      }
    }
    // A kiosk at one station is refused at another's door.
    const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, hkt!.id), eq(station.codePrefix, 'T1')));
    const elsewhere = await ctx.app.inject({
      method: 'GET',
      url: `/box/v1/station/${till!.id}/kiosk/state`,
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(elsewhere.statusCode).toBe(403);
  });
});
