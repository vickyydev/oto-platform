import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { StationSessionDocument } from '@oto/shared';
import type { TicketDisplayState } from '@/lib/displaySession';

/**
 * THE STATION LEASE SURVIVES A RELOAD — `lib/displaySession.ts`.
 *
 * The display publisher takes the station lease under a `holder` id. It was
 * minted once per page load, so a refreshed till was "another till" to the
 * display, which showed "Another till is using this station" until the old
 * lease ran out. The id is now kept in `sessionStorage` (this tab) with a copy
 * in `localStorage` keyed by station, so a reloaded page leases as the same
 * holder; sign-out forgets it. The manager's takeover path is untouched.
 *
 * A reload is simulated the honest way: the module registry is reset, so the
 * publisher's in-memory map is gone and only the browser's stores remain.
 */
vi.mock('react', () => import('./support/hooks'));

const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');

/** A browser store that lives for one test. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
    clear: () => map.clear(),
    key: (index: number) => [...map.keys()][index] ?? null,
    get length() { return map.size; },
  };
}

const HOLDER_KEY = 'oto.display.holder.station-1';

const state = (): TicketDisplayState => ({
  stage: 'identify', step: 1, sessionKey: 'sale-0', tier: 'tourist', phone: '', nickname: '',
  contactChannel: 'whatsapp', member: null, online: true,
});

const document = (overrides: Partial<StationSessionDocument> = {}): StationSessionDocument => ({
  stationId: 'station-1', boxId: 'box-1', schemaVersion: 1, sequence: 0, stage: 'identify', language: 'en', lease: null,
  takeoverCount: 0, updatedAt: '2026-10-29T12:00:00.000Z', ...overrides,
});

const reply = (data: unknown, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data }) as Response;

/** A station bridge with one connected display, recording the holder each lease is asked under. */
function bridge(leaseId: string) {
  let doc = document();
  const holders: string[] = [];
  const request = vi.fn(async (input: string, init?: RequestInit) => {
    if (input.endsWith('/displays')) return reply({ displays: [{ id: 'display-1', name: 'Counter screen', connected: true }] });
    if (input.endsWith('/lease')) {
      holders.push(String((JSON.parse(String(init?.body)) as { holder: string }).holder));
      doc = { ...doc, lease: { leaseId, holder: 'till', holderKind: 'till', accountId: 'account-1',
        startedAt: doc.updatedAt, heartbeatAt: doc.updatedAt, expiresAt: '2026-10-29T12:01:00.000Z' } };
      return reply({ document: doc, lease: doc.lease });
    }
    if (input.endsWith('/lease/renew')) return reply({ document: doc });
    if (input.endsWith('/session')) return reply({ document: doc });
    if (input.endsWith('/intents')) {
      doc = { ...doc, sequence: doc.sequence + 1 };
      return reply({ document: doc });
    }
    return reply({ released: true });
  });
  vi.stubGlobal('fetch', request);
  return { request, holders };
}

/**
 * One page load: fresh modules, the stores as they are. The harness is taken
 * from the mocked `react` itself — the instance the publisher's hooks attach
 * to — because a module reset re-creates every module but the mock keeps its
 * own.
 */
async function load() {
  vi.resetModules();
  const [hooks, { settle }, display] = await Promise.all([
    import('react') as unknown as Promise<typeof import('./support/hooks')>,
    import('./support/fixtures'),
    import('@/lib/displaySession'),
  ]);
  const { renderHook } = hooks;
  const mount = (leaseId: string, stationId = 'station-1') => {
    const seen = bridge(leaseId);
    const hook = renderHook(() => display.useTicketDisplay(stationId, state(), vi.fn()));
    return { ...seen, hook };
  };
  return { mount, settle, display };
}

describe('the display publisher’s holder through a reload', () => {
  let session: Storage;
  let local: Storage;
  beforeEach(() => {
    vi.useFakeTimers();
    session = memoryStorage();
    local = memoryStorage();
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', local);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a reloaded page leases as the same holder, so the lease and the display carry on', async () => {
    const first = await load();
    const before = first.mount('lease-1');
    await first.settle();
    expect(before.holders).toHaveLength(1);
    const holder = before.holders[0]!;
    expect(holder).toMatch(/^[0-9a-f-]{36}$/);
    expect(session.getItem(HOLDER_KEY)).toBe(holder);
    expect(local.getItem(HOLDER_KEY)).toBe(holder);
    before.hook.unmount();

    const second = await load();
    const after = second.mount('lease-2');
    await second.settle();
    expect(after.holders).toEqual([holder]);
    after.hook.unmount();
  });

  it('a closed tab reopened on the same counter finds the holder the browser kept', async () => {
    const first = await load();
    const before = first.mount('lease-1');
    await first.settle();
    const holder = before.holders[0]!;
    before.hook.unmount();

    vi.stubGlobal('sessionStorage', memoryStorage());
    const second = await load();
    const after = second.mount('lease-2');
    await second.settle();
    expect(after.holders).toEqual([holder]);
    expect(sessionStorage.getItem(HOLDER_KEY)).toBe(holder);
    after.hook.unmount();
  });

  it('a station of its own keeps its own holder; another station mints another', async () => {
    const page = await load();
    const one = page.mount('lease-1');
    await page.settle();
    const other = page.mount('lease-other', 'station-2');
    await page.settle();
    expect(other.holders).toHaveLength(1);
    expect(other.holders[0]).not.toBe(one.holders[0]);
    expect(local.getItem('oto.display.holder.station-2')).toBe(other.holders[0]);
    other.hook.unmount();
    one.hook.unmount();
  });

  it('sign-out hands over the lease and forgets the holder, so the next shift on this browser is a new one', async () => {
    const first = await load();
    const before = first.mount('lease-1');
    await first.settle();
    const holder = before.holders[0]!;
    await expect(first.display.takeTicketDisplayLeaseForSignOut()).resolves.toBe('lease-1');
    expect(session.getItem(HOLDER_KEY)).toBeNull();
    expect(local.getItem(HOLDER_KEY)).toBeNull();
    before.hook.unmount();
    // Handed to sign-out, the lease is not released by the unmount.
    expect(before.request.mock.calls.filter(([input]) => String(input).endsWith('/lease/release'))).toHaveLength(0);

    const second = await load();
    const after = second.mount('lease-2');
    await second.settle();
    expect(after.holders).toHaveLength(1);
    expect(after.holders[0]).not.toBe(holder);
    after.hook.unmount();
  });

  it('a sign-out with no publisher on screen still forgets every station’s holder', async () => {
    local.setItem('oto.display.holder.station-1', 'kept-1');
    local.setItem('oto.display.holder.station-2', 'kept-2');
    session.setItem('oto.display.holder.station-1', 'kept-1');
    local.setItem('oto.pos.station.branch-1', 'untouched');
    const page = await load();
    await expect(page.display.takeTicketDisplayLeaseForSignOut()).resolves.toBeUndefined();
    expect(local.getItem('oto.display.holder.station-1')).toBeNull();
    expect(local.getItem('oto.display.holder.station-2')).toBeNull();
    expect(session.getItem('oto.display.holder.station-1')).toBeNull();
    expect(local.getItem('oto.pos.station.branch-1')).toBe('untouched');
  });

  it('sign-out is where the holder is forgotten, and the counter still signs out through it', () => {
    const display = src('lib/displaySession.ts');
    expect(display).toMatch(/export function takeTicketDisplayLeaseForSignOut\(\)[\s\S]*?forgetDisplayHolders\(\);/);
    expect(src('auth/OperatorContext.tsx')).toContain('const displayLease = takeTicketDisplayLeaseForSignOut();');
  });
});
