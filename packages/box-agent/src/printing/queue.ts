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
 *
 * **The queue is on disk (S2-07a).** It was not, and that was the sixth case,
 * found after the fact: a job waiting on paper lived in this module's memory,
 * so a box restarted with three unprinted vouchers came back with none while
 * the cloud went on showing them as queued. Every job is now written to the
 * box's store before it is attempted, moved to `sending` before the socket
 * opens and deleted when it is finished, and `resume()` picks the queue up at
 * boot — `queued` jobs go back on the queue, `sending` ones do not (D12).
 * A box whose store cannot hold jobs still prints; it just forgets on restart,
 * as before, and says so in the log at start-up.
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
import { PRINT_KINDS } from '@oto/shared';
import type { DeviceSettings, PrintKind, PrintTemplate } from '@oto/shared';
import type { BoxConfigBundle, BoxConfigDevice, BoxConfigStation } from '../protocol';
import type { PrintJobRecord, PrintJobStore } from '../store';
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
  /**
   * Where the queue is kept so it outlives the process (S2-07a).
   *
   * Optional, and what it fixes is the defect S2-06 shipped: a job waiting on
   * paper lived only here, in memory, so a box that restarted with three
   * unprinted vouchers came back with none and the cloud rows stayed `queued`
   * for ever. With a store, the job is on disk before the first attempt and
   * the next boot picks it up.
   *
   * **A function, and asked again every time**, because the agent builds this
   * subsystem before it knows its own box id — that is learned at
   * registration, and a box id read once at construction would be null on
   * every real box and the durable queue would silently never engage. Nothing
   * is written while it answers null, and the recovery has not happened yet
   * rather than having happened emptily.
   *
   * Without a store the queue behaves exactly as it did — it prints, it
   * retries, and it forgets on restart. That is a real loss, not a neutral
   * default, so it is logged rather than left to be discovered.
   */
  durable?: () => DurablePrintQueue | null;
}

/** The store to keep the queue in, and whose queue it is. */
export interface DurablePrintQueue {
  jobs: PrintJobStore;
  /** Known only once the box has registered, which is why this is resolved late. */
  boxId: string;
}

export interface PrintSubsystem {
  /** Queue a job and attempt it now. Resolves with the outcome of that attempt. */
  submit(request: PrintRequest): Promise<PrintJobOutcome>;
  /** Retry everything that is due. Called from the agent's poll tick. */
  tick(): Promise<PrintJobOutcome[]>;
  /**
   * Pick the durable queue back up after a restart (S2-07a).
   *
   * Two different things come off the disk and they are treated as opposites,
   * which is the whole of D12:
   *
   *  - A job still `queued` never reached a printer. It goes back on the queue
   *    with its attempt count and its next-attempt time, and the next `tick()`
   *    tries it. Three vouchers waiting on paper are three vouchers waiting on
   *    paper after a restart, which is the acceptance criterion.
   *  - A job that was `sending` had bytes going at a head. Some of it is
   *    already paper in somebody's hand. It is reported `failed` with
   *    `PRINT_INTERRUPTED`, deleted, and NEVER printed again by anything
   *    automatic — a person pressing reprint is a different act, and mints its
   *    own job.
   *
   * Returns the outcomes it reported, which is the interrupted ones.
   *
   * Idempotent, and called by `submit()` and `tick()` before they do anything,
   * so a box recovers whether or not anybody remembered to call it: the agent
   * ticks this queue on every heartbeat.
   */
  resume(): Promise<PrintJobOutcome[]>;
  /**
   * Jobs still waiting, oldest first.
   *
   * The working queue in memory, which is the same list as the durable one
   * once `resume()` has run — and `resume()` runs on the first `submit()` or
   * `tick()`. Read straight after a restart and before either, it is empty:
   * what is on the disk has not been picked up yet.
   */
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
  /** When it was first asked for. Kept through a restart so the order is too. */
  queuedAt: string;
  /** The printer the last attempt used, so an interrupted job can name it. */
  deviceId: string | null;
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

  /** Asked again on every write: see `PrintSubsystemOptions.durable`. */
  const resolveDurable = options.durable ?? (() => null);
  /** Memoised once a queue has actually been recovered, never before. */
  let resumed: Promise<PrintJobOutcome[]> | null = null;
  let warnedMemoryOnly = false;

  /** Said once, when it first matters: at the first job, not at construction. */
  function warnMemoryOnly(): void {
    if (warnedMemoryOnly) return;
    warnedMemoryOnly = true;
    log(
      'warn',
      'this box has no durable print queue: a job waiting on paper will not survive a restart',
    );
  }

  /**
   * Write to the durable queue, and never let it stop the paper.
   *
   * A store that will not write is a box that will forget this job — bad, and
   * worth an error line — but it is not a reason to refuse to print the
   * voucher somebody is standing waiting for. So every failure here is logged
   * with the job named and swallowed, and the queue carries on in memory,
   * which is exactly what a box with no store does anyway.
   */
  async function remember(
    jobId: string,
    what: string,
    fn: (jobs: PrintJobStore, boxId: string) => Promise<void>,
  ): Promise<void> {
    const held = resolveDurable();
    if (!held) {
      warnMemoryOnly();
      return;
    }
    try {
      await fn(held.jobs, held.boxId);
    } catch (err) {
      log('error', `the print queue could not ${what}`, { jobId, err: String(err) });
    }
  }

  function recordFor(
    pending: PendingJob,
    state: PrintJobRecord['state'],
    boxId: string,
    errorMessage: string | null = null,
  ): PrintJobRecord {
    const request = pending.request;
    return {
      id: request.id,
      boxId,
      kind: request.kind,
      role: request.role ?? ROLE_FOR_KIND[request.kind] ?? null,
      stationId: request.stationId ?? null,
      deviceId: pending.deviceId,
      copies: request.copies ?? 1,
      job: request.job,
      finish: (request.finish ?? null) as Record<string, unknown> | null,
      templateId: request.templateId ?? null,
      templateVersion: request.templateVersion ?? null,
      actionId: request.actionId ?? null,
      state,
      attempts: pending.attempts,
      nextAttemptAt: pending.nextAttemptAt
        ? new Date(pending.nextAttemptAt).toISOString()
        : null,
      lastErrorCode: pending.lastError,
      lastErrorMessage: errorMessage,
      queuedAt: pending.queuedAt,
      updatedAt: now().toISOString(),
    };
  }

  /**
   * A stored row as a request again.
   *
   * `kind` is checked against the vocabulary rather than cast: the row was
   * written by some version of this agent, and a kind this one does not know
   * would otherwise reach `ROLE_FOR_KIND`, resolve to `undefined`, and route
   * the job to no printer while claiming it was a routing problem. An unknown
   * kind is a job that cannot be printed by this build, and saying so is the
   * honest failure.
   */
  function requestFrom(record: PrintJobRecord): PrintRequest | null {
    if (!(PRINT_KINDS as readonly string[]).includes(record.kind)) return null;
    return {
      id: record.id,
      kind: record.kind as PrintKind,
      job: record.job,
      stationId: record.stationId,
      role: record.role,
      copies: record.copies,
      actionId: record.actionId,
      templateId: record.templateId,
      templateVersion: record.templateVersion,
      finish: (record.finish ?? undefined) as Partial<Finish> | undefined,
    };
  }

  async function recover(held: DurablePrintQueue): Promise<PrintJobOutcome[]> {
    const { jobs: durable, boxId } = held;
    const reported: PrintJobOutcome[] = [];

    for (const record of await durable.loadInterruptedPrintJobs(boxId)) {
      const outcome: PrintJobOutcome = {
        id: record.id,
        status: 'failed',
        attempts: record.attempts,
        deviceId: record.deviceId,
        role: record.role,
        stationId: record.stationId,
        errorCode: record.lastErrorCode ?? 'PRINT_INTERRUPTED',
        errorMessage:
          record.lastErrorMessage ??
          'The box restarted while this job was going to the printer',
        overflow: [],
        elapsedMs: null,
      };
      await report(outcome);
      await remember(record.id, 'forget an interrupted job', (jobs) =>
        jobs.deletePrintJob(record.id),
      );
      log('warn', 'a print job was interrupted by a restart and will not be retried', {
        jobId: record.id,
        kind: record.kind,
        deviceId: record.deviceId,
      });
      reported.push(outcome);
    }

    for (const record of await durable.loadPendingPrintJobs(boxId)) {
      if (queue.some((inFlight) => inFlight.request.id === record.id)) continue;
      const request = requestFrom(record);
      if (!request) {
        log('error', 'a stored print job names a kind this agent does not know', {
          jobId: record.id,
          kind: record.kind,
        });
        continue;
      }
      queue.push({
        request,
        attempts: record.attempts,
        nextAttemptAt: record.nextAttemptAt ? Date.parse(record.nextAttemptAt) : 0,
        lastError: record.lastErrorCode,
        // The cloud row for a resumed job already says `queued` — it was never
        // told anything else. Reporting it again on the first retry would
        // rewrite a row to the value it already holds, once per box per boot.
        queuedReported: true,
        queuedAt: record.queuedAt,
        deviceId: record.deviceId,
      });
    }
    return reported;
  }

  function ensureResumed(): Promise<PrintJobOutcome[]> {
    const held = resolveDurable();
    if (!held) {
      // Nothing is memoised here on purpose. A box asked before it has
      // registered has not recovered its queue — it has not tried — and
      // remembering "done" would mean the vouchers on its disk were never
      // picked up at all.
      warnMemoryOnly();
      return Promise.resolve([]);
    }
    resumed ??= recover(held).catch((err) => {
      log('error', 'the durable print queue could not be read at start-up', { err: String(err) });
      return [];
    });
    return resumed;
  }

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

    /**
     * On disk as `sending` BEFORE the socket opens, which is the line the
     * restart rule is drawn at (D12). Everything after this point may have put
     * ink on paper, and a box that comes back has to be able to tell that from
     * a job that never left the queue. It costs one write per attempt, on a
     * box doing a few prints a minute.
     */
    pending.deviceId = routed.device.id;
    await remember(request.id, 'mark a job as going to the printer', (jobs) =>
      jobs.updatePrintJob(request.id, {
        state: 'sending',
        deviceId: routed.device.id,
        attempts: pending.attempts,
      }),
    );

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
      // Back to `queued` on disk with the new attempt count and retry time, so
      // a restart in the middle of a paper-out resumes the wait rather than
      // starting it again — or, worse, treating it as interrupted.
      await remember(pending.request.id, 'record a waiting job', (jobs, box) =>
        jobs.putPrintJob(recordFor(pending, 'queued', box, outcome.errorMessage)),
      );
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
    // Finished, one way or another: the cloud's `edge.print_job` row is the
    // history from here, and nothing about this job needs to stay on the box.
    await remember(pending.request.id, 'forget a finished job', (jobs) =>
      jobs.deletePrintJob(pending.request.id),
    );
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
      await ensureResumed();
      const pending: PendingJob = {
        request,
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        queuedReported: false,
        queuedAt: now().toISOString(),
        deviceId: null,
      };
      queue.push(pending);
      // Written down BEFORE the first attempt. A box that dies between the
      // press and the paper then comes back holding the voucher to print,
      // which is the difference between a guest waiting and a guest leaving
      // with nothing.
      await remember(request.id, 'record a new job', (jobs, box) =>
        jobs.putPrintJob(recordFor(pending, 'queued', box)),
      );
      return run(pending);
    },
    async tick() {
      await ensureResumed();
      const due = queue.filter((p) => p.nextAttemptAt <= now().getTime());
      const outcomes: PrintJobOutcome[] = [];
      for (const pending of due) outcomes.push(await run(pending));
      return outcomes;
    },
    resume: ensureResumed,
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
