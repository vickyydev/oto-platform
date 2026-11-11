import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StationDrawer } from '@/components/devices/StationDrawer';
import { STATION_DEVICE_ROLES, type DeviceRow, type StationRow } from '@/api/fleet';
import { deviceRoleWord, roleAccepts, rolesForStationKind } from '@/lib/fleetWords';
import { devicesRead } from '@/lib/deviceList';

/**
 * SCRUM-861 — the station form offers the drop-off band printer beside the
 * two band printers it always had, accepts only a band printer on it, and
 * shows a saved assignment back. A kiosk is not asked: it prints booked
 * passes, never a drop-off stay.
 */

vi.mock('@/lib/workingAuthority', () => ({ useWorkingAuthority: () => ({ isCurrent: () => true, run: (fn: () => unknown) => fn() }) }));
const noop = () => undefined;
const till: StationRow = { id: 'station', branchId: 'branch', boxId: 'box', name: 'ZZ TEST till', kind: 'till', codePrefix: 'T9', ready: true, reasons: [] };
const kidsPrinter: DeviceRow = { id: 'kids', boxId: 'box', kind: 'band_printer', label: 'ZZ TEST kids band printer', transport: 'simulated', protocol: 'tspl2' };
const dropoffPrinter: DeviceRow = { id: 'dropoff', boxId: 'box', kind: 'band_printer', label: 'ZZ TEST drop-off band printer', transport: 'simulated', protocol: 'tspl2' };
const receiptPrinter: DeviceRow = { id: 'receipt', boxId: 'box', kind: 'receipt_printer', label: 'ZZ TEST receipt printer', transport: 'simulated', protocol: 'escpos' };

const drawer = (row: StationRow, devices: DeviceRow[]) =>
  renderToStaticMarkup(createElement(StationDrawer, { station: row, branchId: 'branch', branchLabel: 'Park', boxes: [],
    deviceList: () => devicesRead(devices), onRetryDevices: noop, canEdit: true, onClose: noop, onSaved: noop }));

describe('the drop-off band printer role', () => {
  it('is a station device role, worded like the other two band printers, and takes a band printer only', () => {
    expect(STATION_DEVICE_ROLES).toContain('dropoff_band');
    expect(deviceRoleWord('dropoff_band')).toBe('Drop-off band printer');
    expect(roleAccepts('dropoff_band', 'band_printer')).toBe(true);
    expect(roleAccepts('dropoff_band', 'receipt_printer')).toBe(false);
    expect(roleAccepts('dropoff_band', 'kitchen_printer')).toBe(false);
  });

  it('is asked of a till right after the adult band printer, and never of a kiosk, gate, booth or display', () => {
    const roles = rolesForStationKind('till');
    expect(roles.indexOf('dropoff_band')).toBe(roles.indexOf('adult_band') + 1);
    for (const kind of ['kiosk', 'gate', 'booth', 'display']) {
      expect(rolesForStationKind(kind)).not.toContain('dropoff_band');
    }
  });

  it('shows the field on a till with the box’s band printers to choose from, and no receipt printer among them', () => {
    const html = drawer(till, [kidsPrinter, dropoffPrinter, receiptPrinter]);
    expect(html).toContain('Drop-off band printer');
    const field = html.slice(html.indexOf('Drop-off band printer'));
    const select = field.slice(0, field.indexOf('</select>'));
    expect(select).toContain('value="dropoff"');
    expect(select).toContain('value="kids"');
    expect(select).not.toContain('value="receipt"');
  });

  it('shows a saved drop-off band printer as the chosen one', () => {
    const html = drawer(
      { ...till, devices: [
        { role: 'kids_band', deviceId: kidsPrinter.id, label: kidsPrinter.label, kind: 'band_printer', transport: 'simulated' },
        { role: 'dropoff_band', deviceId: dropoffPrinter.id, label: dropoffPrinter.label, kind: 'band_printer', transport: 'simulated' },
      ] },
      [kidsPrinter, dropoffPrinter],
    );
    const field = html.slice(html.indexOf('Drop-off band printer'));
    const select = field.slice(0, field.indexOf('</select>'));
    expect(select).toMatch(/<option[^>]*value="dropoff"[^>]*selected/);
    expect(select).not.toMatch(/<option[^>]*value="kids"[^>]*selected/);
  });
});
