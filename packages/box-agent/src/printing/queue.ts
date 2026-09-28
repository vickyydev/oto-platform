/**
 * The box's print queue (S2-06).
 *
 * Everything between "the till wants a receipt" and "paper came out": which
 * printer the job goes to, what happens when that printer is out of paper, and
 * what a person is told when it is not there at all.
 *
 * Five things were decided here rather than left to be discovered at a counter,
 * because a printer is a socket that can be unplugged mid-job:
 *
 *  1. **The connection dies after the header and before the cut.** The job is
 *     `failed` with `PRINTER_WRITE_FAILED` and is NOT retried by any timer.
 *     Bytes that reached the head have already come out of the machine, so an
 *     unattended retry puts a second, complete receipt beside a torn-off first
 *     one and afterwards nobody can say which is the real one. A person
 *     pressing reprint is a different act and mints its own job (S2-11). A
 *     printer that keeps the connection but stops taking a job ends it the
 *     same way once the channel's write deadline passes (`tcpChannel`) — but
 *     only a job bigger than the socket buffers between the box and the
 *     printer can meet that deadline (80–110 KB on Linux over a
 *     1500-byte-MTU link, measured in the audit). A smaller one, a booth
 *     slip among them, is taken whole by the buffers, and the status read
 *     after it decides (`readAfterJob` in `adapter.ts`, SCRUM-429): a printer
 *     that answered the read before the job and answers nothing after it,
 *     asked again, ends the job the same way — `failed` with
 *     `PRINTER_SILENT_AFTER_JOB`, and not retried by any timer. Either way
 *     the printer's lock is not held for as long as the printer stays
 *     stopped.
 *  2. **The printer answers a status query with nothing** — before the job as
 *     well as after it. The job is printed anyway and the device is reported
 *     `statusUnknown`. §9.3 leaves open whether every firmware in this family
 *     answers `DLE EOT` over the LAN board; refusing to print on an unanswered
 *     query would mean a unit whose firmware is silent never prints at all,
 *     which is a worse failure than printing without being able to see
 *     inside the machine. A printer that answered before the job and is
 *     silent only after it is not this case: it stopped with the job inside
 *     it, which is case 1. Nor is one that has answered earlier in this
 *     process and is silent before the job: it has stopped, which is case 5.
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
 *  5. **A printer that has answered goes silent before a job** (SCRUM-431).
 *     The job is NOT sent. It stays `queued` with `PRINTER_SILENT_BEFORE_JOB`,
 *     the device is reported `statusUnknown` with that code, and the retry
 *     timer tries it again as it tries a job waiting on paper, up to the same
 *     limit, after which it is `failed` as any retried job is. By case 2
 *     alone the box cannot tell this printer from a unit whose firmware never
 *     answers, and it used to send the slip blind: a printer still stopped
 *     after case 1's silent ending — a jam, the roll out, its input buffer
 *     full — answered the next job's read with nothing too, and that job was
 *     recorded printed with no paper out of the machine. So the box
 *     remembers, for each printer, that it has answered a status query in
 *     this process — a job's read before or after the job, or the
 *     heartbeat's probe — and silence from one it remembers is a printer
 *     that has stopped, not firmware that never answers. Nothing has reached
 *     the paper, so waiting costs no second slip: the booth's press answers
 *     `queued`, the television shows the code and its QR, and the slip comes
 *     out once the printer answers again. The memory is this process's
 *     alone. A restart forgets it, and until the unit answers again it is
 *     printed to as case 2 says; that is accepted. Several jobs held on one
 *     stopped printer cost a tick one attempt between them, not one each
 *     (`tick`; SCRUM-440).
 *
 * A sixth, not a failure: **a job for a role no station on this box has a
 * printer for is `skipped`**, and the till says "not printed" without blocking
 * the sale. That is the acceptance criterion, and it is a configuration a
 * person chose rather than a fault, so nothing raises an alert.
 *
 * **The queue is on disk (S2-07a).** It was not, and that was the seventh case,
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
import {
  PrinterError,
  parseAddress,
  tcpChannel,
  type ChannelFactory,
  type PrinterErrorCode,
} from './channel';
import {
  escposAdapter,
  tsplAdapter,
  unansweredHealth,
  unknownHealth,
  type PrinterAdapter,
  type PrinterHealth,
} from './adapter';

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

/**
 * OPEN THE CASH DRAWER (S2-10a), which is not a print job and is routed like one.
 *
 * The drawer has no address of its own: the pulse rides the receipt printer's
 * RJ11 (§7.3), so what has to be resolved is a printer — the same
 * station-and-role walk every job takes — and then a pulse rather than a page.
 * `PrinterAdapter.pulseDrawer` says why it is not simply a job with an empty
 * document.
 */
export interface DrawerPulseRequest {
  /** Which station's drawer. Null routes through any printer on the box. */
  stationId?: string | null;
  /**
   * The role the pulse rides. `receipt` by default, and NOT `cash_drawer`:
   * that role is how a station says it HAS a drawer, while the bytes go to the
   * printer the RJ11 hangs off.
   */
  role?: string | null;
  /** Overrides for the pulse itself. The defaults are the park's drawer (§9.3). */
  pin?: 0 | 1;
  onMs?: number;
  offMs?: number;
  actionId?: string | null;
}

export interface DrawerPulseOutcome {
  /** True only when the bytes reached a printer that has a drawer line. */
  opened: boolean;
  deviceId: string | null;
  role: string;
  stationId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  elapsedMs: number | null;
}

/** `ESC p 0 25 250` — 50 ms on, 500 ms off on pin 2, which is the park's wiring (§9.3). */
const DRAWER_PULSE = { pin: 0 as const, onMs: 50, offMs: 500 };

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
  /**
   * How long to wait before retrying a job that is waiting on paper. Also the
   * queue's cap: a retry time further off than this was set on a clock that
   * has since gone back, and is due (`retryDue`, SCRUM-439).
   */
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
  /**
   * Queue a job and attempt it now. Resolves with the outcome of that attempt.
   *
   * A job already queued under the same id — the row its caller wrote, picked
   * up by the resume — is that job, taken over rather than queued a second
   * time, so one id never becomes two slips.
   */
  submit(request: PrintRequest): Promise<PrintJobOutcome>;
  /**
   * Take a job onto the queue WITHOUT attempting it, and keep the retry tick
   * off it until `until` (bench, 28 September).
   *
   * A booth's slip: the press saves it, the wheel turns for several seconds,
   * and the page asks for the paper when the result card opens. The slip used
   * to come out before the wheel moved. Held here, it is printed by whichever
   * comes first — `submit` of the same id, which takes it at once, or the
   * tick once `until` has passed, which is how a page that never asks (a
   * crash mid-spin) still gets its slip.
   *
   * The caller writes the job's row itself, as a spin does in its own
   * transaction; this writes nothing. A job already on the printer is left as
   * it is. A hold further off than twice its own length was set on a clock
   * that has since gone back, and no longer holds (`heldBack`).
   */
  hold(request: PrintRequest, until: Date): Promise<void>;
  /**
   * Pulse a station's cash drawer, now or not at all (S2-10a).
   *
   * NOT QUEUED, and that is the whole difference from `submit`. A receipt that
   * waits half an hour on an empty roll is still the right receipt; a drawer
   * that opens half an hour after the guest has gone is a drawer somebody left
   * open. So there is no retry, no durable row and no waiting: it reaches the
   * printer or it answers why, and the counter opens the drawer with the key
   * underneath, which is what every till on earth does when the pulse does not
   * arrive.
   */
  pulseDrawer(request: DrawerPulseRequest): Promise<DrawerPulseOutcome>;
  /**
   * Retry everything that is due. Called from the agent's poll tick — the
   * heartbeat, which awaits this before it is sent.
   *
   * One attempt a tick on a printer that does not answer (SCRUM-440). An
   * attempt that ends silent before the job (case 5 in the header) or
   * unreachable has waited out a status read or a connect, a second or two,
   * and every other job due on that printer would wait out the same. So once
   * an attempt in a tick ends that way, the printer's other due jobs are left
   * for the next tick: untouched, still queued and still due, with nothing
   * recorded against them. N jobs held on one stopped printer used to make
   * every heartbeat N × 1–2 s late, and at about ninety the Console called
   * the box offline (180 s) when it was the printer that had stopped. A
   * printer that answers — printed, out of paper, its cover up — has every
   * due job tried, as before; so does every other printer in the same tick;
   * and a printer that answers again drains all that waited on it in the one
   * tick, each job then costing what its slip takes rather than a timeout. A
   * drawer pulse or a press arriving during a tick still waits behind at most
   * one attempt: the tick takes a printer's lock for one job at a time.
   */
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
  /**
   * Ask every assigned printer how it is, and remember the answers.
   *
   * A printer busy with a job or a drawer pulse is not asked: its entry keeps
   * what it last said (M15, closing audit 2026-09-25). The heartbeat awaits
   * this before it is sent, and asking a busy printer meant queueing behind
   * the job — so a job the printer had stopped taking stopped the heartbeat
   * too, and the Console called the box offline when it was the printer that
   * had stopped.
   */
  probeAll(): Promise<Record<string, PrinterHealth>>;
}

const RETRY_DELAY_MS = 30_000;
const MAX_ATTEMPTS = 20;

/**
 * How an attempt ends when the printer answered nothing to it: a status read
 * waited out, or a connect. Within one tick, the first such ending on a
 * printer leaves its other due jobs for the next tick (`tick`; SCRUM-440).
 */
const PRINTER_NOT_ANSWERING: readonly PrinterErrorCode[] = [
  'PRINTER_SILENT_BEFORE_JOB',
  'PRINTER_UNREACHABLE',
];

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
  /**
   * The attempt in progress, while there is one.
   *
   * One job is one slip, so a job is never attempted twice at once: a second
   * caller — the retry tick arriving while `submit` is printing, or `submit`
   * arriving while the tick is — gets this promise and the outcome of the
   * attempt already going, instead of starting another one on the printer.
   */
  running: Promise<PrintJobOutcome> | null;
  /**
   * Kept off the retry tick until this time, on the queue's clock, and how
   * long the hold was when it was set; both 0 for a job nobody held (`hold`).
   */
  heldUntil: number;
  heldForMs: number;
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
  /**
   * The printers that have answered a status query in this process, by device
   * id: case 5 in the header (SCRUM-431). The adapters put a printer here when
   * it answers a job's read before or after the job, or the heartbeat's probe
   * (`StatusMemory` in `adapter.ts`), and nothing takes one out but a restart.
   */
  const answered = new Set<string>();
  /** One promise per device id: the tail of the chain of jobs for that printer. */
  const locks = new Map<string, Promise<unknown>>();
  /**
   * How many calls are waiting for, or holding, each printer's lock. Absent
   * means none. `locks` cannot say this: its tail stays in the map after the
   * chain has finished.
   */
  const busy = new Map<string, number>();

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
        running: null,
        // A hold does not outlive the process; a held row's retry time,
        // written as the end of its hold, keeps it off the tick instead.
        heldUntil: 0,
        heldForMs: 0,
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
    const deps = {
      deviceId: device.id,
      label: device.label,
      target,
      open,
      now,
      memory: {
        answered: () => answered.has(device.id),
        heard: () => {
          answered.add(device.id);
        },
      },
    };
    return device.protocol === 'tspl2' || device.kind === 'band_printer'
      ? tsplAdapter(deps)
      : escposAdapter(deps);
  }

  /** Run `fn` when this printer is free, and keep it free for the next caller. */
  function serialise<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    busy.set(deviceId, (busy.get(deviceId) ?? 0) + 1);
    const previous = locks.get(deviceId) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    // Swallowed here only: the caller still gets the rejection through `next`.
    locks.set(
      deviceId,
      next.then(
        () => released(deviceId),
        () => released(deviceId),
      ),
    );
    return next;
  }

  function released(deviceId: string): void {
    const left = (busy.get(deviceId) ?? 1) - 1;
    if (left > 0) busy.set(deviceId, left);
    else busy.delete(deviceId);
  }

  /**
   * The printer a job would go to now: the walk `attempt` makes, made ahead
   * of it so the tick can tell which jobs wait on one printer (SCRUM-440).
   * Null when nothing on this box prints the role.
   */
  function deviceFor(pending: PendingJob): string | null {
    const { request } = pending;
    const role = request.role ?? ROLE_FOR_KIND[request.kind];
    return routeTo(options.bundle(), role, request.stationId)?.device.id ?? null;
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
      if (error.code === 'PRINTER_SILENT_AFTER_JOB' || error.code === 'PRINTER_SILENT_BEFORE_JOB') {
        /**
         * Case 1's silent ending (SCRUM-429), and case 5 (SCRUM-431): the
         * printer has answered, and now says nothing, so nothing it said
         * before is known to hold any more. It is there — it took the
         * connection, and in case 1 the job — and cannot be seen into.
         */
        health[routed.device.id] = unansweredHealth(now().toISOString(), error.code);
      }
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

  /**
   * Attempt a job once — unless it is on the printer already, in which case
   * the caller gets the attempt that is going (see `PendingJob.running`).
   *
   * `record` writes the job down as `queued` before the attempt: `submit`'s
   * write, made in here so that the job counts as running from the moment
   * `submit` takes it. A tick that looks at the queue while that row is being
   * written then leaves the job alone instead of printing it too, and the
   * `queued` row cannot land on top of the `sending` its attempt has since
   * recorded.
   */
  function run(pending: PendingJob, opts: { record?: boolean } = {}): Promise<PrintJobOutcome> {
    if (pending.running) return pending.running;
    const running = (async () => {
      if (opts.record) {
        // Written down BEFORE the first attempt. A box that dies between the
        // press and the paper then comes back holding the voucher to print,
        // which is the difference between a guest waiting and a guest leaving
        // with nothing.
        await remember(pending.request.id, 'record a new job', (jobs, box) =>
          jobs.putPrintJob(recordFor(pending, 'queued', box)),
        );
      }
      return settle(pending);
    })();
    pending.running = running;
    const done = (): void => {
      if (pending.running === running) pending.running = null;
    };
    running.then(done, done);
    return running;
  }

  /**
   * Whether a waiting job's turn has come, on the clock as the box reads it
   * now: at or past its retry time — or further from it than one retry delay
   * can put it (SCRUM-439).
   *
   * Every retry time is `now` plus `retryDelayMs`, and `now` is the box's
   * CORRECTED clock (`clock()` in `agent.ts`, SCRUM-402). A correction that
   * moves the clock back — a Pi that booted hours ahead after a power cut,
   * took a voucher while the printer was out of paper, and then measured
   * itself against the platform — leaves every retry time set before it that
   * many hours ahead, and the voucher would wait out the whole offset before
   * the printer was tried again. So the queue holds its retries to its own
   * cap, as the outbox holds its to `OUTBOX_BACKOFF_CAP_MS` (`takeBatch` in
   * `store-sql.ts`): a retry further off than one delay was set by a clock
   * that has since gone back, and the job is due now. A retry set on the
   * clock the box reads now is never further off than the delay, so an
   * ordinary wait is not cut short.
   */
  function retryDue(pending: PendingJob, nowMs: number): boolean {
    return pending.nextAttemptAt <= nowMs || pending.nextAttemptAt > nowMs + retryDelayMs;
  }

  /**
   * Whether a held job is still kept off the tick (`hold`): its time has not
   * come — and it is not further off than twice the hold's own length, which
   * only a clock that has gone back since could make it, as `retryDue` says
   * of a retry. Twice rather than once, so an ordinary correction of a second
   * or two does not let a slip out while its wheel is still turning.
   */
  function heldBack(pending: PendingJob, nowMs: number): boolean {
    if (pending.heldUntil <= nowMs) return false;
    return pending.heldUntil - nowMs <= 2 * pending.heldForMs;
  }

  /** One attempt, and what it leaves behind: the job back on the queue, or gone. */
  async function settle(pending: PendingJob): Promise<PrintJobOutcome> {
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
      /**
       * One id, one job, one slip — the job id is the fence (`putPrintJob`).
       *
       * A caller may write its job's row itself before handing the job over:
       * a spin commits its voucher's print job in the same transaction as its
       * facts. When that hand-over is the first thing to reach this queue
       * after a boot — the first press while `start` is still waiting on a
       * silent cloud, or on a box that booted with the Console's offline
       * switch on, whose heartbeat never ticks the queue — the resume above
       * reads that very row and queues it. Queueing the caller's copy beside
       * it printed the voucher twice: once now, and again at the next tick,
       * after the booth had let the job go, so that second outcome went to the
       * cloud's print-result route instead of the outbox (SCRUM-223).
       *
       * So a job already queued under this id is taken over: attempted now
       * with this caller's request, or — when an attempt of it is on the
       * printer already — answered with that attempt's outcome.
       */
      const held = queue.find((p) => p.request.id === request.id);
      if (held) {
        // The resume assumed its first `queued` outcome was old news; to the
        // caller asking now, it is not.
        held.queuedReported = false;
        // Asked for: whatever `hold` kept it back for is over.
        held.heldUntil = 0;
        held.heldForMs = 0;
        if (held.running) return held.running;
        held.request = request;
        return run(held, { record: true });
      }
      const pending: PendingJob = {
        request,
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        queuedReported: false,
        queuedAt: now().toISOString(),
        deviceId: null,
        running: null,
        heldUntil: 0,
        heldForMs: 0,
      };
      queue.push(pending);
      return run(pending, { record: true });
    },
    async hold(request, until) {
      await ensureResumed();
      const nowMs = now().getTime();
      const heldUntil = until.getTime();
      const heldForMs = Math.max(0, heldUntil - nowMs);
      // The row the caller wrote may already be here, picked up by the resume
      // above: that is this job, held rather than queued a second time.
      const found = queue.find((p) => p.request.id === request.id);
      if (found) {
        // On the printer already, because somebody asked for it: nothing to hold.
        if (found.running) return;
        found.request = request;
        found.queuedReported = false;
        found.heldUntil = heldUntil;
        found.heldForMs = heldForMs;
        return;
      }
      queue.push({
        request,
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        queuedReported: false,
        queuedAt: now().toISOString(),
        deviceId: null,
        running: null,
        heldUntil,
        heldForMs,
      });
    },
    async pulseDrawer(request) {
      const role = request.role ?? ROLE_FOR_KIND.receipt;
      const routed = routeTo(options.bundle(), role, request.stationId);
      const base = {
        role,
        stationId: request.stationId ?? null,
        elapsedMs: null as number | null,
      };
      if (!routed) {
        return {
          ...base,
          opened: false,
          deviceId: null,
          errorCode: 'NO_DEVICE_FOR_ROLE',
          errorMessage: `No ${role} printer is assigned${
            request.stationId ? ' to this station' : ' on this box'
          }, so there is nothing to open a drawer through`,
        };
      }
      const adapter = adapterFor(routed.device);
      if (adapter instanceof PrinterError) {
        return {
          ...base,
          opened: false,
          deviceId: routed.device.id,
          errorCode: adapter.code,
          errorMessage: adapter.message,
        };
      }
      try {
        // Behind the same per-device lock as a print job: the pulse is bytes on
        // the same socket, and writing them into the middle of a receipt would
        // put `ESC p` where the raster data should be.
        const result = await serialise(routed.device.id, () =>
          adapter.pulseDrawer({
            pin: request.pin ?? DRAWER_PULSE.pin,
            onMs: request.onMs ?? DRAWER_PULSE.onMs,
            offMs: request.offMs ?? DRAWER_PULSE.offMs,
          }),
        );
        // A pulse is also a health reading, and a free one: the drawer is
        // opened at a counter far more often than anybody presses Test print.
        if (result.supported) health[routed.device.id] = result.health;
        log(result.supported ? 'info' : 'warn', 'cash drawer pulse', {
          deviceId: routed.device.id,
          stationId: request.stationId ?? null,
          actionId: request.actionId ?? null,
          supported: result.supported,
        });
        return {
          ...base,
          opened: result.supported,
          deviceId: routed.device.id,
          elapsedMs: result.elapsedMs,
          errorCode: result.supported ? null : 'PRINTER_HAS_NO_DRAWER',
          errorMessage: result.supported
            ? null
            : `${routed.device.label} has no cash-drawer line, so this station's drawer is on another printer`,
        };
      } catch (err) {
        const error =
          err instanceof PrinterError
            ? err
            : new PrinterError(
                'DRAWER_WRITE_FAILED',
                err instanceof Error ? err.message : String(err),
              );
        health[routed.device.id] = {
          ...(health[routed.device.id] ?? unknownHealth(now().toISOString())),
          reachability: error.code === 'PRINTER_UNREACHABLE' ? 'unreachable' : 'reachable',
          lastError: error.code,
          checkedAt: now().toISOString(),
        };
        log('error', 'the cash drawer could not be opened', {
          deviceId: routed.device.id,
          errorCode: error.code,
        });
        return {
          ...base,
          opened: false,
          deviceId: routed.device.id,
          errorCode: error.code,
          errorMessage: error.message,
        };
      }
    },
    async tick() {
      await ensureResumed();
      // A held slip is left alone until its hold is over (`hold`), however
      // due its retry time says it is.
      const isDue = (p: PendingJob): boolean =>
        p.running === null &&
        queue.includes(p) &&
        !heldBack(p, now().getTime()) &&
        retryDue(p, now().getTime());
      const due = queue.filter(isDue);
      const outcomes: PrintJobOutcome[] = [];
      /**
       * The printers an attempt in this tick found not answering, by device
       * id, with what the attempt ended as and how many due jobs have been
       * left on each (SCRUM-440; see the interface). A job left is not
       * touched: its attempt count, its retry time and its row on the card
       * stay as they were, so the next tick finds it due as this one did.
       */
      const notAnswering = new Map<string, { errorCode: string; left: number }>();
      for (const pending of due) {
        // Asked again at its turn: while an earlier job printed, `submit` may
        // have taken this one up or finished it, and attempting it again then
        // would be a second slip.
        if (!isDue(pending)) continue;
        const deviceId = deviceFor(pending);
        const stopped = deviceId === null ? undefined : notAnswering.get(deviceId);
        if (stopped) {
          stopped.left += 1;
          continue;
        }
        const outcome = await run(pending);
        outcomes.push(outcome);
        if (
          outcome.deviceId !== null &&
          outcome.errorCode !== null &&
          (PRINTER_NOT_ANSWERING as readonly string[]).includes(outcome.errorCode)
        ) {
          notAnswering.set(outcome.deviceId, { errorCode: outcome.errorCode, left: 0 });
        }
      }
      for (const [deviceId, { errorCode, left }] of notAnswering) {
        if (left === 0) continue;
        log('info', 'print jobs left for the next tick: their printer did not answer', {
          deviceId,
          errorCode,
          left,
        });
      }
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
          if (busy.has(device.id)) {
            /**
             * Busy: left as it last was, and not queued for (see the
             * interface). The job on it reports for itself — it sets this
             * entry when it ends, printed or failed; case 1 in the header
             * says how a job ends on a printer that stops — and the next
             * heartbeat asks again.
             */
            log('info', 'a printer was busy, so the heartbeat reports what it last said', {
              deviceId: device.id,
            });
            continue;
          }
          health[device.id] = await serialise(device.id, () => adapter.probe());
        }
      }
      return { ...health };
    },
  };
}
