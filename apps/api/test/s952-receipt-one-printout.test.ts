import { describe, expect, it } from 'vitest';
import { FIXTURES } from '@oto/print/fixtures';
import { parseEscpos } from '@oto/print/reader';
import {
  createPrinting,
  type BoxConfigBundle,
  type BoxConfigDevice,
  type BoxConfigStation,
  type ChannelFactory,
} from '@oto/box-agent';

/**
 * SCRUM-952 point 4 — ONE CASH RECEIPT, ONE PRINTOUT.
 *
 * The SCRUM-898 and SCRUM-930 staging proofs read the virtual box's simulated
 * receipt printer after every cash sale and found two printouts: the receipt,
 * and a second one 576 dots wide and 0 high, a fifth of a second later.
 *
 * What the second one is: the cash drawer. A sale that took cash opens the
 * drawer with `ESC p` on a session of its own (`pulseDrawer` in
 * `packages/box-agent/src/printing/adapter.ts`, the box's `drawer_kick`
 * command), and the simulator turned every closed session into a printout —
 * this one with no rows and no cut, so "cut off mid-job". The existing
 * `s737-first-sale-print-review` pinned exactly that: five bytes, height 0.
 *
 * Nothing in the printing changes. This proves what a real ESC/POS receipt
 * printer receives for one cash receipt — two sessions, the receipt's ending
 * in its one cut and the drawer's five bytes moving no paper — and that the
 * simulator now records the drawer as the `drawer.kick` it was rather than
 * as a printout.
 */

const RECEIPT = FIXTURES.find((f) => f.job.kind === 'receipt')!.job;

const ESC = 0x1b;
const GS = 0x1d;
const DLE = 0x10;
/** `ESC p 0 25 250`: drawer pin 2, 50 ms on, 500 ms off — the box's pulse. */
const PULSE = [ESC, 0x70, 0x00, 0x19, 0xfa];

function receiptPrinter(over: Partial<BoxConfigDevice> = {}): BoxConfigDevice {
  return {
    id: 'dev-receipt',
    role: 'receipt',
    kind: 'receipt_printer',
    label: 'ZZ TEST SCRUM-952 receipt printer',
    transport: 'simulated',
    address: '192.0.2.52:9100',
    model: 'Welltech G4 (Xprinter XP-C260)',
    protocol: 'escpos',
    serialNumber: null,
    terminalId: null,
    merchantId: null,
    settings: { escpos: { drawerKick: true } },
    ...over,
  } as BoxConfigDevice;
}

function bundleOf(devices: BoxConfigDevice[]): BoxConfigBundle {
  const station: BoxConfigStation = {
    id: 'station-1',
    name: 'ZZ TEST SCRUM-952 till',
    kind: 'till',
    codePrefix: 'Z1',
    capabilities: [],
    configVersion: 1,
    paymentRouting: null,
    offlineWalletCapSatang: null,
    accessScope: 'branch',
    devices,
  };
  return {
    configVersion: 'v1',
    box: { id: 'box-1', name: 'Box 1', slot: 'virtual-1', role: 'virtual', epoch: 1, status: 'online' },
    branch: {
      id: 'branch-1',
      code: 'HKT',
      name: 'HKT Central',
      operatorId: 'op-1',
      timezone: 'Asia/Bangkok',
      openingHours: null,
      businessDayStart: '06:00',
    },
    stations: [station],
    printTemplates: [],
    signingKeys: [],
    heartbeatIntervalS: 60,
    minSupportedAgentVersion: '0.1.0',
  };
}

function printing(devices: BoxConfigDevice[], openReal?: ChannelFactory) {
  return createPrinting({
    ...(openReal ? { openReal } : {}),
    bundle: () => bundleOf(devices),
    templates: () => [],
    retryDelayMs: 0,
  });
}

/** A cash sale at the counter: its receipt job, then the drawer it took the cash into. */
async function cashReceipt(controller: ReturnType<typeof printing>) {
  const printed = await controller.submit({ id: 'job-receipt', kind: 'receipt', job: RECEIPT, stationId: 'station-1' });
  const drawer = await controller.pulseDrawer({ stationId: 'station-1' });
  return { printed, drawer };
}

/** Bytes as a real printer would be handed them, with the `DLE EOT n` status reads taken out. */
function withoutStatusReads(bytes: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < bytes.length; i += 1) {
    if (bytes[i] === DLE && bytes[i + 1] === 0x04) {
      i += 2;
      continue;
    }
    out.push(bytes[i]!);
  }
  return out;
}

describe('SCRUM-952 — one cash receipt leaves one printout', () => {
  it('the simulator records the receipt as the printout and the drawer as a drawer kick', async () => {
    const controller = printing([receiptPrinter()]);
    const { printed, drawer } = await cashReceipt(controller);
    expect(printed.status).toBe('printed');
    expect(drawer.opened).toBe(true);

    const sim = controller.simulator('dev-receipt')!;
    const printouts = sim.printouts();
    expect(printouts.map((p) => ({ height: p.heightDots > 0, truncated: p.truncated }))).toEqual([
      { height: true, truncated: false },
    ]);
    expect(printouts.some((p) => p.heightDots === 0)).toBe(false);

    const events = sim.events();
    expect(events.filter((e) => e.kind === 'job.printed')).toHaveLength(1);
    expect(events.filter((e) => e.kind === 'cut')).toHaveLength(1);
    const kicks = events.filter((e) => e.kind === 'drawer.kick');
    expect(kicks.map((e) => e.detail)).toEqual([{ pin: 0, onMs: 50, offMs: 500, jobBytes: 5, paper: false }]);
  });

  it('a second cash sale is a second printout, never a fourth', async () => {
    const controller = printing([receiptPrinter()]);
    await cashReceipt(controller);
    await controller.submit({ id: 'job-receipt-2', kind: 'receipt', job: RECEIPT, stationId: 'station-1' });
    await controller.pulseDrawer({ stationId: 'station-1' });
    const sim = controller.simulator('dev-receipt')!;
    expect(sim.printouts().map((p) => p.seq)).toEqual([1, 2]);
    expect(sim.printouts().every((p) => p.heightDots > 0 && !p.truncated)).toBe(true);
    expect(sim.events().filter((e) => e.kind === 'drawer.kick')).toHaveLength(2);
  });

  it('what a real ESC/POS receipt printer receives: the receipt with one cut, then five bytes that move no paper', async () => {
    const sessions: number[][] = [];
    const openReal: ChannelFactory = async () => {
      const session: number[] = [];
      sessions.push(session);
      return {
        async write(bytes: Uint8Array) {
          session.push(...bytes);
        },
        async query(bytes: Uint8Array) {
          session.push(...bytes);
          // `DLE EOT n`, answered as a printer that is ready with paper.
          return new Uint8Array([0x12]);
        },
        async close() {},
      };
    };
    const controller = printing([receiptPrinter({ transport: 'lan', address: '192.0.2.53:9100' })], openReal);
    const { printed, drawer } = await cashReceipt(controller);
    expect(printed.status).toBe('printed');
    expect(drawer.opened).toBe(true);

    expect(sessions).toHaveLength(2);
    const [receipt, pulse] = sessions.map(withoutStatusReads);

    // The receipt: one job, starting `ESC @`, ending in its one partial cut.
    const parsed = parseEscpos(Uint8Array.from(receipt!), 576);
    expect(receipt!.slice(0, 2)).toEqual([ESC, 0x40]);
    expect(receipt!.slice(-4)).toEqual([GS, 0x56, 0x42, 0x00]);
    expect(parsed.cuts).toBe(1);
    expect(parsed.bitmap.height).toBeGreaterThan(100);
    expect(parsed.drawerKicks).toHaveLength(0);

    // The drawer: `ESC p` and nothing else — no rows, no feed, no cut.
    expect(pulse).toEqual(PULSE);
  });
});
