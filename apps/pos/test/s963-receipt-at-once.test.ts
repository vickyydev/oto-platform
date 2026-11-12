import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SCRUM-963 (8) — THE DOOR CHECK-IN DIALOG'S SUCCESS LINE ARRIVES WHOLE.
 *
 * The proof of 12 November (pictures 08a to 08c): after a drop-off sale the
 * dialog's line read "฿1444.50 • Cash" first and "Receipt Z95401-000001 • …"
 * about half a second later. The till asked the platform for the finished
 * sale (`useSaleIssue`) to learn its number, although the finalise answer it
 * already held carried it. Now that number is given to the read at once, so
 * the line (and the success screen's own) is whole from the start; the read
 * still brings the bands, the lines and the credit as before.
 */
const history = vi.hoisted(() => ({ getSale: vi.fn() }));
vi.mock('react', async () => ({ ...await vi.importActual('react'), ...await import('./support/hooks') }));
vi.mock('@/api/history', async () => ({ ...await vi.importActual('@/api/history'), getSale: history.getSale }));

import { paidLineOf, useSaleIssue, type SaleNumber } from '@/components/till/StepConfirmation';
import { renderHook } from './support/hooks';
import { settle } from './support/fixtures';

const SALE = '01990000-0000-7000-8000-000000000963';
const sale = { total: 1444.5, paymentMethod: 'cash' } as const;

beforeEach(() => { history.getSale.mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('the number the finalise answer carried is shown at once', () => {
  it('with it given, the line is whole before the platform’s read answers, and stays so after', async () => {
    let answer: (value: unknown) => void = () => undefined;
    history.getSale.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const given: SaleNumber = { kind: 'receipt', number: 'Z96301-000001' };
    const view = renderHook(() => useSaleIssue(SALE, given, null));
    expect(paidLineOf(sale, view.result.current.number)).toBe('Receipt Z96301-000001 • ฿1444.50 • Cash');
    answer({ sale: { receiptNumber: 'Z96301-000001' }, bands: [], lines: [], printJobs: [] });
    await settle();
    expect(paidLineOf(sale, view.result.current.number)).toBe('Receipt Z96301-000001 • ฿1444.50 • Cash');
    // The read still ran, for the bands, lines and credit.
    expect(history.getSale).toHaveBeenCalledWith(SALE);
    view.unmount();
  });

  it('without it, as before: the amount first, the number when the read answers', async () => {
    let answer: (value: unknown) => void = () => undefined;
    history.getSale.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    const view = renderHook(() => useSaleIssue(SALE, undefined, null));
    expect(paidLineOf(sale, view.result.current.number)).toBe('฿1444.50 • Cash');
    answer({ sale: { receiptNumber: 'Z96301-000001' }, bands: [], lines: [], printJobs: [] });
    await settle();
    expect(paidLineOf(sale, view.result.current.number)).toBe('Receipt Z96301-000001 • ฿1444.50 • Cash');
    view.unmount();
  });

  it('the counter till gives the number of the sale its writer finalised, for that sale only', () => {
    const till = readFileSync(path.resolve(import.meta.dirname, '..', 'src', 'pages', 'Till.tsx'), 'utf8');
    expect(till).toContain("const writtenReceipt = saleWriter.state.kind === 'written' && saleWriter.state.saleId === saleResult?.id ? saleWriter.state.sale.receiptNumber : null;");
    expect(till).toContain("const saleIssue = useSaleIssue(saleResult?.id ?? '', writtenReceipt ? { kind: 'receipt', number: writtenReceipt } : undefined, saleResult ? boxSaleIssue(saleResult.id) : null);");
    // The dialog reads the same number (SCRUM-953's line, unchanged).
    expect(till).toContain('paidLine={shownResult ? paidLineOf(shownResult, saleIssue.number) : null}');
  });
});
