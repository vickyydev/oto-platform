import * as React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WALLET_TENDER_CODE, type WalletEntryView, type WalletView } from '@oto/shared';
import type { IssuableDefinition } from '@/api/vouchers';
import type { FnbOrder, WalletEntry, Wristband } from '@/types';
import type { PaymentSettlement } from '@/lib/usePaymentStage';
import { walletEntriesOf, wristbandOfWallet, type ApiWalletRead } from '@/api/wallet';
import { fnbPaymentResult, walletBalanceAfter } from '@/components/fnb/FnbPayment';
import { FnbConfirmation, confirmationLedger } from '@/components/fnb/FnbConfirmation';
import { IssueVoucherRow } from '@/components/till/RedeemVoucher';

/**
 * SCRUM-443 + SCRUM-484 — REVIEW of fix lane F3, written from outside the
 * builder's own tests.
 *
 *  1. THE F&B WALLET LEDGER against the platform's own row. The entry the
 *     success screen adds is compared with the row the platform writes for the
 *     spend (`debitForSale` → `ledgerOf`, as the till reads it through
 *     `walletEntriesOf`), on an order built the way both stations build it
 *     (the tab as SCANNED, the platform's settlement, `fnbPaymentResult`). The
 *     list then adds up to the balance the screen shows, and a re-scan after
 *     the spend — the platform's ledger, spend and all — never counts it twice.
 *  2. THE TRIPWIRE the builder asked for: the stations hand the screen the tab
 *     as scanned. A station that starts re-reading the wallet into its tab after
 *     the spend would make `confirmationLedger` add the spend a second time.
 *  3. THE ISSUE PICKER with the park's real promotions (the seed's six, the
 *     longest "Free Bracelet Workshop"): the chosen one is the select's
 *     tooltip, read as its option reads.
 *
 * The layout claims (the chip, the bracelet badge, the picker's width) were
 * measured in Chromium against the real components, not here: this runner has
 * no layout engine.
 */
beforeEach(() => {
  vi.stubGlobal('React', React);
});

const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/&#x27;/g, "'");

// --- 1 -------------------------------------------------------------------------------

const WALLET_ID = '01990000-0000-7000-8000-0000000000a1';
const SALE_ID = '01990000-0000-7000-8000-0000000000b1';
const NEXT_SALE_ID = '01990000-0000-7000-8000-0000000000b2';
const BRANCH = '01990000-0000-7000-8000-0000000000c1';
const STATION = '01990000-0000-7000-8000-0000000000d1';
/** The seeded reception account's employee: no nickname, so the platform names it by `name`. */
const STAFF = 'Som (Reception)';

const wallet = (balanceSatang: number): WalletView => ({
  id: WALLET_ID,
  branchId: BRANCH,
  memberId: null,
  holderName: 'Mint',
  status: 'active',
  balanceSatang,
  keys: [{ kind: 'voucher_qr', display: 'QR-MRKD90Z65F1ESEQMVSPV' }],
  createdAt: '2026-10-07T09:00:00.000Z',
  expiresAt: null,
  lapsedSatang: 0,
});

/** A row as the platform's `ledgerOf` maps `wallet_entry` for the till. */
const row = (over: Partial<WalletEntryView> & Pick<WalletEntryView, 'id' | 'kind' | 'source' | 'amountSatang' | 'balanceAfterSatang' | 'at'>): WalletEntryView => ({
  saleId: null,
  refundId: null,
  branchId: BRANCH,
  stationId: STATION,
  offline: false,
  businessDate: '2026-10-07',
  actorName: STAFF,
  expiresAt: null,
  ...over,
});

const grantRow = row({
  id: '01990000-0000-7000-8000-0000000000e1',
  kind: 'grant',
  source: 'ticket_sale',
  amountSatang: 35_000,
  balanceAfterSatang: 35_000,
  at: '2026-10-07T09:00:00.000Z',
});

/** The spend row `debitForSale` writes for an F&B sale: `fnb_order`, minus the attempt's amount, by the request's account. */
const spendRow = (id: string, saleId: string, amountSatang: number, balanceAfterSatang: number, at: string) =>
  row({ id, kind: 'spend', source: 'fnb_order', amountSatang: -amountSatang, balanceAfterSatang, saleId, at });

/** What `usePaymentStage` records when the platform settles the wallet tender. */
const creditSettlement = (amountSatang: number, balanceAfterSatang?: number): PaymentSettlement => ({
  attemptId: `attempt-${amountSatang}`,
  method: WALLET_TENDER_CODE,
  kind: 'other',
  amountSatang,
  tenderedSatang: amountSatang,
  changeSatang: 0,
  ...(balanceAfterSatang !== undefined ? { walletBalanceAfterSatang: balanceAfterSatang } : {}),
});

/** The record both stations build in their confirm handler (`OrderStation`, `MobileOrderStation`). */
function stationOrder(scanned: Wristband, settlements: PaymentSettlement[], createdAt: string): { order: FnbOrder; newBalance: number | null } {
  const payment = fnbPaymentResult(settlements);
  const balanceAfter = walletBalanceAfter(settlements) ?? scanned.creditBalanceTHB ?? null;
  const paidWristband = balanceAfter !== null ? { ...scanned, creditBalanceTHB: balanceAfter } : scanned;
  const order = {
    id: '0001',
    operatorId: 'acc-som',
    operatorName: STAFF,
    wristband: paidWristband,
    lines: [],
    manualDiscounts: [],
    total: 60,
    pickupCode: '042',
    payment,
    createdAt,
    status: 'paid',
    refunds: [],
  } as unknown as FnbOrder;
  return { order, newBalance: balanceAfter };
}

const withoutAt = (entries: readonly WalletEntry[]) => entries.map(({ at: _at, ...rest }) => rest);
const sum = (entries: readonly WalletEntry[]) => entries.reduce((total, e) => total + e.amountTHB, 0);

describe('1 — the F&B wallet ledger matches the platform’s row, and nothing counts twice', () => {
  const before: ApiWalletRead = { wallet: wallet(35_000), ledger: [grantRow] };
  const scanned = wristbandOfWallet(before, 'QR-MRKD90Z65F1ESEQMVSPV');
  const spent = spendRow('01990000-0000-7000-8000-0000000000f1', SALE_ID, 6_000, 29_000, '2026-10-07T10:15:00.120Z');

  it('the entry the screen adds is the platform’s spend row, field for field (its time is the till’s, which the list does not show)', () => {
    const { order } = stationOrder(scanned, [creditSettlement(6_000, 29_000)], '2026-10-07T10:15:00.450Z');
    const platform = walletEntriesOf([grantRow, spent]);
    expect(withoutAt(confirmationLedger(order))).toEqual(withoutAt(platform));
    // The time is the till's own clock, a moment after the platform's row; the list prints no time.
    expect(confirmationLedger(order).at(-1)?.at).toBe('2026-10-07T10:15:00.450Z');
  });

  it('a split takes only the credit part, as the platform’s row does', () => {
    const cash: PaymentSettlement = { attemptId: 'cash-1', method: 'cash', kind: 'cash', amountSatang: 2_500, tenderedSatang: 3_000, changeSatang: 500 };
    const { order, newBalance } = stationOrder(scanned, [creditSettlement(3_500, 31_500), cash], '2026-10-07T10:15:00.450Z');
    const platform = walletEntriesOf([grantRow, spendRow('01990000-0000-7000-8000-0000000000f2', SALE_ID, 3_500, 31_500, 'x')]);
    expect(withoutAt(confirmationLedger(order))).toEqual(withoutAt(platform));
    expect(sum(confirmationLedger(order))).toBe(newBalance);
  });

  it('the list adds up to the balance the screen shows under it', () => {
    const { order, newBalance } = stationOrder(scanned, [creditSettlement(6_000, 29_000)], '2026-10-07T10:15:00.450Z');
    expect(newBalance).toBe(290);
    expect(sum(confirmationLedger(order))).toBe(290);
  });

  it('the screen draws the spend once, newest first', () => {
    const { order, newBalance } = stationOrder(scanned, [creditSettlement(6_000, 29_000)], '2026-10-07T10:15:00.450Z');
    const out = html(React.createElement(FnbConfirmation, { order, newBalance, onNewOrder: () => undefined }));
    const list = out.slice(out.indexOf('data-testid="wallet-ledger"'));
    expect(list.match(/฿-60/g)).toHaveLength(1);
    expect(list.match(/>spend</g)).toHaveLength(1);
    expect(list.indexOf('฿-60')).toBeLessThan(list.indexOf('+฿350'));
    expect(out).toContain('฿290');
  });

  it('a re-scan after the spend reads the platform’s row once; the next order adds only its own', () => {
    const after: ApiWalletRead = { wallet: wallet(29_000), ledger: [grantRow, spent] };
    const rescanned = wristbandOfWallet(after, 'QR-MRKD90Z65F1ESEQMVSPV');
    expect(rescanned.creditBalanceTHB).toBe(290);
    expect(rescanned.ledger?.filter((e) => e.kind === 'spend')).toHaveLength(1);

    // A cash-only order on the re-scanned tab: the list is the platform's, spend counted once.
    const cashOnly = stationOrder(rescanned, [{ attemptId: 'cash-2', method: 'cash', kind: 'cash', amountSatang: 6_000, tenderedSatang: 6_000, changeSatang: 0 }], '2026-10-07T10:30:00.000Z');
    expect(confirmationLedger(cashOnly.order)).toEqual(rescanned.ledger);
    expect(sum(confirmationLedger(cashOnly.order))).toBe(cashOnly.newBalance);

    // A second credit order: two spends in all, each once, and still the balance shown.
    const second = stationOrder(rescanned, [creditSettlement(10_000, 19_000)], '2026-10-07T10:31:00.000Z');
    const ledger = confirmationLedger(second.order);
    expect(ledger.filter((e) => e.kind === 'spend').map((e) => e.amountTHB)).toEqual([-60, -100]);
    expect(sum(ledger)).toBe(190);
    expect(second.newBalance).toBe(190);
    const platformAfterSecond = walletEntriesOf([grantRow, spent, spendRow('01990000-0000-7000-8000-0000000000f3', NEXT_SALE_ID, 10_000, 19_000, 'x')]);
    expect(withoutAt(ledger)).toEqual(withoutAt(platformAfterSecond));
  });

  it('the screen keeps no copy: drawing it again from the same record draws the same list', () => {
    const { order, newBalance } = stationOrder(scanned, [creditSettlement(6_000, 29_000)], '2026-10-07T10:15:00.450Z');
    const first = html(React.createElement(FnbConfirmation, { order, newBalance, onNewOrder: () => undefined }));
    const again = html(React.createElement(FnbConfirmation, { order, newBalance, onNewOrder: () => undefined }));
    expect(again).toBe(first);
    expect(order.wristband?.ledger).toEqual(walletEntriesOf([grantRow]));
  });
});

// --- 2 -------------------------------------------------------------------------------

describe('2 — tripwire: the stations hand the success screen the tab as scanned', () => {
  /**
   * `confirmationLedger` appends this order's spend to the tab's ledger. That is
   * right only while the tab is the one SCANNED before the order. If a station
   * starts writing a wallet read taken after the spend into its tab, the
   * platform's row is already in that ledger and the screen would show it
   * twice — change `confirmationLedger` in the same commit.
   */
  const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
  for (const [name, rel] of [
    ['OrderStation', '../src/pages/OrderStation.tsx'],
    ['MobileOrderStation', '../src/components/mobile/order-station/MobileOrderStation.tsx'],
  ] as const) {
    it(`${name}: the tab is set only by a scan, a corrected order or a reset, and the record carries it`, () => {
      const source = read(rel);
      const calls = [...source.matchAll(/setWristband\(([^;]*?)\);/g)].map((m) => m[1]!.trim()).sort();
      expect(calls).toEqual(['correction.wristband ?? null', 'null', 'wb']);
      expect(source).toMatch(/const servedWristband = wristband \? withPrepaidServed\(wristband, lines\) : wristband;/);
      expect(source).toMatch(/wristband: paidWristband \?\? undefined,/);
      expect(source).toMatch(/order=\{completedOrder\}/);
    });
  }
});

// --- 3 -------------------------------------------------------------------------------

describe('3 — the Issue picker with the park’s real promotions', () => {
  // The seed's six definitions (packages/db/src/seed/index.ts), as the platform
  // lists them for the till: by English name, none with a usage limit.
  const seeded = ['1+1 Kids Ticket', '100 THB Voucher', '150 THB Voucher', '200 THB Voucher', 'Free Bracelet Workshop', 'Kids Pizza'].map(
    (nameEn, i) =>
      ({
        id: `d${i}`, code: `c${i}`, nameEn, nameTh: null, kind: 'discount', valueSatang: 10_000, valueBp: null,
        validFrom: null, validUntil: null, usageLimit: null, redeemed: 0,
      }) as IssuableDefinition,
  );
  const render = (options: IssuableDefinition[] | null, chosen: string) =>
    html(React.createElement(IssueVoucherRow, {
      options, chosen, busy: false, answer: null, onChoose: () => undefined, onIssue: () => undefined, onClose: () => undefined,
    }));
  const selectTag = (out: string) => /<select([^>]*)>/.exec(out)?.[1] ?? '';

  it('the longest seeded name is the tooltip once chosen, exactly as its option reads', () => {
    const out = render(seeded, 'd4');
    expect(selectTag(out)).toContain('title="Free Bracelet Workshop"');
    expect(out).toContain('<option value="d4" selected="">Free Bracelet Workshop</option>');
  });

  it('a used-up promotion names its count in the tooltip as in the list, and stays greyed', () => {
    const usedUp = { ...seeded[4]!, usageLimit: 3, redeemed: 3 };
    const out = render([usedUp], 'd4');
    expect(selectTag(out)).toContain('title="Free Bracelet Workshop (3/3 used)"');
    expect(out).toMatch(/<option value="d4" disabled="" selected="">Free Bracelet Workshop \(3\/3 used\)<\/option>/);
    // Issue stays refused for it, as before the change.
    expect(out).toMatch(/<button[^>]*disabled=""[^>]*>Issue &amp; print<\/button>/);
  });

  it('a choice the list no longer holds falls back to the prompt, never a stale name', () => {
    expect(selectTag(render(seeded, 'gone'))).toContain('title="Choose a promotion…"');
  });
});
