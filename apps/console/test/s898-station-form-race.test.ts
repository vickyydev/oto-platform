import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { StationDrawer } from '@/components/devices/StationDrawer';
import { ApiError } from '@/api/client';
import type { DeviceRow, StationRow } from '@/api/fleet';
import { devicesRead } from '@/lib/deviceList';
import {
  expectedVersion,
  newerStations,
  refillsFrom,
  stationChangedWords,
  stationSaveRefusal,
  withSavedStation,
} from '@/lib/stationForm';

/**
 * SCRUM-898 — THE STATION FORM IS NEVER OPENED FROM SETTINGS OLDER THAN THE
 * LAST SAVE.
 *
 * The race, as the SCRUM-861 staging proof caught it: a till saved in
 * Devices > Stations (v1 → v2, the drop-off band printer set), the drawer
 * closed and the list re-read started, the same card pressed before that read
 * came back — and the form showed config v1 with the drop-off band printer
 * "Not set", ready to save v1 back. These cases drive the page's own rules:
 * the save's answer held by the list at once, a late read never taking a row
 * back, an untouched form refilled from a newer reading and a touched one
 * kept, and the api's refusal of an older form put in the owner's words.
 */

vi.mock('@/lib/workingAuthority', () => ({
  useWorkingAuthority: () => ({ isCurrent: () => true, run: (fn: () => unknown) => fn() }),
}));

const noop = () => undefined;
const kids: DeviceRow = { id: 'kids', boxId: 'box', kind: 'band_printer', label: 'ZZ TEST kids band printer', transport: 'simulated', address: '192.168.88.204:9100', protocol: 'tspl2' };
const dropoff: DeviceRow = { id: 'dropoff', boxId: 'box', kind: 'band_printer', label: 'ZZ TEST drop-off band printer', transport: 'simulated', address: '192.168.88.212:9100', protocol: 'tspl2' };
const assigned = (role: string, d: DeviceRow) => ({ role, deviceId: d.id, label: d.label, kind: d.kind, transport: d.transport, address: d.address ?? null });

/** Reception Till 1 as the list read it before the save: v1, no drop-off band printer. */
const v1: StationRow = {
  id: 'till', branchId: 'branch', boxId: 'box', name: 'ZZ TEST Reception Till 1', kind: 'till', codePrefix: 'T9',
  ready: true, reasons: [], configVersion: 1, devices: [assigned('kids_band', kids)],
  screen: { state: 'online', lastSeenAt: '2026-11-12T05:00:00.000Z' },
};
/** The save's answer: v2, the drop-off band printer set. A write's answer carries no till screen. */
const v2: StationRow = { ...v1, configVersion: 2, devices: [assigned('kids_band', kids), assigned('dropoff_band', dropoff)], screen: null };
const otherTill: StationRow = { ...v1, id: 'other', name: 'ZZ TEST Till 2', configVersion: 4, devices: [] };

const drawer = (row: StationRow | null) =>
  renderToStaticMarkup(createElement(StationDrawer, {
    station: row, branchId: 'branch', branchLabel: 'Park', boxes: [],
    deviceList: () => devicesRead([kids, dropoff]), onRetryDevices: noop, canEdit: true, onClose: noop, onSaved: noop,
  }));

/** The drop-off band printer's select, as the drawer drew it. */
const dropoffField = (html: string) => {
  const field = html.slice(html.indexOf('Drop-off band printer'));
  return field.slice(0, field.indexOf('</select>'));
};

/** The row the page hands the drawer for a card: the list's own copy (Devices.tsx). */
const opened = (list: StationRow[], card: StationRow) => list.find((s) => s.id === card.id) ?? card;

describe('the race: save, close, press the card again before the list is read again', () => {
  it('without the save held, the card opens the form on v1 with the drop-off band printer "Not set" — the defect', () => {
    const html = drawer(v1);
    expect(html).toContain('config v1');
    expect(dropoffField(html)).not.toMatch(/<option[^>]*value="dropoff"[^>]*selected/);
  });

  it('with the save’s answer held by the list at once, the same press opens v2 with the drop-off band printer chosen', () => {
    const list = withSavedStation([v1, otherTill], v2);
    const html = drawer(opened(list, v1));
    expect(html).toContain('config v2');
    expect(dropoffField(html)).toMatch(/<option[^>]*value="dropoff"[^>]*selected/);
  });

  it('a read that left before the save and lands after it does not put v1 back', () => {
    const held = withSavedStation([v1, otherTill], v2);
    const late = newerStations(held, [v1, otherTill]);
    expect(opened(late, v1).configVersion).toBe(2);
    expect(dropoffField(drawer(opened(late, v1)))).toMatch(/<option[^>]*value="dropoff"[^>]*selected/);
    // The read after the save brings v2 itself, with the till screen again.
    const fresh = newerStations(late, [{ ...v2, screen: v1.screen }, otherTill]);
    expect(opened(fresh, v1)).toMatchObject({ configVersion: 2, screen: v1.screen });
  });
});

describe('the list holds a save at once', () => {
  it('in place of the row it replaces, keeping the till screen the answer does not carry', () => {
    const list = withSavedStation([v1, otherTill], v2);
    expect(list.map((s) => s.id)).toEqual(['till', 'other']);
    expect(list[0]).toMatchObject({ configVersion: 2, devices: v2.devices, screen: v1.screen });
    expect(list[1]).toBe(otherTill);
  });

  it('a new station is added; an archived one is held as archived', () => {
    const made: StationRow = { ...otherTill, id: 'new', name: 'ZZ TEST new till', configVersion: 1 };
    expect(withSavedStation([v1], made).map((s) => s.id)).toEqual(['till', 'new']);
    expect(withSavedStation([v1], { ...v1, archived: true })[0]?.archived).toBe(true);
  });
});

describe('a read of the list', () => {
  it('decides which stations there are, and takes a row at the same or a newer version', () => {
    const held = [v2, otherTill];
    expect(newerStations(held, [v1])).toEqual([v2]);
    const v3 = { ...v2, configVersion: 3, name: 'ZZ TEST renamed' };
    expect(newerStations(held, [v3, otherTill])).toEqual([v3, otherTill]);
    // The same version read again is the read's: who may use it is not in the version.
    const sameVersion = { ...v2, staff: [{ accountId: 'a1', name: 'Som' }] };
    expect(newerStations(held, [sameVersion])[0]).toBe(sameVersion);
    // An api older than the version field: nothing to compare, the read stands.
    const unversioned = { ...v1, configVersion: undefined };
    expect(newerStations(held, [unversioned])[0]).toBe(unversioned);
  });
});

describe('an open form and a newer reading of its station', () => {
  it('refills only while untouched, only from the same station, never from an older version', () => {
    expect(refillsFrom(v1, v2, false)).toBe(true);
    expect(refillsFrom(v1, v2, true)).toBe(false);
    expect(refillsFrom(v2, v1, false)).toBe(false);
    expect(refillsFrom(v2, v2, false)).toBe(false);
    expect(refillsFrom(v1, otherTill, false)).toBe(false);
    expect(refillsFrom(null, v2, false)).toBe(false);
    expect(refillsFrom(v2, { ...v2 }, false)).toBe(true);
  });

  it('a save names the version the form was filled from, and none when the row never carried one', () => {
    expect(expectedVersion(v1)).toBe(1);
    expect(expectedVersion(v2)).toBe(2);
    expect(expectedVersion({ ...v1, configVersion: undefined })).toBeNull();
    expect(expectedVersion({ ...v1, configVersion: null })).toBeNull();
    expect(expectedVersion(null)).toBeNull();
  });
});

describe('the api’s refusal of an older form', () => {
  it('is said in the owner’s words, the form kept open with them', () => {
    const refused = new ApiError(409, 'STATION_CHANGED', 'This station was changed since you opened it. Close it and open it again.');
    expect(stationSaveRefusal(refused, 'till', 'The station could not be saved')).toBe(
      'This till was changed since you opened it. Close it and open it again.',
    );
    expect(stationChangedWords('booth')).toBe('This booth was changed since you opened it. Close it and open it again.');
  });

  it('leaves every other refusal in the api’s own words', () => {
    const taken = new ApiError(409, 'BOOTH_CODE_PREFIX_TAKEN', 'Booth 1 already starts its codes with B1');
    expect(stationSaveRefusal(taken, 'booth', 'The station could not be saved')).toBe('Booth 1 already starts its codes with B1');
    expect(stationSaveRefusal('nothing useful', 'till', 'The station could not be saved')).toBe('The station could not be saved');
  });
});
