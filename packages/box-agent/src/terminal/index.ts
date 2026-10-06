/**
 * The box's card-terminal side, assembled (S2-10a).
 *
 * The one decision this file makes is **which terminals are simulated**, and it
 * takes the answer from the device row rather than from a flag on the process,
 * exactly as `printing/index.ts:1-17` does: a device whose `transport` is
 * `simulated` is served by a simulator and every other terminal is a serial
 * port. That is what the seed already says about the park's two EDCs, and it is
 * what lets one Pi drive a real NEXGO and a simulated PAX on the same counter
 * while somebody waits for Digio to enable ECR mode — with no build flag and no
 * branch inside the adapter.
 *
 * The other thing it owns is **one conversation per terminal at a time**. A
 * tethered EDC has one serial link and one screen; two tenders sent at once
 * would interleave on the wire and, worse, a guest would be looking at somebody
 * else's amount. `printing/queue.ts:524-536` does the same for printers for a
 * weaker reason (nobody knows what a second socket does) — here it is plain.
 */

import { businessDate as businessDateFor, parseDayStart } from '@oto/shared';

import type { BoxConfigBundle, BoxConfigDevice, BoxConfigStation } from '../protocol';
import type { BoxStore } from '../store';
import {
  TerminalError,
  roleForTender,
  terminalProtocolOf,
  type PaymentTerminal,
  type SimulatedOutcome,
  type SimulatedOutcomeOptions,
  type TerminalCommandPayload,
  type TerminalChannel,
  type TerminalProgress,
  type TerminalProtocol,
  type TerminalResult,
  type TerminalSettlementCommand,
  type TerminalSettlementResult,
  type SimulatedTransaction,
  type TerminalSimulator,
  type TerminalSimulatorEvent,
} from './contract';
import { createTerminalRefCounter, type TerminalRefCounter } from './counter';
import { digioTerminal, DIGIO_PAYMENT_TYPES } from './digio';
import { ghlTerminal, GHL_CARD_TRADE_TYPE, GHL_WALLET_TRADE_TYPES } from './ghl';
import { createDigioSimulator } from './simulator-digio';
import { createGhlSimulator } from './simulator-ghl';
import { openSerialChannel, serialTargetFor, type SerialOpener } from './serial-channel';

export * from './contract';
export * from './counter';
export * from './digio';
export * from './ghl';
export * from './serial-channel';
export * from './simulator-digio';
export * from './simulator-ghl';

export interface TerminalsOptions {
  bundle: () => BoxConfigBundle | null;
  /** Where the reference counter lives. Null means no card tenders — by design. */
  store?: BoxStore | null;
  boxId: () => string | null;
  now?: () => Date;
  log?: (level: 'info' | 'warn' | 'error', msg: string, detail?: Record<string, unknown>) => void;
  /** How a REAL serial port is opened. Never used for a simulated terminal. */
  openSerial?: SerialOpener;
  /** Configuration, never a constant: see `DigioDeps.voidPassword`. */
  voidPassword?: string | null;
  /** The operator stamp when a tender names none. */
  cashier?: string | null;
  /** Read deadlines, for a test that must not wait out a two-minute budget. */
  timeouts?: { saleMs?: number; probeMs?: number };
}

export interface RoutedTerminal {
  station: BoxConfigStation | null;
  device: BoxConfigDevice;
  role: string;
  terminal: PaymentTerminal;
}

export interface TerminalCommandOutcome {
  routed: {
    deviceId: string;
    stationId: string | null;
    role: string;
    protocol: TerminalProtocol;
  } | null;
  result: TerminalResult | null;
  errorCode?: string;
  errorMessage?: string;
}

export interface TerminalController {
  terminals(): PaymentTerminal[];
  terminal(deviceId: string): PaymentTerminal | undefined;
  /** The terminal for a station's role, or null when the station has none. */
  route(stationId: string | null | undefined, role: string): RoutedTerminal | null;
  /** Run one exchange as a `terminal_sale` command describes it. */
  runCommand(
    payload: TerminalCommandPayload,
    opts?: { onProgress?: (event: TerminalProgress) => void },
  ): Promise<TerminalCommandOutcome>;
  settle(payload: TerminalSettlementCommand): Promise<TerminalSettlementResult>;
  simulators(): TerminalSimulator[];
  simulator(deviceId: string): TerminalSimulator | undefined;
  /** False when the device is not one this box simulates. */
  setOutcome(deviceId: string, outcome: SimulatedOutcome, opts?: SimulatedOutcomeOptions): boolean;
  advanceClock(deviceId: string, minutes: number): boolean;
  events(deviceId: string, limit?: number): TerminalSimulatorEvent[];
  /** The branch's trading day, which is what the reference counter is keyed by. */
  businessDate(): string;
}

/** Every terminal the bundle names, once, whichever station it hangs off. */
export function terminalDevices(bundle: BoxConfigBundle | null): BoxConfigDevice[] {
  const seen = new Set<string>();
  const out: BoxConfigDevice[] = [];
  for (const station of bundle?.stations ?? []) {
    for (const device of station.devices) {
      if (seen.has(device.id)) continue;
      // By PROTOCOL rather than by kind: a device row is a terminal to this
      // module when it speaks a dialect this module has, which is the same
      // question `adapterFor` asks in the print queue.
      if (!terminalProtocolOf(device.protocol)) continue;
      seen.add(device.id);
      out.push(device);
    }
  }
  return out;
}

export function createTerminals(options: TerminalsOptions): TerminalController {
  const now = options.now ?? (() => new Date());
  const log = options.log ?? (() => {});
  const openSerial = options.openSerial;
  const sims = new Map<string, TerminalSimulator>();
  type SettlementState = {
    transactions: SimulatedTransaction[];
    tid?: string | null;
    mid?: string | null;
    batches: Record<string, { businessDate: string; result: TerminalSettlementResult }>;
  };
  const settlementStates = new Map<string, SettlementState>();
  const settlementKey = (deviceId: string) => `terminal.settlement.${deviceId}`;

  /** One promise per device id: the tail of the chain of exchanges for it. */
  const locks = new Map<string, Promise<unknown>>();
  const counter: TerminalRefCounter = createTerminalRefCounter({
    store: options.store ?? null,
    boxId: options.boxId,
    now,
  });

  function businessDate(): string {
    const branch = options.bundle()?.branch;
    if (!branch) {
      throw new TerminalError(
        'TERMINAL_NOT_CONFIGURED',
        'this box has no branch in its bundle, so it cannot say which trading day a tender belongs to',
      );
    }
    return businessDateFor(now(), branch.timezone, parseDayStart(branch.businessDayStart));
  }

  /**
   * Stand a simulator up for every simulated terminal in the current bundle and
   * drop the ones whose device has gone.
   *
   * Called wherever a terminal is asked for, so a device added on the Console
   * appears on the next config pull and one removed there stops existing here.
   * An existing simulator is KEPT rather than rebuilt: it is holding the
   * transactions an inquiry or a void has to find, and rebuilding it on a
   * config pull would lose a tender somebody is standing at a counter waiting
   * to void.
   */
  function reconcile(): Map<string, BoxConfigDevice> {
    const devices = new Map(terminalDevices(options.bundle()).map((d) => [d.id, d]));
    for (const id of [...sims.keys()]) if (!devices.has(id)) sims.delete(id);
    for (const [id, device] of devices) {
      if (device.transport !== 'simulated') {
        sims.delete(id);
        continue;
      }
      if (sims.has(id)) continue;
      const protocol = terminalProtocolOf(device.protocol);
      if (!protocol) continue;
      const shared = {
        deviceId: id,
        label: device.label,
        terminalId: device.terminalId,
        merchantId: device.merchantId,
        serialNumber: device.serialNumber,
        now,
      };
      sims.set(
        id,
        protocol === 'ghl_linkpos'
          ? createGhlSimulator(shared)
          : createDigioSimulator({ ...shared, voidPassword: options.voidPassword ?? null }),
      );
    }
    return devices;
  }

  /**
   * One factory in front of both worlds.
   *
   * The adapter above it cannot tell which it got, which is the property worth
   * having: whatever the simulator proves about the adapter is a claim about
   * the code that will drive the real terminal, because it IS that code.
   */
  function openFor(device: BoxConfigDevice, protocol: TerminalProtocol): () => Promise<TerminalChannel> {
    return async () => {
      const sim = sims.get(device.id);
      if (sim) return sim.connect();
      const target = serialTargetFor(device, protocol);
      if (!target) {
        throw new TerminalError(
          'DEVICE_NO_ADDRESS',
          `${device.label} has no serial path, so there is nothing to open`,
        );
      }
      return openSerialChannel(target, openSerial);
    };
  }

  function adapterFor(device: BoxConfigDevice): PaymentTerminal | null {
    const protocol = terminalProtocolOf(device.protocol);
    if (!protocol) return null;
    const deps = {
      deviceId: device.id,
      label: device.label,
      terminalId: device.terminalId,
      merchantId: device.merchantId,
      open: openFor(device, protocol),
      nextRef: () => counter.next({ deviceId: device.id, protocol, businessDate: businessDate() }),
      now,
      cashier: options.cashier ?? null,
      ...(options.timeouts ? { timeouts: options.timeouts } : {}),
    };
    return protocol === 'ghl_linkpos'
      ? ghlTerminal(deps)
      : digioTerminal({ ...deps, voidPassword: options.voidPassword ?? null });
  }

  /** Run `fn` when this terminal is free, and keep it free for the next caller. */
  function serialise<T>(deviceId: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(deviceId) ?? Promise.resolve();
    const run = async () => {
      const sim = sims.get(deviceId);
      const boxId = options.boxId();
      if (!sim || !boxId || !options.store) return fn();
      const saved = await options.store.readRuntimeValue(boxId, settlementKey(deviceId));
      const held: SettlementState = saved ? JSON.parse(saved) as SettlementState
        : { transactions: sim.transactions(), batches: {} };
      sim.restoreTransactions(held.transactions);
      settlementStates.set(deviceId, held);
      try {
        const result = await fn();
        if (result && typeof result === 'object' && 'tid' in result) {
          const terminalResult = result as { tid?: string | null; mid?: string | null };
          held.tid = terminalResult.tid ?? held.tid;
          held.mid = terminalResult.mid ?? held.mid;
        }
        return result;
      } finally {
        held.transactions = sim.transactions();
        await options.store.writeRuntimeValue(boxId, settlementKey(deviceId), JSON.stringify(held));
      }
    };
    const next = previous.then(run, run);
    locks.set(
      deviceId,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  function find(deviceId: string): BoxConfigDevice | undefined {
    return reconcile().get(deviceId);
  }

  /**
   * A station that names itself gets ITS terminal or nothing.
   *
   * Falling back to another station's terminal would put a guest's card in
   * front of a different counter — the same rule `routeTo`
   * (`printing/queue.ts:296-305`) states for a receipt, with more at stake. A
   * tender that names no station may use any terminal on the box, which is what
   * a Console panel acting on one device does.
   */
  function routeTo(stationId: string | null | undefined, role: string): RoutedTerminal | null {
    const bundle = options.bundle();
    if (!bundle) return null;
    reconcile();
    const stations = stationId
      ? bundle.stations.filter((s) => s.id === stationId)
      : bundle.stations;
    for (const station of stations) {
      const device = station.devices.find(
        (d) => d.role === role && terminalProtocolOf(d.protocol),
      );
      if (!device) continue;
      const terminal = adapterFor(device);
      if (terminal) return { station, device, role, terminal };
    }
    return null;
  }

  return {
    terminals() {
      const devices = reconcile();
      const out: PaymentTerminal[] = [];
      for (const device of devices.values()) {
        const adapter = adapterFor(device);
        if (adapter) out.push(adapter);
      }
      return out;
    },
    terminal(deviceId) {
      const device = find(deviceId);
      return device ? (adapterFor(device) ?? undefined) : undefined;
    },
    route: routeTo,
    async runCommand(payload, opts = {}) {
      const role = payload.role ?? roleForTender(payload.tender);
      let found: RoutedTerminal | null = null;
      if (payload.deviceId) {
        const device = find(payload.deviceId);
        const terminal = device ? adapterFor(device) : null;
        if (device && terminal) found = { station: null, device, role, terminal };
      } else {
        found = routeTo(payload.stationId ?? null, role);
      }
      if (!found) {
        /**
         * The cloud recorded a route when it queued this and the BOX's answer
         * wins, for the reason `services/print.ts:297-305` gives: the box holds
         * the configuration it is actually running, and a terminal moved to
         * another station since the command was minted is a fact only the box
         * has.
         */
        return {
          routed: null,
          result: null,
          errorCode: 'TERMINAL_NOT_ON_THIS_BOX',
          errorMessage: `this box has no ${role} for ${payload.stationId ?? 'any station'}`,
        };
      }
      const routed = found;
      const protocol = terminalProtocolOf(routed.device.protocol) as TerminalProtocol;
      const where = {
        deviceId: routed.device.id,
        stationId: routed.station?.id ?? null,
        role,
        protocol,
      };
      try {
        const result = await serialise(routed.device.id, async () => {
          if (payload.mode === 'inquire') {
            if (!payload.terminalRef) {
              throw new TerminalError(
                'TERMINAL_BAD_REQUEST',
                'an inquiry has to name the sale it is about',
              );
            }
            return routed.terminal.inquire({
              attemptId: payload.attemptId,
              tender: payload.tender,
              wallet: payload.wallet ?? null,
              terminalRef: payload.terminalRef,
              tranRef: payload.tranRef ?? null,
              cashier: payload.cashier ?? null,
              amountSatang: payload.amountSatang,
            });
          }
          if (payload.mode === 'void') {
            if (!payload.tranRef) {
              throw new TerminalError(
                'TERMINAL_BAD_REQUEST',
                'a void has to name the transaction it undoes',
              );
            }
            return routed.terminal.void({
              attemptId: payload.attemptId,
              tender: payload.tender,
              wallet: payload.wallet ?? null,
              amountSatang: payload.amountSatang,
              tranRef: payload.tranRef,
              approvalCode: payload.approvalCode ?? null,
              cashier: payload.cashier ?? null,
            });
          }
          return routed.terminal.sale({
            attemptId: payload.attemptId,
            amountSatang: payload.amountSatang,
            tender: payload.tender,
            wallet: payload.wallet ?? null,
            cashier: payload.cashier ?? null,
            requestQrPayload: payload.requestQrPayload ?? false,
            qrDirection: payload.qrDirection ?? 'show',
            onProgress: opts.onProgress,
          });
        });
        return { routed: where, result };
      } catch (err) {
        const code = err instanceof TerminalError ? err.code : 'TERMINAL_UNREACHABLE';
        log('warn', 'a terminal exchange could not be attempted', {
          deviceId: routed.device.id,
          attemptId: payload.attemptId,
          code,
        });
        return {
          routed: where,
          result: null,
          errorCode: code,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
    },
    async settle(payload) {
      const device = find(payload.deviceId);
      const terminal = device ? adapterFor(device) : null;
      const failure = (errorCode: string): TerminalSettlementResult => ({
        outcome: 'failed', deviceId: payload.deviceId, errorCode, lines: [],
      });
      if (!device || !terminal) return failure('TERMINAL_NOT_ON_THIS_BOX');
      const sim = sims.get(device.id);
      if (!sim) return serialise(device.id, () => terminal.settle());
      if (!options.store || !options.boxId()) return failure('TERMINAL_NOT_CONFIGURED');
      return serialise(device.id, async () => {
        const held = settlementStates.get(device.id);
        const branch = options.bundle()?.branch;
        if (!held || !branch) return failure('TERMINAL_NOT_CONFIGURED');
        const prior = held.batches[payload.batchId];
        if (prior) return prior.businessDate === payload.businessDate
          ? prior.result : failure('SETTLEMENT_BATCH_CONFLICT');
        const transactions = sim.transactions();
        const included = transactions.filter((row) => !row.voided && !row.settled && row.amountSatang > 0 &&
          ([GHL_CARD_TRADE_TYPE, ...GHL_WALLET_TRADE_TYPES, ...Object.values(DIGIO_PAYMENT_TYPES)] as string[]).includes(row.kind) &&
          businessDateFor(new Date(row.at), branch.timezone, parseDayStart(branch.businessDayStart)) === payload.businessDate);
        if (included.length > 10_000) return failure('SETTLEMENT_BATCH_TOO_LARGE');
        const identities = new Set(included.map((row) => JSON.stringify([row.tid, row.mid])));
        if (identities.size > 1) return failure('SETTLEMENT_TERMINAL_IDENTITY_CHANGED');
        const result: TerminalSettlementResult = {
          outcome: 'settled', deviceId: device.id, tid: included[0]?.tid ?? held.tid ?? device.terminalId,
          mid: included[0]?.mid ?? held.mid ?? device.merchantId, batchRef: `SIM-${payload.batchId}`,
          lines: included.map((row) => ({
            method: ['CARD', 'A1'].includes(row.kind) ? 'card' : 'qr',
            amountSatang: row.amountSatang, terminalRef: row.ref,
            tranRef: row.tranRef, approvalCode: row.approvalCode,
          })),
        };
        for (const row of included) row.settled = true;
        sim.restoreTransactions(transactions);
        held.batches[payload.batchId] = { businessDate: payload.businessDate, result };
        return result;
      });
    },
    simulators() {
      reconcile();
      return [...sims.values()];
    },
    simulator(deviceId) {
      reconcile();
      return sims.get(deviceId);
    },
    setOutcome(deviceId, outcome, opts) {
      reconcile();
      const sim = sims.get(deviceId);
      if (!sim) return false;
      sim.setOutcome(outcome, opts);
      return true;
    },
    advanceClock(deviceId, minutes) {
      reconcile();
      const sim = sims.get(deviceId);
      if (!sim) return false;
      sim.advanceClock(minutes);
      return true;
    },
    events(deviceId, limit) {
      reconcile();
      return sims.get(deviceId)?.events(limit) ?? [];
    },
    businessDate,
  };
}
