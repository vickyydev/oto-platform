import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { account, auditLog, band, box, boxCommand, branch, checkin, idempotencyKey, station, ticketPackage } from '@oto/db';
import { bandShortCode, mintVoucherQr, newId, normalizePhone } from '@oto/shared';
import {
  ScanRouter,
  StationSessionManager,
  type BoxAgent,
  type StationScanMessage,
} from '@oto/box-agent';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { attachInProcessBox, detachInProcessBox } from '../src/services/box';
import { createWalletWithGrant } from '../src/services/wallet';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-731 — a wristband and a wallet QR read at the counter's scanner.
 *
 * The box hands over a band's short code and never its signed code; the box had
 * no handler at all for a wallet's voucher QR. What the till does with either
 * is the typed path, so what has to be true on this side is that the key the
 * scan delivers gets the same answer the typed key gets: the same child, the
 * same allergy line, the same wallet. And a wallet QR, which spends credit for
 * whoever holds it, must reach the staff screen and be kept nowhere else.
 *
 * The in-process box is the real `ScanRouter` and `StationSessionManager` on the
 * api's own store, as `station-scans-poll.test.ts` wires them.
 * `boxScanner.deliver(…)` is the call `agent.ts` makes for a `scanner.scan`
 * simulator command and for a code off the real scanner.
 */

const STORAGE_ENV = {
  MINIO_ENDPOINT: 'localhost',
  MINIO_PORT: '9000',
  MINIO_USE_SSL: 'false',
  MINIO_ACCESS_KEY: 'oto',
  MINIO_SECRET_KEY: 'otosecret123',
  MINIO_BUCKET: 'oto-files-test',
};
const ALL_CONFIRMATIONS = ['confirm-15min', 'confirm-no-refund', 'confirm-evac'];

let ctx: TestContext;
let cookie: string;
let adminCookie: string;
let branchId: string;
let operatorId: string;
let tillId: string;
let boxId: string;
let packageId: string;
let boxScanner: ScanRouter;
let boxSessions: StationSessionManager;
let fakeAgent: BoxAgent;
let n = 0;
const idem = () => `s731-${process.pid}-${Date.now()}-${n++}`;

beforeAll(async () => {
  ctx = await createTestContext({ files: true, env: STORAGE_ENV });
  cookie = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  adminCookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  tillId = till!.id;
  boxId = till!.boxId!;
  const [pkg] = await ctx.db
    .select()
    .from(ticketPackage)
    .where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play'), isNull(ticketPackage.archivedAt)));
  packageId = pkg!.id;

  const picked = await ctx.app.inject({
    method: 'PUT',
    url: '/me/session/station',
    headers: { cookie },
    payload: { stationId: tillId },
  });
  expect(picked.statusCode, picked.body).toBe(200);

  const store = boxStoreFor(ctx.db);
  boxSessions = new StationSessionManager({
    store,
    boxId,
    resolveStation: (id) =>
      id === tillId ? { stationId: tillId, boxId, operatorId, branchId } : null,
  });
  boxScanner = new ScanRouter({
    boxId,
    store,
    bandKey: () => currentBandKey(),
    publish: (stationId, message) => boxSessions.emitScan(stationId, message),
  });
  fakeAgent = {
    state: { boxId },
    sessions: () => boxSessions,
    scanner: () => boxScanner,
  } as unknown as BoxAgent;
  attachInProcessBox(fakeAgent);
}, 180_000);

afterAll(async () => {
  detachInProcessBox(fakeAgent);
  await ctx.close();
  await teardownAll();
});

/** A child registered, paid for and checked in now: a banded stay with an allergy line. */
async function childInPark(name: string, allergies: string, foodRestrictions: string): Promise<{ checkinId: string; code: string }> {
  const checkinId = newId();
  const reg = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/registrations',
    headers: { cookie },
    payload: {
      id: newId(),
      branchId,
      stationId: tillId,
      guardianName: 'Ploy',
      guardianPhone: '0812345678',
      contactChannel: 'whatsapp',
      consentAcknowledged: true,
      acknowledgedConfirmationIds: ALL_CONFIRMATIONS,
      children: [
        {
          checkinId,
          name,
          ageYears: 6,
          service: 'drop_off',
          allergies,
          foodRestrictions,
          foodProvision: { mode: 'none', paidSatang: 0 },
        },
      ],
    },
  });
  expect(reg.statusCode, reg.body).toBe(200);
  const saleId = newId();
  const commit = await ctx.app.inject({
    method: 'POST',
    url: '/sales',
    headers: { cookie },
    payload: {
      id: saleId,
      stationId: tillId,
      lines: [
        {
          id: checkinId,
          packageId,
          kids: 1,
          adults: 0,
          serviceFee: { label: 'Drop-off service', amountSatang: 22_500 },
          foodProvision: null,
        },
      ],
    },
  });
  expect(commit.statusCode, commit.body).toBe(200);
  const finalised = await ctx.app.inject({
    method: 'POST',
    url: `/sales/${saleId}/finalise`,
    headers: { cookie },
    payload: {},
  });
  expect(finalised.statusCode, finalised.body).toBe(200);
  const now = await ctx.app.inject({
    method: 'POST',
    url: '/checkin/check-in-now',
    headers: { cookie },
    payload: { saleId, entries: [{ checkinId, nannyId: null }] },
  });
  expect(now.statusCode, now.body).toBe(200);
  const [row] = await ctx.db
    .select({ code: band.code })
    .from(checkin)
    .innerJoin(band, eq(band.id, checkin.bandId))
    .where(eq(checkin.id, checkinId));
  return { checkinId, code: row!.code };
}

async function tapeNumber(view: 'staff' | 'customer' = 'staff'): Promise<number> {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/stations/${tillId}/scans?view=${view}`,
    headers: { cookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { next: number }).next;
}

async function heard(after: number, view: 'staff' | 'customer' = 'staff') {
  const res = await ctx.app.inject({
    method: 'GET',
    url: `/stations/${tillId}/scans?view=${view}&after=${after}`,
    headers: { cookie },
  });
  expect(res.statusCode, res.body).toBe(200);
  return { raw: res.body, scans: (res.json() as { scans: StationScanMessage[] }).scans };
}

const lookup = (key: string) =>
  ctx.app.inject({
    method: 'GET',
    url: `/wallets/scan?key=${encodeURIComponent(key)}&branchId=${branchId}`,
    headers: { cookie },
  });

describe('a band read at the counter’s scanner', () => {
  it('reaches the screens as its short code, never its signed code, and that short code reads the same child as the typed code', async () => {
    const stay = await childInPark('ZZ TEST Scan Child', 'Peanuts', 'No dairy');
    const after = await tapeNumber();

    const read = await boxScanner.deliver(tillId, { code: `${stay.code}\r\n`, source: 'simulator' });
    expect(read.kind).toBe('band');
    expect(read.outcome).toBe('handled');

    const { raw, scans } = await heard(after);
    expect(raw).not.toContain(stay.code);
    const detail = scans[0]!.detail as { band: { shortCode: string } };
    expect(detail.band.shortCode).toBe(bandShortCode(stay.code));

    const scanned = await lookup(detail.band.shortCode);
    const typed = await lookup(stay.code);
    expect(scanned.statusCode, scanned.body).toBe(200);
    expect(typed.statusCode, typed.body).toBe(200);
    const body = scanned.json() as { stay: { childName: string; allergiesMedical: string; foodRestrictions: string; checkinId: string } };
    // The same stay, the same safety lines: a band is one child, however its key arrived.
    expect(body.stay).toEqual((typed.json() as { stay: unknown }).stay);
    expect(body.stay.checkinId).toBe(stay.checkinId);
    expect(body.stay.childName).toBe('ZZ TEST Scan Child');
    expect(body.stay.allergiesMedical).toContain('Peanuts');
    expect(body.stay.foodRestrictions).toContain('No dairy');
  });

  it('finds the same sales in History by the short code as by the typed code', async () => {
    const stay = await childInPark('ZZ TEST History Child', 'None known', 'None');
    const by = (band: string) =>
      ctx.app.inject({
        method: 'GET',
        url: `/sales/lookup?band=${encodeURIComponent(band)}&branchId=${branchId}&limit=50`,
        headers: { cookie },
      });
    const short = await by(bandShortCode(stay.code)!);
    const whole = await by(stay.code);
    expect(short.statusCode, short.body).toBe(200);
    expect(whole.statusCode, whole.body).toBe(200);
    const ids = (res: typeof short) => (res.json() as { sales: Array<{ id: string }> }).sales.map((s) => s.id);
    expect(ids(short).length).toBeGreaterThan(0);
    expect(ids(short)).toEqual(ids(whole));
  });
});

describe('a wallet QR read at the counter’s scanner', () => {
  const grant = async () => {
    const qr = mintVoucherQr();
    await ctx.db.transaction((tx) =>
      createWalletWithGrant(tx, { accountId: null, operatorId }, {
        actionId: `test:grant:${newId()}`,
        branchId,
        holderName: 'ZZ TEST Voucher Guest',
        amountSatang: 50_000,
        source: 'ticket_sale',
        keys: [{ kind: 'voucher_qr', value: qr }],
      }),
    );
    return qr;
  };

  it('reaches the staff screen with the key the platform takes, and is not said to the screen facing the guest', async () => {
    const qr = await grant();
    const after = await tapeNumber();
    const guestAfter = await tapeNumber('customer');

    const read = await boxScanner.deliver(tillId, { code: qr, source: 'box_hid' });
    expect(read.kind).toBe('wallet');
    expect(read.outcome).toBe('handled');

    const staff = await heard(after);
    const key = (staff.scans[0]!.detail as { walletKey: string }).walletKey;
    expect(key).toBe(qr);

    const guest = await heard(guestAfter, 'customer');
    expect(guest.scans).toHaveLength(1);
    expect(guest.raw).not.toContain(qr);

    const opened = await lookup(key);
    expect(opened.statusCode, opened.body).toBe(200);
    const body = opened.json() as { wallet: { holderName: string; balanceSatang: number } };
    expect(body.wallet.holderName).toBe('ZZ TEST Voucher Guest');
    expect(body.wallet.balanceSatang).toBe(50_000);
  });

  it('is classed on the api’s own scan door too, and its answer is never kept under an Idempotency-Key', async () => {
    const qr = await grant();
    const key = idem();
    const send = () =>
      ctx.app.inject({
        method: 'POST',
        url: `/stations/${tillId}/scan`,
        headers: { cookie, 'idempotency-key': key },
        payload: { code: qr, source: 'camera' },
      });
    const first = await send();
    expect(first.statusCode, first.body).toBe(200);
    const answer = first.json() as { kind: string; handler: string; detail: { walletKey: string } };
    expect(answer.kind).toBe('wallet');
    expect(answer.handler).toBe('wallet-qr');
    expect(answer.detail.walletKey).toBe(qr);

    const [acc] = await ctx.db.select().from(account).where(eq(account.phone, normalizePhone(RECEPTION.phone)!));
    const rows = await ctx.db
      .select()
      .from(idempotencyKey)
      .where(and(eq(idempotencyKey.key, key), eq(idempotencyKey.accountId, acc!.id)));
    expect(JSON.stringify(rows)).not.toContain(qr);

    const again = await send();
    expect(again.statusCode, again.body).toBe(200);
    expect((again.json() as { detail: { walletKey: string } }).detail.walletKey).toBe(qr);
  });

  it('cannot travel through the command queue, where it would be stored and shown', async () => {
    const qr = await grant();
    // The queue only opens for a box that has come online once.
    await ctx.db.update(box).set({ registeredAt: new Date() }).where(eq(box.id, boxId));
    for (const sent of [qr, `  ${qr.toLowerCase()}\r\n`]) {
      const res = await ctx.app.inject({
        method: 'POST',
        url: `/boxes/${boxId}/commands`,
        headers: { cookie: adminCookie, 'idempotency-key': idem() },
        payload: {
          kind: 'simulate',
          payload: { action: { action: 'scanner.scan', input: { code: sent, source: 'simulator' } } },
        },
      });
      expect(res.statusCode, res.body).toBe(409);
      expect((res.json() as { error: { code: string } }).error.code).toBe('SIMULATOR_ACTION_CARRIES_SECRET');
    }
    expect(JSON.stringify(await ctx.db.select().from(boxCommand))).not.toContain(qr);
    expect(JSON.stringify(await ctx.db.select().from(auditLog))).not.toContain(qr);
  });
});
