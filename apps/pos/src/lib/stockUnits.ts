import { StockUnit } from '@/types';

/**
 * Convert a combo quantity expression to total eaches.
 *
 * Supports:
 *   - Plain number: "24"  → 24
 *   - Single unit:  "2 cases" → 2 × unit.eaches
 *   - Combo:        "1 case + 3"  → 1×24 + 3 = 27
 *                   "2 dozen + 5" → 2×12 + 5 = 29
 *
 * The function is intentionally lenient — unrecognised unit labels are treated
 * as a base-each count so entry errors don't silently silently produce wrong totals
 * (the parsed result is always shown to the user before confirming).
 */
export function parseUnitCombo(raw: string, units: StockUnit[]): number {
  const str = raw.trim().toLowerCase();
  if (!str) return 0;

  const totalFromSegment = (seg: string): number => {
    const n = parseFloat(seg);
    if (isNaN(n)) return 0;
    return Math.max(0, n);
  };

  // Split on '+' to handle combos
  const parts = str.split('+').map((p) => p.trim());
  let total = 0;

  for (const part of parts) {
    if (!part) continue;
    // Try to match a unit label at the end, e.g. "2 case" or "1case"
    let matched = false;
    for (const unit of units) {
      const label = unit.label.toLowerCase();
      // Accept plural too ("cases", "dozens")
      const re = new RegExp(`^([\\d.]+)\\s*${label}s?$`);
      const m = re.exec(part);
      if (m) {
        const qty = parseFloat(m[1]);
        if (!isNaN(qty)) {
          total += Math.max(0, qty) * unit.eaches;
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      // No unit label found — treat as plain eaches
      total += totalFromSegment(part);
    }
  }

  return Math.round(total);
}

/**
 * Format a qty in eaches back to a human-readable string using the largest
 * matching unit.  E.g. 27 with units [{label:'Case',eaches:24}] → "1 Case + 3".
 * Falls back to "N" when no units apply.
 */
export function formatInUnits(qty: number, units: StockUnit[]): string {
  if (!units.length || qty <= 0) return String(qty);
  const sorted = [...units].sort((a, b) => b.eaches - a.eaches);
  let remaining = qty;
  const parts: string[] = [];
  for (const unit of sorted) {
    const packs = Math.floor(remaining / unit.eaches);
    if (packs > 0) {
      parts.push(`${packs} ${unit.label}${packs !== 1 ? 's' : ''}`);
      remaining -= packs * unit.eaches;
    }
  }
  if (remaining > 0) parts.push(String(remaining));
  return parts.join(' + ') || String(qty);
}

/**
 * Build a human-readable description of a unit combo entry for display.
 * e.g. "2 cases + 3" with Case=24 → "51 eaches"
 */
export function comboSummary(eaches: number): string {
  return `${eaches} each${eaches !== 1 ? 'es' : ''}`;
}
