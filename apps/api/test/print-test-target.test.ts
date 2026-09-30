import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, asc, eq, isNull } from 'drizzle-orm';
import { box, boxCommand, branch, device, printJob, station, stationDevice } from '@oto/db';
import { newId } from '@oto/shared';
import {
  createTestContext,
  signInAs,
  teardownAll,
  ADMIN,
  CENTRAL_BRANCH_CODE,
  type TestContext,
} from './helpers';

/**
 * SCRUM-476 — a template's Test print names the STATION's printer for the
 * role its printout takes, and nothing else.
 *
 * Seen on staging: in the till back office at Reception Till 1, the receipt
 * template's Test print was labelled "to Booth Voucher Printer". The editor
 * had asked without a station, and the resolution then fell back to "the
 * branch's first box by slot, and any printer on it carrying the role". The
 * booth's Pi box sorts first (`booth-1` < `virtual-1`) and its only
 * receipt-role device is the booth's voucher printer. A printer's role is a
 * fact about a station, so without one there is no right printer for a kind:
 * the answer is now to ask for a station, and with one the routing looks
 * only at that station's own assignments.
 */

let ctx: TestContext;
let cookie: string;

beforeAll(async () => {
  ctx = await createTestContext();
  cookie = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
});
afterAll(async () => {
  await ctx.close();
  await teardownAll();
});

async function get(url: string) {
  return ctx.app.inject({ method: 'GET', url, headers: { cookie } });
}
async function post(url: string, payload?: unknown, headers: Record<string, string> = {}) {
  return ctx.app.inject({
    method: 'POST',
    url,
    headers: { cookie, ...headers },
    payload: payload as never,
  });
}

interface Target {
  printer: { deviceId: string; label: string } | null;
  note: string | null;
  widthDots: number;
}

/** The seeded fleet at Central: two boxes, three stations, distinct printers. */
async function central() {
  const [row] = await ctx.db
    .select({ id: branch.id, operatorId: branch.operatorId })
    .from(branch)
    .where(eq(branch.code, CENTRAL_BRANCH_CODE))
    .limit(1);
  const branchId = row!.id;
  const stationNamed = async (name: string) => {
    const [s] = await ctx.db
      .select()
      .from(station)
      .where(and(eq(station.branchId, branchId), eq(station.name, name)))
      .limit(1);
    expect(s, `the seed has ${name} at Central`).toBeTruthy();
    return s!;
  };
  const templates = (await get(`/branches/${branchId}/print-templates`)).json().templates as {
    id: string;
    type: string;
  }[];
  const template = (type: string) => {
    const t = templates.find((x) => x.type === type);
    expect(t, `the branch has a ${type} template`).toBeTruthy();
    return t!;
  };
  return {
    branchId,
    operatorId: row!.operatorId,
    till: await stationNamed('Reception Till 1'),
    counter2: await stationNamed('Counter 2'),
    booth: await stationNamed('Booth 1'),
    template,
  };
}

async function targetOf(templateId: string, stationId: string | null): Promise<Target> {
  const res = await get(
    `/print-templates/${templateId}/test-print-target${stationId ? `?stationId=${stationId}` : ''}`,
  );
  expect(res.statusCode, res.body).toBe(200);
  return res.json() as Target;
}

describe('the printer a template’s Test print names is the station’s own (SCRUM-476)', () => {
  /**
   * The kind-to-printer table at two tills with distinct printers, as the seed
   * assigns them: Reception Till 1 on box 1 carries receipt, kitchen and both
   * band roles; Counter 2 on box 2 carries receipt and bar on one 80 mm unit.
   * A label here is the printer that kind really prints to at that station,
   * and a null is a role that station's routing has nothing for — never a
   * printer borrowed from the other till.
   */
  it.each([
    ['Reception Till 1', 'receipt', 'Receipt Printer 1'],
    ['Reception Till 1', 'credit_voucher', 'Receipt Printer 1'],
    ['Reception Till 1', 'kitchen_ticket', 'Kitchen Printer'],
    ['Reception Till 1', 'kids_wristband', 'Band Printer (kids)'],
    ['Reception Till 1', 'adult_wristband', 'Band Printer (adults)'],
    ['Reception Till 1', 'bar_ticket', null],
    ['Counter 2', 'receipt', 'Receipt Printer 3'],
    ['Counter 2', 'credit_voucher', 'Receipt Printer 3'],
    ['Counter 2', 'bar_ticket', 'Receipt Printer 3'],
    ['Counter 2', 'kitchen_ticket', null],
    ['Counter 2', 'kids_wristband', null],
    ['Counter 2', 'adult_wristband', null],
  ] as const)('%s: a %s test print goes to %s', async (stationName, type, label) => {
    const { till, counter2, template } = await central();
    const at = stationName === 'Counter 2' ? counter2 : till;
    const target = await targetOf(template(type).id, at.id);
    if (label) {
      expect(target.printer?.label).toBe(label);
      expect(target.note).toBeNull();
      // The device it names is one of THIS station's assignments.
      const assigned = await ctx.db
        .select({ deviceId: stationDevice.deviceId })
        .from(stationDevice)
        .where(eq(stationDevice.stationId, at.id));
      expect(assigned.map((a) => a.deviceId)).toContain(target.printer!.deviceId);
    } else {
      expect(target.printer).toBeNull();
      expect(target.note).toMatch(/^No printer takes .+ at this station$/);
    }
  });

  it('the none case: a role the station has no printer for is said in words', async () => {
    // Booth 1 carries only a receipt role. What a test print then records —
    // a skipped job, no command — is `print-preview-samples.test.ts` ("a
    // print that cannot be queued leaves no pull behind") with the box up.
    const { booth, template } = await central();
    const target = await targetOf(template('kids_wristband').id, booth.id);
    expect(target).toMatchObject({
      printer: null,
      note: 'No printer takes kids bands at this station',
    });
    expect(target.widthDots).toBeGreaterThan(0);
  });
});

/**
 * The cross-station case, in staging's own shape: a third box at Central
 * whose slot sorts before every virtual box, carrying one booth station whose
 * receipt-role device is a voucher printer.
 */
describe('a receipt test at the till can never name another station’s voucher printer (SCRUM-476)', () => {
  const ids = { box: newId(), station: newId(), device: newId() };

  beforeAll(async () => {
    const { branchId, operatorId } = await central();
    await ctx.db.insert(box).values({
      id: ids.box,
      operatorId,
      branchId,
      name: 'FortuneWheelBox',
      slot: 'booth-1',
      role: 'virtual',
      status: 'unclaimed',
    });
    await ctx.db.insert(station).values({
      id: ids.station,
      operatorId,
      branchId,
      boxId: ids.box,
      name: 'FWBooth1',
      kind: 'booth',
      codePrefix: 'B9',
      capabilities: [],
      accessScope: 'all_staff',
    });
    await ctx.db.insert(device).values({
      id: ids.device,
      operatorId,
      branchId,
      boxId: ids.box,
      kind: 'receipt_printer',
      label: 'Booth Voucher Printer',
      transport: 'simulated',
      protocol: 'escpos',
      reachability: 'reachable',
      paperStatus: 'ok',
    });
    await ctx.db
      .insert(stationDevice)
      .values({ id: newId(), stationId: ids.station, role: 'receipt', deviceId: ids.device });
  });

  it('that box is the one the old fallback would have picked', async () => {
    // The premise of the staging symptom, stated so the test below proves
    // something: by slot, the booth's box comes first at this branch.
    const { branchId } = await central();
    const [first] = await ctx.db
      .select({ id: box.id })
      .from(box)
      .where(and(eq(box.branchId, branchId), isNull(box.archivedAt)))
      .orderBy(asc(box.slot))
      .limit(1);
    expect(first!.id).toBe(ids.box);
  });

  it('at Reception Till 1 the receipt test names the till’s receipt printer', async () => {
    const { till, template } = await central();
    const target = await targetOf(template('receipt').id, till.id);
    expect(target.printer?.label).toBe('Receipt Printer 1');
    expect(target.printer?.deviceId).not.toBe(ids.device);
    expect(target.note).toBeNull();
  });

  it('at the booth station it names the booth’s own printer — routing is by station, not by label', async () => {
    const { template } = await central();
    const target = await targetOf(template('receipt').id, ids.station);
    expect(target.printer).toEqual({ deviceId: ids.device, label: 'Booth Voucher Printer' });
  });

  it('without a station it names no printer and asks for one, and the print is refused', async () => {
    const { template } = await central();
    const receipt = template('receipt');
    const target = await targetOf(receipt.id, null);
    expect(target.printer).toBeNull();
    expect(target.note).toBe('Pick a station first: a test print goes to that station’s printer');
    expect(JSON.stringify(target)).not.toContain('Booth Voucher Printer');

    const action = newId();
    const res = await post(`/print-templates/${receipt.id}/test-print`, {}, { 'x-oto-action-id': action });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error.code).toBe('STATION_REQUIRED');
    expect(await ctx.db.select().from(printJob).where(eq(printJob.actionId, action))).toHaveLength(0);
    expect(await ctx.db.select().from(boxCommand).where(eq(boxCommand.actionId, action))).toHaveLength(0);
  });

  it('still previews without a station, at the kind’s own paper', async () => {
    const { template } = await central();
    const res = await post(`/print-templates/${template('receipt').id}/preview.png`, {});
    expect(res.statusCode, res.body).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(Number(res.headers['x-oto-preview-width-dots'])).toBeGreaterThan(0);
  });
});
