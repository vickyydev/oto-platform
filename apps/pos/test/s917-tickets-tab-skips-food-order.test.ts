import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { apiSale, settle } from './support/fixtures';
import { renderHook } from './support/hooks';
import { salesApi } from '@/api/sales';
import { kindOf, type ApiSaleListItem } from '@/api/history';
import { opensOnTicketsTab, useLeftBehindSales } from '@/lib/leftBehindSale';
import { rememberSaleOnScreen } from '@/lib/saleOnScreen';

/**
 * SCRUM-917 — THE TICKETS TAB NEVER PICKS A SALE IT CANNOT OPEN.
 *
 * Found in SCRUM-889's staging proof (picture 07a): an F&B order left
 * part-paid at the counter till, and opening Tickets put a red toast "That
 * sale is not a ticket sale" on screen before staff had pressed anything.
 * The restaurant counter rings up at the same station, so the order was one
 * of the station's unpaid sales; the left-behind list offered it as this
 * account's own, picked it as the only one to resume, and the ticket till's
 * resume then refused it.
 *
 * The list row names what the sale was made of (`lineKinds`, History's card
 * reads the same field). A sale with no ticket line is left off the Tickets
 * tab's list: never picked, never offered to resume, no toast. It stays where
 * it is finished — the F&B or Shop counter, and History, whose F&B tab lists
 * it. A party's settlement keeps its card (SCRUM-889), and a row from an
 * older platform that names no kinds is listed exactly as before.
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/api/sales', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/api/sales')>();
  return { ...actual, salesApi: { ...actual.salesApi, get: vi.fn(), voidSale: vi.fn(), list: vi.fn() } };
});

const listSales = vi.mocked(salesApi.list);

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

const mine = { accountId: 'account-1', name: 'Som' };
const party = { eventId: 'party-event-1', settlementId: 'settlement-1' };

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('sessionStorage', memoryStorage());
  vi.stubGlobal('localStorage', memoryStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mount = () =>
  renderHook(() =>
    useLeftBehindSales({
      branchId: 'branch-1', stationId: 'station-1', stationName: 'Reception Till 1',
      accountId: 'account-1', enabled: true, ownsSale: () => false,
    }),
  );

describe('the Tickets tab and an order from another counter', () => {
  it('a part-paid F&B order rung up here by this account is not listed and not picked', async () => {
    listSales.mockResolvedValue({
      sales: [apiSale({ id: 'fnb-order', stationId: 'station-1', soldBy: mine, lineKinds: ['fnb_item'] })],
    });
    const view = mount();
    await settle();
    expect(view.result.current.sales).toEqual([]);
    expect(view.result.current.resumeId).toBeNull();
  });

  it('is not picked even when this tab remembers it on screen', async () => {
    rememberSaleOnScreen('station-1', 'fnb-order');
    listSales.mockResolvedValue({
      sales: [apiSale({ id: 'fnb-order', stationId: 'station-1', soldBy: mine, lineKinds: ['fnb_item'] })],
    });
    const view = mount();
    await settle();
    expect(view.result.current.resumeId).toBeNull();
    expect(view.result.current.sales.map((s) => s.saleId)).toEqual([]);
  });

  it('a shop order, and a sale with no lines at all, are left off the same way', async () => {
    listSales.mockResolvedValue({
      sales: [
        apiSale({ id: 'shop-order', stationId: 'station-1', soldBy: mine, lineKinds: ['merch_item'] }),
        apiSale({ id: 'empty-sale', stationId: 'station-1', soldBy: mine, lineKinds: [] }),
      ],
    });
    const view = mount();
    await settle();
    expect(view.result.current.sales).toEqual([]);
    expect(view.result.current.resumeId).toBeNull();
  });

  it('a ticket sale beside the food order is still the one the till goes back to', async () => {
    listSales.mockResolvedValue({
      sales: [
        apiSale({ id: 'fnb-order', stationId: 'station-1', soldBy: mine, lineKinds: ['fnb_item'] }),
        apiSale({ id: 'ticket-sale', stationId: 'station-1', soldBy: mine, lineKinds: ['kids', 'adults_paid', 'socks'] }),
      ],
    });
    const view = mount();
    await settle();
    expect(view.result.current.sales.map((s) => [s.saleId, s.resumable])).toEqual([['ticket-sale', true]]);
    expect(view.result.current.resumeId).toBe('ticket-sale');
  });

  it('a ticket sale that also carries a food line is a ticket sale', async () => {
    listSales.mockResolvedValue({
      sales: [apiSale({ id: 'mixed-sale', stationId: 'station-1', soldBy: mine, lineKinds: ['fnb_item', 'kids'] })],
    });
    const view = mount();
    await settle();
    expect(view.result.current.resumeId).toBe('mixed-sale');
  });

  it("a party's settlement keeps its card whatever its lines are (SCRUM-889)", async () => {
    listSales.mockResolvedValue({
      sales: [apiSale({ id: 'settlement-sale', stationId: 'station-1', soldBy: mine, partySettlement: party, lineKinds: [] })],
    });
    const view = mount();
    await settle();
    expect(view.result.current.sales).toEqual([
      expect.objectContaining({ saleId: 'settlement-sale', resumable: false, partySettlement: { eventId: 'party-event-1' } }),
    ]);
    expect(view.result.current.resumeId).toBeNull();
  });

  it('a row that names no kinds (an older platform) is listed and resumed as before', async () => {
    listSales.mockResolvedValue({ sales: [apiSale({ id: 'old-row', stationId: 'station-1', soldBy: mine })] });
    const view = mount();
    await settle();
    expect(view.result.current.sales.map((s) => [s.saleId, s.resumable])).toEqual([['old-row', true]]);
    expect(view.result.current.resumeId).toBe('old-row');
  });
});

describe('which sales the Tickets tab can open', () => {
  it('has a ticket line, or names no kinds', () => {
    expect(opensOnTicketsTab({ lineKinds: ['kids'] })).toBe(true);
    expect(opensOnTicketsTab({ lineKinds: ['service_fee'] })).toBe(true);
    expect(opensOnTicketsTab({ lineKinds: ['promo_item'] })).toBe(true);
    expect(opensOnTicketsTab({})).toBe(true);
    expect(opensOnTicketsTab({ lineKinds: ['fnb_item'] })).toBe(false);
    expect(opensOnTicketsTab({ lineKinds: ['merch_item', 'fnb_item'] })).toBe(false);
    expect(opensOnTicketsTab({ lineKinds: [] })).toBe(false);
  });

  it('the food order stays where it belongs: History files it under F&B', () => {
    const row = { ...apiSale({ id: 'fnb-order' }), lineKinds: ['fnb_item'], revenueCategories: ['fnb'] } as unknown as ApiSaleListItem;
    expect(kindOf(row)).toBe('fnb');
  });

  it("the ticket till's own resume still refuses a sale that is not a ticket sale", () => {
    // The guard for a row that named no kinds: unchanged, in the till's words.
    const till = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'pages', 'Till.tsx'), 'utf8');
    expect(till).toContain("title: 'That sale is not a ticket sale'");
  });
});
