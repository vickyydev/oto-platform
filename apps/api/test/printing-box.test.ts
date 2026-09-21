import { describe, expect, it } from 'vitest';
import { FIXTURES, PROFILES } from '@oto/print/fixtures';
import { parseEscpos } from '@oto/print/reader';
import { renderJob } from '@oto/print';
import {
  PrinterError,
  ROLE_FOR_KIND,
  createPrinterSimulator,
  createPrinting,
  escposAdapter,
  printerDevices,
  tcpChannel,
  testPrintJob,
  tsplAdapter,
  type BoxConfigBundle,
  type BoxConfigDevice,
  type BoxConfigStation,
  type PrintJobOutcome,
  type PrinterChannel,
} from '@oto/box-agent';

/**
 * S2-06 — the box's print pipeline, by itself.
 *
 * No database and no HTTP: this is the adapter, the simulator and the queue,
 * which is where the four cases the ticket calls out actually live. The routed
 * path is `print-api.test.ts`; this is the part of it that has to be right
 * before a route is worth writing.
 *
 * **It lives in `apps/api/test` and not in `packages/box-agent/test` for one
 * concrete reason:** that package runs on Node's own test runner with
 * `--experimental-strip-types`, which refuses TypeScript parameter properties
 * — and `Bitmap1`'s constructor uses them, so `@oto/print` cannot be imported
 * there at all. The api's vitest transpiles properly and depends on both
 * packages. Recorded rather than left as a puzzle for whoever wonders why
 * these are not beside the code they test.
 */

const RECEIPT = FIXTURES.find((f) => f.job.kind === 'receipt')!.job;
const KIDS_BAND = FIXTURES.find((f) => f.job.kind === 'kids_wristband')!.job;

function device(
  over: Partial<BoxConfigDevice> & Pick<BoxConfigDevice, 'id' | 'role'>,
): BoxConfigDevice {
  return {
    kind: 'receipt_printer',
    label: 'Receipt Printer 1',
    transport: 'simulated',
    address: '192.168.88.202:9100',
    model: 'Welltech G4 (Xprinter XP-C260)',
    protocol: 'escpos',
    serialNumber: null,
    terminalId: null,
    merchantId: null,
    ...over,
  };
}

function bundleOf(devices: BoxConfigDevice[]): BoxConfigBundle {
  const station: BoxConfigStation = {
    id: 'station-1',
    name: 'Reception Till 1',
    kind: 'till',
    codePrefix: 'T1',
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

function printing(devices: BoxConfigDevice[]) {
  let current = bundleOf(devices);
  const reported: PrintJobOutcome[] = [];
  const controller = createPrinting({
    bundle: () => current,
    /**
     * The bundle's templates are `PrintTemplateWire` — `type: string`, because
     * the wire is deliberately loose about a vocabulary the cloud may extend
     * before a box is updated — and the subsystem wants the closed union. The
     * agent parses them with `PrintTemplateSchema`; here the fixtures carry
     * none, so an empty list says exactly that rather than a cast saying
     * something it cannot know.
     */
    templates: () => [],
    report: (outcome) => {
      reported.push(outcome);
    },
    retryDelayMs: 0,
  });
  return {
    controller,
    reported,
    setBundle(next: BoxConfigDevice[]) {
      current = bundleOf(next);
    },
  };
}

describe('the printers the box drives (S2-06)', () => {
  it('a receipt reaches the simulator as the same dots the renderer drew', async () => {
    const { controller, reported } = printing([device({ id: 'dev-receipt', role: 'receipt' })]);

    const outcome = await controller.submit({ id: 'job-1', kind: 'receipt', job: RECEIPT });

    expect(outcome.status).toBe('printed');
    expect(outcome.deviceId).toBe('dev-receipt');
    expect(reported.map((r) => r.status)).toEqual(['printed']);

    const sim = controller.simulator('dev-receipt')!;
    const [printout] = sim.printouts();
    expect(printout).toBeTruthy();
    expect(printout!.truncated).toBe(false);
    expect(printout!.widthDots).toBe(576);
    expect(printout!.heightDots).toBeGreaterThan(100);
    expect([...printout!.preview.subarray(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);

    // Cut once. No drawer: nothing asked for one, and this printer's row does
    // not say a drawer hangs off its RJ11.
    expect(sim.events().filter((e) => e.kind === 'cut')).toHaveLength(1);
    expect(sim.events().filter((e) => e.kind === 'drawer.kick')).toHaveLength(0);
  });

  /**
   * The drawer, which needs BOTH halves to agree.
   *
   * §7.3: the drawer hangs off the receipt printer's RJ11 and is fired by the
   * printer, so the pulse is bytes inside the print job rather than a command
   * of its own. Whether a drawer EXISTS is the device row
   * (`settings.escpos.drawerKick`); whether it should OPEN is the sale, which
   * is S2-11's decision and arrives here as the job's `finish`. A printer with
   * no drawer drops the pulse rather than erroring, which is what stops a
   * mis-set flag from failing a receipt.
   */
  it('fires the cash drawer only where the printer has one', async () => {
    const pulse = { pin: 0 as const, onMs: 50, offMs: 500 };

    const withDrawer = printing([
      device({ id: 'dev-drawer', role: 'receipt', settings: { escpos: { drawerKick: true } } }),
    ]);
    expect(
      (await withDrawer.controller.submit({ id: 'j1', kind: 'receipt', job: RECEIPT, finish: { drawerKick: pulse } }))
        .status,
    ).toBe('printed');
    const kicks = withDrawer.controller
      .simulator('dev-drawer')!
      .events()
      .filter((e) => e.kind === 'drawer.kick');
    expect(kicks).toHaveLength(1);
    // `ESC p 0 25 250` — pin 2, 50 ms on, 500 ms off (§9.3).
    expect(kicks[0]!.detail).toEqual({ pin: 0, onMs: 50, offMs: 500 });

    const without = printing([device({ id: 'dev-plain', role: 'receipt' })]);
    expect(
      (await without.controller.submit({ id: 'j2', kind: 'receipt', job: RECEIPT, finish: { drawerKick: pulse } }))
        .status,
    ).toBe('printed');
    expect(
      without.controller.simulator('dev-plain')!.events().filter((e) => e.kind === 'drawer.kick'),
    ).toHaveLength(0);
  });

  it('a band reaches the label simulator with its TSPL setup intact', async () => {
    const { controller } = printing([
      device({
        id: 'dev-band',
        role: 'kids_band',
        kind: 'band_printer',
        label: 'Band Printer (kids)',
        model: '4B-2082A',
        protocol: 'tspl2',
        address: '192.168.88.204:9100',
      }),
    ]);

    const outcome = await controller.submit({ id: 'job-band', kind: 'kids_wristband', job: KIDS_BAND });
    expect(outcome.status).toBe('printed');

    const [printout] = controller.simulator('dev-band')!.printouts();
    // 50 mm of band at 8 dots/mm (§9.1).
    expect(printout!.widthDots).toBe(400);
    expect(printout!.setup).toContain('SIZE 50 mm,250 mm');
    expect(printout!.setup).toContain('GAP 3 mm,0 mm');
  });

  it('routes each printout to the role the prototype routed it to', async () => {
    expect(ROLE_FOR_KIND).toEqual({
      receipt: 'receipt',
      kitchen_ticket: 'kitchen',
      bar_ticket: 'bar',
      kids_wristband: 'kids_band',
      adult_wristband: 'adult_band',
      credit_voucher: 'receipt',
      item_voucher: 'receipt',
      booth_voucher: 'receipt',
      test_page: 'receipt',
    });
    for (const kind of Object.keys(ROLE_FOR_KIND) as (keyof typeof ROLE_FOR_KIND)[]) {
      expect((await testPrintJob(kind)).kind).toBe(kind);
    }
  });

  it('renders a 512-dot unit at 512 dots', async () => {
    const { controller } = printing([
      device({
        id: 'dev-narrow',
        role: 'receipt',
        label: 'Secondary counter',
        model: 'XP-80C',
        settings: { escpos: { dotsPerLine: 512 } },
      }),
    ]);
    expect((await controller.submit({ id: 'j', kind: 'receipt', job: RECEIPT })).status).toBe('printed');
    expect(controller.simulator('dev-narrow')!.printouts()[0]!.widthDots).toBe(512);
  });

  it('gives a simulator only to simulated printers', () => {
    const devices = [
      device({ id: 'dev-receipt', role: 'receipt' }),
      device({
        id: 'dev-real',
        role: 'kitchen',
        kind: 'kitchen_printer',
        transport: 'lan',
        address: '192.168.88.206:9100',
      }),
      device({ id: 'dev-scanner', role: 'scanner', kind: 'scanner', transport: 'usb', address: null }),
    ];
    expect(printerDevices(bundleOf(devices)).map((d) => d.id)).toEqual(['dev-receipt', 'dev-real']);

    const { controller } = printing(devices);
    expect(controller.simulators().map((s) => s.deviceId)).toEqual(['dev-receipt']);
    expect(controller.setFault('dev-real', 'paper_out')).toBe(false);
    expect(controller.setFault('dev-scanner', 'paper_out')).toBe(false);
  });
});

describe('what a printer does when it is unwell (S2-06)', () => {
  it('queues on paper out, reports once, and prints when the paper is back', async () => {
    const { controller, reported } = printing([device({ id: 'dev-receipt', role: 'receipt' })]);
    expect(controller.setFault('dev-receipt', 'paper_out')).toBe(true);

    const first = await controller.submit({ id: 'job-2', kind: 'receipt', job: RECEIPT });
    expect(first.status).toBe('queued');
    expect(first.errorCode).toBe('PRINTER_PAPER_OUT');
    expect(controller.simulator('dev-receipt')!.printouts()).toHaveLength(0);
    expect(controller.jobs.health()['dev-receipt']?.paperStatus).toBe('out');

    // A retry while the paper is still out must not rewrite the cloud row: a
    // row rewritten every thirty seconds is a row with no history in it.
    await controller.jobs.tick();
    expect(reported).toHaveLength(1);

    controller.clearFaults('dev-receipt');
    const [second] = await controller.jobs.tick();
    expect(second!.status).toBe('printed');
    expect(controller.jobs.pending()).toHaveLength(0);
    expect(reported.map((r) => r.status)).toEqual(['queued', 'printed']);
  });

  it('probes report what the printer says, not what we hope', async () => {
    const { controller } = printing([device({ id: 'dev-receipt', role: 'receipt' })]);
    // Nothing is claimed before anything has been asked.
    expect(controller.jobs.health()).toEqual({});

    expect((await controller.jobs.probeAll())['dev-receipt']).toMatchObject({
      reachability: 'reachable',
      paperStatus: 'ok',
      statusUnknown: false,
    });

    controller.setFault('dev-receipt', 'paper_low');
    expect((await controller.jobs.probeAll())['dev-receipt']?.paperStatus).toBe('low');

    controller.setFault('dev-receipt', 'cover_open');
    expect((await controller.jobs.probeAll())['dev-receipt']?.coverOpen).toBe(true);

    controller.clearFaults('dev-receipt');
    controller.setFault('dev-receipt', 'unreachable');
    expect((await controller.jobs.probeAll())['dev-receipt']).toMatchObject({
      reachability: 'unreachable',
      lastError: 'PRINTER_UNREACHABLE',
    });
  });

  it('queues rather than loses a job when nothing answers', async () => {
    const { controller } = printing([device({ id: 'dev-receipt', role: 'receipt' })]);
    controller.setFault('dev-receipt', 'unreachable');

    const outcome = await controller.submit({ id: 'job-3', kind: 'receipt', job: RECEIPT });
    expect(outcome.status).toBe('queued');
    expect(outcome.errorCode).toBe('PRINTER_UNREACHABLE');

    controller.clearFaults('dev-receipt');
    expect((await controller.jobs.tick())[0]!.status).toBe('printed');
  });
});

/**
 * The four the ticket names as most likely to be got wrong. Each is a decision
 * written down in `packages/box-agent/src/printing/queue.ts`; these are the
 * cases that hold the decisions to their word.
 */
describe('a printer is a socket that can be unplugged (S2-06)', () => {
  it('fails a job cut mid-print and never retries it unattended', async () => {
    const sim = createPrinterSimulator({
      deviceId: 'dev-receipt',
      label: 'Receipt Printer 1',
      model: 'Welltech G4',
      language: 'escpos',
      widthDots: 576,
    });

    /** Takes the first half of the job and then dies, as an unplugged cable does. */
    const dying = async (): Promise<PrinterChannel> => {
      const inner = sim.connect();
      let first = true;
      return {
        async write(bytes) {
          if (!first) throw new PrinterError('PRINTER_WRITE_FAILED', 'cable pulled', { partial: true });
          first = false;
          await inner.write(bytes.subarray(0, Math.floor(bytes.length / 2)));
          throw new PrinterError('PRINTER_WRITE_FAILED', 'cable pulled', { partial: true });
        },
        query: (bytes, expect_, ms) => inner.query(bytes, expect_, ms),
        close: () => inner.close(),
      };
    };

    const adapter = escposAdapter({
      deviceId: 'dev-receipt',
      label: 'Receipt Printer 1',
      target: { host: '192.168.88.202', port: 9100 },
      open: dying,
      now: () => new Date(),
    });

    const bytes = renderJob(RECEIPT, { device: PROFILES.escpos576! }).bytes;
    await expect(adapter.print({ bytes })).rejects.toMatchObject({
      code: 'PRINTER_WRITE_FAILED',
      // The pair that decides against a timer sending it again: paper has
      // already come out, so trying again hands the guest a second receipt.
      partial: true,
      retryable: false,
    });

    // The paper that did come out is kept and marked unfinished, rather than
    // disappearing as though the job had never started.
    await sim.connect().close();
    const dropped = sim.events().filter((e) => e.kind === 'job.dropped');
    const printed = sim.printouts();
    expect(dropped.length + printed.length).toBeGreaterThan(0);
    for (const out of printed) expect(out.truncated).toBe(true);
  });

  it('prints to a printer that answers no status query, and says the status is unknown', async () => {
    const sim = createPrinterSimulator({
      deviceId: 'dev-silent',
      label: 'Silent XP-80',
      model: 'XP-80C',
      language: 'escpos',
      widthDots: 576,
    });

    /**
     * §9.3 leaves open whether every firmware in this family answers
     * `DLE EOT` over the LAN board. A unit that does not must still print, or
     * a park with one silent printer has a till that cannot sell.
     */
    const silent = async (): Promise<PrinterChannel> => {
      const inner = sim.connect();
      return {
        write: (bytes) => inner.write(bytes),
        async query(bytes) {
          await inner.write(bytes);
          return new Uint8Array(0);
        },
        close: () => inner.close(),
      };
    };

    const adapter = escposAdapter({
      deviceId: 'dev-silent',
      label: 'Silent XP-80',
      target: { host: '192.168.88.207', port: 9100 },
      open: silent,
      now: () => new Date(),
    });

    const result = await adapter.print({
      bytes: renderJob(RECEIPT, { device: PROFILES.escpos576! }).bytes,
    });
    expect(result.written).toBe(1);
    expect(result.health).toMatchObject({
      statusUnknown: true,
      paperStatus: 'unknown',
      reachability: 'reachable',
    });
    expect(sim.printouts()).toHaveLength(1);
  });

  it('serialises two jobs racing one printer instead of interleaving them', async () => {
    const { controller } = printing([device({ id: 'dev-receipt', role: 'receipt' })]);

    const [a, b] = await Promise.all([
      controller.submit({ id: 'job-a', kind: 'receipt', job: RECEIPT }),
      controller.submit({ id: 'job-b', kind: 'receipt', job: RECEIPT }),
    ]);

    expect(a.status).toBe('printed');
    expect(b.status).toBe('printed');
    const outs = controller.simulator('dev-receipt')!.printouts();
    expect(outs).toHaveLength(2);
    // Two whole receipts, not one interleaved mess.
    expect(outs.map((o) => o.truncated)).toEqual([false, false]);
    expect(outs.map((o) => o.seq)).toEqual([1, 2]);
    expect(outs[0]!.heightDots).toBe(outs[1]!.heightDots);
  });

  it('skips a job whose printer has left the box', async () => {
    const kit = printing([device({ id: 'dev-receipt', role: 'receipt' })]);
    kit.controller.setFault('dev-receipt', 'paper_out');
    expect((await kit.controller.submit({ id: 'job-gone', kind: 'receipt', job: RECEIPT })).status).toBe(
      'queued',
    );

    // Somebody archives the printer, or unassigns it from the station.
    kit.setBundle([]);
    const [outcome] = await kit.controller.jobs.tick();
    expect(outcome!.status).toBe('skipped');
    expect(outcome!.errorCode).toBe('DEVICE_GONE');
    expect(kit.controller.jobs.pending()).toHaveLength(0);
  });

  it('skips a job for a role no station prints, and raises nothing', async () => {
    const { controller, reported } = printing([device({ id: 'dev-receipt', role: 'receipt' })]);

    const outcome = await controller.submit({ id: 'job-band', kind: 'kids_wristband', job: KIDS_BAND });
    expect(outcome).toMatchObject({
      status: 'skipped',
      errorCode: 'NO_DEVICE_FOR_ROLE',
      role: 'kids_band',
      deviceId: null,
    });
    expect(reported.map((r) => r.status)).toEqual(['skipped']);
    expect(controller.jobs.pending()).toHaveLength(0);
  });
});

describe('the transport is a real socket (S2-06)', () => {
  it('drives a simulator over TCP with the same adapter a real printer gets', async () => {
    const sim = createPrinterSimulator({
      deviceId: 'dev-band',
      label: 'Band Printer (kids)',
      model: '4B-2082A',
      language: 'tspl2',
      widthDots: 400,
    });
    const server = await sim.listen();
    try {
      const adapter = tsplAdapter({
        deviceId: 'dev-band',
        label: 'Band Printer (kids)',
        target: { host: '127.0.0.1', port: server.port },
        open: tcpChannel,
        now: () => new Date(),
      });

      expect(await adapter.probe()).toMatchObject({ reachability: 'reachable', paperStatus: 'ok' });

      const bytes = renderJob(KIDS_BAND, { device: PROFILES.tspl400! }).bytes;
      expect((await adapter.print({ bytes })).written).toBe(1);

      // The server's last data event needs a turn before the paper is read.
      await new Promise((ok) => setTimeout(ok, 50));
      expect(sim.printouts()[0]?.widthDots).toBe(400);
    } finally {
      await server.close();
    }
  });

  it('parses our own bytes with the reader the emitters are pinned against', () => {
    const bytes = renderJob(RECEIPT, { device: PROFILES.escpos576! }).bytes;
    const parsed = parseEscpos(bytes, 576);
    expect(parsed.initialised).toBe(true);
    expect(parsed.cuts).toBe(1);
    expect(parsed.unknown).toEqual([]);
  });
});
