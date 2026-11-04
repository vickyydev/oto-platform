import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { station, idempotencyKey } from '@oto/db';
import { boxCredential } from '@oto/box-agent';
import { randomUUID } from 'node:crypto';
import { createTestContext, teardownAll, boxBySlot, type TestContext } from './helpers';
import { issueClaimCode } from '../src/services/box';
import { stationScanTape } from '../src/lib/station-scan-tape';

let ctx: TestContext;
let credential: string;
let till: typeof station.$inferSelect;
beforeAll(async () => {
  ctx = await createTestContext();
  const box = await boxBySlot(ctx.db, 'virtual-1');
  till = (await ctx.db.select().from(station).where(eq(station.boxId, box.id)))[0]!;
  const { code } = await issueClaimCode(ctx.db, box.id);
  const registered = await ctx.app.inject({ method: 'POST', url: '/box/v1/register',
    payload: { claimCode: code, agentVersion: '0.1.0', hostname: 'zz-test-s736' } });
  expect(registered.statusCode).toBe(200);
  credential = boxCredential(box.id, registered.json().secret as string);
});
afterAll(async () => { await ctx?.close(); await teardownAll(); });
const scan = () => ({ kind: 'scan' as const, scanId: randomUUID(), source: 'box_hid',
  codeKind: 'wallet', codeFingerprint: 'a'.repeat(16), outcome: 'handled', handler: 'wallet-qr',
  errorCode: null, detail: { walletKey: 'ZZ TEST synthetic wallet key' }, actionId: null,
  scannedAt: new Date().toISOString() });
const post = (payload: unknown, auth = credential) => ctx.app.inject({ method: 'POST', url: '/box/v1/scans',
  headers: auth ? { authorization: 'Bearer ' + auth } : {}, payload: payload as never });

describe('SCRUM-736 adversarial review: a box relays only its own live scans', () => {
  it('HIGH: the same read relayed twice appears only once on the platform tape', async () => {
    const message = scan(), before = stationScanTape.read(till.id).next;
    expect((await post({ stationId: till.id, scan: message })).statusCode).toBe(204);
    expect((await post({ stationId: till.id, scan: message })).statusCode).toBe(204);
    const page = stationScanTape.read(till.id, before);
    expect(page.scans).toEqual([message]); expect(page.next).toBe(before + 1);
  });
  it('HIGH: a fresh physical read of the same code remains a separate event', async () => {
    const before = stationScanTape.read(till.id).next;
    await post({ stationId: till.id, scan: scan() }); await post({ stationId: till.id, scan: scan() });
    expect(stationScanTape.read(till.id, before).scans).toHaveLength(2);
  });
  it('CRITICAL: an unauthenticated sender cannot inject into a till', async () => {
    const before = stationScanTape.read(till.id).next;
    expect((await post({ stationId: till.id, scan: scan() }, '')).statusCode).toBe(401);
    expect(stationScanTape.read(till.id).next).toBe(before);
  });
  it('CRITICAL: a different box cannot inject into this box station', async () => {
    const other = await boxBySlot(ctx.db, 'virtual-2');
    const { code } = await issueClaimCode(ctx.db, other.id);
    const r = await ctx.app.inject({ method: 'POST', url: '/box/v1/register', payload: { claimCode: code, agentVersion: '0.1.0' } });
    const before = stationScanTape.read(till.id).next;
    expect((await post({ stationId: till.id, scan: scan() }, boxCredential(other.id, r.json().secret as string))).statusCode).toBe(403);
    expect(stationScanTape.read(till.id).next).toBe(before);
  });
  it('HIGH: an archived station cannot receive a scan', async () => {
    await ctx.db.update(station).set({ archivedAt: new Date() }).where(eq(station.id, till.id));
    try { expect((await post({ stationId: till.id, scan: scan() })).statusCode).toBe(404); }
    finally { await ctx.db.update(station).set({ archivedAt: null }).where(eq(station.id, till.id)); }
  });
  it('HIGH: no identity, malformed input and oversized input are refused before delivery', async () => {
    const message = scan(); const { scanId: _id, ...old } = message;
    const before = stationScanTape.read(till.id).next;
    expect((await post({ stationId: till.id, scan: old })).statusCode).toBe(400);
    expect((await post({ stationId: till.id, scan: { ...message, kind: 'snapshot' } })).statusCode).toBe(400);
    expect((await post({ stationId: till.id, scan: { ...message, detail: { value: 'x'.repeat(17000) } } })).statusCode).toBe(413);
    expect(stationScanTape.read(till.id).next).toBe(before);
  });
  it('HIGH: a scanned credential is never written to the idempotency store', async () => {
    await ctx.app.inject({ method: 'POST', url: '/box/v1/scans',
      headers: { authorization: 'Bearer ' + credential, 'idempotency-key': 's736-no-scan-storage' },
      payload: { stationId: till.id, scan: scan() } });
    const rows = await ctx.db.select().from(idempotencyKey);
    expect(JSON.stringify(rows)).not.toContain('ZZ TEST synthetic wallet key');
  });
});
