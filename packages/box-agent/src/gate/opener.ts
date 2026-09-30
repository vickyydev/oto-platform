/**
 * WHAT OPENS THE LANE — the one switch the installer sets (OD-A2).
 *
 * Three ways, one interface:
 *
 *   box_relay     the relay HAT on the gate box closes the dry contact on the
 *                 board's L-OP or R-OP against COM for about a second
 *                 (supplier answer 1; HX-X1 terminal block 10). The brief's
 *                 choice and the default (PC §7.5).
 *   serial        the §1 "open gate" command down the serial line, which the
 *                 board acknowledges at once (GE-X2 §1).
 *   reader_relay  the reader's own relay, which it closes when the box answers
 *                 code "1" (Gate Interface Spec §1) — an inference from the
 *                 spec, not a wiring anyone has seen (DEVICE_INVENTORY §6).
 *                 The box does nothing; the answer is the open.
 *
 * Each refuses LOUDLY when it cannot act: a relay opener with no relay driver
 * or no wiring, a serial opener with no link to the board. A refusal becomes
 * "gate not ready" at the reader and a fault on Health — never a silent
 * "welcome" at a lane that did not move.
 */

import { spawn } from 'node:child_process';

import type { GateOpenerMode, RelayWiring } from './config';
import type { GateSide } from './ge-x2';
import type { GateLink } from './link';

export class GateOpenerError extends Error {
  readonly code: 'GATE_OPENER_NOT_READY' | 'GATE_OPENER_FAILED';
  constructor(code: 'GATE_OPENER_NOT_READY' | 'GATE_OPENER_FAILED', message: string) {
    super(message);
    this.name = 'GateOpenerError';
    this.code = code;
  }
}

export interface GateOpener {
  readonly mode: GateOpenerMode;
  /** Whether it can act at all; the reason when it cannot. */
  ready(): { ok: true } | { ok: false; reason: string };
  /** Open one side for one passage. Throws `GateOpenerError`. */
  open(side: GateSide): Promise<void>;
}

// --- The relay ------------------------------------------------------------------

/**
 * Drives one relay line. The host supplies it: this package takes no native
 * dependency, and which HAT sits on the box is an installation fact.
 */
export interface RelayDriver {
  pulse(line: { chip: string; line: number; activeLow: boolean }, ms: number): Promise<void>;
}

/**
 * A relay driver over libgpiod's `gpioset` (v2 syntax), which Raspberry Pi OS
 * ships: set the line, hold it for the pulse, set it back, exit. `run` is
 * injected so a test can see the command without a GPIO chip.
 */
export function gpiosetRelayDriver(
  run: (command: string, args: string[]) => Promise<number> = spawnAndWait,
): RelayDriver {
  return {
    async pulse(target, ms) {
      const on = target.activeLow ? 0 : 1;
      const args = ['-c', target.chip, '-t', `${ms}ms,0`, `${target.line}=${on}`];
      const code = await run('gpioset', args);
      if (code !== 0) {
        throw new GateOpenerError(
          'GATE_OPENER_FAILED',
          `gpioset exited ${code} pulsing line ${target.line}`,
        );
      }
    },
  };
}

function spawnAndWait(command: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.on('error', () => resolve(-1));
    child.on('exit', (code) => resolve(code ?? -1));
  });
}

export function relayOpener(wiring: RelayWiring | null, driver: RelayDriver | null): GateOpener {
  function ready(): { ok: true } | { ok: false; reason: string } {
    if (!wiring) return { ok: false, reason: 'no relay wiring is configured for this gate' };
    if (!driver) return { ok: false, reason: 'this box has no relay driver' };
    return { ok: true };
  }
  return {
    mode: 'box_relay',
    ready,
    async open(side) {
      const state = ready();
      if (!state.ok) throw new GateOpenerError('GATE_OPENER_NOT_READY', state.reason);
      const w = wiring!;
      const line = side === 'left' ? w.leftLine : w.rightLine;
      try {
        await driver!.pulse({ chip: w.chip, line, activeLow: w.activeLow }, w.pulseMs);
      } catch (err) {
        if (err instanceof GateOpenerError) throw err;
        throw new GateOpenerError('GATE_OPENER_FAILED', `relay pulse failed: ${String(err)}`);
      }
    },
  };
}

// --- The serial command -----------------------------------------------------------

export function serialOpener(link: () => GateLink | null): GateOpener {
  function ready(): { ok: true } | { ok: false; reason: string } {
    return link()
      ? { ok: true }
      : { ok: false, reason: 'the serial line to the gate controller is not open' };
  }
  return {
    mode: 'serial',
    ready,
    async open(side) {
      const l = link();
      if (!l)
        throw new GateOpenerError(
          'GATE_OPENER_NOT_READY',
          'the serial line to the gate controller is not open',
        );
      const acked = await l.open(side);
      if (!acked) {
        throw new GateOpenerError(
          'GATE_OPENER_FAILED',
          'the gate controller did not acknowledge the open',
        );
      }
    },
  };
}

// --- The reader's relay -------------------------------------------------------------

export function readerRelayOpener(): GateOpener {
  return {
    mode: 'reader_relay',
    ready: () => ({ ok: true }),
    // The reader closes its own relay on code "1": the answer is the open.
    async open() {},
  };
}

export function createOpener(
  mode: GateOpenerMode,
  deps: { wiring: RelayWiring | null; relay: RelayDriver | null; link: () => GateLink | null },
): GateOpener {
  switch (mode) {
    case 'box_relay':
      return relayOpener(deps.wiring, deps.relay);
    case 'serial':
      return serialOpener(deps.link);
    case 'reader_relay':
      return readerRelayOpener();
  }
}
