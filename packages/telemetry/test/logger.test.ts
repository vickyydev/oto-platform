import { describe, expect, it } from 'vitest';
import { safeLogger, type LogFn, type PinoLike } from '../src/index';

/**
 * The seam's whole claim is that a caller cannot forget, so the cases are the
 * ways a caller forgets: a binding, a child binding, an interpolated message,
 * and an error handed straight to `log.error`.
 */

interface Line {
  level: string;
  first: unknown;
  rest: unknown[];
}

interface Recorder {
  root: PinoLike;
  lines: Line[];
  /** Bindings as each child received them — after the seam, not before. */
  childBindings: Record<string, unknown>[];
}

function recorder(): Recorder {
  const lines: Line[] = [];
  const childBindings: Record<string, unknown>[] = [];

  function make(): PinoLike {
    const log: Partial<PinoLike> = {
      level: 'info',
      child: (bindings) => {
        childBindings.push(bindings);
        return make();
      },
    };
    for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      log[level] = ((first: unknown, ...rest: unknown[]) => {
        lines.push({ level, first, rest });
      }) as LogFn;
    }
    return log as PinoLike;
  }

  return { root: make(), lines, childBindings };
}

const E164 = '+66811111111';

describe('safeLogger', () => {
  it('redacts a binding object before the logger sees it', () => {
    const sink = recorder();
    safeLogger(sink.root).info({ phone: E164, accountId: 'acc-1', ms: 12 }, 'request completed');

    const line = sink.lines[0]!;
    expect(line.first).toEqual({ phone: '[redacted]', accountId: 'acc-1', ms: 12 });
    expect(line.rest[0]).toBe('request completed');
    expect(JSON.stringify(sink.lines)).not.toContain('66811111111');
  });

  it('sweeps a message string, interpolated or not', () => {
    const sink = recorder();
    const log = safeLogger(sink.root);
    log.warn(`no account for ${E164}`);
    log.info({ op: 'member.create' }, `created for ${E164}`);

    expect(sink.lines[0]!.first).toBe('no account for [redacted:phone]');
    expect(sink.lines[1]!.rest[0]).toBe('created for [redacted:phone]');
  });

  it("puts an error under pino's own `err` key, redacted", () => {
    const sink = recorder();
    safeLogger(sink.root).error(new Error(`terminal refused ${E164}`), 'sale failed');

    const payload = sink.lines[0]!.first as { err: { type: string; message: string } };
    expect(payload.err.type).toBe('Error');
    expect(payload.err.message).toBe('terminal refused [redacted:phone]');
    expect(JSON.stringify(sink.lines)).not.toContain('66811111111');
  });

  it('redacts child bindings, which repeat on every line the child writes', () => {
    const sink = recorder();
    safeLogger(sink.root).child({ phone: E164, stationId: 'st-1' });

    expect(sink.childBindings[0]).toEqual({ phone: '[redacted]', stationId: 'st-1' });
  });

  it('wraps children, so the seam survives one', () => {
    const sink = recorder();
    const log = safeLogger(sink.root).child({ stationId: 'st-1' }).child({ boxId: 'box-1' });
    // The one place a phone is written to a logger on purpose: this asserts
    // the seam redacts it. The rule is right to refuse everywhere else.
    // eslint-disable-next-line oto/no-pii-in-logs
    log.info({ phone: E164 });

    expect(sink.childBindings).toHaveLength(2);
    expect(sink.lines[0]!.first).toEqual({ phone: '[redacted]' });
  });

  it('forwards the level through to the logger it wraps', () => {
    const sink = recorder();
    const log = safeLogger(sink.root);
    expect(log.level).toBe('info');
    log.level = 'debug';
    expect(sink.root.level).toBe('debug');
    expect(log.level).toBe('debug');
  });

  it('does not fall over on a null, undefined or numeric first argument', () => {
    const sink = recorder();
    const log = safeLogger(sink.root);
    expect(() => log.info(null)).not.toThrow();
    expect(() => log.info(undefined)).not.toThrow();
    expect(() => log.info(42)).not.toThrow();
    expect(sink.lines).toHaveLength(3);
    expect(sink.lines[2]!.first).toEqual({ value: 42 });
  });
});
