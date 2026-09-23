import assert from 'node:assert/strict';
import { test } from 'node:test';

import { TERMINAL_TIMEOUTS, TerminalError } from '../src/terminal/contract';
import { CHANNEL_TIMEOUTS } from '../src/printing/channel';
import { digioFrameScanner, encodeDigioFrame, encodeTlv, toHex } from '../src/terminal/digio';
import { ghlFrameScanner } from '../src/terminal/ghl';
import {
  SERIAL_DEFAULTS,
  isByIdPath,
  noSerialDriver,
  openSerialChannel,
  resolveSerialPath,
  serialTargetFor,
  terminalChannel,
  type SerialFs,
} from '../src/terminal/serial-channel';

/**
 * The wire, without a terminal on the end of it (S2-10a).
 *
 * Two things are proved here and neither needs hardware: that the path is
 * resolved by id at every open, so a handset that comes back on a different
 * `ttyACM` number is still found (`DEVICE_INVENTORY.md:946`, `:949-957`), and
 * that framing survives the way bytes actually arrive on a serial line — a few
 * at a time, with the next message's first bytes already behind them.
 */

/** A `/dev/serial/by-id` tree that can be re-pointed, as a hot-plug does. */
function fakeFs(links: Record<string, string>): SerialFs & { repoint(from: string, to: string): void } {
  const map = { ...links };
  return {
    existsSync: (target) => target in map || Object.values(map).includes(target),
    realpathSync: (target) => map[target] ?? target,
    repoint(from, to) {
      map[from] = to;
    },
  };
}

test('the serial path is resolved by id at every open, so a hot-plug is followed', () => {
  const io = fakeFs({
    '/dev/serial/by-id/usb-PAX_Technology_A920-if00': '/dev/ttyACM0',
  });
  assert.equal(
    resolveSerialPath('/dev/serial/by-id/usb-PAX_Technology_A920-if00', io),
    '/dev/ttyACM0',
  );
  /**
   * The handset is lifted off the counter and put back. The kernel gives it a
   * different number; the by-id link follows it. An adapter that had cached
   * `/dev/ttyACM0` would now be talking to nothing — that is the bug this
   * resolution exists to prevent, and §9.5 asks a simulator to reproduce it.
   */
  io.repoint('/dev/serial/by-id/usb-PAX_Technology_A920-if00', '/dev/ttyACM1');
  assert.equal(
    resolveSerialPath('/dev/serial/by-id/usb-PAX_Technology_A920-if00', io),
    '/dev/ttyACM1',
  );
});

test('a terminal that is not plugged in is unreachable by name', () => {
  const io = fakeFs({});
  assert.throws(
    () => resolveSerialPath('/dev/serial/by-id/usb-NEXGO-if00', io),
    (err: unknown) => err instanceof TerminalError && err.code === 'TERMINAL_UNREACHABLE',
  );
  assert.equal(isByIdPath('/dev/serial/by-id/usb-NEXGO-if00'), true);
  assert.equal(isByIdPath('/dev/ttyACM0'), false);
});

test('the line settings come from the dialect and the device row overrides them', () => {
  // The NEXGO parity is the open question: the spec body says nothing and the
  // vendor's own sample sets Odd, so odd is the default and a site visit can
  // change it on the Console instead of in this file.
  assert.equal(SERIAL_DEFAULTS.ghl_linkpos.parity, 'odd');
  assert.equal(SERIAL_DEFAULTS.digio_tlv.parity, 'none');
  assert.equal(SERIAL_DEFAULTS.digio_tlv.baud, 9600);

  const target = serialTargetFor(
    { address: '/dev/serial/by-id/usb-NEXGO-if00', settings: { terminal: { parity: 'none' } } },
    'ghl_linkpos',
  );
  assert.equal(target?.parity, 'none');
  assert.equal(target?.baud, 9600);
  // A row with no address is a configuration somebody has not finished.
  assert.equal(serialTargetFor({ address: null }, 'ghl_linkpos'), null);
  assert.equal(serialTargetFor({ address: '   ' }, 'digio_tlv'), null);
});

test('a box with no serial driver refuses by name instead of pretending', async () => {
  const io = fakeFs({ '/dev/serial/by-id/usb-NEXGO-if00': '/dev/ttyACM0' });
  await assert.rejects(
    openSerialChannel(
      { path: '/dev/serial/by-id/usb-NEXGO-if00', ...SERIAL_DEFAULTS.ghl_linkpos },
      noSerialDriver,
      io,
    ),
    (err: unknown) => err instanceof TerminalError && err.code === 'TERMINAL_NO_SERIAL_DRIVER',
  );
});

test('a frame split across reads is one frame, and the next one is not lost', async () => {
  let sink: ((bytes: Uint8Array) => void) | null = null;
  const channel = terminalChannel({
    async write() {},
    onData(next) {
      sink = next;
    },
    async close() {},
  });
  const first = encodeDigioFrame(encodeTlv([{ tag: '21', value: 'A18' }]));
  const second = encodeDigioFrame(encodeTlv([{ tag: '21', value: 'A3' }]));

  // Bytes arrive the way a serial line delivers them: a few at a time, and the
  // second message's first bytes behind the first message's last.
  const deliver = (bytes: Uint8Array): void => sink?.(bytes);
  const reading = channel.readFrame(digioFrameScanner, 500);
  deliver(first.slice(0, 3));
  deliver(first.slice(3));
  deliver(second);
  const frame = await reading;
  assert.ok(frame);
  assert.equal(toHex(frame), toHex(first));

  /**
   * The second frame is still buffered, which is the Digio QR exchange: `A18`
   * with the payload, then `A3` when the guest pays. A channel that cleared
   * itself between reads would lose the payment.
   */
  const next = await channel.readFrame(digioFrameScanner, 500);
  assert.ok(next);
  assert.equal(toHex(next), toHex(second));
});

test('a read that gets nothing resolves null rather than throwing', async () => {
  const channel = terminalChannel({
    async write() {},
    onData() {},
    async close() {},
  });
  const started = Date.now();
  const frame = await channel.readFrame(ghlFrameScanner, 40);
  assert.equal(frame, null, 'silence is an outcome, not an error');
  assert.ok(Date.now() - started >= 30);
});

test('discard throws away a half-message, so a new tender starts clean', async () => {
  // Typed with a no-op default rather than a nullable, so the calls below are
  // calls and not optional ones: the transport always registers its sink.
  let sink: (bytes: Uint8Array) => void = () => {};
  const channel = terminalChannel({
    async write() {},
    onData(next) {
      sink = next;
    },
    async close() {},
  });
  sink(new TextEncoder().encode('<xml><pos_ref_no>HALF'));
  channel.discard();
  sink(new TextEncoder().encode('</pos_ref_no></xml>'));
  const frame = await channel.readFrame(ghlFrameScanner, 30);
  assert.equal(frame, null, 'the tail of an abandoned message is not a message');
});

test('the terminal budget is the guest’s, not the printer’s', () => {
  /**
   * `CHANNEL_TIMEOUTS` has no customer-interaction budget and should not: a
   * till waiting on a printer is a queue of people waiting on a till, so those
   * are seconds. A till waiting on a PIN is the guest.
   */
  assert.equal(TERMINAL_TIMEOUTS.customerInteractionMs, 120_000);
  assert.equal(TERMINAL_TIMEOUTS.openMs, 2000);
  assert.equal(TERMINAL_TIMEOUTS.idleReadMs, 500);
  assert.ok(
    TERMINAL_TIMEOUTS.customerInteractionMs > CHANNEL_TIMEOUTS.jobCompleteMs * 5,
    'the two budgets are different questions and must not be shared',
  );
});
