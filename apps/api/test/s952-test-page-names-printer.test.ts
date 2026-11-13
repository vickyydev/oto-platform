import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { box, boxCommand, branch, device, printJob, station, stationDevice } from '@oto/db';
import { profileFor, type BoxConfigDevice } from '@oto/box-agent';
import { renderJob, type PrintJob } from '@oto/print';
import { formatDayTimeInTz, newId } from '@oto/shared';
import { reprintJob } from '../src/services/print';
import { buildPrintDocument } from '../src/services/sale-printing';
import { NO_ADDRESS_ON_PAGE, testPageDocumentOf } from '../src/services/test-page';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';

/**
 * SCRUM-952 point 1 — THE TEST PAGE NAMES THE PRINTER IT RAN ON.
 *
 * Seen in the SCRUM-930 staging proof (picture 02d): a test print from the
 * till's drop-off card came out of a ZZ TEST band printer reading "Device
 * Main counter", "Welltech G4" and a park-network address — the renderer's
 * committed fixture, which the box printed whatever printer it ran on.
 *
 * A station's test page is now composed by the platform for the printer the
 * job is routed to and fetched by the box like a sale's receipt
 * (`document: 'platform'`): its label, its model (or its kind), its address
 * (or "no address"), the station, the box and the time, in the page's own
 * layout. Driven through the test-print route against the seeded Reception
 * Till 1, with a ZZ TEST printer on its bar role.
 */

let ctx: TestContext;
let admin: string;
let boxId: string;
let boxName: string;
let tillId: string;
let branchId: string;
let operatorId: string;
let timezone: string;
let printerId: string;

const PRINTER = {
  kind: 'receipt_printer',
  label: 'ZZ TEST SCRUM-952 test page printer',
  transport: 'simulated',
  address: '192.0.2.61:9100',
  model: 'Xprinter XP-80',
  protocol: 'escpos',
};

const post = (url: string, payload: Record<string, unknown>) =>
  ctx.app.inject({ method: 'POST', url, headers: { cookie: admin }, payload });

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [hkt] = await ctx.db.select().from(branch).where(eq(branch.code, 'hkt-central'));
  branchId = hkt!.id;
  operatorId = hkt!.operatorId;
  timezone = hkt!.timezone;
  const [till] = await ctx.db
    .select()
    .from(station)
    .where(and(eq(station.branchId, branchId), eq(station.codePrefix, 'T1')));
  tillId = till!.id;
  boxId = till!.boxId!;
  boxName = (await ctx.db.select().from(box).where(eq(box.id, boxId)))[0]!.name;
  // As a box that has registered: commands are only queued for one that has.
  await ctx.db.update(box).set({ registeredAt: new Date() }).where(eq(box.id, boxId));

  const made = await post(`/boxes/${boxId}/devices`, PRINTER);
  expect(made.statusCode, made.body).toBe(200);
  printerId = made.json().device.id as string;
  // The seeded T1 has no bar printer: this one takes the bar role there.
  await ctx.db.insert(stationDevice).values({ id: newId(), stationId: tillId, role: 'bar', deviceId: printerId });
}, 180_000);

afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function testPrint(kind: string, role: string) {
  const res = await post(`/stations/${tillId}/test-print`, { kind, role });
  expect(res.statusCode, res.body).toBe(200);
  const jobId = res.json().printJob.id as string;
  const commandId = res.json().commandId as string;
  const [job] = await ctx.db.select().from(printJob).where(eq(printJob.id, jobId)).limit(1);
  const [command] = await ctx.db.select().from(boxCommand).where(eq(boxCommand.id, commandId)).limit(1);
  return { job: job!, payload: (command!.payload ?? {}) as Record<string, unknown> };
}

/** Every line of text the page would put on the paper, as the renderer lays it out. */
function linesOf(job: PrintJob, deviceRow: typeof device.$inferSelect): string[] {
  const profile = profileFor({ ...deviceRow, role: 'bar', serialNumber: null, terminalId: null, merchantId: null } as unknown as BoxConfigDevice);
  return renderJob(job, { device: profile }).layout.items.flatMap((item) => (item.k === 'text' ? [item.text] : []));
}

describe('SCRUM-952 — a station test page names the printer it runs on', () => {
  it('the box is sent for the platform’s page, not its own sample', async () => {
    const { job, payload } = await testPrint('test_page', 'bar');
    expect(job.deviceId).toBe(printerId);
    expect(payload).toMatchObject({ document: 'platform', kind: 'test_page', printJobId: job.id, role: 'bar', deviceId: printerId });
  });

  it('the page carries the printer’s name, model, address, station, box and time', async () => {
    const { job } = await testPrint('test_page', 'bar');
    const document = await buildPrintDocument(ctx.db, { boxId, operatorId }, job.id);
    expect(document.kind).toBe('test_page');
    expect(document.job.kind).toBe('test_page');
    expect(document.job.data).toMatchObject({
      deviceLabel: PRINTER.label,
      model: PRINTER.model,
      address: PRINTER.address,
      station: 'Reception Till 1',
      box: boxName,
      time: formatDayTimeInTz(job.queuedAt, timezone),
      transport: 'Simulated · escpos',
      widthDots: 576,
    });

    const [row] = await ctx.db.select().from(device).where(eq(device.id, printerId));
    const text = linesOf(document.job, row!).join('\n');
    for (const said of [PRINTER.label, PRINTER.model, PRINTER.address, 'Reception Till 1', boxName, formatDayTimeInTz(job.queuedAt, timezone)]) {
      expect(text.includes(said), `the page says ${said}`).toBe(true);
    }
    // Nobody's network but the printer's own, and not the fixture's printer.
    expect(text.includes('192.168.')).toBe(false);
    expect(text.includes('Main counter')).toBe(false);
    expect(text.includes('Welltech')).toBe(false);
  });

  it('a printer with no address says so, and one with no model is named by its kind', async () => {
    const { job } = await testPrint('test_page', 'bar');
    const bareId = newId();
    await ctx.db.insert(device).values({
      id: bareId, operatorId, branchId, boxId, kind: 'band_printer', label: 'ZZ TEST SCRUM-952 bare band printer',
      transport: 'simulated', protocol: 'tspl2', reachability: 'unknown', paperStatus: 'unknown',
    });
    const page = await testPageDocumentOf(ctx.db, { ...job, deviceId: bareId });
    expect(page).toMatchObject({
      deviceLabel: 'ZZ TEST SCRUM-952 bare band printer',
      model: 'Band printer',
      address: NO_ADDRESS_ON_PAGE,
      transport: 'Simulated · tspl2',
    });
  });

  it('a test of any other printout is still the sample, as before', async () => {
    const { payload } = await testPrint('receipt', 'bar');
    expect(payload.document).toBeUndefined();
    expect(payload).toMatchObject({ kind: 'receipt', role: 'bar' });
  });

  /**
   * SCRUM-971 point 4 — the route's own description said a test page has no
   * platform document, which stopped being true with the page above.
   */
  it('the document route says a station’s test page is one of its documents', () => {
    const doc = ctx.app.swagger() as { paths?: Record<string, { get?: { description?: string } }> };
    const said = doc.paths?.['/box/v1/print-jobs/{id}/document']?.get?.description ?? '';
    expect(said).toContain('a test page asked for at a station');
    expect(said).not.toContain('no platform document (a test page)');
  });

  /**
   * SCRUM-971 point 6 — the comments that describe the old page say a
   * park-network address without quoting one.
   */
  it('the files that describe the old page quote no address of the park’s network', () => {
    const park = ['192', '168', '88', ''].join('.');
    const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
    for (const file of [
      at('../src/services/test-page.ts'),
      at('./s952-test-page-names-printer.test.ts'),
      at('../../../packages/db/src/seed/index.ts'),
      at('../../console/src/lib/printerAddress.ts'),
    ]) {
      expect(readFileSync(file, 'utf8').includes(park), file).toBe(false);
    }
  });

  it('a copy asked for from History is composed for the same printer', async () => {
    const { job } = await testPrint('test_page', 'bar');
    const [boxRow] = await ctx.db.select().from(box).where(eq(box.id, boxId));
    const copy = await reprintJob(
      ctx.db,
      { requestId: 'zz-test-scrum-952' },
      { accountId: job.requestedByAccountId!, operatorId },
      job,
      boxRow!,
      'ZZ TEST SCRUM-952 copy',
      newId(),
    );
    const [command] = await ctx.db.select().from(boxCommand).where(eq(boxCommand.id, copy.commandId));
    expect(command!.payload).toMatchObject({ document: 'platform', kind: 'test_page', reprintOf: job.id });
    const document = await buildPrintDocument(ctx.db, { boxId, operatorId }, copy.printJob.id);
    expect(document.job.data).toMatchObject({ deviceLabel: PRINTER.label, address: PRINTER.address });
  });
});
