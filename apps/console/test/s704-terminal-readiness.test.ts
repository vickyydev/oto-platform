import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StationDrawer } from '@/components/devices/StationDrawer';
import { TerminalProtocolField } from '@/components/devices/BoxDrawer';
import { StationCard } from '@/pages/Devices';
import type { DeviceRow, StationRow } from '@/api/fleet';
import { devicesRead } from '@/lib/deviceList';

vi.mock('@/lib/workingAuthority', () => ({ useWorkingAuthority: () => ({ isCurrent: () => true, run: (fn: () => unknown) => fn() }) }));
const noop = () => undefined;
const station: StationRow = { id: 'station', branchId: 'branch', boxId: 'box', name: 'ZZ TEST terminal draft', kind: 'till', codePrefix: 'T7',
  paymentRouting: { card: 'card_terminal', qr: 'none' }, ready: false, reasons: ['Card is routed to the terminal but no terminal is assigned'] };
const drawer = (row: StationRow, devices: DeviceRow[] = []) => renderToStaticMarkup(createElement(StationDrawer, { station: row,
  branchId: 'branch', branchLabel: 'Park', boxes: [], deviceList: () => devicesRead(devices), onRetryDevices: noop, canEdit: true, onClose: noop, onSaved: noop }));

describe('terminal setup guidance', () => {
  it('shows the same missing-terminal reason on the station card and drawer, while Save remains available', () => {
    const card = renderToStaticMarkup(createElement(StationCard, { station, branchLabel: 'Park', onOpen: noop }));
    const form = drawer(station);
    for (const html of [card, form]) expect(html).toContain(station.reasons![0]);
    const save = form.match(/<button[^>]*>Save the station<\/button>/)?.[0];
    expect(save).toBeDefined();
    expect(save).not.toMatch(/\sdisabled(?:=|\s|>)/);
  });
  it('shows a blank protocol as unusable, disables its assignment choice, and explains the current assignment', () => {
    const device: DeviceRow = { id: 'terminal', boxId: 'box', kind: 'terminal', label: 'ZZ TEST EDC', transport: 'simulated', protocol: null };
    const html = drawer({ ...station, devices: [{ role: 'card_terminal', deviceId: device.id, label: device.label, kind: 'terminal', transport: 'simulated' }] }, [device]);
    expect(html).toContain('The assigned terminal has no supported protocol');
    expect(html).toMatch(/<option[^>]*value="terminal"[^>]*disabled/);
    expect(html).toContain('Unusable: no supported protocol');
  });
  it('asks for a QR terminal when QR is left unset, with Save still available', () => {
    const device: DeviceRow = { id: 'terminal', boxId: 'box', kind: 'terminal', label: 'ZZ TEST EDC', transport: 'simulated', protocol: 'digio_tlv' };
    const html = drawer({ ...station, paymentRouting: { card: 'card_terminal' },
      devices: [{ role: 'card_terminal', deviceId: device.id, label: device.label, kind: 'terminal', transport: 'simulated' }] }, [device]);
    expect(html).toContain('Not ready for selling');
    expect(html).toContain('QR is routed to the terminal but no terminal is assigned');
    expect(html).not.toContain('Card is routed to the terminal but no terminal is assigned');
    expect(html.match(/<button[^>]*>Save the station<\/button>/)?.[0]).not.toMatch(/\sdisabled(?:=|\s|>)/);
  });
  it.each(['gateway', 'none'])('does not ask for a QR terminal with QR %s', (qr) => {
    const device: DeviceRow = { id: 'terminal', boxId: 'box', kind: 'terminal', label: 'ZZ TEST EDC', transport: 'simulated', protocol: 'digio_tlv' };
    const html = drawer({ ...station, paymentRouting: { card: 'card_terminal', qr },
      devices: [{ role: 'card_terminal', deviceId: device.id, label: device.label, kind: 'terminal', transport: 'simulated' }] }, [device]);
    expect(html).toContain('Ready for selling');
    expect(html).not.toContain('QR is routed to the terminal');
  });
  it('says a saved terminal this box does not list is on another box', () => {
    const html = drawer({ ...station, devices: [{ role: 'card_terminal', deviceId: 'elsewhere', label: 'ZZ TEST EDC', kind: 'terminal', transport: 'simulated' }] }, []);
    expect(html).toContain('The assigned terminal is on another box');
    expect(html).not.toContain('Card is routed to the terminal but no terminal is assigned');
  });
  it.each(['serial', 'simulated'])('offers only supported dialect choices for %s terminals', (transport) => {
    const html = renderToStaticMarkup(createElement(TerminalProtocolField, { value: 'unknown', onChange: noop, transport }));
    expect(html).toContain('<select');
    expect(html).not.toContain('<input');
    expect(html).toContain('value="ghl_linkpos"');
    expect(html).toContain('value="digio_tlv"');
    expect(html).toContain('Unusable: no supported protocol');
    if (transport === 'simulated') expect(html).toContain('Simulated GHL LinkPOS');
  });
});
