import { SerialPort } from 'serialport';
import { TerminalError, TERMINAL_TIMEOUTS } from './contract';
import type { SerialOpener, TerminalTransport } from './serial-channel';

/** The operating system owns the port exclusively until this exchange ends. */
export const openNativeSerial: SerialOpener = target => {
  const supported = process.platform === 'win32' ? /^COM[1-9]\d*$/i : /^\/dev\/tty(?:ACM|USB|S|AMA)\d+$/;
  if (!supported.test(target.path)) {
    throw new TerminalError('TERMINAL_UNREACHABLE', 'Choose the terminal serial port in device settings.');
  }
  const port = new SerialPort({
    path: target.path, baudRate: target.baud, dataBits: target.dataBits,
    parity: target.parity, stopBits: target.stopBits, autoOpen: false, lock: true,
  });
  return connectTerminalPort(port);
};

type TerminalPort = Pick<SerialPort, 'on' | 'isOpen' | 'open' | 'close' | 'write' | 'drain'>;

export async function connectTerminalPort(port: TerminalPort): Promise<TerminalTransport> {
  let disconnected: (() => void) | undefined;
  let broken = false;
  const markClosed = () => { broken = true; disconnected?.(); };
  port.on('error', markClosed);
  port.on('close', markClosed);

  await new Promise<void>((resolve, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new TerminalError('TERMINAL_UNREACHABLE', 'The terminal serial port did not open in time.'));
    }, TERMINAL_TIMEOUTS.openMs);
    port.open(error => {
      clearTimeout(timer);
      if (timedOut) { if (port.isOpen) port.close(() => {}); return; }
      if (error) reject(new TerminalError('TERMINAL_UNREACHABLE', 'The terminal serial port could not be opened. Check its cable, address and access permissions.', { cause: error }));
      else resolve();
    });
  });
  const transport: TerminalTransport = {
    onData(sink) { port.on('data', sink); },
    onDisconnect(sink) { disconnected = sink; if (broken) sink(); },
    async write(bytes) {
      if (broken || !port.isOpen) throw new TerminalError('TERMINAL_UNREACHABLE', 'The terminal was disconnected.');
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new TerminalError('TERMINAL_WRITE_FAILED',
          'The terminal did not confirm the serial write.', { partial: true })), TERMINAL_TIMEOUTS.openMs);
        const done = (err: Error | null | undefined) => {
          clearTimeout(timer);
          if (err) reject(err); else resolve();
        };
        port.write(Buffer.from(bytes), err => err ? done(err) : port.drain(done));
      });
    },
    async close() {
      if (!port.isOpen) return;
      await new Promise<void>(resolve => port.close(() => resolve()));
    },
  };
  return transport;
}
