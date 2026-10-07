import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IssuableDefinition } from '@/api/vouchers';
import type { FnbOrder, Sale, WalletEntry, Wristband } from '@/types';
import { StepConfirmation } from '@/components/till/StepConfirmation';
import { IssueVoucherRow } from '@/components/till/RedeemVoucher';
import { FnbConfirmation, confirmationLedger } from '@/components/fnb/FnbConfirmation';

/**
 * SCRUM-484 — THREE SMALL THINGS FROM THE WALLET WALKTHROUGH:
 *
 *   1  with the Credit Grants column showing, the bracelet rows fit their
 *      column again: "ALL DAY + MEAL" wraps inside its badge instead of being
 *      cut to "ALL" at the card's edge;
 *   2  the Issue a voucher picker gives its select the whole line, and the
 *      chosen promotion's full name as its tooltip;
 *   3  the F&B success screen's Wallet ledger includes the spend the order
 *      just made.
 *
 * The layout itself was measured in a browser at 1600px (the customer display
 * open and folded) and at 1366 and 1440; these checks pin the classes that
 * produce it, since the runner has no layout engine.
 */
beforeEach(() => {
  vi.stubGlobal('React', React);
});

const html = (el: React.ReactElement) => renderToStaticMarkup(el).replace(/&#x27;/g, "'");
const classesOf = (tag: string | undefined) =>
  (tag ?? '').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&').split(/\s+/).filter(Boolean);

// --- 1 -------------------------------------------------------------------------------

describe('1 — the bracelet rows fit their column', () => {
  const ticket = (name: string, durationLabel: string) => ({ id: name, name, durationLabel }) as unknown as Sale['lines'][number]['ticketType'];
  const sale = {
    // Not a platform id: the screen asks the platform for nothing.
    id: 'local-sale-1',
    operatorId: 'o',
    operatorName: 'Staff',
    tier: 'tourist',
    lines: [
      { id: 'l1', ticketType: ticket('Eat & Play Kids Pass', 'All Day + Meal'), tier: 'tourist', kids: 1, adults: 1, socks: 0, addOns: [], lineTotal: 1650 },
    ],
    manualDiscounts: [],
    total: 1650,
    quoted: { taxRows: [] },
    creditGrants: [],
    bracelets: { adults: 1, children: 1 },
    createdAt: '2026-10-07T10:00:00.000Z',
    status: 'paid',
    refunds: [],
  } as unknown as Sale;
  const render = () => html(React.createElement(StepConfirmation, { sale, onNewSale: () => undefined, saleNumber: { kind: 'receipt', number: 'T1-000001' } }));

  it('the rows scroll as a block, not as a table as wide as its longest caption', () => {
    // Radix lays a scroll area's content out as `display: table`; overridden,
    // the rows are the column's width and their captions truncate.
    const out = render();
    const areas = [...out.matchAll(/class="(relative overflow-hidden[^"]*)"/g)].map((m) => classesOf(m[1]));
    expect(areas).toHaveLength(1); // the bracelets column; no credit column without a voucher printout
    expect(areas[0]).toContain('[&_[data-radix-scroll-area-viewport]>div]:!block');
  });

  it('the duration badge may wrap, and the row text keeps room for its longest word', () => {
    const out = render();
    const badges = [...out.matchAll(/<div class="([^"]*rounded-full text-xs[^"]*)">All Day \+ Meal<\/div>/g)].map((m) => classesOf(m[1]));
    expect(badges).toHaveLength(2); // the child row and the adult row
    for (const badge of badges) {
      expect(badge).not.toContain('shrink-0');
      expect(badge).toContain('text-center');
    }
    const text = /<div class="([^"]*)"><div class="text-lg font-bold">1× Child bracelet/.exec(out)?.[1];
    expect(classesOf(text)).toEqual(expect.arrayContaining(['flex-1', 'min-w-[5.5rem]']));
  });

  it('a truncated caption is given in full on hover', () => {
    expect(render()).toContain('title="All Day + Meal • Eat &amp; Play Kids Pass"');
  });
});

// --- 2 -------------------------------------------------------------------------------

describe('2 — the Issue a voucher picker', () => {
  const def = (over: Partial<IssuableDefinition>): IssuableDefinition => ({
    id: 'd', code: 'c', nameEn: 'Promotion', nameTh: null, kind: 'discount', valueSatang: 10_000, valueBp: null,
    validFrom: null, validUntil: null, usageLimit: null, redeemed: 0, ...over,
  }) as IssuableDefinition;
  const long = def({ id: 'long', nameEn: 'Birthday month free kid admission voucher', usageLimit: 5, redeemed: 0 });
  const row = (options: IssuableDefinition[] | null, chosen = '') => html(React.createElement(IssueVoucherRow, {
    options, chosen, busy: false, answer: null, onChoose: () => undefined, onIssue: () => undefined, onClose: () => undefined,
  }));
  const selectOf = (out: string) => /<select([^>]*)>/.exec(out)?.[1] ?? '';

  it('the select takes the whole first line; the buttons go under it', () => {
    const select = classesOf(/class="([^"]*)"/.exec(selectOf(row([long])))?.[1]);
    expect(select).toContain('basis-full');
    expect(select).not.toContain('basis-40');
  });

  it('its tooltip is the prompt, then the chosen promotion in full', () => {
    expect(selectOf(row([long]))).toContain('title="Choose a promotion…"');
    expect(selectOf(row(null))).toContain('title="Loading…"');
    expect(selectOf(row([long], 'long'))).toContain('title="Birthday month free kid admission voucher (0/5 used)"');
    // The option reads as it did.
    expect(row([long])).toContain('<option value="long">Birthday month free kid admission voucher (0/5 used)</option>');
  });
});

// --- 3 -------------------------------------------------------------------------------

describe('3 — the F&B Wallet ledger includes the order’s own spend', () => {
  const grant: WalletEntry = { kind: 'grant', amountTHB: 350, source: 'ticket_sale', at: '2026-10-07T09:00:00.000Z', by: 'Reception' };
  const tab = (ledger?: WalletEntry[]): Wristband => ({
    id: '01a0f899-49d8-70f6-81d8-52e8e5c213ff', code: 'QR-MRKD90Z65F1ESEQMVSPV', customerNickname: 'Mint', creditBalanceTHB: 350,
    gateAccess: false, ...(ledger ? { ledger } : {}),
  });
  const order = (creditUsed: number, wristband: Wristband | null = tab([grant])): FnbOrder => ({
    id: '0001', operatorId: 'op', operatorName: 'Nok', ...(wristband ? { wristband } : {}), lines: [], manualDiscounts: [], total: 60, pickupCode: '042',
    payment: { creditUsed, cash: 60 - creditUsed, card: 0, promptpay: 0 }, createdAt: '2026-10-07T10:15:00.000Z', status: 'paid', refunds: [],
  }) as unknown as FnbOrder;

  it('the spend the platform took is appended, as the prototype appended it to the band', () => {
    expect(confirmationLedger(order(60))).toEqual([
      grant,
      { kind: 'spend', amountTHB: -60, source: 'fnb_order', at: '2026-10-07T10:15:00.000Z', by: 'Nok' },
    ]);
  });

  it('a split counts only the credit part', () => {
    expect(confirmationLedger(order(35)).at(-1)).toMatchObject({ kind: 'spend', amountTHB: -35 });
  });

  it('an order that spent no credit adds nothing', () => {
    expect(confirmationLedger(order(0))).toEqual([grant]);
    expect(confirmationLedger(order(0, tab()))).toEqual([]);
    expect(confirmationLedger(order(0, null))).toEqual([]);
  });

  it('the scanned tab is not changed', () => {
    const o = order(60);
    confirmationLedger(o);
    expect(o.wristband?.ledger).toEqual([grant]);
  });

  it('the screen lists the spend first, under the balance it left', () => {
    const out = html(React.createElement(FnbConfirmation, { order: order(60), newBalance: 290, onNewOrder: () => undefined }));
    const list = /data-testid="wallet-ledger">([\s\S]*?)<\/div><\/div><\/div>/.exec(out)?.[0] ?? out.slice(out.indexOf('data-testid="wallet-ledger"'));
    expect(out).toContain('฿290');
    // Amounts read as the prototype wrote them: "+฿350", and a spend "฿-60".
    const spendAt = list.indexOf('฿-60');
    const grantAt = list.indexOf('+฿350');
    expect(spendAt).toBeGreaterThan(-1);
    expect(grantAt).toBeGreaterThan(spendAt);
    expect(list).toContain('fnb order');
  });
});
