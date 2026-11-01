import { describe, expect, it } from 'vitest';
import {
  scannerDefaultIds,
  scannerHealthOf,
  scannerHealthWords,
  scannerSetupOf,
  scannerSetupProblem,
  transportForScannerMode,
  withScannerSetup,
} from '@/lib/scannerSetup';

/**
 * SCRUM-700 — the scanner form on the device panel, and the line the panel
 * shows from what the box last said about the scanner it reads itself.
 */

const DEVICE = '018f0000-0000-7000-8000-00000000ac01';

describe('scannerSetupOf', () => {
  it('reads the row, and a row that names no mode by its transport, as the box does', () => {
    expect(scannerSetupOf(undefined, 'usb')).toEqual({ mode: 'hid', vendorId: '', productId: '', devicePath: '' });
    expect(scannerSetupOf(undefined, 'serial').mode).toBe('cdc');
    expect(
      scannerSetupOf({ mode: 'cdc', vendorId: '05e0', productId: '1701', devicePath: '/dev/ttyACM0' }, 'usb'),
    ).toEqual({ mode: 'cdc', vendorId: '05e0', productId: '1701', devicePath: '/dev/ttyACM0' });
  });
});

describe('withScannerSetup', () => {
  it('writes the form over the row, drops empty fields and keeps what the form does not edit', () => {
    expect(
      withScannerSetup(
        { mode: 'hid', suffix: 'enter', burstGapMs: 60, buttonKey: 'F9', devicePath: '/dev/input/event3' },
        { mode: 'cdc', vendorId: ' 05E0 ', productId: '', devicePath: '' },
      ),
    ).toEqual({ mode: 'cdc', vendorId: '05e0', suffix: 'enter', burstGapMs: 60, buttonKey: 'F9' });
  });
});

describe('scannerSetupProblem', () => {
  it('accepts empty ids and paths, and refuses an id that is not four hex digits or a path off /dev', () => {
    expect(scannerSetupProblem({ mode: 'hid', vendorId: '', productId: '', devicePath: '' })).toBeNull();
    expect(scannerSetupProblem({ mode: 'hid', vendorId: '05e', productId: '', devicePath: '' })).toMatch(/vendor id/);
    expect(scannerSetupProblem({ mode: 'hid', vendorId: '', productId: 'zz00', devicePath: '' })).toMatch(/product id/);
    expect(scannerSetupProblem({ mode: 'cdc', vendorId: '', productId: '', devicePath: 'ttyACM0' })).toMatch(/\/dev\//);
  });

  it('names the Zebra cradle’s ids as the defaults, and the transport each mode is reached over', () => {
    expect(scannerDefaultIds('hid')).toEqual({ vendorId: '05e0', productId: '1200' });
    expect(scannerDefaultIds('cdc')).toEqual({ vendorId: '05e0', productId: '1701' });
    expect(transportForScannerMode('hid')).toBe('usb');
    expect(transportForScannerMode('cdc')).toBe('serial');
  });
});

describe('scannerHealthOf and scannerHealthWords', () => {
  const lastStatus = (scanner: unknown) => ({
    devices: [
      { id: 'another', kind: 'receipt_printer', reachability: 'reachable' },
      { id: DEVICE, kind: 'scanner', reachability: 'reachable', ...(scanner === undefined ? {} : { scanner }) },
    ],
  });

  it('reads the block the heartbeat carried for this device', () => {
    const health = scannerHealthOf(
      lastStatus({
        mode: 'hid',
        present: true,
        open: true,
        path: '/dev/input/event4',
        lastScanAt: '2026-11-02T03:00:00.000Z',
        scans: 4,
        dropped: 1,
      }),
      DEVICE,
    );
    expect(health).toEqual({
      mode: 'hid',
      present: true,
      open: true,
      path: '/dev/input/event4',
      lastScanAt: '2026-11-02T03:00:00.000Z',
      scans: 4,
      dropped: 1,
    });
    expect(scannerHealthWords(health!)).toEqual({ words: 'Reading /dev/input/event4', tone: 'ok' });
  });

  it('says plugged in but not open, and not plugged in, in words', () => {
    const shut = scannerHealthOf(
      lastStatus({ mode: 'cdc', present: true, open: false, path: '/dev/ttyACM0', lastScanAt: null }),
      DEVICE,
    );
    expect(scannerHealthWords(shut!)).toEqual({ words: 'Plugged in at /dev/ttyACM0 but not open', tone: 'down' });
    const gone = scannerHealthOf(
      lastStatus({ mode: 'hid', present: false, open: false, path: null, lastScanAt: null }),
      DEVICE,
    );
    expect(scannerHealthWords(gone!)).toEqual({ words: 'Not plugged into this box', tone: 'down' });
  });

  it('is null for an older agent, a box that does not read the scanner, and a malformed block', () => {
    expect(scannerHealthOf(lastStatus(undefined), DEVICE)).toBeNull();
    expect(scannerHealthOf(lastStatus({ present: 'yes' }), DEVICE)).toBeNull();
    expect(scannerHealthOf(null, DEVICE)).toBeNull();
    expect(scannerHealthOf({ devices: 'none' }, DEVICE)).toBeNull();
  });
});
