import { describe, expect, it } from 'vitest';
import { parsePackQuantity, reorderPointFor, type StockPack } from '../src';

/**
 * SCRUM-496 review, entries 32 and 36: the pack parser and the usage-based
 * reorder point measured against a verbatim copy of the approved rules
 * (lib/stockUnits.ts:16-55 parseUnitCombo; lib/inventory.ts:55-58 usage × lead).
 */
function approvedParseUnitCombo(raw: string, units: readonly StockPack[]): number {
  const str = raw.trim().toLowerCase();
  if (!str) return 0;
  const totalFromSegment = (seg: string): number => {
    const n = parseFloat(seg);
    if (isNaN(n)) return 0;
    return Math.max(0, n);
  };
  const parts = str.split('+').map((p) => p.trim());
  let total = 0;
  for (const part of parts) {
    if (!part) continue;
    let matched = false;
    for (const unit of units) {
      const label = unit.label.toLowerCase();
      const re = new RegExp(`^([\\d.]+)\\s*${label}s?$`);
      const m = re.exec(part);
      if (m) {
        const qty = parseFloat(m[1]!);
        if (!isNaN(qty)) {
          total += Math.max(0, qty) * unit.eaches;
          matched = true;
          break;
        }
      }
    }
    if (!matched) total += totalFromSegment(part);
  }
  return Math.round(total);
}

const PACKS: StockPack[] = [
  { label: 'Case', eaches: 24 },
  { label: 'Dozen', eaches: 12 },
  { label: 'Single', eaches: 1 },
];

describe('parsePackQuantity agrees with the approved parser on finite entries', () => {
  const corpus = [
    '', '   ', '24', '2 cases', '1 case + 3', '2 dozen + 5', '1.3 dozen', '1.5 dozen', '2.5', '0.5 + 0.5',
    '-3', '-1 dozen', '2 dozen + -5', 'lots', '3 boxes', '1case', '2 Dozens', '1 single', '4 singles',
    '1.2.3 dozen', '0.1 case + 0.1 case + 0.3 case', '+5', '5+', '1 case ++ 2', ' 7 ', '0', '-0.4', '0.49', '0.5',
    '2 dozen + 1 single + 1 case', '10 abc',
  ];
  it.each(corpus)('"%s"', (raw) => {
    expect(parsePackQuantity(raw, PACKS)).toEqual({ ok: true, eaches: approvedParseUnitCombo(raw, PACKS) });
  });

  it('accepts a pack of one each, as the approved form does', () => {
    expect(parsePackQuantity('3 singles + 2', [{ label: 'Single', eaches: 1 }])).toEqual({ ok: true, eaches: 5 });
  });
});

describe('reorderPointFor matches ceil(used × lead / 30) once the item has 30 days of history', () => {
  it.each([
    [25, 10],
    [30, 2],
    [1, 1],
    [0, 7],
    [59, 3],
    [61, 14],
  ])('used %i, lead %i', (used, lead) => {
    const answer = reorderPointFor({ staticPoint: 5, leadTimeDays: lead, usedInWindow: used, firstSaleDate: '2026-01-01', today: '2026-10-01' });
    expect(answer.rule).toBe('trend');
    expect(answer.reorderPoint).toBe(Math.ceil((used * lead) / 30));
  });
});
