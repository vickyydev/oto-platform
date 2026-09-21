/**
 * The box's printing side, assembled (S2-06).
 *
 * The one decision this file makes is **which devices are simulated**, and it
 * takes the answer from the device row rather than from a flag on the process:
 * a device whose `transport` is `simulated` is served by a simulator, and every
 * other printer is a real socket on TCP 9100. That is what the seed already
 * says about the park's six printers on the two virtual boxes, and it is what
 * lets one Raspberry Pi in Phuket drive four real printers and one simulated
 * band printer while somebody waits for stock — without a build flag, without a
 * branch in the adapter, and without a "simulate everything" switch that could
 * be left on in the park.
 *
 * The simulators are created lazily from the config bundle, so a printer added
 * on the Console appears here on the next config pull, and a device removed
 * there stops existing here.
 */

import type { PrintKind, PrintTemplate, PrinterFault } from '@oto/shared';
import type { BoxConfigBundle, BoxConfigDevice } from '../protocol';
import { PrinterError, parseAddress, tcpChannel, type ChannelFactory } from './channel';
import { createPrinterSimulator, type Printout, type PrinterSimulator, type SimulatorEvent } from './simulator';
import { createPrintSubsystem, profileFor, type PrintRequest, type PrintSubsystem } from './queue';

export * from './channel';
export * from './adapter';
export * from './queue';
export * from './simulator';

export interface PrintingOptions {
  bundle: () => BoxConfigBundle | null;
  templates: () => readonly PrintTemplate[];
  now?: () => Date;
  log?: (level: 'info' | 'warn' | 'error', msg: string, detail?: Record<string, unknown>) => void;
  report?: Parameters<typeof createPrintSubsystem>[0]['report'];
  retryDelayMs?: number;
  /** Open a socket to a real printer. Swapped in tests; never for a simulator. */
  openReal?: ChannelFactory;
}

export interface PrintingController {
  readonly jobs: PrintSubsystem;
  submit(request: PrintRequest): ReturnType<PrintSubsystem['submit']>;
  /** Every simulator this box currently stands up, keyed by device id. */
  simulators(): PrinterSimulator[];
  simulator(deviceId: string): PrinterSimulator | undefined;
  /** Returns false when the device is not one this box simulates. */
  setFault(deviceId: string, fault: PrinterFault): boolean;
  clearFaults(deviceId: string): boolean;
  printouts(deviceId: string, limit?: number): Printout[];
  events(deviceId: string, limit?: number): SimulatorEvent[];
}

/** Every printer the bundle names, once, whichever station it hangs off. */
export function printerDevices(bundle: BoxConfigBundle | null): BoxConfigDevice[] {
  const seen = new Set<string>();
  const out: BoxConfigDevice[] = [];
  for (const station of bundle?.stations ?? []) {
    for (const device of station.devices) {
      if (seen.has(device.id)) continue;
      if (!device.kind.endsWith('printer')) continue;
      seen.add(device.id);
      out.push(device);
    }
  }
  return out;
}

export function createPrinting(options: PrintingOptions): PrintingController {
  const openReal = options.openReal ?? tcpChannel;
  const sims = new Map<string, PrinterSimulator>();

  /**
   * Stand a simulator up for every simulated printer in the current bundle and
   * drop the ones whose device has gone.
   *
   * Called on every channel open rather than on a config change, because the
   * bundle is a function and the cheapest correct moment to reconcile is the
   * moment somebody asks for a socket.
   */
  function reconcile(): Map<string, BoxConfigDevice> {
    const devices = new Map(printerDevices(options.bundle()).map((d) => [d.id, d]));
    for (const id of [...sims.keys()]) if (!devices.has(id)) sims.delete(id);
    for (const [id, device] of devices) {
      if (device.transport !== 'simulated') {
        sims.delete(id);
        continue;
      }
      const existing = sims.get(id);
      const profile = profileFor(device);
      // Width and model are read from the device row, so a unit corrected from
      // 576 to 512 on the Console changes what the simulator accepts too —
      // which is the point of the correction.
      if (existing && existing.widthDots === profile.widthDots && existing.model === profile.model) {
        continue;
      }
      sims.set(
        id,
        createPrinterSimulator({
          deviceId: id,
          label: device.label,
          model: profile.model,
          language: profile.language,
          widthDots: profile.widthDots,
          now: options.now,
        }),
      );
    }
    return devices;
  }

  /**
   * One factory in front of both worlds.
   *
   * The adapter above it cannot tell which it got, which is the property worth
   * having: whatever the simulator proves about the adapter is a claim about
   * the code that will drive the real printer, because it IS that code.
   */
  const open: ChannelFactory = async (target) => {
    const devices = reconcile();
    for (const [id, device] of devices) {
      const at = parseAddress(device.address);
      if (!at || at.host !== target.host || at.port !== target.port) continue;
      const sim = sims.get(id);
      if (sim) return sim.connect();
      // A real printer at this address. Fall through to the socket.
      break;
    }
    return openReal(target);
  };

  const jobs = createPrintSubsystem({
    bundle: options.bundle,
    templates: options.templates,
    open,
    now: options.now,
    log: options.log,
    report: options.report,
    retryDelayMs: options.retryDelayMs,
  });

  function find(deviceId: string): PrinterSimulator | undefined {
    reconcile();
    return sims.get(deviceId);
  }

  return {
    jobs,
    submit: (request) => jobs.submit(request),
    simulators() {
      reconcile();
      return [...sims.values()];
    },
    simulator: find,
    setFault(deviceId, fault) {
      const sim = find(deviceId);
      if (!sim) return false;
      sim.setFault(fault);
      return true;
    },
    clearFaults(deviceId) {
      const sim = find(deviceId);
      if (!sim) return false;
      sim.clearFaults();
      return true;
    },
    printouts(deviceId, limit) {
      return find(deviceId)?.printouts(limit) ?? [];
    },
    events(deviceId, limit) {
      return find(deviceId)?.events(limit) ?? [];
    },
  };
}

/**
 * Turn a print kind into the renderer's job, using the fixture sample for that
 * kind.
 *
 * A **test print's content is fixture content** by definition — it exists to
 * prove the renderer, the transport and the paper path, not to say anything
 * about a sale — so it renders the same sample data the renderer's own committed
 * fixtures pin, which is also where the acceptance criterion's two strings
 * (`สวัสดี OTO Park`, `Привет`) come from. Anything else would be a second set
 * of sample data that could quietly drift from the fixtures.
 *
 * The import is deliberately dynamic: the fixture module pulls in the whole
 * template set, and a box that never prints a test page should not pay for it
 * at boot.
 */
export async function testPrintJob(
  kind: PrintKind,
): Promise<Parameters<PrintSubsystem['submit']>[0]['job']> {
  const { FIXTURES } = await import('@oto/print/fixtures');
  const fixture = FIXTURES.find((f) => f.job.kind === kind);
  if (!fixture) {
    throw new PrinterError('RENDER_FAILED', `there is no sample print for ${kind}`);
  }
  return fixture.job;
}
