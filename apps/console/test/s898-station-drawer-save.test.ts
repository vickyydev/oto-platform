import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/api/client';
import { fleetApi, type BoxRow, type DeviceRow, type StationRow } from '@/api/fleet';
import { StationDrawer } from '@/components/devices/StationDrawer';
import { devicesRead } from '@/lib/deviceList';

/**
 * SCRUM-898 — THE STATION DRAWER ITSELF, run with its own hooks: what it sends
 * when Save is pressed, what it does when a newer reading of its station
 * arrives while it is open, and what it leaves on screen when the api refuses
 * a save from an older version.
 *
 * No browser: React's hooks are stood in for by the small runner below (the
 * till's `test/support/hooks.ts` in miniature), the drawer is called as the
 * function it is, and its buttons and fields are found in the element tree it
 * returns and pressed through their own handlers.
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
    render,
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

const noop = () => undefined;
const box: BoxRow = { id: 'box', branchId: 'branch', name: 'ZZ TEST box', slot: 'till-9', role: 'virtual', status: 'online' } as BoxRow;
const kids: DeviceRow = { id: 'kids', boxId: 'box', kind: 'band_printer', label: 'ZZ TEST kids band printer', transport: 'simulated', address: '192.168.88.204:9100', protocol: 'tspl2' };
const dropoff: DeviceRow = { id: 'dropoff', boxId: 'box', kind: 'band_printer', label: 'ZZ TEST drop-off band printer', transport: 'simulated', address: '192.168.88.212:9100', protocol: 'tspl2' };
const assigned = (role: string, d: DeviceRow) => ({ role, deviceId: d.id, label: d.label, kind: d.kind, transport: d.transport, address: d.address ?? null });
const v1: StationRow = {
  id: 'till', branchId: 'branch', boxId: 'box', name: 'ZZ TEST Reception Till 1', kind: 'till', codePrefix: 'T9',
  ready: true, reasons: [], configVersion: 1, accessScope: 'all_staff', devices: [assigned('kids_band', kids)],
};
const v2: StationRow = { ...v1, configVersion: 2, devices: [assigned('kids_band', kids), assigned('dropoff_band', dropoff)] };
const v3: StationRow = { ...v2, configVersion: 3, name: 'ZZ TEST renamed elsewhere' };

let tree: ReactElement;
let station: StationRow | null = v1;
const onSaved = vi.fn();
const onStale = vi.fn();
const boxes = [box];
const deviceList = () => devicesRead([kids, dropoff]);

function show(next: StationRow | null) {
  station = next;
  runner.render();
}

beforeEach(() => {
  onSaved.mockReset();
  onStale.mockReset();
  station = v1;
  runner.mount(() => {
    tree = StationDrawer({
      station, branchId: 'branch', branchLabel: 'Park', boxes, deviceList, onRetryDevices: noop,
      canEdit: true, onClose: noop, onSaved, onStale,
    }) as ReactElement;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Reading the tree the drawer returned -------------------------------------

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
  throw new Error(`${what} is not on the drawer`);
};

const version = () => textOf(find('the version', (p, el) => el.type === 'span' && textOf(p.children).startsWith('config v')).children);
const dropoffChoice = () => {
  const field = find('the drop-off band printer field', (p) => p.label === 'Drop-off band printer');
  return ((field.children as ReactElement<{ value: string }>).props).value;
};
const nameField = () => find('the name field', (p) => p.placeholder === 'Reception Till 1');
const refusal = () => {
  for (const element of walk(tree)) {
    const props = element.props as { message?: unknown };
    if (typeof props.message === 'string') return props.message;
  }
  return null;
};

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

async function pressSave() {
  const save = find('Save the station', (p) => typeof p.onClick === 'function' && textOf(p.children).includes('Save the station'));
  (save.onClick as () => void)();
  await settle();
}

// --- The cases ------------------------------------------------------------------

describe('SCRUM-898 — the station drawer and the version it was filled from', () => {
  it('a save sends the version the form was opened at, and hands the answer to the page', async () => {
    const update = vi.spyOn(fleetApi, 'updateStation').mockResolvedValue({ station: v2 });
    expect(version()).toBe('config v1');
    await pressSave();
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0]?.[0]).toBe('till');
    expect(update.mock.calls[0]?.[1]).toMatchObject({ name: v1.name, expectedConfigVersion: 1 });
    expect(onSaved).toHaveBeenCalledWith(v2);
    expect(onStale).not.toHaveBeenCalled();
  });

  it('an untouched form takes a newer reading of its station: v2 shown, the drop-off printer chosen, v2 sent', async () => {
    expect(dropoffChoice()).toBe('');
    show(v2);
    expect(version()).toBe('config v2');
    expect(dropoffChoice()).toBe('dropoff');
    // An older reading arriving after it changes nothing.
    show(v1);
    expect(version()).toBe('config v2');
    expect(dropoffChoice()).toBe('dropoff');

    const update = vi.spyOn(fleetApi, 'updateStation').mockResolvedValue({ station: v2 });
    await pressSave();
    expect(update.mock.calls[0]?.[1]).toMatchObject({ expectedConfigVersion: 2 });
  });

  it('a touched form keeps what was typed when a newer version arrives, and its save says the older version', async () => {
    (nameField().onChange as (value: string) => void)('ZZ TEST typed here');
    show(v3);
    expect(version()).toBe('config v1');
    expect(nameField().value).toBe('ZZ TEST typed here');

    const update = vi
      .spyOn(fleetApi, 'updateStation')
      .mockRejectedValue(new ApiError(409, 'STATION_CHANGED', 'This station was changed since you opened it. Close it and open it again.'));
    await pressSave();
    expect(update.mock.calls[0]?.[1]).toMatchObject({ name: 'ZZ TEST typed here', expectedConfigVersion: 1 });
    // Kept open, in the owner's words, and the list is asked to read again.
    expect(refusal()).toBe('This till was changed since you opened it. Close it and open it again.');
    expect(onSaved).not.toHaveBeenCalled();
    expect(onStale).toHaveBeenCalledTimes(1);
    expect(nameField().value).toBe('ZZ TEST typed here');
  });

  it('any other refusal is left in the api’s words, and the list is not re-read for it', async () => {
    vi.spyOn(fleetApi, 'updateStation').mockRejectedValue(
      new ApiError(400, 'DEVICE_NOT_ON_BOX', 'That device is not on this station’s box'),
    );
    await pressSave();
    expect(refusal()).toBe('That device is not on this station’s box');
    expect(onStale).not.toHaveBeenCalled();
  });

  it('a new station sends no version at all', async () => {
    const create = vi.spyOn(fleetApi, 'createStation').mockResolvedValue({ station: v1 });
    station = null;
    runner.mount(() => {
      tree = StationDrawer({
        station, branchId: 'branch', branchLabel: 'Park', boxes, deviceList, onRetryDevices: noop,
        canEdit: true, onClose: noop, onSaved, onStale,
      }) as ReactElement;
    });
    (nameField().onChange as (value: string) => void)('ZZ TEST new till');
    const press = find('Create the station', (p) => typeof p.onClick === 'function' && textOf(p.children).includes('Create the station'));
    (press.onClick as () => void)();
    await settle();
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0]?.[1]).not.toHaveProperty('expectedConfigVersion');
    expect(onSaved).toHaveBeenCalledWith(v1);
  });
});

// --- SCRUM-932 ----------------------------------------------------------------

describe('SCRUM-932 — the drawer shows one station, the one its form was filled from', () => {
  const title = () => (tree.props as { title?: unknown }).title;

  it('after a save is refused as made from an older version, the title keeps the form’s name beside the form’s version, and the refusal says to reopen', async () => {
    (nameField().onChange as (value: string) => void)('ZZ TEST typed here');
    vi.spyOn(fleetApi, 'updateStation').mockRejectedValue(
      new ApiError(409, 'STATION_CHANGED', 'This station was changed since you opened it. Close it and open it again.'),
    );
    await pressSave();
    // The page reads the list again and hands the drawer the station as it now stands.
    show(v3);
    expect(title()).toBe(v1.name);
    expect(title()).not.toBe(v3.name);
    expect(version()).toBe('config v1');
    expect(refusal()).toBe('This till was changed since you opened it. Close it and open it again.');
  });

  it('an untouched form that takes a newer reading shows that reading’s name and version together', () => {
    expect(title()).toBe(v1.name);
    show(v3);
    expect(title()).toBe(v3.name);
    expect(version()).toBe('config v3');
  });

  it('a new station is still called "New station"', () => {
    station = null;
    runner.mount(() => {
      tree = StationDrawer({
        station, branchId: 'branch', branchLabel: 'Park', boxes, deviceList, onRetryDevices: noop,
        canEdit: true, onClose: noop, onSaved, onStale,
      }) as ReactElement;
    });
    expect(title()).toBe('New station');
  });
});
