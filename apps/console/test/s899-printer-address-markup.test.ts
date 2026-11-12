import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AddDeviceForm, DeviceRowItem, EditDeviceForm } from '@/components/devices/BoxDrawer';
import { StationDrawer } from '@/components/devices/StationDrawer';
import type { DeviceRow, StationRow } from '@/api/fleet';
import { devicesRead } from '@/lib/deviceList';
import { NO_ADDRESS_LINE, editedDeviceAddress, newDeviceAddress, printerWithoutAddress } from '@/lib/printerAddress';

/**
 * SCRUM-899 — THE CONSOLE ASKS FOR A PRINTER'S ADDRESS: before a new printer
 * can be added, and before a printer without one can be given a job at a
 * till. A printer saved without one before this rule still renames and
 * archives, and the box's device list says plainly that nothing prints on it
 * instead of the box's bare `DEVICE_NO_ADDRESS`.
 */

vi.mock('@/lib/workingAuthority', () => ({
  useWorkingAuthority: () => ({ isCurrent: () => true, run: (fn: () => unknown) => fn() }),
}));
const noop = () => undefined;

const printer = (over: Partial<DeviceRow> = {}): DeviceRow => ({
  id: 'printer', boxId: 'box', kind: 'band_printer', label: 'ZZ TEST drop-off band printer', transport: 'simulated',
  address: '192.168.88.212:9100', protocol: 'tspl2', ...over,
});

/** The button with this text, as the markup drew it. */
const button = (html: string, text: string) => html.match(new RegExp(`<button[^>]*>(?:(?!</button>).)*${text}</button>`))?.[0];
const isDisabled = (tag: string | undefined) => {
  if (!tag) throw new Error('that button is not on the form');
  return /\sdisabled(?:=|\s|>)/.test(tag);
};

describe('the rule the forms draw from', () => {
  it('a new printer is held back until it has an address the box can open; any other device is not', () => {
    expect(newDeviceAddress('receipt_printer', '')).toMatchObject({ blocks: true, tone: 'down' });
    expect(newDeviceAddress('receipt_printer', '')).toHaveProperty('hint', expect.stringContaining('Required for a printer'));
    expect(newDeviceAddress('band_printer', '/dev/usb/lp0')).toMatchObject({ blocks: true, tone: 'down' });
    expect(newDeviceAddress('band_printer', '127.0.0.1:9100')).toMatchObject({ blocks: false, tone: 'plain' });
    expect(newDeviceAddress('scanner', '')).toEqual({ hint: '192.168.88.204:9100, or /dev/ttyACM0.', tone: 'plain', blocks: false });
    expect(newDeviceAddress('terminal', '/dev/ttyACM0')).toMatchObject({ blocks: false });
  });

  it('an edit is judged only when the address changes: cleared or unreadable is held back, none at all still saves', () => {
    const addressed = printer();
    expect(editedDeviceAddress(addressed, '192.168.88.212:9100')).toMatchObject({ blocks: false });
    expect(editedDeviceAddress(addressed, '')).toMatchObject({ blocks: true, tone: 'down' });
    expect(editedDeviceAddress(addressed, 'printer one')).toMatchObject({ blocks: true, tone: 'down' });
    expect(editedDeviceAddress(addressed, '192.168.88.214:9100')).toMatchObject({ blocks: false });
    const bare = printer({ address: null });
    expect(editedDeviceAddress(bare, '')).toMatchObject({ blocks: false, tone: 'warn' });
    expect(editedDeviceAddress(bare, '')).toHaveProperty('hint', expect.stringContaining('No address yet, so nothing prints on it.'));
    expect(editedDeviceAddress(bare, '192.168.88.214:9100')).toMatchObject({ blocks: false });
    expect(editedDeviceAddress({ kind: 'scanner', address: null }, '')).toEqual({ hint: '', tone: 'plain', blocks: false });
  });

  it('a printer without an address is the one not to give a job', () => {
    expect(printerWithoutAddress(printer({ address: null }))).toBe(true);
    expect(printerWithoutAddress(printer({ address: '  ' }))).toBe(true);
    expect(printerWithoutAddress(printer())).toBe(false);
    expect(printerWithoutAddress({ kind: 'scanner', address: null })).toBe(false);
  });
});

describe('Add a device', () => {
  it('opens on a receipt printer asking for its address, with "Add it" held back', () => {
    const html = renderToStaticMarkup(createElement(AddDeviceForm, { boxId: 'box', onClose: noop, onAdded: noop }));
    expect(html).toContain('Required for a printer.');
    expect(html).toContain('127.0.0.1:9100 for a USB printer on the box');
    expect(isDisabled(button(html, 'Add it'))).toBe(true);
  });
});

describe('Edit a device', () => {
  it('a printer saved without an address still saves a new name, and is told nothing prints on it', () => {
    const html = renderToStaticMarkup(createElement(EditDeviceForm, { device: printer({ address: null }), onClose: noop, onSaved: noop }));
    expect(html).toContain('No address yet, so nothing prints on it.');
    expect(isDisabled(button(html, 'Save'))).toBe(false);
    expect(isDisabled(button(html, 'Archive it'))).toBe(false);
  });

  it('a printer with an address saves as before', () => {
    const html = renderToStaticMarkup(createElement(EditDeviceForm, { device: printer(), onClose: noop, onSaved: noop }));
    expect(html).not.toContain('No address yet');
    expect(isDisabled(button(html, 'Save'))).toBe(false);
  });
});

describe('the box’s device list', () => {
  it('says plainly that a printer without an address prints nothing, instead of DEVICE_NO_ADDRESS', () => {
    const html = renderToStaticMarkup(createElement(DeviceRowItem, {
      device: printer({ address: null, lastError: 'DEVICE_NO_ADDRESS' }), scannerHealth: null, canUpdate: true, onChanged: noop,
    }));
    expect(html).toContain(NO_ADDRESS_LINE.replace(/'/g, '&#x27;'));
    expect(html).not.toContain('DEVICE_NO_ADDRESS');
  });

  it('leaves a printer with an address, and any other fault, as they were', () => {
    const html = renderToStaticMarkup(createElement(DeviceRowItem, {
      device: printer({ lastError: 'PRINTER_PAPER_OUT' }), scannerHealth: null, canUpdate: true, onChanged: noop,
    }));
    expect(html).not.toContain('No address');
    expect(html).toContain('PRINTER_PAPER_OUT');
    const scanner = renderToStaticMarkup(createElement(DeviceRowItem, {
      device: { ...printer({ address: null }), kind: 'scanner', label: 'ZZ TEST scanner' }, scannerHealth: null, canUpdate: true, onChanged: noop,
    }));
    expect(scanner).not.toContain('No address');
  });
});

describe('the station drawer', () => {
  const till: StationRow = { id: 'till', branchId: 'branch', boxId: 'box', name: 'ZZ TEST till', kind: 'till', codePrefix: 'T9', ready: true, reasons: [], configVersion: 3 };
  const kids = printer({ id: 'kids', label: 'ZZ TEST kids band printer', address: '192.168.88.204:9100' });
  const bare = printer({ id: 'bare', label: 'ZZ TEST unaddressed band printer', address: null });
  const drawer = (row: StationRow) =>
    renderToStaticMarkup(createElement(StationDrawer, {
      station: row, branchId: 'branch', branchLabel: 'Park', boxes: [], deviceList: () => devicesRead([kids, bare]),
      onRetryDevices: noop, canEdit: true, onClose: noop, onSaved: noop,
    }));
  const field = (html: string, label: string) => {
    const from = html.slice(html.indexOf(label));
    return from.slice(0, from.indexOf('</select>'));
  };

  it('offers a printer without an address greyed out, saying so, and asks for its address under the box', () => {
    const html = drawer(till);
    const select = field(html, 'Drop-off band printer');
    expect(select).toMatch(/<option[^>]*value="bare"[^>]*disabled[^>]*>ZZ TEST unaddressed band printer — Unusable: no address<\/option>/);
    expect(select).toMatch(/<option[^>]*value="kids"(?![^>]*disabled)[^>]*>ZZ TEST kids band printer — /);
    expect(html).toContain('ZZ TEST unaddressed band printer has no address, so nothing would print on it.');
  });

  it('still shows a saved assignment to one, so the till’s saved setup is not lost on the form', () => {
    const html = drawer({ ...till, devices: [{ role: 'dropoff_band', deviceId: 'bare', label: bare.label, kind: 'band_printer', transport: 'simulated', address: null }] });
    expect(field(html, 'Drop-off band printer')).toMatch(/<option[^>]*value="bare"[^>]*selected/);
  });
});
