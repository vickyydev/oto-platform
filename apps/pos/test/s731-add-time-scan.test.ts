import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SaleExtension, SaleExtensionsRead } from '@/api/history';
import { api } from '@/api/client';
import { ExtensionBandRecovery, ExtensionPayment } from '@/components/history/SaleExtensions';
import { toast } from '@/hooks/use-toast';
import type { BandScanSlot } from '@/lib/tabScan';
import { settle } from './support/fixtures';
import { renderHook } from './support/hooks';

/**
 * SCRUM-731 — A BAND READ AT THE COUNTER WHILE HISTORY'S ADD TIME IS OPEN.
 *
 * The dialog asks staff to select or scan bracelets, and a short code typed into
 * its field ticks the bracelet. A band read by the box goes through that same
 * step, so the two cannot differ on what is eligible, and it never reaches the
 * charge once the bracelets are set for payment.
 */
vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/station/StationContext', () => ({ useStation: () => ({ active: { id: 'station-1' } }) }));
vi.mock('@/auth/OperatorContext', () => ({
  useOperator: () => ({ operator: null, can: () => true, offlineUnlock: null }),
}));

// This runner has no React plugin, so the component's JSX is compiled to
// `React.createElement` and looks for `React` in scope.
beforeEach(() => {
  vi.stubGlobal('React', React);
  vi.mocked(toast).mockClear();
});

function elements(node: unknown): React.ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!React.isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function words(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(words).join('');
  return React.isValidElement<Record<string, unknown>>(node) ? words(node.props.children) : '';
}
function press(tree: unknown, label: string) {
  const button = elements(tree).find((node) => typeof node.props.onClick === 'function' && words(node.props.children) === label);
  expect(button, label).toBeDefined();
  (button!.props.onClick as () => void)();
}

const FIRST = 'T1-7KMQ4X';
const SECOND = 'T1-9ABCDE';
const NOT_ON_THIS_RECEIPT = 'T1-1ZZZZZ';
const NOT_ELIGIBLE = 'This bracelet is not eligible on this receipt.';

// SCRUM-797 — the owner's extra hour: two children on the order, ฿300 each an hour.
const data: SaleExtensionsRead = {
  options: [{ id: 'ext-60', label: '+1 hour', hours: 1, minutes: 60, unitSatang: 30000 }],
  children: 2,
  perChildHourSatang: 30000,
  eligibleBands: [
    { id: 'band-1', shortCode: FIRST, kind: 'kids' },
    { id: 'band-2', shortCode: SECOND, kind: 'kids' },
  ],
  extensions: [],
};

function openDialog() {
  const slot: BandScanSlot = { current: null };
  const hook = renderHook(() =>
    ExtensionPayment({ saleId: 'source-1', stationId: 'station-1', data, resume: null, operatorName: 'Som', onClose: vi.fn(), bandScans: slot }),
  );
  const boxes = () => elements(hook.result.current).filter((node) => node.type === 'input' && node.props.type === 'checkbox');
  const ticked = () => boxes().map((box) => box.props.checked);
  const untick = (index: number) => (boxes()[index]!.props.onChange as (event: unknown) => void)({ target: { checked: false } });
  const scan = (key: string) => slot.current!(key);
  const typed = (key: string) => {
    const field = elements(hook.result.current).find((node) => node.props['aria-label'] === 'Scan bracelet')!;
    (field.props.onChange as (event: unknown) => void)({ target: { value: key } });
    press(hook.result.current, 'Add bracelet');
  };
  return { slot, hook, ticked, untick, scan, typed };
}

describe('the Add time dialog hears a band for as long as it is open', () => {
  it('fills the slot History hands it, and lets go when it closes', () => {
    const { slot, hook } = openDialog();
    expect(slot.current).toBeTypeOf('function');
    hook.unmount();
    expect(slot.current).toBeNull();
  });

  it('runs without a slot, as it does on the phone layout where no channel listens', () => {
    const hook = renderHook(() =>
      ExtensionPayment({ saleId: 'source-1', stationId: 'station-1', data, resume: null, operatorName: 'Som', onClose: vi.fn() }),
    );
    expect(words(hook.result.current)).toContain('Add bracelet');
    hook.unmount();
  });
});

describe('a band read by the box is what the typed short code is', () => {
  it('ticks the bracelet and says so', () => {
    const { hook, ticked, untick, scan } = openDialog();
    untick(1);
    expect(ticked()).toEqual([true, false]);
    scan(SECOND);
    expect(ticked()).toEqual([true, true]);
    expect(toast).toHaveBeenCalledWith({ title: `Bracelet ${SECOND} added`, description: 'It is ticked on this Add time.' });
    hook.unmount();
  });

  it('the typed code ticks the same bracelet the same way', () => {
    const { hook, ticked, untick, typed } = openDialog();
    untick(1);
    typed(SECOND);
    expect(ticked()).toEqual([true, true]);
    hook.unmount();
  });

  it('says so when the bracelet was already ticked, where nothing on screen would move', () => {
    const { hook, ticked, scan } = openDialog();
    scan(FIRST);
    expect(ticked()).toEqual([true, true]);
    expect(toast).toHaveBeenCalledWith({ title: `Bracelet ${FIRST} is already ticked`, description: 'Nothing changed.' });
    hook.unmount();
  });

  it('a bracelet not on this receipt gets the same words as when typed, and changes nothing', () => {
    const scanned = openDialog();
    scanned.scan(NOT_ON_THIS_RECEIPT);
    expect(words(scanned.hook.result.current)).toContain(NOT_ELIGIBLE);
    expect(scanned.ticked()).toEqual([true, true]);
    scanned.hook.unmount();

    const typed = openDialog();
    typed.typed(NOT_ON_THIS_RECEIPT);
    expect(words(typed.hook.result.current)).toContain(NOT_ELIGIBLE);
    expect(typed.ticked()).toEqual([true, true]);
    typed.hook.unmount();
  });

  it('a good scan clears the words a bad one left', () => {
    const { hook, scan } = openDialog();
    scan(NOT_ON_THIS_RECEIPT);
    scan(FIRST);
    expect(words(hook.result.current)).not.toContain(NOT_ELIGIBLE);
    hook.unmount();
  });
});

describe('where the dialog cannot take a band, it says so and changes nothing', () => {
  it('Count only has no bracelets to tick', () => {
    const { hook, ticked, untick, scan } = openDialog();
    untick(1);
    press(hook.result.current, 'Count only');
    scan(SECOND);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: `Bracelet ${SECOND} not added`, variant: 'destructive' }));
    expect(vi.mocked(toast).mock.calls[0]![0].description).toContain('Count only is chosen');
    press(hook.result.current, 'Select or scan bracelets');
    expect(ticked()).toEqual([true, false]);
    hook.unmount();
  });

  it('once the charge has the bracelets, a scan never reaches what it pays for', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ sale: { id: 'charge-1', status: 'tendering', totals: { grossSatang: 60_000 } }, extension: {}, replay: false });
    const get = vi.spyOn(api, 'get').mockResolvedValue({ sale: { id: 'charge-1', status: 'tendering', totals: { grossSatang: 60_000 } }, attempts: [] });
    const { hook, ticked, untick, scan } = openDialog();
    untick(1);
    const duration = elements(hook.result.current).find((node) => typeof node.props.onClick === 'function' && words(node.props.children).startsWith('+1 hour'))!;
    (duration.props.onClick as () => void)();
    press(hook.result.current, 'Continue to payment');
    await settle();
    expect(post.mock.calls[0]?.[1]).toMatchObject({ selection: { mode: 'bands', bandIds: ['band-1'] } });

    vi.mocked(toast).mockClear();
    scan(SECOND);
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: `Bracelet ${SECOND} not added`, variant: 'destructive' }));
    expect(vi.mocked(toast).mock.calls[0]![0].description).toContain('already set for payment');
    expect(ticked()).toEqual([true, false]);
    expect(post).toHaveBeenCalledTimes(1);
    hook.unmount();
    post.mockRestore();
    get.mockRestore();
  });
});

describe('replacing bracelets on a paid charge has no scan field', () => {
  const entry = {
    id: 'extension-1',
    chargeSaleId: 'charge-1',
    optionId: 'ext-60',
    label: '+1 hour',
    minutesAdded: 60,
    braceletCount: 1,
    amountSatang: 60000,
    selection: { mode: 'bands', bandIds: ['band-9'] },
    status: 'applied',
    createdAt: '2026-11-03T05:00:00.000Z',
    createdByName: 'Som',
    appliedAt: '2026-11-03T05:01:00.000Z',
    currentBandIds: [],
    needsReselection: true,
  } as unknown as SaleExtension; // the fields this dialog reads; the rest are the ledger's

  it('says to use the list, ticks nothing, and lets go when it closes', () => {
    const slot: BandScanSlot = { current: null };
    const hook = renderHook(() =>
      ExtensionBandRecovery({ saleId: 'source-1', stationId: 'station-1', entry, bands: data.eligibleBands, onClose: vi.fn(), bandScans: slot }),
    );
    slot.current!(FIRST);
    expect(toast).toHaveBeenCalledWith({
      title: `Bracelet ${FIRST} not added`,
      description: 'Tick the replacement bracelets on this list. Nothing changed.',
      variant: 'destructive',
    });
    const boxes = elements(hook.result.current).filter((node) => node.type === 'input' && node.props.type === 'checkbox');
    expect(boxes.map((box) => box.props.checked)).toEqual([false, false]);
    hook.unmount();
    expect(slot.current).toBeNull();
  });
});
