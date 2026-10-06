import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_FLOAT, applyEndOfDayEntries, recomputeEndOfDay, type EndOfDayRecord } from '@oto/shared';
import { api } from '@/api/client';
import {
  closeBodyOf,
  closeEndOfDay,
  edcTerminalsOf,
  floatSourceLabelOf,
  getEndOfDay,
  screenEndOfDay,
  withActual,
  withCounted,
  withFloatLeft,
  withNotes,
  withVouchers,
} from '@/api/endOfDay';
import { CashCountCard } from '@/components/eod/CashCountCard';
import { CashMovementList } from '@/components/eod/CashMovementList';
import { ReconSummary } from '@/components/eod/ReconSummary';
import { ReconTable } from '@/components/eod/ReconTable';

/**
 * S2-15a round 1 — the End of Day screens on the platform's record.
 *
 *   - the record the platform sends is what the prototype's components show, in
 *     baht, with the prototype's words (the float's source, "whole branch
 *     drawer", the TID labels);
 *   - what staff type is recomputed with the platform's own `recomputeEndOfDay`,
 *     and the close body carries only the entries — so the server, rebuilding the
 *     day and applying them, arrives at exactly what the screen showed;
 *   - the day's paid-outs and safe drops are listed under the count.
 */

// The components are compiled with the classic JSX runtime in this runner.
Object.assign(globalThis, { React });

afterEach(() => {
  vi.restoreAllMocks();
});

const BRANCH = '0192f000-0000-7000-8000-00000000b001';
const MANAGER = '0192f000-0000-7000-8000-00000000a004';
const RECEPTION = '0192f000-0000-7000-8000-00000000a002';

/** An open day as `GET /branches/:id/end-of-day` answers it. */
function openDay(): EndOfDayRecord {
  return recomputeEndOfDay<EndOfDayRecord>({
    id: `eod-${BRANCH}-2026-10-02`,
    branchId: BRANCH,
    date: '2026-10-02',
    status: 'open',
    lines: [
      { channel: 'cash', expectedSatang: 2_000_50, actualSatang: null, differenceSatang: 0 },
      { channel: 'promptpay', expectedSatang: 450_00, actualSatang: null, differenceSatang: 0 },
      { channel: 'card:65703235', expectedSatang: 1_200_00, actualSatang: null, differenceSatang: 0 },
      { channel: 'card:NO-TERMINAL', expectedSatang: 99_99, actualSatang: null, differenceSatang: 0 },
      { channel: 'ewallet', expectedSatang: 0, actualSatang: null, differenceSatang: 0 },
      { channel: 'bank_transfer', expectedSatang: 0, actualSatang: null, differenceSatang: 0 },
      { channel: 'party_prepay', expectedSatang: 0, actualSatang: null, differenceSatang: 0 },
      { channel: 'credit', expectedSatang: 150_00, actualSatang: null, differenceSatang: 0 },
    ],
    cashCount: { countedSatang: null, floatSatang: 5_000_00, cashIncomeSatang: null },
    floatFromDate: '2026-10-01',
    floatLeftSatang: DEFAULT_FLOAT,
    vouchers: { handedOut: null, redeemed: null },
    totalExpectedSatang: 0,
    totalActualSatang: 0,
    totalDifferenceSatang: 0,
    notes: null,
    closedBy: null,
    closedAt: null,
    terminals: [{ tid: '65703235', label: 'EDC 1' }],
    cashMovements: [
      {
        id: '0192f000-0000-7000-8000-00000000c001',
        kind: 'paid_out',
        amountSatang: 300_00,
        reason: 'Ice from the shop next door',
        businessDate: '2026-10-02',
        actor: { accountId: RECEPTION, name: 'Som' },
        approver: { accountId: MANAGER, name: 'Khun Lek' },
        witness: null,
        createdAt: '2026-10-02T08:00:00.000Z',
      },
    ],
  });
}

const markup = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

describe('the platform’s record on the prototype’s components', () => {
  it('reads the day and closes it through the platform', async () => {
    const get = vi.spyOn(api, 'get').mockResolvedValue(openDay());
    await getEndOfDay(BRANCH, '2026-10-02');
    expect(get).toHaveBeenCalledWith(`/branches/${BRANCH}/end-of-day?date=2026-10-02`);
    const post = vi.spyOn(api, 'post').mockResolvedValue(openDay());
    await closeEndOfDay(BRANCH, closeBodyOf(openDay()), 'key-1');
    expect(post).toHaveBeenCalledWith(`/branches/${BRANCH}/end-of-day/close`, expect.objectContaining({ date: '2026-10-02' }), { idempotencyKey: 'key-1' });
  });

  it('shows baht, the TID labels and the float’s source in the prototype’s words', () => {
    const rec = openDay();
    const screen = screenEndOfDay(rec);
    expect(screen.lines[0]).toEqual({ channel: 'cash', expectedTHB: 2_000.5, actualTHB: null, differenceTHB: 0 });
    expect(screen.cashCount.floatTHB).toBe(5_000);
    expect(screen.totalExpectedTHB).toBeCloseTo(3_900.49, 2);
    expect(floatSourceLabelOf(rec)).toBe('carried from 2026-10-01 close');
    expect(floatSourceLabelOf({ floatFromDate: null })).toBe('standard opening float (no prior close)');

    const table = markup(React.createElement(ReconTable, { lines: screen.lines, terminals: edcTerminalsOf(rec), readOnly: false, onActual: () => {} }));
    expect(table).toContain('Card · EDC 1 (65703235)');
    expect(table).toContain('Card · NO-TERMINAL');
    expect(table).toContain('PromptPay / QR');
    expect(table).toContain('฿2,000.5');
    expect(table).toContain('from cash count');

    const card = markup(
      React.createElement(
        CashCountCard,
        {
          cashCount: screen.cashCount,
          expectedCashTHB: screen.lines[0]!.expectedTHB,
          floatSourceLabel: floatSourceLabelOf(rec),
          readOnly: false,
          onCounted: () => {},
        },
        React.createElement(CashMovementList, { movements: rec.cashMovements }),
      ),
    );
    expect(card).toContain('whole branch drawer');
    expect(card).toContain('carried from 2026-10-01 close');
    expect(card).toContain('฿5,000');
    expect(card).toContain('Paid out');
    expect(card).toContain('approved by Khun Lek');
    expect(card).toContain('taken off expected cash');

    expect(markup(React.createElement(ReconSummary, { record: screen }))).toBeTruthy();
    // No movements, no list: the prototype's card is unchanged.
    expect(markup(React.createElement(CashMovementList, { movements: [] }))).toBe('');
  });

  it('a closed record shows who locked it', () => {
    const closed: EndOfDayRecord = { ...openDay(), status: 'closed', closedBy: { accountId: RECEPTION, name: 'Som' }, closedAt: '2026-10-02T14:00:00.000Z', notes: 'All good' };
    const screen = screenEndOfDay(closed);
    expect(screen.status).toBe('closed');
    expect(screen.closedBy).toBe('Som');
    expect(screen.notes).toBe('All good');
  });
});

describe('what staff type is recomputed as the platform will', () => {
  it('the screen’s figures equal the server applying the close body to the same day', () => {
    let rec = openDay();
    rec = withActual(rec, 'promptpay', 450);
    rec = withActual(rec, 'card:65703235', 1_150);
    rec = withActual(rec, 'cash', 1); // never typed: the cash line comes from the count
    rec = withCounted(rec, 7_020);
    rec = withFloatLeft(rec, 6_000);
    rec = withVouchers(rec, { handedOut: 4 });
    rec = withNotes(rec, '฿50 short on EDC 1');

    expect(rec.cashCount.cashIncomeSatang).toBe(2_020_00);
    expect(rec.lines[0]).toMatchObject({ actualSatang: 2_020_00, differenceSatang: 19_50 });
    expect(rec.lines[2]).toMatchObject({ actualSatang: 1_150_00, differenceSatang: -50_00 });

    const body = closeBodyOf(rec);
    expect(body).toEqual({
      date: '2026-10-02',
      actuals: [
        { channel: 'promptpay', actualSatang: 450_00 },
        { channel: 'card:65703235', actualSatang: 1_150_00 },
        { channel: 'card:NO-TERMINAL', actualSatang: null },
        { channel: 'ewallet', actualSatang: null },
        { channel: 'bank_transfer', actualSatang: null },
        { channel: 'party_prepay', actualSatang: null },
        { channel: 'credit', actualSatang: null },
      ],
      countedSatang: 7_020_00,
      floatLeftSatang: 6_000_00,
      vouchers: { handedOut: 4, redeemed: null },
      notes: '฿50 short on EDC 1',
    });
    // What `closeEndOfDay` on the platform does with that body.
    const server = applyEndOfDayEntries(openDay(), body);
    expect(server.lines).toEqual(rec.lines);
    expect(server.totalExpectedSatang).toBe(rec.totalExpectedSatang);
    expect(server.totalActualSatang).toBe(rec.totalActualSatang);
    expect(server.totalDifferenceSatang).toBe(rec.totalDifferenceSatang);
  });
});
