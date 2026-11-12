import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AddDeviceForm, DeviceRowItem } from '@/components/devices/BoxDrawer';
import type { DeviceRow } from '@/api/fleet';
import { ADDRESS_PLACEHOLDER, NOT_SET_UP, deviceDotTone } from '@/lib/printerAddress';

/**
 * SCRUM-932 — SMALL POINTS FROM THE CONSOLE'S DEVICE FORMS (staging proof of
 * SCRUM-898 to 900, pictures 03a and 03e).
 *
 *  (c) The Add a device form's grey Address placeholder read
 *      "192.168.88.204:9100" — the real address of the park's kids band
 *      printer — and looked like a value already filled in. It is an address
 *      nobody has (TEST-NET-1) and it says it is an example.
 *  (d) A printer with no address (the seeded one at Robinson Chalong) showed a
 *      green dot and "paper ok" beside "No address, so nothing prints on it".
 *      A printer that can never be sent a job is not healthy: it is drawn as
 *      not set up, in the "down" tone its line is already written in.
 */

vi.mock('@/lib/workingAuthority', () => ({
  useWorkingAuthority: () => ({ isCurrent: () => true, run: (fn: () => unknown) => fn() }),
}));
const noop = () => undefined;

const printer = (over: Partial<DeviceRow> = {}): DeviceRow => ({
  id: 'printer', boxId: 'box', kind: 'receipt_printer', label: 'ZZ TEST receipt printer', transport: 'simulated',
  address: '192.0.2.21:9100', protocol: 'escpos', reachability: 'reachable', paperStatus: 'ok', ...over,
});

const row = (device: DeviceRow) =>
  renderToStaticMarkup(createElement(DeviceRowItem, { device, scannerHealth: null, canUpdate: true, onChanged: noop }));

describe('(c) the Add a device form’s example address', () => {
  it('is an address nobody has, and the placeholder says it is an example', () => {
    expect(ADDRESS_PLACEHOLDER).toBe('e.g. 192.0.2.10:9100');
    const html = renderToStaticMarkup(createElement(AddDeviceForm, { boxId: 'box', onClose: noop, onAdded: noop }));
    expect(html).toContain('placeholder="e.g. 192.0.2.10:9100"');
    expect(html).not.toContain('192.168.88.204');
    // The hint under it gives the same example.
    expect(html).toContain('for example 192.0.2.10:9100 for a printer on the park network');
  });
});

describe('(d) a printer with no address in the box’s device list', () => {
  it('is drawn as not set up — the failing mark and "not set up" — never a healthy dot and "paper ok"', () => {
    const bare = printer({ address: null, label: 'Receipt Printer 1' });
    expect(deviceDotTone(bare)).toBe('down');
    const html = row(bare);
    expect(html).toContain(`>${NOT_SET_UP}</span>`);
    expect(html).not.toContain('paper ok');
    expect(html).not.toContain('aria-label="Healthy"');
    expect(html).toContain('aria-label="Failing"');
    expect(html).toContain('No address, so nothing prints on it.');
  });

  it('a printer with an address keeps its own dot and its paper as before', () => {
    const html = row(printer());
    expect(deviceDotTone(printer())).toBe('ok');
    expect(html).toContain('aria-label="Healthy"');
    expect(html).toContain('paper ok');
    expect(html).not.toContain(NOT_SET_UP);
    expect(deviceDotTone(printer({ reachability: 'unreachable' }))).toBe('down');
    expect(deviceDotTone(printer({ reachability: 'unknown' }))).toBe('idle');
  });

  it('a device that is not a printer is never "not set up" for want of an address', () => {
    const scanner = printer({ kind: 'scanner', label: 'ZZ TEST scanner', address: null, paperStatus: 'unknown' });
    expect(deviceDotTone(scanner)).toBe('ok');
    expect(row(scanner)).not.toContain(NOT_SET_UP);
  });
});
