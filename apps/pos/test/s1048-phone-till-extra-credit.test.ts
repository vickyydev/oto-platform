import * as React from 'react';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * SCRUM-1048 — EXTRA FOOD CREDIT ON ANY CHILD TICKET, ON THE PHONE TILL TOO.
 *
 * The owner's answer: "Extra food credit can be added on any child ticket, as
 * its own line on the order." The counter till offers it on its order panel
 * (`s1048-extra-credit.test.ts`); the phone till draws the same panel, on its
 * Review step and in its cart sheet, and now passes it the same control, with
 * the same rules around it: the line follows its ticket, keeps its amount
 * through a rate change, is named in the discount list, and is sold online
 * only — not offered through the counter's box, and Pay says why if a line
 * is on the order there.
 */

vi.mock('react', async (original) => ({ ...(await original<typeof import('react')>()), ...(await import('./support/hooks')) }));
beforeEach(() => { vi.stubGlobal('React', React); });
afterEach(() => { vi.unstubAllGlobals(); });

import { MobileCartSheet } from '@/components/mobile/MobileCartSheet';
import { OrderSummary } from '@/components/till/OrderSummary';
import { renderHook } from './support/hooks';

type Element = React.ReactElement<Record<string, unknown>>;
const elements = (node: unknown): Element[] => Array.isArray(node) ? node.flatMap(elements) :
  React.isValidElement<Record<string, unknown>>(node) ? [node, ...elements(node.props.children)] : [];

const phoneTill = readFileSync(path.join(import.meta.dirname, '..', 'src', 'components', 'mobile', 'MobileTill.tsx'), 'utf8');

describe('the phone till\'s cart sheet', () => {
  const sheet = (extra: Record<string, unknown>) => {
    const view = renderHook(() => MobileCartSheet({
      open: true, onOpenChange: () => undefined, tier: 'tourist', customerName: 'ZZ TEST', lines: [], activeLineId: null,
      discounts: [], manualDiscounts: [], onUpdateLine: () => undefined, onConfigureLine: () => undefined,
      onRemoveLine: () => undefined, onRemoveDiscount: () => undefined, onAddManualDiscount: () => undefined,
      onRemoveManualDiscount: () => undefined, onPay: () => undefined, onCancel: () => undefined, canPay: true,
      totals: { subtotal: 0, discount: 0, total: 0, vat: 0, serviceCharge: 0 } as never,
      ...extra,
    } as Parameters<typeof MobileCartSheet>[0]));
    const panel = elements(view.result.current).find((node) => node.type === OrderSummary);
    view.unmount();
    return panel!;
  };

  it('hands the order panel the extra food credit control the phone till gives it', () => {
    const add = vi.fn();
    expect(sheet({ onAddExtraCredit: add }).props.onAddExtraCredit).toBe(add);
  });

  it('offers none where the phone till gives none (working through the counter box)', () => {
    expect('onAddExtraCredit' in sheet({}).props).toBe(false);
  });
});

describe('the phone till\'s own wiring', () => {
  it('adds the line through the shared rule and keeps it following its ticket', () => {
    expect(phoneTill).toContain("import { followTickets, kidLabel, withExtraCredit } from '@/lib/extraCredit';");
    expect(phoneTill).toMatch(/const handleAddExtraCredit = \(ticketLineId: string, kidOrdinal: number, amountTHB: number\) => \{\s*setLines\(\(prev\) =>\s*withExtraCredit\(prev, ticketLineId, kidOrdinal, amountTHB,/);
    expect(phoneTill).toMatch(/const followed = followTickets\(lines\);\s*if \(followed === lines\) return;\s*setLines\(followed\);\s*setManualDiscounts\(\(mds\) => dropOrphanedDiscounts\(mds, followed\)\);\s*\}, \[lines\]\);/);
  });

  it('keeps the line\'s amount when the rate changes', () => {
    expect(phoneTill).toContain('lineTotal: l.dropOff || l.extraCredit ? l.lineTotal : computeLineTotal({ ...l, tier: t }),');
  });

  it('offers it on the Review step and in the cart sheet, never through the counter\'s box', () => {
    expect(phoneTill.match(/\{\.\.\.\(lane === 'box' \? \{\} : \{ onAddExtraCredit: handleAddExtraCredit \}\)\}/g)).toHaveLength(2);
  });

  it('holds Pay on the box lane with the line on the order, and says why beneath the total (a phone shows no button title)', () => {
    expect(phoneTill).toContain("const extraCreditOffline = lane === 'box' && lines.some((l) => l.extraCredit);");
    expect(phoneTill).toMatch(/const canPay =\s*lines\.some\(\(l\) => l\.kids \+ l\.adults > 0\) && allLengthsChosen && allNanniesAssigned && !extraCreditOffline;/);
    expect(phoneTill).toMatch(/\{extraCreditOffline && \(\s*<p className="flex items-start gap-2 text-xs text-amber-300" data-testid="extra-credit-offline">/);
  });

  it('names the line in the discount list as the counter does, whole-line only', () => {
    expect(phoneTill).toContain('? `Extra food credit · ${kidLabel(l.extraCredit.kidOrdinal)}`');
    expect(phoneTill).toContain('components: l.dropOff || l.extraCredit ? undefined : lineDiscountComponents(l),');
  });
});
