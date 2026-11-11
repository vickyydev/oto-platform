import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as history from '@/api/history';
import * as wallet from '@/api/wallet';
import History from '@/pages/History';
import { MobileHistory } from '@/components/mobile/history/MobileHistory';
import { TransactionCard } from '@/components/history/TransactionCard';
import { ExtensionPayment, useSaleExtensions } from '@/components/history/SaleExtensions';
import { useScanField } from '@/lib/useScanField';
import { SCAN_PACE_QUIET_MS } from '@/lib/pageScan';
import { renderHook } from './support/hooks';
import { settle } from './support/fixtures';

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('wouter', () => ({ useSearch: () => '', useLocation: () => ['/', vi.fn()], Link: 'a' }));
vi.mock('@/branch/BranchContext', () => ({ useBranch: () => ({ branch: { id: 'zz-test-park', apiId: 'park-802', name: 'ZZ TEST park', timezone: 'Asia/Bangkok' } }) }));
vi.mock('@/station/StationContext', () => ({ useStation: () => ({ station: null, active: { id: 'station-802' } }) }));
vi.mock('@/auth/OperatorContext', () => ({ useOperator: () => ({ locked: false, can: () => true, operator: null, offlineUnlock: null }) }));
vi.mock('@/lib/tenderDisplay', () => ({ useTenderDisplay: () => ({ handover: vi.fn() }), useTenderPresentation: vi.fn() }));
vi.mock('@/lib/scanChannel', async (original) => ({ ...(await original<typeof import('@/lib/scanChannel')>()), useStationScans: vi.fn() }));
vi.mock('@/lib/pageScan', async (original) => ({ ...(await original<typeof import('@/lib/pageScan')>()), usePageScanRoute: vi.fn() }));

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];
const words = (node: unknown): string => typeof node === 'string' || typeof node === 'number' ? String(node) :
  Array.isArray(node) ? node.map(words).join('') : React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';
const click = (node: Element) => (node.props.onClick as () => void)();
const button = (tree: unknown, label: string) => elements(tree).find(node => words(node.props.children) === label && typeof node.props.onClick === 'function')!;
const transaction = (id: string) => ({ id, kind: 'ticket', reference: `ZZ TEST ${id}`, total: 600, ledger: { member: null } }) as history.HistoryTxn;
const BAND = 'Z802-7KMQ4X';

beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.useFakeTimers();
  vi.spyOn(history, 'businessDateToday').mockResolvedValue('2026-11-11');
  vi.spyOn(history, 'listSales').mockResolvedValue([transaction('admission')]);
  vi.spyOn(history, 'lookupSales').mockResolvedValue({ sales: [], nextCursor: null } as never);
  vi.spyOn(wallet, 'scanWallet').mockResolvedValue(null);
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe.each([['counter', History], ['phone', MobileHistory]] as const)('SCRUM-802 %s History', (_name, Screen) => {
  async function scanScreen() {
    const view = renderHook(() => Screen());
    await settle();
    click(button(view.result.current, 'Scan bracelet'));
    const input = () => elements(view.result.current).find(node => node.props['aria-label'] === 'Bracelet code')!;
    const dom = { value: '' };
    (input().props.ref as React.MutableRefObject<unknown>).current = dom;
    const change = (value: string, at: number, pasted = false) => {
      dom.value = value;
      (input().props.onChange as (event: unknown) => void)({ target: dom,
        nativeEvent: { timeStamp: at, inputType: pasted ? 'insertFromPaste' : 'insertText' } });
    };
    return { view, input, dom, change };
  }

  it('loads a pasted bracelet without Find and does not ask twice', async () => {
    const { view, change } = await scanScreen();
    change(BAND, 1000, true);
    await vi.advanceTimersByTimeAsync(SCAN_PACE_QUIET_MS);
    expect(history.lookupSales).toHaveBeenCalledExactlyOnceWith('park-802', { band: BAND });
    await vi.advanceTimersByTimeAsync(500);
    expect(history.lookupSales).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  it('loads a scanner run without Enter; hand typing waits for Enter', async () => {
    let scan = await scanScreen();
    for (let i = 1; i <= BAND.length; i++) scan.change(BAND.slice(0, i), 1000 + i * 15);
    await vi.advanceTimersByTimeAsync(SCAN_PACE_QUIET_MS);
    expect(history.lookupSales).toHaveBeenCalledTimes(1);
    scan.view.unmount();
    vi.mocked(history.lookupSales).mockClear();
    scan = await scanScreen();
    for (let i = 1; i <= BAND.length; i++) scan.change(BAND.slice(0, i), 1000 + i * 140);
    await vi.advanceTimersByTimeAsync(500);
    expect(history.lookupSales).not.toHaveBeenCalled();
    (scan.input().props.onKeyDown as (event: unknown) => void)({ key: 'Enter', nativeEvent: { isComposing: false }, currentTarget: scan.dom, preventDefault: vi.fn() });
    await settle();
    expect(history.lookupSales).toHaveBeenCalledTimes(1);
    scan.view.unmount();
  });

  it('rereads the day after the paid time charge without leaving History', async () => {
    const view = renderHook(() => Screen());
    await settle();
    const card = elements(view.result.current).find(node => node.type === TransactionCard)!;
    click(card);
    const detail = elements(view.result.current).find(node => typeof node.props.onExtensionPaid === 'function')!;
    vi.mocked(history.listSales).mockResolvedValue([transaction('extra-time'), transaction('admission')]);
    (detail.props.onExtensionPaid as () => void)();
    await settle();
    expect(history.listSales).toHaveBeenCalledTimes(2);
    (detail.props.onBack as () => void)();
    expect(elements(view.result.current).filter(node => node.type === TransactionCard).map(node => (node.props.txn as history.HistoryTxn).id)).toEqual(['extra-time', 'admission']);
    view.unmount();
  });
});

it('a queued paste cannot open History after leaving the scan field', async () => {
  const take = vi.fn();
  let active = true;
  const view = renderHook(() => useScanField(take, active));
  view.result.current.field.current = { value: BAND } as HTMLInputElement;
  view.result.current.noteChange(BAND, BAND.length, 1000, true);
  active = false; view.rerender();
  await vi.advanceTimersByTimeAsync(500);
  expect(take).not.toHaveBeenCalled();
  view.unmount();
});

it('the time panel notifies History on payment, not on closing an unpaid dialog', async () => {
  vi.spyOn(history, 'readSaleExtensions').mockResolvedValue({ options: [], extensions: [], eligibleBands: [{ id: 'band' }] } as unknown as history.SaleExtensionsRead);
  const paid = vi.fn();
  const view = renderHook(() => useSaleExtensions({ saleId: 'admission', enabled: true, eligible: true, offline: false, fmt: value => value, onPaid: paid }));
  await settle();
  click(button(view.result.current.button, 'Add time'));
  let dialog = elements(view.result.current.dialogs).find(node => node.type === ExtensionPayment)!;
  (dialog.props.onClose as () => void)();
  await settle();
  expect(paid).not.toHaveBeenCalled();
  click(button(view.result.current.button, 'Add time'));
  dialog = elements(view.result.current.dialogs).find(node => node.type === ExtensionPayment)!;
  (dialog.props.onPaid as (value: unknown) => void)({ label: '+1 hour', braceletCount: 1 });
  expect(paid).toHaveBeenCalledTimes(1);
  view.unmount();
});
