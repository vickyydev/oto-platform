import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import {
  auditLog,
  boxCommand,
  branch,
  device,
  member,
  opsRun,
  paymentAttempt,
  station,
  ticketPackage,
} from '@oto/db';
import {
  createBoxAgent,
  memoryCredentialStore,
  type AgentFetch,
  type BoxAgent,
} from '@oto/box-agent';
import { ATTEMPT_ALLOW_LIST, newId } from '@oto/shared';
import {
  ADMIN,
  RECEPTION,
  createTestContext,
  signInAs,
  teardownAll,
  type TestContext,
} from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { attachInProcessBox, provisionVirtualBox } from '../src/services/box';

/**
 * S2-10a (SCRUM-206, Slice C2) — NO CARD NUMBER, NO CARDHOLDER, NO RAW FRAME.
 *
 * Both vendors hand the box things that have no business in our database. A
 * GHL card response carries `card_no` and a Digio `A1` carries a masked PAN on
 * tag `09` and the cardholder's name on tag `0A` — the two fixtures below are
 * the real ones C1 recorded off the wire between the adapter and the simulator,
 * with the identities the park's own terminals report on them.
 *
 * THREE NETS, and this file drives all three rather than asserting one:
 *
 *  1. **The parser, on the box.** It reduces the masked PAN to four digits and
 *     drops the cardholder's name where it reads them, so the cloud is never
 *     offered either. The first case proves that by taking a real card tender
 *     the whole way round and looking for the placeholder anywhere.
 *  2. **The route's schema.** zod names what a box may say and strips the rest,
 *     so an agent that posted a raw frame for convenience — or a firmware
 *     version that starts sending a name — has it dropped before anything reads
 *     it. The second case posts exactly that.
 *  3. **`ATTEMPT_ALLOW_LIST` and `packages/telemetry`'s redaction.** What is
 *     stored on the attempt is an allow-listed projection, and every
 *     `ops_run.detail` goes through the redactor on its way in.
 *
 * AND THE ONE THING THAT IS NOT A LEAK, stated here so nobody "fixes" it: an
 * approval code on `pos.payment_attempt` is correct — it is the money record,
 * and a void cannot be sent without it — while the same code inside an
 * `ops_run.detail` is redacted, because that is a page in a browser. The last
 * case pins both halves.
 */

/**
 * A Digio SALE response (`A1`), approved — byte for byte
 * `packages/box-agent/test/fixtures/terminal/digio/sale-response-card-approved.hex`.
 *
 * Tag `09` is `424242******4242` and tag `0A` is `TEST CARDHOLDER`, both
 * plainly readable in the hex below. Nothing that posts this at the api may
 * leave either of them anywhere.
 */
const DIGIO_A1_FRAME =
  '3E5581E82102413101053130303530040634383030303122033130300518353433353535343832363039323331343035303030303031060652303030303107023030080B566973612043726564697409103432343234322A2A2A2A2A2A343234320A0F544553542043415244484F4C4445520B063030303030310D0E41303030303030303033313031300E02303111083230323630393233120531343A303513083534333535353438140C53494D554C415445444D494415023031170C323331343035303030303031180436383030190A38304130303438303030200F43686970204F6E6C696E652050696E44';

/** The masked placeholder both dialects carry, and the name Digio adds to it. */
const MASKED_PAN = '424242******4242';
const CARDHOLDER = 'TEST CARDHOLDER';
/** A GHL card response's own field, as the fixture spells it. */
const GHL_CARD_NO = '424242******4242';

let ctx: TestContext;
let cookie: string;
let adminCookie: string;
let agent: BoxAgent;
let operatorId: string;
let branchId: string;
let stationId: string;
let cardDeviceId: string;
let twoHoursId: string;
let jamesId: string;
let boxCredential = '';

function injectTransport(): AgentFetch {
  return async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const auth = init.headers?.authorization;
    if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
      boxCredential = auth.slice('Bearer '.length);
    }
    const res = await ctx.app.inject({
      method: init.method as 'GET',
      url: path,
      headers: init.headers,
      payload: init.body,
    });
    return {
      status: res.statusCode,
      json: async () => (res.body ? JSON.parse(res.body) : null),
      text: async () => res.body,
      header: (name) => {
        const value = res.headers[name.toLowerCase()];
        return typeof value === 'string' ? value : null;
      },
    };
  };
}

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);

  const branches = await ctx.db.select().from(branch);
  const hkt = branches.find((row) => row.code === 'hkt-central') ?? branches[0]!;
  branchId = hkt.id;
  operatorId = hkt.operatorId;

  const stations = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.kind, 'till')));
  const till = stations.find((s) => s.codePrefix === 'T1') ?? stations[0]!;
  stationId = till.id;

  const devices = await ctx.db.select().from(device).where(eq(device.branchId, branchId));
  cardDeviceId = devices.find((d) => d.label === 'EDC 1')!.id;

  const packages = await ctx.db
    .select()
    .from(ticketPackage)
    .where(eq(ticketPackage.branchId, branchId));
  twoHoursId = packages.find((p) => p.name === '2 Hours Play')!.id;

  const members = await ctx.db.select().from(member).where(eq(member.operatorId, operatorId));
  jamesId = members.find((m) => m.phone === '+66822222222')!.id;

  agent = createBoxAgent({
    apiBaseUrl: 'http://redaction.test',
    credentials: memoryCredentialStore(),
    hostname: 'virtual-redaction-test',
    fetch: injectTransport(),
    claimCode: async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null,
    store: boxStoreFor(ctx.db),
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
  attachInProcessBox(agent);
}, 180_000);

afterAll(async () => {
  agent.stop();
  await ctx.close();
  await teardownAll();
});

async function commitSale(): Promise<{ saleId: string; owed: number }> {
  const saleId = newId();
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: {
      id: saleId,
      stationId,
      memberId: jamesId,
      lines: [{ id: newId(), packageId: twoHoursId, kids: 1, adults: 1 }],
      finalise: true,
    },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { saleId, owed: res.json().outstandingSatang as number };
}

async function cardTender(saleId: string): Promise<string> {
  await ctx.app.inject({
    method: 'POST',
    url: '/payments/terminal-simulator',
    headers: { cookie: adminCookie },
    payload: { action: 'terminal.outcome', deviceId: cardDeviceId, outcome: 'approved' },
  });
  const started = await ctx.app.inject({
    method: 'POST',
    url: '/payments/attempts',
    headers: { cookie },
    payload: { saleId },
  });
  expect(started.statusCode, started.body).toBe(200);
  return (started.json() as { attempt: { id: string } }).attempt.id;
}

/**
 * Everything this ticket writes, as one string.
 *
 * Deliberately whole rows rather than the fields somebody remembered to check:
 * the question is whether a card number survives ANYWHERE, and a search that
 * names its haystack is a search that misses the column nobody thought of.
 */
async function everythingWritten(): Promise<string> {
  const [attempts, runs, commands, audits] = await Promise.all([
    ctx.db.select().from(paymentAttempt),
    ctx.db.select().from(opsRun),
    ctx.db.select().from(boxCommand),
    ctx.db.select().from(auditLog),
  ]);
  return JSON.stringify({ attempts, runs, commands, audits });
}

describe('a real card tender leaves four digits and nothing else', () => {
  it('the masked PAN and the cardholder name are nowhere in anything this ticket writes', async () => {
    const { saleId } = await commitSale();
    const attemptId = await cardTender(saleId);
    expect(await agent.runPendingCommands()).toBeGreaterThanOrEqual(1);

    const [row] = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.id, attemptId));
    expect(row!.status).toBe('approved');
    // Four digits kept, and they are the last four of the masked number.
    expect(row!.last4).toBe('4242');
    expect(MASKED_PAN.endsWith(row!.last4!)).toBe(true);

    const written = await everythingWritten();
    expect(written, 'a masked PAN reached the database').not.toContain(MASKED_PAN);
    expect(written, 'a masked PAN reached the database').not.toContain('424242');
    expect(written, 'a cardholder name reached the database').not.toContain(CARDHOLDER);
    expect(written, 'a raw GHL card_no reached the database').not.toContain(GHL_CARD_NO);
  });

  it('what is stored off the adapter’s answer is the allow-list and nothing else', async () => {
    const { saleId } = await commitSale();
    const attemptId = await cardTender(saleId);
    await agent.runPendingCommands();

    const [row] = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.id, attemptId));
    const payload = row!.payload as { terminal?: Record<string, unknown> };
    expect(payload.terminal, 'the adapter’s answer was projected onto the attempt').toBeTruthy();
    const kept = Object.keys(payload.terminal!);
    // Every key that survived is on the allow-list. The list may hold keys this
    // exchange had no value for; nothing outside it may appear.
    expect(kept.filter((key) => !(ATTEMPT_ALLOW_LIST as readonly string[]).includes(key))).toEqual(
      [],
    );
  });
});

describe('a box that posts more than it should', () => {
  /**
   * The fixture, posted as a box would post it if somebody added a "for
   * debugging" field — which is exactly how a raw frame ends up in a database.
   */
  it('a raw Digio A1 frame, a cardholder name and a card number are dropped at the route', async () => {
    const { saleId, owed } = await commitSale();
    const attemptId = await cardTender(saleId);

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/payments/attempts/${attemptId}/result`,
      headers: { authorization: `Bearer ${boxCredential}` },
      payload: {
        stage: 'final',
        outcome: 'approved',
        requestedSatang: owed,
        approvedSatang: owed,
        // Distinct from anything the simulator mints: the reference is unique
        // per terminal per day and the invoice number is unique for ever, and
        // both indexes are real.
        terminalRef: '269999000001',
        tranRef: '999001',
        invoiceNo: 'RDCT999001',
        approvalCode: 'R00001',
        last4: '4242',
        tid: '54355548',
        mid: 'SIMULATEDMID',
        responseCode: '100',
        responseText: 'APPROVED',
        // None of these is a field this route names.
        rawFrame: DIGIO_A1_FRAME,
        cardholderName: CARDHOLDER,
        cardNo: MASKED_PAN,
        card_no: GHL_CARD_NO,
        pan: '4242424242424242',
        track2: '4242424242424242=25121011234567890',
      },
    });
    expect(res.statusCode, res.body).toBe(200);

    const written = await everythingWritten();
    expect(written, 'a raw frame reached the database').not.toContain(DIGIO_A1_FRAME);
    // The frame's own hex header, in case a truncation ever hid the rest.
    expect(written, 'part of a raw frame reached the database').not.toContain('3E5581E8');
    expect(written).not.toContain(CARDHOLDER);
    expect(written).not.toContain(MASKED_PAN);
    expect(written).not.toContain('4242424242424242');
    expect(written).not.toContain('track2');
  });

  it('the same frame in a hand-made result for a fresh attempt is dropped too', async () => {
    const { saleId, owed } = await commitSale();
    const attemptId = await cardTender(saleId);

    await ctx.app.inject({
      method: 'POST',
      url: `/payments/attempts/${attemptId}/result`,
      headers: { authorization: `Bearer ${boxCredential}` },
      payload: {
        stage: 'final',
        outcome: 'declined',
        requestedSatang: owed,
        responseCode: '05',
        responseText: `Do not honor — ${CARDHOLDER}`,
        rawFrame: DIGIO_A1_FRAME,
      },
    });

    const [row] = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.id, attemptId));
    expect(row!.status).toBe('declined');
    // `responseText` IS a named field, so a name smuggled into it is the box's
    // own doing and is stored — which is why the redactor under `ops_run` is a
    // second net and not a duplicate of the first. It must not reach the run.
    const runs = await ctx.db.select().from(opsRun);
    expect(JSON.stringify(runs.map((r) => r.detail))).not.toContain(CARDHOLDER);
    expect(JSON.stringify(runs.map((r) => r.detail))).not.toContain(DIGIO_A1_FRAME);
  });
});

describe('an approval code is money on one row and a leak on another', () => {
  it('lives on the attempt, and never in an ops_run detail', async () => {
    const { saleId } = await commitSale();
    const attemptId = await cardTender(saleId);
    await agent.runPendingCommands();

    const [row] = await ctx.db
      .select()
      .from(paymentAttempt)
      .where(eq(paymentAttempt.id, attemptId));
    const code = row!.approvalCode;
    // On the money record, which is correct and is the only way a void of this
    // tender could ever be sent.
    expect(code).toMatch(/^R\d{5}$/);

    const runs = await ctx.db.select().from(opsRun);
    const details = JSON.stringify(runs.map((r) => r.detail));
    expect(details, 'an approval code reached an ops_run detail').not.toContain(code!);
    expect(details).not.toContain('approvalCode');
  });
});
