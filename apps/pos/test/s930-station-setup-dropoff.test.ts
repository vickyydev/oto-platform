import * as React from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from './support/hooks';
import { ApiError } from '@/api/client';
import type { ApiDevice, ApiStation } from '@/api/platform';
import { toStationProfile } from '@/station/fleet';
import type { StationCapability } from '@/types';

/**
 * SCRUM-930 — THE TILL'S STATION SETTINGS SHOW THE DROP-OFF BRACELET PRINTER.
 *
 * Seen on staging (SCRUM-898 proof, picture 02c2): the Console's station form
 * has a drop-off band printer (SCRUM-861), the till's own Station settings had
 * no card for it, and a manager at the till could neither see nor change it.
 * The card now sits beside the adult bracelet printer and reads and saves the
 * same `dropoff_band` assignment, with the same choices (the band printers on
 * the station's box) and the same "Not set".
 *
 * The settings now open on the station as the platform holds it (the record
 * read for "who may use it"), not on the copy this till took at its pick, and
 * a save names the config version they came from, so SCRUM-898's refusal of
 * a form that fell behind holds for the till as it does for the Console.
 *
 * The editor runs with its own hooks (`support/hooks`) and is read as the
 * element tree it returns; its cards and buttons are pressed through their
 * own handlers. The platform is stood in for at `stationsApi`.
 */

const seam = vi.hoisted(() => ({
  active: null as ApiStation | null,
  record: null as ApiStation | null,
  devices: [] as ApiDevice[],
  get: vi.fn(),
  update: vi.fn(),
  pick: vi.fn(async () => undefined),
  reload: vi.fn(async () => undefined),
  navigate: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('react', async () => ({ ...(await vi.importActual<typeof import('react')>('react')), ...(await import('./support/hooks')) }));
vi.mock('wouter', () => ({ useLocation: () => ['/station-setup/settings', seam.navigate] }));
vi.mock('@/hooks/use-mobile', () => ({ useIsMobile: () => false }));
vi.mock('@/hooks/use-toast', () => ({ toast: seam.toast }));
vi.mock('@/auth/OperatorContext', () => ({ useOperator: () => ({ can: () => true }) }));
vi.mock('@/branch/BranchContext', () => ({
  useBranch: () => ({ branch: { id: 'park', apiId: 'branch-api', name: 'ZZ TEST park' } }),
}));
vi.mock('@/station/StationContext', () => ({
  useStation: () => ({
    station: seam.active ? toStationProfile(seam.active, 'park') : null,
    active: seam.active,
    fleetAvailable: true,
    pick: seam.pick,
    setStation: vi.fn(),
    reload: seam.reload,
  }),
}));
vi.mock('@/api/platform', async (original) => ({
  ...(await original<typeof import('@/api/platform')>()),
  stationsApi: {
    boxes: async () => ({ boxes: [{ id: 'box', name: 'ZZ TEST box', branchId: 'branch-api' }] }),
    boxDevices: async () => ({ devices: seam.devices }),
    get: seam.get,
    update: seam.update,
    testPrint: vi.fn(),
    staffCandidates: async () => ({ staff: [] }),
  },
}));

const printer = (id: string, kind: string, label: string): ApiDevice =>
  ({ id, boxId: 'box', kind, label, transport: 'simulated', address: `192.0.2.${id.length}:9100`, archived: false }) as ApiDevice;
const RECEIPT = printer('receipt', 'receipt_printer', 'ZZ TEST receipt printer');
const KIDS = printer('kids', 'band_printer', 'ZZ TEST kids band printer');
const ADULT = printer('adult', 'band_printer', 'ZZ TEST adult band printer');
const DROPOFF = printer('dropoff', 'band_printer', 'ZZ TEST drop-off band printer');
const KITCHEN = printer('kitchen', 'kitchen_printer', 'ZZ TEST kitchen printer');

const assigned = (role: string, d: ApiDevice) => ({ role, deviceId: d.id, label: d.label, kind: d.kind, transport: d.transport, address: d.address });

/** The till as this iPad took it: three printers, a card terminal the screen has no slot for, config v3. */
const TAKEN: ApiStation = {
  id: 'till', branchId: 'branch-api', boxId: 'box', boxName: 'ZZ TEST box', name: 'ZZ TEST Reception Till 1', kind: 'till',
  capabilities: [], accessScope: 'all_staff', configVersion: 3,
  devices: [assigned('receipt', RECEIPT), assigned('kids_band', KIDS), assigned('adult_band', ADULT), { role: 'card_terminal', deviceId: 'edc' }],
};
/** The same till after the Console gave it the drop-off band printer: v4. */
const CONSOLE_SAVED: ApiStation = { ...TAKEN, configVersion: 4, devices: [...TAKEN.devices!, assigned('dropoff_band', DROPOFF)] };

type Node = React.ReactElement<Record<string, unknown>>;
function nodes(tree: React.ReactNode): Node[] {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!React.isValidElement<Record<string, unknown>>(tree)) return [];
  return [tree, ...nodes(tree.props.children as React.ReactNode)];
}
function words(tree: React.ReactNode): string {
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(words).join(' ');
  return React.isValidElement<{ children?: React.ReactNode }>(tree) ? words(tree.props.children) : '';
}

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

// The page's module draws its capability icons as it loads, with the classic
// JSX runtime the tests compile to, so React is put in place before it is read.
let StationEditor: typeof import('@/pages/StationSetup').StationEditor;
let filledVersion: typeof import('@/pages/StationSetup').filledVersion;
beforeAll(async () => {
  vi.stubGlobal('React', React);
  ({ StationEditor, filledVersion } = await import('@/pages/StationSetup'));
});
afterAll(() => {
  vi.unstubAllGlobals();
});

async function open(record: ApiStation | null = CONSOLE_SAVED) {
  seam.record = record;
  const view = renderHook(() => StationEditor({ wizard: false }));
  await settle();
  return view;
}

const cardTitles = (tree: React.ReactNode): string[] =>
  nodes(tree)
    .map((n) => n.props.title)
    .filter((t): t is string => typeof t === 'string' && t.endsWith('printer'));

function card(tree: React.ReactNode, title: string) {
  const found = nodes(tree).find((n) => n.props.title === title);
  if (!found) throw new Error(`no "${title}" card on the screen`);
  return found.props as {
    selectedId?: string;
    devices: Array<{ id: string; label: string }>;
    note?: string;
    onSelect: (id: string) => void;
    onClear: () => void;
  };
}

async function pressSave(tree: React.ReactNode) {
  const button = nodes(tree).find((n) => typeof n.props.onClick === 'function' && words(n.props.children as React.ReactNode).includes('Save changes'));
  if (!button) throw new Error('no Save changes button');
  (button.props.onClick as () => void)();
  await settle();
}

const sent = () => seam.update.mock.calls[0]?.[1] as { devices: Array<{ role: string; deviceId: string }>; expectedConfigVersion?: number };

beforeEach(() => {
  vi.stubGlobal('React', React);
  seam.active = TAKEN;
  seam.devices = [RECEIPT, KIDS, ADULT, DROPOFF, KITCHEN];
  seam.get.mockReset().mockImplementation(async () => {
    if (!seam.record) throw new ApiError(503, 'UNAVAILABLE', 'The platform did not answer');
    return { station: seam.record };
  });
  seam.update.mockReset().mockImplementation(async (_id: string, body: unknown) => ({ station: { ...CONSOLE_SAVED, ...(body as object) } }));
  seam.pick.mockClear();
  seam.reload.mockClear();
  seam.navigate.mockReset();
  seam.toast.mockReset();
});

describe('SCRUM-930 — the drop-off bracelet printer card', () => {
  it('sits beside the adult bracelet printer, in the order the Console asks, and offers the band printers on the box', async () => {
    const view = await open();
    expect(cardTitles(view.result.current)).toEqual([
      'Receipt printer',
      'Kids bracelet printer',
      'Adult bracelet printer',
      'Drop-off bracelet printer',
      'Kitchen printer',
      'Bar printer',
    ]);
    const dropoff = card(view.result.current, 'Drop-off bracelet printer');
    // The same choices as the kids and adult cards: every band printer on this box, nothing else.
    expect(dropoff.devices.map((d) => d.id)).toEqual(['kids', 'adult', 'dropoff']);
    expect(card(view.result.current, 'Adult bracelet printer').devices.map((d) => d.id)).toEqual(['kids', 'adult', 'dropoff']);
    expect(dropoff.note).toBe('Optional — leave unset to print drop-off bracelets on the kids bracelet printer.');
    view.unmount();
  });

  it('shows the printer the Console assigned since this till took the station, and saves it back with the version it read', async () => {
    const view = await open();
    expect(seam.get).toHaveBeenCalledWith('till');
    expect(card(view.result.current, 'Drop-off bracelet printer').selectedId).toBe('dropoff');
    await pressSave(view.result.current);
    expect(seam.update).toHaveBeenCalledTimes(1);
    expect(sent().expectedConfigVersion).toBe(4);
    expect(sent().devices).toContainEqual({ role: 'dropoff_band', deviceId: 'dropoff' });
    // A role the screen has no slot for is still sent back as the station holds it.
    expect(sent().devices).toContainEqual({ role: 'card_terminal', deviceId: 'edc' });
    expect(sent().devices.filter((d) => d.role === 'dropoff_band')).toHaveLength(1);
    view.unmount();
  });

  it('is "Not set" when nothing is assigned; choosing one saves it; clearing it sends no drop-off role at all', async () => {
    const view = await open(TAKEN);
    expect(card(view.result.current, 'Drop-off bracelet printer').selectedId).toBeUndefined();
    card(view.result.current, 'Drop-off bracelet printer').onSelect('dropoff');
    expect(card(view.result.current, 'Drop-off bracelet printer').selectedId).toBe('dropoff');
    await pressSave(view.result.current);
    expect(sent().devices).toContainEqual({ role: 'dropoff_band', deviceId: 'dropoff' });
    expect(sent().expectedConfigVersion).toBe(3);

    seam.update.mockClear();
    const again = await open(CONSOLE_SAVED);
    card(again.result.current, 'Drop-off bracelet printer').onClear();
    await pressSave(again.result.current);
    expect(sent().devices.some((d) => d.role === 'dropoff_band')).toBe(false);
    expect(sent().devices).toContainEqual({ role: 'kids_band', deviceId: 'kids' });
    expect(sent().devices).toContainEqual({ role: 'card_terminal', deviceId: 'edc' });
    view.unmount();
    again.unmount();
  });

  it('follows the capabilities as the kids card does: a ticket till and a drop-off till have it, an F&B-only till does not', async () => {
    const shown = async (capabilities: StationCapability[]) => {
      const view = await open({ ...CONSOLE_SAVED, capabilities });
      const titles = cardTitles(view.result.current);
      view.unmount();
      return titles.includes('Drop-off bracelet printer');
    };
    expect(await shown(['tickets'])).toBe(true);
    expect(await shown(['dropoff'])).toBe(true);
    expect(await shown(['fnb'])).toBe(false);
    expect(await shown(['parties'])).toBe(false);
    expect(await shown([])).toBe(true);
  });
});

describe('SCRUM-930 — the stale-save refusal of SCRUM-898 holds for the till', () => {
  it('a change made before the record lands keeps what the person chose, and the save names the version it was filled from', async () => {
    seam.record = CONSOLE_SAVED;
    let answer!: (value: { station: ApiStation }) => void;
    seam.get.mockReset().mockImplementation(() => new Promise((resolve) => { answer = resolve; }));
    const view = renderHook(() => StationEditor({ wizard: false }));
    await settle();
    card(view.result.current, 'Kids bracelet printer').onSelect('adult');
    answer({ station: CONSOLE_SAVED });
    await settle();
    // Not refilled under the person: their kids choice stands, the drop-off printer they never saw is not claimed.
    expect(card(view.result.current, 'Kids bracelet printer').selectedId).toBe('adult');
    expect(card(view.result.current, 'Drop-off bracelet printer').selectedId).toBeUndefined();
    seam.update.mockRejectedValueOnce(
      new ApiError(409, 'STATION_CHANGED', 'This station was changed since you opened it. Close it and open it again.'),
    );
    await pressSave(view.result.current);
    expect(sent().expectedConfigVersion).toBe(3);
    // Refused, and said in the platform's words; nothing navigates away as if it saved.
    expect(seam.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: "Couldn't save the station",
      description: 'This station was changed since you opened it. Close it and open it again.',
      variant: 'destructive',
    }));
    expect(seam.navigate).not.toHaveBeenCalled();
    expect(seam.pick).not.toHaveBeenCalled();
    view.unmount();
  });

  it('when the record cannot be read, the settings stay as this till took them and the save names that version', async () => {
    const view = await open(null);
    expect(card(view.result.current, 'Drop-off bracelet printer').selectedId).toBeUndefined();
    await pressSave(view.result.current);
    expect(sent().expectedConfigVersion).toBe(3);
    // "Who may use it" was never read, so it is left out of the save, as before.
    expect(sent()).not.toHaveProperty('accessScope');
    view.unmount();
  });

  it('a station from an api with no config version sends none', () => {
    expect(filledVersion({ configVersion: 7 })).toBe(7);
    expect(filledVersion({ configVersion: null })).toBeNull();
    expect(filledVersion({ configVersion: 0 })).toBeNull();
    expect(filledVersion({ configVersion: 1.5 })).toBeNull();
    expect(filledVersion(null)).toBeNull();
  });
});
