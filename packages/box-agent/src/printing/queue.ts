/**
 * The box's print queue (S2-06).
 *
 * Everything between "the till wants a receipt" and "paper came out": which
 * printer the job goes to, what happens when that printer is out of paper, and
 * what a person is told when it is not there at all.
 *
 * Four things were decided here rather than left to be discovered at a counter,
 * because a printer is a socket that can be unplugged mid-job:
 *
 *  1. **The connection dies after the header and before the cut.** The job is
 *     `failed` with `PRINTER_WRITE_FAILED` and is NOT retried by any timer.
 *     Bytes that reached the head have already come out of the machine, so an
 *     unattended retry puts a second, complete receipt beside a torn-off first
 *     one and afterwards nobody can say which is the real one. A person
 *     pressing reprint is a different act and mints its own job (S2-11).
 *  2. **The printer answers a status query with nothing.** The job is printed
 *     anyway and the device is reported `statusUnknown`. §9.3 leaves open
 *     whether every firmware in this family answers `DLE EOT` over the LAN
 *     board; refusing to print on an unanswered query would mean a unit whose
 *     firmware is silent never prints at all, which is a worse failure than
 *     printing without being able to see inside the machine.
 *  3. **Two jobs race for one printer.** Neither vendor document says whether a
 *     second TCP session is refused or stalled (§9.1, §9.6 — both list it as
 *     "confirm on site"), so the queue never opens two: jobs for one device are
 *     serialised in arrival order and a job waiting its turn is `queued`, not
 *     failed. One unknown on the wire is worth more than a till that deadlocks.
 *  4. **The job is queued for a printer that is no longer on this box.** The
 *     device is re-resolved from the CURRENT config bundle on every attempt, so
 *     a printer that was archived or unassigned while the job waited ends it as
 *     `skipped` with `DEVICE_GONE` — not failed. Nobody can fix it by waiting,
 *     and an alert about a printer somebody deliberately removed is noise.
 *
 * A fifth, not a failure: **a job for a role no station on this box has a
 * printer for is `skipped`**, and the till says "not printed" without blocking
 * the sale. That is the acceptance criterion, and it is a configuration a
 * person chose rather than a fault, so nothing raises an alert.
 */

import {
  renderJob,
  escposProfile,
  tsplProfile,
  mmToDots,
  type DeviceProfile,
  type Finish,
  type PrintJob as RenderJob,
  type PrintTemplate as RenderTemplate,
} from '@oto/print';
import type { DeviceSettings, PrintKind, PrintTemplate } from '@oto/shared';
import type { BoxConfigBundle, BoxConfigDevice, BoxConfigStation } from '../protocol';
import { PrinterError, parseAddress, tcpChannel, type ChannelFactory } from './channel';
import { escposAdapter, tsplAdapter, unknownHealth, type PrinterAdapter, type PrinterHealth } from './adapter';

/**
 * Which `station_device` role prints which kind.
 *
 * Ported from the prototype's `lib/printRouting.tsx`, where a sale's receipt
 * and both voucher kinds go to `station.receiptPrinterId`, bands go to the two
 * bracelet printers, and an F&B order's prep tickets split between the kitchen
 * and bar printers. The test page follows the receipt, because that is the
 * printer whose paper path a person is standing in front of.
 */
export const ROLE_FOR_KIND: Record<PrintKind, string> = {
  receipt: 'receipt',
  kitchen_ticket: 'kitchen',
  bar_ticket: 'bar',
  kids_wristband: 'kids_band',
  adult_wristband: 'adult_band',
  credit_voucher: 'receipt',
  item_voucher: 'receipt',
  booth_voucher: 'receipt',
  test_page: 'receipt',
};

export interface PrintRequest {
  /** The `edge.print_job` id. Minted where the job was raised, never here. */
  id: string;
  kind: PrintKind;
  /** The job's data, already shaped for the renderer's builder for this kind. */
  job: RenderJob;
  /** Which station's devices to route through. Null routes through any on the box. */
  stationId?: string | null;
  /** Override the role `ROLE_FOR_KIND` would choose. */
  role?: string | null;
  copies?: number;
  actionId?: string | null;
  templateId?: string | null;
  templateVersion?: number | null;
  /**
   * Cut, copies and the cash-drawer pulse, overriding what the template asked
   * for.
   *
   * The drawer is here rather than on the device because whether a drawer
   * opens is a property of the SALE — a card payment does not open it and a
   * cash one does (S2-11 decides that) — while whether a drawer exists is a
   * property of the printer, which is `settings.escpos.drawerKick` on the
   * device row. Both have to agree: `emitEscpos` drops the pulse on a profile
   * with no drawer, so asking for one on a printer that has none is inert
   * rather than an error.
   */
  finish?: Partial<Finish>;
}

export type PrintJobStatus = 'queued' | 'printed' | 'failed' | 'skipped';

export interface PrintJobOutcome {
  id: string;
  status: PrintJobStatus;
  attempts: number;
  deviceId: string | null;
  role: string | null;
  stationId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** Layout complaints the renderer reported. Never fatal; worth showing. */
  overflow: string[];
  elapsedMs: number | null;
}

export interface PrintSubsystemOptions {
  /** The config bundle as it stands now — read fresh on every attempt. */
  bundle: () => BoxConfigBundle | null;
  /** The branch's templates, as the cache bundle carries them. */
  templates: () => readonly PrintTemplate[];
  /** How a socket is opened. Swapped for the simulator registry on a box with no hardware. */
  open?: ChannelFactory;
  now?: () => Date;
  log?: (level: 'info' | 'warn' | 'error', msg: string, detail?: Record<string, unknown>) => void;
  /** Called on every terminal outcome, and on the first queued one. */
  report?: (outcome: PrintJobOutcome) => Promise<void> | void;
  /** How long to wait before retrying a job that is waiting on paper. */
  retryDelayMs?: number;
  /** After this many attempts a retryable job is given up as failed. */
  maxAttempts?: number;
}

export interface PrintSubsystem {
  /** Queue a job and attempt it now. Resolves with the outcome of that attempt. */
  submit(request: PrintRequest): Promise<PrintJobOutcome>;
  /** Retry everything that is due. Called from the agent's poll tick. */
  tick(): Promise<PrintJobOutcome[]>;
  /** Jobs still waiting, oldest first. */
  pending(): { id: string; kind: PrintKind; attempts: number; lastError: string | null }[];
  /** What the box currently believes about each printer it can reach. */
  health(): Record<string, PrinterHealth>;
  /** Ask every assigned printer how it is, and remember the answers. */
  probeAll(): Promise<Record<string, PrinterHealth>>;
}

const RETRY_DELAY_MS = 30_000;
const MAX_ATTEMPTS = 20;

interface PendingJob {
  request: PrintRequest;
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  /** Reported once, so the cloud row is not rewritten on every failed retry. */
  queuedReported: boolean;
}

/**
 * Build the renderer's device profile from the device row and its per-unit
 * settings.
 *
 * `widthDots` is the field that must never be guessed twice: §9.4 and D6 say
 * the XP-80 family ships as 576 **or** 512 and only the self-test page tells
 * you which, and `GS v 0` discards the overflow in silence. So the row's
 * `settings.escpos.dotsPerLine` wins when somebody has read a self-test page,
 * and `escposProfile`'s own 576 default stands in until they have.
 */
export function profileFor(device: BoxConfigDevice): DeviceProfile {
  const settings = (device.settings ?? {}) as DeviceSettings;
  if (device.protocol === 'tspl2' || device.kind === 'band_printer') {
    const label = settings.label ?? {};
    const widthMm = label.labelWidthMm ?? 50;
    return tsplProfile({
      id: device.id,
      label: device.label,
      model: device.model ?? '4B-2082A',
      widthDots: mmToDots(widthMm),
      media: {
        widthMm,
        lengthMm: label.labelHeightMm ?? 250,
        gapMm: label.gapMm ?? 3,
        sensing: 'gap',
      },
      density: label.darkness,
      speed: label.speed,
    });
  }
  const escpos = settings.escpos ?? {};
  return escposProfile({
    id: device.id,
    label: device.label,
    model: device.model ?? 'Xprinter XP-80',
    widthDots: escpos.dotsPerLine,
    hasCutter: escpos.cut === undefined ? undefined : escpos.cut !== 'none',
    hasDrawer: escpos.drawerKick,
  });
}

/** `@oto/shared`'s stored template as the renderer wants it. */
export function toRenderTemplate(template: PrintTemplate): RenderTemplate {
  return {
    id: template.id,
    type: template.type,
    name: template.name,
    showLogo: template.showLogo,
    headerText: template.headerText ?? undefined,
    footerText: template.footerText ?? undefined,
    fields: template.fields,
  };
}

export interface RoutedDevice {
  station: BoxConfigStation | null;
  device: BoxConfigDevice;
  role: string;
}

/**
 * Find the printer for a role.
 *
 * Preferring the named station and falling back to any station on the box is
 * deliberate: a test print raised from the Console's Devices area has no
 * station, and a box with one till should not need one named. A job that names
 * a station gets that station's printer or nothing — routing a till's receipt
 * to the booth's printer because the till's is missing would put a guest's
 * receipt on a counter they are not standing at.
 */
export function routeTo(
  bundle: BoxConfigBundle | null,
  role: string,
  stationId: string | null | undefined,
): RoutedDevice | null {
  if (!bundle) return null;
  const stations = stationId
    ? bundle.stations.filter((s) => s.id === stationId)
    : bundle.stations;
  for (const station of stations) {
    const device = station.devices.find((d) => d.role === role);
    if (device) return { station, device, role };
  }
  return null;
}

export function createPrintSubsystem(options: PrintSubsystemOptions): PrintSubsystem {
  const now = options.now ?? (() => new Date());
  const open = options.open ?? tcpChannel;
  const log = options.log ?? (() => {});
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const maxAttempts = options.maxAttempts ?? MAX_ATTEMPTS;

  const queue: PendingJob[] = [];
  const health: Record<string, PrinterHealth> = {};
  /** One promise per device id: the tail of the chain of jobs for that printer. */
  const locks = new Map<string, Promise<unknown>>();

  function adapterFor(device: BoxConfigDevice): PrinterAdapter | PrinterError {
    const target = parseAddress(device.address);
    if (!target) {
      return new PrinterError(
        'DEVICE_NO_ADDRESS',
        `${device.label} has no address, so there is nothing to open`,
      );
    }
    const deps = { deviceId: device.id, label: device.label, target, open, now };
    return device.protocol === 'tspl2' || device.kind === 'band_printer'
      ? tsplAdapter(deps)
      : escposAdapter(deps);
  }

  /** Run `fn` when this printer is free, and keep it free for the next caller. */
  function serialise<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(deviceId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // Swallowed here only: the caller still gets the rejection through `next`.
    locks.set(
      deviceId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async function attempt(pending: PendingJob): Promise<PrintJobOutcome> {
    const { request } = pending;
    pending.attempts += 1;
    const role = request.role ?? ROLE_FOR_KIND[request.kind];
    const bundle = options.bundle();
    const routed = routeTo(bundle, role, request.stationId);

    const base = {
      id: request.id,
      attempts: pending.attempts,
      role,
      stationId: request.stationId ?? null,
      overflow: [] as string[],
      elapsedMs: null as number | null,
    };

    if (!routed) {
      /**
       * Nothing on this box prints this role. Skipped, not failed: the till
       * shows "not printed" and carries on, and no alert is raised, because a
       * station with no band printer is a choice somebody made in Station
       * Setup rather than a machine that broke.
       */
      return {
        ...base,
        status: 'skipped',
        deviceId: null,
        errorCode: pending.attempts > 1 ? 'DEVICE_GONE' : 'NO_DEVICE_FOR_ROLE',
        errorMessage:
          pending.attempts > 1
            ? `The ${role} printer this job was waiting for is no longer on this box`
            : `No ${role} printer is assigned${request.stationId ? ' to this station' : ' on this box'}`,
      };
    }

    const adapter = adapterFor(routed.device);
    if (adapter instanceof PrinterError) {
      return {
        ...base,
        status: 'skipped',
        deviceId: routed.device.id,
        errorCode: adapter.code,
        errorMessage: adapter.message,
      };
    }

    let bytes: Uint8Array;
    let overflow: string[];
    try {
      const templates = options.templates().map(toRenderTemplate);
      const rendered = renderJob(request.job, {
        device: profileFor(routed.device),
        templates,
        finish: request.finish,
      });
      bytes = rendered.bytes;
      overflow = rendered.overflow;
    } catch (err) {
      /**
       * A render failure is not retryable and never will be: the same input
       * and the same device profile produce the same bytes, which is the
       * property `@oto/print` is built around. Retrying would be a timer
       * asking the same question every thirty seconds for ever.
       */
      return {
        ...base,
        status: 'failed',
        deviceId: routed.device.id,
        errorCode: 'RENDER_FAILED',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
    }

    try {
      const result = await serialise(routed.device.id, () =>
        adapter.print({ bytes, copies: request.copies ?? 1 }),
      );
      health[routed.device.id] = result.health;
      return {
        ...base,
        status: 'printed',
        deviceId: routed.device.id,
        errorCode: null,
        errorMessage: null,
        overflow,
        elapsedMs: result.elapsedMs,
      };
    } catch (err) {
      const error =
        err instanceof PrinterError
          ? err
          : new PrinterError('PRINTER_WRITE_FAILED', err instanceof Error ? err.message : String(err), {
              partial: true,
            });
      health[routed.device.id] = {
        ...(health[routed.device.id] ?? unknownHealth(now().toISOString())),
        reachability: error.code === 'PRINTER_UNREACHABLE' ? 'unreachable' : 'reachable',
        paperStatus: error.code === 'PRINTER_PAPER_OUT' ? 'out' : health[routed.device.id]?.paperStatus ?? 'unknown',
        lastError: error.code,
        checkedAt: now().toISOString(),
      };
      pending.lastError = error.code;
      const giveUp = !error.retryable || error.partial || pending.attempts >= maxAttempts;
      return {
        ...base,
        status: giveUp ? 'failed' : 'queued',
        deviceId: routed.device.id,
        errorCode: error.code,
        errorMessage: error.message,
        overflow,
      };
    }
  }

  async function run(pending: PendingJob): Promise<PrintJobOutcome> {
    const outcome = await attempt(pending);
    if (outcome.status === 'queued') {
      pending.nextAttemptAt = now().getTime() + retryDelayMs;
      if (!pending.queuedReported) {
        pending.queuedReported = true;
        await report(outcome);
      }
      log('warn', 'print job waiting for the printer', {
        jobId: pending.request.id,
        attempts: pending.attempts,
        errorCode: outcome.errorCode,
      });
      return outcome;
    }
    const at = queue.indexOf(pending);
    if (at >= 0) queue.splice(at, 1);
    await report(outcome);
    log(outcome.status === 'printed' ? 'info' : 'warn', `print job ${outcome.status}`, {
      jobId: pending.request.id,
      kind: pending.request.kind,
      deviceId: outcome.deviceId,
      errorCode: outcome.errorCode,
    });
    return outcome;
  }

  async function report(outcome: PrintJobOutcome): Promise<void> {
    try {
      await options.report?.(outcome);
    } catch (err) {
      /**
       * The cloud not hearing about a job does not un-print it. The paper is
       * out of the machine either way, so a failed report is a log line and
       * not an exception that would make the till think the print failed.
       */
      log('error', 'the outcome of a print job could not be reported', {
        jobId: outcome.id,
        err: String(err),
      });
    }
  }

  return {
    async submit(request) {
      const pending: PendingJob = {
        request,
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        queuedReported: false,
      };
      queue.push(pending);
      return run(pending);
    },
    async tick() {
      const due = queue.filter((p) => p.nextAttemptAt <= now().getTime());
      const outcomes: PrintJobOutcome[] = [];
      for (const pending of due) outcomes.push(await run(pending));
      return outcomes;
    },
    pending() {
      return queue.map((p) => ({
        id: p.request.id,
        kind: p.request.kind,
        attempts: p.attempts,
        lastError: p.lastError,
      }));
    },
    health() {
      return { ...health };
    },
    async probeAll() {
      const bundle = options.bundle();
      const seen = new Set<string>();
      for (const station of bundle?.stations ?? []) {
        for (const device of station.devices) {
          if (seen.has(device.id)) continue;
          if (!device.kind.endsWith('printer')) continue;
          seen.add(device.id);
          const adapter = adapterFor(device);
          if (adapter instanceof PrinterError) {
            health[device.id] = {
              ...unknownHealth(now().toISOString()),
              lastError: adapter.code,
            };
            continue;
          }
          health[device.id] = await serialise(device.id, () => adapter.probe());
        }
      }
      return { ...health };
    },
  };
}
