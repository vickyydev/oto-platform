import { describe, expect, it } from 'vitest';
import {
  PRINTER_DEFAULT_PORT,
  isPrinterKind,
  parsePrinterAddress,
  printerAddressProblem,
  printerAddressWords,
} from '../src/printer-address';

/**
 * SCRUM-899 — a printer's address, in the forms the box prints to: a printer
 * on the park network, a USB printer through the Pi's bridge, a simulator
 * found by its address. Nothing else is accepted, because nothing else prints.
 */
describe('parsePrinterAddress', () => {
  it('reads the three kinds of printer the park has, the port 9100 when none is written', () => {
    expect(parsePrinterAddress('192.168.88.204:9100')).toEqual({ host: '192.168.88.204', port: 9100 });
    expect(parsePrinterAddress('127.0.0.1:9101')).toEqual({ host: '127.0.0.1', port: 9101 });
    expect(parsePrinterAddress('s737-spare:9100')).toEqual({ host: 's737-spare', port: 9100 });
    expect(parsePrinterAddress('192.168.88.202')).toEqual({ host: '192.168.88.202', port: PRINTER_DEFAULT_PORT });
    expect(parsePrinterAddress('printer-1.local:9100')).toEqual({ host: 'printer-1.local', port: 9100 });
    expect(parsePrinterAddress('  192.168.88.210:9100 ')).toEqual({ host: '192.168.88.210', port: 9100 });
  });

  it('refuses what the box cannot open', () => {
    for (const address of [
      '/dev/usb/lp0',
      '/dev/ttyACM0',
      '192.168.88.300:9100',
      '192.168.88:9100',
      '192.168.88.204:0',
      '192.168.88.204:65536',
      '192.168.88.204:91oo',
      '192.168.88.204:',
      ':9100',
      'tcp://192.168.88.204:9100',
      '::1',
      'two words:9100',
      '-printer:9100',
      'printer_1:9100',
    ]) {
      expect(parsePrinterAddress(address), address).toBeNull();
    }
  });

  it('has nothing to read in an empty address', () => {
    expect(parsePrinterAddress(null)).toBeNull();
    expect(parsePrinterAddress(undefined)).toBeNull();
    expect(parsePrinterAddress('   ')).toBeNull();
  });
});

describe('printerAddressProblem', () => {
  it('names a missing address apart from one the box cannot open', () => {
    expect(printerAddressProblem(null)).toBe('missing');
    expect(printerAddressProblem('')).toBe('missing');
    expect(printerAddressProblem(' ')).toBe('missing');
    expect(printerAddressProblem('/dev/usb/lp0')).toBe('invalid');
    expect(printerAddressProblem('127.0.0.1:9100')).toBeNull();
  });

  it('says each in words a manager can act on', () => {
    expect(printerAddressWords('missing')).toContain('192.168.88.204:9100');
    expect(printerAddressWords('missing')).toContain('127.0.0.1:9100');
    expect(printerAddressWords('invalid')).toContain('not an address the box can print to');
  });
});

describe('isPrinterKind', () => {
  it('is every printer the box opens a socket to, and nothing else', () => {
    for (const kind of ['receipt_printer', 'band_printer', 'kitchen_printer', 'bar_printer']) expect(isPrinterKind(kind)).toBe(true);
    for (const kind of ['scanner', 'terminal', 'gate', 'gate_reader', 'cash_drawer']) expect(isPrinterKind(kind)).toBe(false);
  });
});
