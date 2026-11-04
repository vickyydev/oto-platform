import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HeldSale, Permission, SaleResumeAnswer } from '@oto/shared';
import { ApiError, NetworkError } from '@/api/client';
import { heldSalesApi } from '@/api/heldSales';
import { refundSale } from '@/api/history';
import { BOX_LANE_NO_RESUME, useHeldSaleDesk, type ResumedHold } from '@/lib/heldSales';
import { renderHook } from './support/hooks';
import { settle } from './support/fixtures';

/**
 * SCRUM-774 — THE TILL'S HELD SALES DESK (`useHeldSaleDesk`), shared by the
 * counter's ticket till and the phone's: each press keeps its action id until
 * it has an answer it can act on, so a lost answer — or a resume the screen
 * could not open — is pressed again as the same press and the platform
 * answers what it already did, instead of stranding the sale off the list.
 *
 * The hook runs on the harness in place of React (support/hooks.ts); the round
 * trips are replaced.
 */
vi.mock('react', () => import('./support/hooks'));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/api/heldSales', () => ({
  heldSalesApi: { list: vi.fn(), hold: vi.fn(), resume: vi.fn() },
}));
vi.mock('@/api/history', () => ({
  refundSale: vi.fn(),
  newActionId: (() => {
    let n = 0;
    return () => `refund-press-${++n}`;
  })(),
}));
vi.mock('@/api/sales', () => ({ salesApi: { voidSale: vi.fn() } }));

const resumeCall = vi.mocked(heldSalesApi.resume);
const holdCall = vi.mocked(heldSalesApi.hold);
const refundCall = vi.mocked(refundSale);

const SALE_ID = '0192f000-0000-7000-8000-00000000d101';

const heldSale = (over: Partial<HeldSale> = {}): HeldSale => ({
  holdId: '0192f000-0000-7000-8000-00000000e101',
  saleId: SALE_ID,
  branchId: '0192f000-0000-7000-8000-00000000b001',
  kind: 'part_paid',
  label: 'ZZ TEST Khun Ben',
  note: null,
  grossSatang: 55_000,
  paidSatang: 20_000,
  balanceSatang: 35_000,
  businessDate: '2026-11-04',
  heldAt: '2026-11-04T07:05:00.000Z',
  heldBy: { accountId: '0192f000-0000-7000-8000-00000000a002', name: 'Som' },
  heldStation: { id: '0192f000-0000-7000-8000-00000000c001', name: 'Counter 1' },
  flaggedAt: null,
  ...over,
});

const answer: SaleResumeAnswer = {
  replay: false,
  saleId: SALE_ID,
  stationId: '0192f000-0000-7000-8000-00000000c002',
  kind: 'part_paid',
  label: 'ZZ TEST Khun Ben',
  note: null,
  grossSatang: 55_000,
  paidSatang: 20_000,
  balanceSatang: 35_000,
};

interface Props {
  openResumed: (saleId: string, fromHold: ResumedHold) => Promise<boolean>;
  boxLane?: boolean;
  saleOnScreen?: boolean;
}

function mountDesk(initial: Props) {
  const onHeld = vi.fn();
  const hook = renderHook(
    (props: Props) =>
      useHeldSaleDesk({
        branchId: '0192f000-0000-7000-8000-00000000b001',
        // The list is not read in these tests: only the presses are.
        enabled: false,
        can: (_permission: Permission) => true,
        stationId: '0192f000-0000-7000-8000-00000000c002',
        boxLane: props.boxLane ?? false,
        saleOnScreen: props.saleOnScreen ?? false,
        holdSaleId: SALE_ID,
        onHeld,
        openResumed: props.openResumed,
      }),
    initial,
  );
  return { hook, onHeld };
}

beforeEach(() => {
  vi.stubGlobal('window', globalThis);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('Resume keeps its press until the sale is open on this screen', () => {
  it('a lost answer is pressed again under the same action id', async () => {
    const openResumed = vi.fn(async () => true);
    const { hook } = mountDesk({ openResumed });
    resumeCall.mockRejectedValueOnce(new NetworkError());
    await hook.result.current.resume(heldSale());
    await settle();
    expect(hook.result.current.refusal).toBe(
      'No answer from the platform — press Resume again when the connection is back: it picks up the same sale.',
    );
    resumeCall.mockResolvedValueOnce({ ...answer, replay: true });
    await hook.result.current.resume(heldSale());
    await settle();
    expect(resumeCall).toHaveBeenCalledTimes(2);
    expect(resumeCall.mock.calls[0]![1]).toBe(resumeCall.mock.calls[1]![1]);
    expect(openResumed).toHaveBeenCalledWith(SALE_ID, { label: 'ZZ TEST Khun Ben', note: null, paidSatang: 20_000 });
    expect(hook.result.current.refusal).toBeNull();
  });

  it('a sale the screen could not open is opened by the next press, under the same id', async () => {
    const openResumed = vi.fn(async () => false);
    const { hook } = mountDesk({ openResumed });
    resumeCall.mockResolvedValue(answer);
    await hook.result.current.resume(heldSale());
    await settle();
    expect(hook.result.current.refusal).toBe(
      'ZZ TEST Khun Ben was taken back to this till but could not be opened on the screen — press Resume again to open it.',
    );
    openResumed.mockResolvedValueOnce(true);
    hook.rerender({ openResumed });
    await hook.result.current.resume(heldSale());
    await settle();
    expect(resumeCall.mock.calls[0]![1]).toBe(resumeCall.mock.calls[1]![1]);
    expect(hook.result.current.refusal).toBeNull();
    // Opened: the next resume of anything is a new press.
    await hook.result.current.resume(heldSale());
    await settle();
    expect(resumeCall.mock.calls[2]![1]).not.toBe(resumeCall.mock.calls[1]![1]);
  });

  it('a refusal is final for that press, and shows the platform’s sentence', async () => {
    const openResumed = vi.fn(async () => true);
    const { hook } = mountDesk({ openResumed });
    resumeCall.mockRejectedValueOnce(
      new ApiError(409, 'SALE_HOLD_RESUMED', 'This sale was already taken back to Counter 2 by Som — it is no longer in Held sales.'),
    );
    await hook.result.current.resume(heldSale());
    await settle();
    expect(hook.result.current.refusal).toBe(
      'This sale was already taken back to Counter 2 by Som — it is no longer in Held sales.',
    );
    expect(openResumed).not.toHaveBeenCalled();
    resumeCall.mockResolvedValueOnce(answer);
    await hook.result.current.resume(heldSale());
    await settle();
    expect(resumeCall.mock.calls[1]![1]).not.toBe(resumeCall.mock.calls[0]![1]);
  });

  it('on the box lane, Resume says why it cannot be pressed and asks nothing', async () => {
    const { hook } = mountDesk({ openResumed: vi.fn(async () => true), boxLane: true });
    expect(hook.result.current.actionsFor(heldSale()).resumeReason).toBe(BOX_LANE_NO_RESUME);
    await hook.result.current.resume(heldSale());
    await settle();
    expect(resumeCall).not.toHaveBeenCalled();
    expect(hook.result.current.refusal).toBe(BOX_LANE_NO_RESUME);
  });

  it('with a sale on the screen, Resume waits and says so', () => {
    const { hook } = mountDesk({ openResumed: vi.fn(async () => true), saleOnScreen: true });
    expect(hook.result.current.actionsFor(heldSale()).resumeReason).toBe('Finish or cancel the sale on screen first.');
  });
});

describe('Hold sale and the refund keep their press across a lost answer', () => {
  it('a hold whose answer was lost is sent again under the same id, then clears the screen', async () => {
    const { hook, onHeld } = mountDesk({ openResumed: vi.fn(async () => true) });
    hook.result.current.openHoldDialog('part_paid');
    await settle();
    holdCall.mockRejectedValueOnce(new NetworkError());
    await hook.result.current.confirmHold('ZZ TEST Khun Ben', '');
    await settle();
    expect(hook.result.current.holdError).toBe('No answer from the platform. This screen has no connection.');
    expect(hook.result.current.holdKind).toBe('part_paid');
    holdCall.mockResolvedValueOnce({
      replay: true,
      hold: { ...heldSale(), kind: 'part_paid' },
    });
    await hook.result.current.confirmHold('ZZ TEST Khun Ben', '');
    await settle();
    expect(holdCall.mock.calls[0]![1].actionId).toBe(holdCall.mock.calls[1]![1].actionId);
    expect(onHeld).toHaveBeenCalledTimes(1);
    expect(hook.result.current.holdKind).toBeNull();
  });

  it('Cancel and refund retries a lost answer under the same id', async () => {
    const { hook } = mountDesk({ openResumed: vi.fn(async () => true) });
    refundCall.mockRejectedValueOnce(new NetworkError());
    await hook.result.current.refundHeld(heldSale(), 'Customer cancelled');
    await settle();
    expect(hook.result.current.refusal).toBe('No answer from the platform. This screen has no connection.');
    refundCall.mockResolvedValueOnce({ refund: { amountSatang: 20_000, number: 'R-T1-000001' } } as never);
    await hook.result.current.refundHeld(heldSale(), 'Customer cancelled');
    await settle();
    expect(refundCall.mock.calls[0]![1].actionId).toBe(refundCall.mock.calls[1]![1].actionId);
    expect(hook.result.current.refusal).toBeNull();
  });
});
