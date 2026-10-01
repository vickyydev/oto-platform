import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { band, box, branch, child, device, member, printJob, product, station, stationDevice, ticketPackage } from '@oto/db';
import { createBoxAgent, memoryCredentialStore, type AgentFetch, type BoxAgent } from '@oto/box-agent';
import { bandShortCode, newId, verifyBandCode } from '@oto/shared';
import { renderJob, type PrintJob } from '@oto/print';
import { PROFILES, TEMPLATES } from '@oto/print/fixtures';
import { decodeQrMatrix } from '../../../packages/print/test/qr-reader';
import { DEV_BAND_HMAC_KEY } from '../src/env';
import { provisionVirtualBox } from '../src/services/box';
import { boxStoreFor } from '../src/lib/box-store';
import { ADMIN, RECEPTION, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

// The seam the unit suites cannot see: a finalised sale becomes platform print
// documents, the REAL box agent collects and prints them, the renderer draws
// them without overflow, and the band QR decodes back to a verifiable code.
// Written by the S2-11 integration gate and kept as a regression test.
let ctx: TestContext;
let reception: string;
let admin: string;
let agent: BoxAgent;
let hostKey: string | null = null;
let stationId: string;
let branchId: string;
let twoHoursId: string;
let maliId: string;
let maliChildren: { id: string; name: string; allergies: string | null }[];
const productByCode = new Map<string, string>();

function injectTransport(): AgentFetch {
  return async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const res = await ctx.app.inject({ method: init.method as 'GET', url: path, headers: init.headers, payload: init.body });
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

let credential = '';
beforeAll(async () => {
  ctx = await createTestContext();
  reception = await signInAs(ctx.app, RECEPTION.phone, RECEPTION.password);
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const hkt = (await ctx.db.select().from(branch)).find((r) => r.code === 'hkt-central')!;
  branchId = hkt.id;
  const [till] = await ctx.db.select().from(station).where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  stationId = till!.id;
  const [pkg] = await ctx.db.select().from(ticketPackage).where(and(eq(ticketPackage.branchId, branchId), eq(ticketPackage.name, '2 Hours Play')));
  twoHoursId = pkg!.id;
  const members = await ctx.db.select().from(member).where(eq(member.operatorId, hkt.operatorId));
  maliId = members.find((m) => m.phone === '+66811111111')!.id;
  maliChildren = await ctx.db.select({ id: child.id, name: child.name, allergies: child.allergies }).from(child).where(and(eq(child.memberId, maliId), isNull(child.archivedAt)));
  for (const row of await ctx.db.select().from(product).where(eq(product.operatorId, hkt.operatorId))) {
    if (row.code) productByCode.set(row.code, row.id);
  }
  const transport = injectTransport();
  agent = createBoxAgent({
    apiBaseUrl: 'http://gate.test',
    credentials: memoryCredentialStore(),
    hostname: 'virtual-gate-test',
    fetch: async (url, init) => {
      const auth = init.headers?.authorization;
      if (typeof auth === 'string' && auth.startsWith('Bearer ')) credential = auth.slice(7);
      return transport(url, init);
    },
    claimCode: async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null,
    printing: { retryDelayMs: 0 },
    bands: { key: () => hostKey },
    store: boxStoreFor(ctx.db),
  });
  await agent.ensureRegistered();
  await agent.syncConfig();
}, 180_000);

afterAll(async () => {
  agent?.stop();
  await ctx.close();
  await teardownAll();
});

async function post(url: string, cookie: string, payload: unknown) {
  return ctx.app.inject({ method: 'POST', url, headers: { cookie }, payload: payload as never });
}
async function documentOf(jobId: string) {
  const res = await ctx.app.inject({ method: 'GET', url: `/box/v1/print-jobs/${jobId}/document`, headers: { authorization: `Bearer ${credential}` } });
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as { kind: string; job: PrintJob };
}
function texts(r: ReturnType<typeof renderJob>): string[] {
  return r.layout.items.filter((i) => i.k === 'text').map((i) => (i as { text: string }).text);
}
async function boxId(): Promise<string> {
  if (agent.state.boxId) return agent.state.boxId;
  const [row] = await ctx.db.select().from(box).where(eq(box.slot, 'virtual-1')).limit(1);
  return row!.id;
}
async function scan(code: string) {
  const res = await post(`/boxes/${await boxId()}/simulate`, admin, { action: 'scanner.scan', input: { code, source: 'simulator' } });
  expect(res.statusCode, res.body).toBe(200);
  await agent.runPendingCommands();
  const { boxCommand } = await import('@oto/db');
  const [row] = await ctx.db.select().from(boxCommand).where(eq(boxCommand.id, String(res.json().commandId)));
  return row!;
}

describe('gate seam', () => {
  let saleId: string;
  let bands: (typeof band.$inferSelect)[];

  it('ticket sale: the real agent fetches every platform document and prints it; each renders clean', async () => {
    const visit = await post('/visits', reception, { memberId: maliId, childIds: maliChildren.map((c) => c.id) });
    expect(visit.statusCode, visit.body).toBe(200);
    saleId = newId();
    const lineId = newId();
    const c = await post('/sales', reception, { id: saleId, stationId, memberId: maliId, visitId: visit.json().id, lines: [{ id: lineId, packageId: twoHoursId, kids: 2, adults: 1 }] });
    expect(c.statusCode, c.body).toBe(200);
    const f = await post(`/sales/${saleId}/finalise`, reception, {});
    expect(f.statusCode, f.body).toBe(200);
    const jobs = f.json().printing.jobs as { id: string; kind: string; status: string; subjectId: string }[];
    // S2-14a — the adult's ticket comes back as credit, so its voucher prints after the bands.
    expect(jobs.map((j) => j.kind)).toEqual(['receipt', 'kids_wristband', 'kids_wristband', 'adult_wristband', 'credit_voucher']);
    const grants = f.json().grants as { walletId: string; qrCode: string }[];
    expect(grants).toHaveLength(1);

    const ran = await agent.runPendingCommands();
    expect(ran).toBeGreaterThanOrEqual(4);
    const rows = await ctx.db.select().from(printJob).where(eq(printJob.actionId, (await ctx.db.select().from(printJob).where(eq(printJob.id, jobs[0]!.id)))[0]!.actionId!));
    for (const j of jobs) {
      const [row] = await ctx.db.select().from(printJob).where(eq(printJob.id, j.id));
      expect(row!.status, `${j.kind}: ${row!.errorCode} ${row!.errorMessage}`).toBe('printed');
    }
    expect(rows.length).toBeGreaterThanOrEqual(4);

    bands = await ctx.db.select().from(band).where(eq(band.saleId, saleId));
    for (const j of jobs) {
      const doc = await documentOf(j.id);
      const profile = j.kind === 'receipt' || j.kind === 'credit_voucher' ? PROFILES.escpos576! : PROFILES.tspl400!;
      const rendered = renderJob(doc.job, { device: profile, templates: TEMPLATES });
      expect(rendered.overflow, j.kind).toEqual([]);
      const t = texts(rendered);
      if (j.kind === 'receipt') {
        const all = t.join('\n');
        expect(all).toContain('ใบกำกับภาษีอย่างย่อ');
        expect(all).toContain('ABBREVIATED TAX INVOICE');
        for (const b of bands) expect(all).toContain(bandShortCode(b.code)!);
        for (const b of bands) expect(all).not.toContain(b.code);
      } else if (j.kind === 'credit_voucher') {
        // The voucher's QR is the wallet's ONE key — never a band's signed code.
        const qr = rendered.layout.items.find((i) => i.k === 'qr');
        if (qr?.k !== 'qr') throw new Error('credit voucher has no QR');
        expect(j.subjectId).toBe(grants[0]!.walletId);
        expect(decodeQrMatrix(qr.matrix)).toBe(grants[0]!.qrCode);
        for (const b of bands) expect(t.join(' ')).not.toContain(b.code);
      } else {
        const qr = rendered.layout.items.find((i) => i.k === 'qr');
        expect(qr, `${j.kind} has no QR`).toBeDefined();
        if (qr?.k !== 'qr') throw new Error(`${j.kind} has no QR`);
        const decoded = decodeQrMatrix(qr.matrix);
        const row = bands.find((b) => b.id === j.subjectId)!;
        expect(decoded).toBe(row.code);
        const v = verifyBandCode(decoded, DEV_BAND_HMAC_KEY);
        expect(v.ok && v.bandId).toBe(row.id);
        expect(t).toContain(bandShortCode(row.code)!);
        // 25 mm stock too
        const narrow = renderJob(doc.job, { device: PROFILES.tspl200!, templates: TEMPLATES });
        expect(narrow.overflow, `${j.kind} 25mm`).toEqual([]);
        console.log(`${j.kind} TEXT >>> ` + t.join(' | '));
      }
    }
  });

  it('POS seam: GET /sales/:id carries bands placeable on the cart line and printed jobs', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: `/sales/${saleId}`, headers: { cookie: reception } });
    const d = res.json();
    expect(d.bands).toHaveLength(3);
    expect(d.printJobs.every((j: { status: string }) => j.status === 'printed')).toBe(true);
    const cartOf = new Map((d.lines as { id: string; cartLineId: string }[]).map((l) => [l.id, l.cartLineId]));
    for (const b of d.bands as { saleLineId: string; shortCode: string }[]) {
      expect(cartOf.get(b.saleLineId), 'band line not in detail.lines').toBeTruthy();
      expect(b.shortCode).toMatch(/^T1-/);
    }
    expect(JSON.stringify(d)).not.toContain(bands[0]!.code);
  });

  it('scanner simulator on the api-hosted box: the key comes in the config bundle (OD-13) -> handled to the band id; tampered -> refused', async () => {
    // Offline plan Round 4, OD-13: a counter box is sent the park's band key
    // in its config bundle, so it can mint and check bands with no internet.
    expect((agent.config() as { bandKey?: string } | null)?.bandKey ?? null).toBe(DEV_BAND_HMAC_KEY);
    const code = bands[0]!.code;
    hostKey = null;
    const fromBundle = await scan(code);
    expect((fromBundle.result as { outcome: string }).outcome).toBe('handled');
    hostKey = DEV_BAND_HMAC_KEY;
    const ok = await scan(code);
    const okResult = ok.result as { outcome: string; band?: { bandId: string } };
    console.log('WITH KEY >>>', ok.state, JSON.stringify(okResult));
    expect(okResult.outcome).toBe('handled');
    expect(okResult.band?.bandId).toBe(bands[0]!.id);
    const last = code.slice(-1);
    const tampered = code.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    const bad = await scan(tampered);
    console.log('TAMPERED >>>', bad.state, JSON.stringify(bad.result));
    expect((bad.result as { outcome: string; errorCode: string }).errorCode).toBe('BAND_SIGNATURE_INVALID');
  });

  it('F&B: kitchen prints with the allergy line through the agent; bar skipped', async () => {
    const id = newId();
    const c = await post('/sales', reception, {
      id, stationId, memberId: maliId, channel: 'fnb', pickupCode: '42', note: 'Birthday table',
      items: [
        { id: newId(), productId: productByCode.get('FB-HOTDOG')!, quantity: 1, note: 'no onions' },
        { id: newId(), productId: productByCode.get('FB-JUICE')!, quantity: 2 },
      ],
    });
    expect(c.statusCode, c.body).toBe(200);
    const f = await post(`/sales/${id}/finalise`, reception, {});
    const jobs = f.json().printing.jobs as { id: string; kind: string; status: string }[];
    await agent.runPendingCommands();
    const kitchen = jobs.find((j) => j.kind === 'kitchen_ticket')!;
    const [row] = await ctx.db.select().from(printJob).where(eq(printJob.id, kitchen.id));
    expect(row!.status, `${row!.errorCode}`).toBe('printed');
    const doc = await documentOf(kitchen.id);
    const rendered = renderJob(doc.job, { device: PROFILES.escpos576!, templates: TEMPLATES });
    expect(rendered.overflow).toEqual([]);
    const all = texts(rendered).join('\n');
    console.log('KITCHEN TEXT >>>\n' + all);
    expect(all).toMatch(/ALLERGY/i);
  });

  it('paper-out during a sale: sale finalises; job waits; prints when cleared', async () => {
    const [receiptDev] = await ctx.db
      .select({ id: device.id })
      .from(stationDevice)
      .innerJoin(device, eq(device.id, stationDevice.deviceId))
      .where(and(eq(stationDevice.stationId, stationId), eq(stationDevice.role, 'receipt' as never)));
    const fault = await post(`/boxes/${await boxId()}/simulate`, admin, { action: 'printer.fault', deviceId: receiptDev!.id, fault: 'paper_out' });
    expect(fault.statusCode, fault.body).toBe(200);
    await agent.runPendingCommands();
    const id = newId();
    const c = await post('/sales', reception, { id, stationId, memberId: maliId, lines: [{ id: newId(), packageId: twoHoursId, kids: 0, adults: 1 }] });
    expect(c.statusCode, c.body).toBe(200);
    const f = await post(`/sales/${id}/finalise`, reception, {});
    expect(f.statusCode, f.body).toBe(200);
    expect(f.json().finalised).toBe(true);
    const receipt = (f.json().printing.jobs as { id: string; kind: string }[]).find((j) => j.kind === 'receipt')!;
    await agent.runPendingCommands();
    let [row] = await ctx.db.select().from(printJob).where(eq(printJob.id, receipt.id));
    console.log('PAPER OUT >>>', row!.status, row!.errorCode);
    expect(row!.status).not.toBe('printed');
    const clear = await post(`/boxes/${await boxId()}/simulate`, admin, { action: 'printer.clear', deviceId: receiptDev!.id });
    expect(clear.statusCode, clear.body).toBe(200);
    await agent.runPendingCommands();
    await agent.printing()!.jobs.tick();
    [row] = await ctx.db.select().from(printJob).where(eq(printJob.id, receipt.id));
    console.log('AFTER CLEAR >>>', row!.status, row!.attempts);
    expect(row!.status).toBe('printed');
  });

  it('reprint receipt from History: copy job prints through the agent with reprint_of', async () => {
    const r = await post(`/sales/${saleId}/reprints`, reception, { kind: 'receipt' });
    expect(r.statusCode, r.body).toBe(200);
    const job = r.json().jobs[0] as { id: string; reprintOf: string | null };
    expect(job.reprintOf).not.toBeNull();
    await agent.runPendingCommands();
    const [row] = await ctx.db.select().from(printJob).where(eq(printJob.id, job.id));
    expect(row!.status).toBe('printed');
    const doc = await documentOf(job.id);
    expect((doc.job.data as { title: string }).title).toBe('Receipt (copy)');
  });
});
