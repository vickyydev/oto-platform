import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fleetApi, type BoxRow, type DeviceRow, type StationRow } from '@/api/fleet';
import { EditDeviceForm } from '@/components/devices/BoxDrawer';
import { StationDrawer } from '@/components/devices/StationDrawer';
import { devicesRead } from '@/lib/deviceList';
import { deviceEdits, deviceEditFormOf, hasEdits } from '@/lib/deviceEdit';
import { stationUsesCodePrefix } from '@/lib/fleetWords';

/**
 * SCRUM-971 — two Console forms after the printers' second staging proof.
 *
 * Point 8 of the ticket: the device Edit form wrote a paper width or a band
 * stock nobody chose whenever a device was saved. In the proof, a simulated
 * receipt printer and a band printer with no settings had only their address
 * edited, and the request also carried `{"escpos":{"dotsPerLine":576}}` (step
 * 5, pictures 05b to 05g and 05z). A save now sends only what was changed,
 * and a settings section only when something in it was.
 *
 * Point 8 of the plan (picture 03b): a customer display's station form
 * offered a code prefix ("T1" in grey), though a display mints no code. A
 * station kind that issues no receipts, bands or vouchers is not asked for
 * one.
 *
 * No browser, as in `s898-station-drawer-save`: React's hooks are stood in for
 * by the small runner below, the forms are called as the functions they are,
 * and their fields and buttons are found in the element tree they return and
 * pressed through their own handlers.
 */

type Deps = readonly unknown[] | undefined;
type Slot = {
  value?: unknown;
  set?: (next: unknown) => void;
  deps?: Deps;
  ref?: { current: unknown };
  cleanup?: (() => void) | null;
};

const runner = vi.hoisted(() => {
  let slots: Slot[] = [];
  let cursor = 0;
  let pending: Array<() => void> = [];
  let rendering = false;
  let again = false;
  let body: () => void = () => undefined;
  const changed = (was: Deps, now: Deps) =>
    was === undefined || now === undefined || was.length !== now.length || was.some((v, i) => !Object.is(v, now[i]));
  const render = (): void => {
    if (rendering) {
      again = true;
      return;
    }
    rendering = true;
    try {
      do {
        again = false;
        cursor = 0;
        pending = [];
        body();
        const effects = pending;
        pending = [];
        for (const run of effects) run();
      } while (again);
    } finally {
      rendering = false;
    }
  };
  const slot = (): Slot => {
    const index = cursor++;
    slots[index] ??= {};
    return slots[index]!;
  };
  return {
    mount(next: () => void) {
      slots = [];
      body = next;
      render();
    },
    useState(initial: unknown) {
      const s = slot();
      if (!s.set) {
        s.value = typeof initial === 'function' ? (initial as () => unknown)() : initial;
        s.set = (next: unknown) => {
          const value = typeof next === 'function' ? (next as (was: unknown) => unknown)(s.value) : next;
          if (Object.is(value, s.value)) return;
          s.value = value;
          render();
        };
      }
      return [s.value, s.set];
    },
    useRef(initial: unknown) {
      const s = slot();
      s.ref ??= { current: initial };
      return s.ref;
    },
    useMemo(factory: () => unknown, deps: Deps) {
      const s = slot();
      if (!s.deps || changed(s.deps, deps)) {
        s.value = factory();
        s.deps = deps;
      }
      return s.value;
    },
    useCallback(callback: unknown, deps: Deps) {
      const s = slot();
      if (!s.deps || changed(s.deps, deps)) {
        s.value = callback;
        s.deps = deps;
      }
      return s.value;
    },
    useEffect(effect: () => void | (() => void), deps?: Deps) {
      const s = slot();
      if (s.deps !== undefined && deps !== undefined && !changed(s.deps, deps)) return;
      s.deps = deps;
      pending.push(() => {
        s.cleanup?.();
        const cleanup = effect();
        s.cleanup = typeof cleanup === 'function' ? cleanup : null;
      });
    },
  };
});

vi.mock('react', async (original) => {
  const react = await original<typeof import('react')>();
  return {
    ...react,
    useState: runner.useState,
    useRef: runner.useRef,
    useMemo: runner.useMemo,
    useCallback: runner.useCallback,
    useEffect: runner.useEffect,
  };
});
vi.mock('@/lib/workingAuthority', () => ({
  useWorkingAuthority: () => ({ isCurrent: () => true, run: (fn: () => unknown) => fn() }),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Reading the tree a form returned ---------------------------------------------

let tree: ReactElement;

function* walk(node: unknown): Generator<ReactElement<Record<string, unknown>>> {
  if (Array.isArray(node)) {
    for (const item of node) yield* walk(item);
    return;
  }
  if (!isValidElement(node)) return;
  const element = node as ReactElement<Record<string, unknown>>;
  yield element;
  for (const value of Object.values(element.props)) yield* walk(value);
}

const textOf = (node: unknown): string =>
  typeof node === 'string' || typeof node === 'number'
    ? String(node)
    : Array.isArray(node)
      ? node.map(textOf).join('')
      : isValidElement(node)
        ? textOf((node.props as { children?: ReactNode }).children)
        : '';

const find = (what: string, match: (props: Record<string, unknown>, element: ReactElement) => boolean) => {
  for (const element of walk(tree)) if (match(element.props, element)) return element.props;
  throw new Error(`${what} is not on the form`);
};
const has = (match: (props: Record<string, unknown>) => boolean) => {
  for (const element of walk(tree)) if (match(element.props)) return true;
  return false;
};
const named = (name: string) => (_: Record<string, unknown>, element: ReactElement) =>
  typeof element.type === 'function' && element.type.name === name;

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

// --- Point 8 of the ticket: the device Edit form ------------------------------------

/** As the proof found them: simulated, an address, no model on one, and NO settings. */
const receipt: DeviceRow = {
  id: 'receipt', boxId: 'box', kind: 'receipt_printer', label: 'ZZ TEST 952 no-model receipt printer',
  transport: 'simulated', address: '192.0.2.54:9100', model: null, protocol: 'escpos', settings: null,
};
const bandPrinter: DeviceRow = {
  id: 'band', boxId: 'box', kind: 'band_printer', label: 'ZZ TEST 952 band printer',
  transport: 'simulated', address: '192.0.2.53:9100', model: null, protocol: 'tspl2', settings: null,
};
const scanner: DeviceRow = {
  id: 'scanner', boxId: 'box', kind: 'scanner', label: 'ZZ TEST scanner', transport: 'usb', address: null, settings: null,
};

const onClose = vi.fn();
const onSaved = vi.fn();

function editing(device: DeviceRow) {
  onClose.mockReset();
  onSaved.mockReset();
  runner.mount(() => {
    tree = EditDeviceForm({ device, onClose, onSaved }) as ReactElement;
  });
}

const addressField = () => {
  const field = find('the Address field', (p) => p.label === 'Address');
  return (field.children as ReactElement<{ value: string; onChange: (next: string) => void }>).props;
};

async function pressSave() {
  const save = find('Save', (p) => typeof p.onClick === 'function' && textOf(p.children) === 'Save');
  (save.onClick as () => void)();
  await settle();
}

describe('SCRUM-971 — the device Edit form saves only what was changed', () => {
  for (const device of [receipt, bandPrinter]) {
    it(`${device.label} with no settings, only the address edited: the request holds the address alone`, async () => {
      const update = vi.spyOn(fleetApi, 'updateDevice').mockResolvedValue({ device });
      editing(device);
      addressField().onChange('192.0.2.55:9100');
      expect(addressField().value).toBe('192.0.2.55:9100');
      await pressSave();
      expect(update).toHaveBeenCalledTimes(1);
      expect(update.mock.calls[0]?.[0]).toBe(device.id);
      expect(update.mock.calls[0]?.[1]).toEqual({ address: '192.0.2.55:9100' });
      expect(onSaved).toHaveBeenCalledTimes(1);
    });
  }

  it('the form still SHOWS the box’s defaults for a row with none', () => {
    editing(receipt);
    expect(find('the paper width', named('PaperWidthField')).value).toBe(576);
    editing(bandPrinter);
    expect(find('the band stock', named('BandStockFields')).value).toMatchObject({ sensing: 'gap' });
  });

  it('an untouched form sends nothing and closes', async () => {
    const update = vi.spyOn(fleetApi, 'updateDevice').mockResolvedValue({ device: receipt });
    editing(receipt);
    await pressSave();
    expect(update).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('a paper width somebody chose is sent, over what else the row’s settings hold', async () => {
    const withCutter: DeviceRow = { ...receipt, settings: { escpos: { cut: 'partial' } } };
    const update = vi.spyOn(fleetApi, 'updateDevice').mockResolvedValue({ device: withCutter });
    editing(withCutter);
    (find('the paper width', named('PaperWidthField')).onChange as (next: number) => void)(512);
    await pressSave();
    expect(update.mock.calls[0]?.[1]).toEqual({ settings: { escpos: { cut: 'partial', dotsPerLine: 512 } } });
  });

  it('a band stock somebody changed is sent with the row’s own stock width', async () => {
    const parkStock: DeviceRow = { ...bandPrinter, settings: { label: { labelWidthMm: 25, labelHeightMm: 246 } } };
    const update = vi.spyOn(fleetApi, 'updateDevice').mockResolvedValue({ device: parkStock });
    editing(parkStock);
    const stock = find('the band stock', named('BandStockFields'));
    (stock.onChange as (next: unknown) => void)({ ...(stock.value as object), sensing: 'bline', printOffsetMm: 50, printLengthMm: 80 });
    await pressSave();
    expect(update.mock.calls[0]?.[1]).toEqual({
      settings: { label: { labelWidthMm: 25, labelHeightMm: 246, sensing: 'bline', printOffsetMm: 50, printLengthMm: 80 } },
    });
  });

  it('the rule itself: each field and section only when it differs from the row', () => {
    const form = deviceEditFormOf(receipt);
    expect(deviceEdits(receipt, form)).toEqual({});
    expect(hasEdits(deviceEdits(receipt, form))).toBe(false);
    // Spaces typed round a value are not a change; a cleared model is.
    expect(deviceEdits(receipt, { ...form, label: ` ${receipt.label} ` })).toEqual({});
    const modelled: DeviceRow = { ...receipt, model: 'Xprinter XP-80' };
    expect(deviceEdits(modelled, { ...deviceEditFormOf(modelled), model: '' })).toEqual({ model: null });
    // Back to the value it opened with: nothing to send.
    expect(deviceEdits(receipt, { ...form, dotsPerLine: 576 })).toEqual({});
    // A scanner's section only when its setup was changed.
    const scanForm = deviceEditFormOf(scanner);
    expect(deviceEdits(scanner, scanForm)).toEqual({});
    expect(deviceEdits(scanner, { ...scanForm, scanner: { ...scanForm.scanner, vendorId: '05E0' } }))
      .toEqual({ settings: { scanner: { mode: 'hid', vendorId: '05e0' } } });
  });
});

// --- Point 8 of the plan: the station form's code prefix ------------------------------

const box: BoxRow = { id: 'box', branchId: 'branch', name: 'ZZ TEST box', slot: 'virtual-1', role: 'virtual', status: 'online' } as BoxRow;
const stationOf = (kind: string, codePrefix: string | null): StationRow => ({
  id: `zz-${kind}`, branchId: 'branch', boxId: 'box', name: `ZZ TEST 952 ${kind}`, kind, codePrefix,
  ready: true, reasons: [], configVersion: 1, accessScope: 'all_staff', devices: [],
} as StationRow);

function drawer(station: StationRow | null) {
  runner.mount(() => {
    tree = StationDrawer({
      station, branchId: 'branch', branchLabel: 'Park', boxes: [box], deviceList: () => devicesRead([]),
      onRetryDevices: () => undefined, canEdit: true, onClose: () => undefined, onSaved: vi.fn(),
    }) as ReactElement;
  });
}
const prefixShown = () => has((p) => p.label === 'Code prefix');

describe('SCRUM-971 — only a station that mints codes is asked for a code prefix', () => {
  it('a customer display and a gate show no code prefix field', () => {
    drawer(stationOf('display', null));
    expect(prefixShown()).toBe(false);
    drawer(stationOf('gate', null));
    expect(prefixShown()).toBe(false);
  });

  it('a till, a kiosk and a booth still do', () => {
    for (const kind of ['till', 'kiosk', 'booth']) {
      drawer(stationOf(kind, kind === 'booth' ? 'B9' : 'T9'));
      expect(prefixShown(), kind).toBe(true);
    }
  });

  it('a display saved with a prefix from an older setup sends it back as it was', async () => {
    const legacy = stationOf('display', 'D1');
    const update = vi.spyOn(fleetApi, 'updateStation').mockResolvedValue({ station: legacy });
    drawer(legacy);
    const save = find('Save the station', (p) => typeof p.onClick === 'function' && textOf(p.children).includes('Save the station'));
    (save.onClick as () => void)();
    await settle();
    expect(update.mock.calls[0]?.[1]).toMatchObject({ codePrefix: 'D1' });
  });

  it('the kinds that use one: the till and the kiosk number receipts and bands, the booth its vouchers', () => {
    expect(['till', 'kiosk', 'booth', 'gate', 'display'].filter(stationUsesCodePrefix)).toEqual(['till', 'kiosk', 'booth']);
  });
});
