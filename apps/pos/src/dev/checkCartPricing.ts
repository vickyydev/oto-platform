/**
 * DOES THE TILL STILL CHARGE WHAT IT ALWAYS CHARGED? — S2-09a (SCRUM-203),
 * rewired for SCRUM-271 ("one calculator").
 *
 * Until SCRUM-271 this script priced every seeded cart twice on the spot — with
 * the prototype's baht arithmetic (`computeTotals`, `lib/sale.ts`) and with the
 * platform's satang engine through `lib/cartWire.ts` — and asserted the two
 * agreed to the satang. That arithmetic is gone; the figures it produced for the
 * same carts are recorded in `test/fixtures/one-calculator-parity.json`, taken
 * immediately before it was deleted.
 *
 * So it now, in one command against this till's live seed:
 *
 *   1. rebuilds every ticket cart of the parity fixture — every package, every
 *      tier, five shapes, weekday and weekend, staff discounts, a comp, codes,
 *      events, drop-off and history (`test/support/parityCases.ts`);
 *   2. prices each through BOTH of the till's roads to the engine — the quote
 *      (`localQuote`, what a commit reconciles against) and the totals the
 *      screens draw (`ticketTotals`) — and asserts they agree to the satang;
 *   3. while the seed is still the one the fixture was taken against, asserts
 *      each agrees with the prototype's recorded figure, and names every case
 *      that may differ and why (`differs` on the case: rounding, or rulings 1
 *      and 2 in `packages/shared/src/cart-totals.ts`).
 *
 *   cd apps/pos && node_modules/.bin/tsx src/dev/checkCartPricing.ts
 *
 * The same comparison, against the fixture's own catalogue, runs in the till's
 * suite on every push (`test/one-calculator-parity.test.ts`); this is the
 * version that reads the seed as it stands.
 */
import { readFileSync } from 'node:fs';
import { getAddOns, getTaxConfig, getTicketTypes } from '@/store/catalogStore';
import { computeLineTotal } from '@/lib/pricing';
import { localQuote } from '@/api/sales';
import { fnbLineTotal, merchLineTotal, platformId, ticketTotals, toSatang } from '@/lib/cartWire';
import { todayRateMode, setBranchRateMode, branchTradingDate, type RateMode } from '@/lib/pricingMode';
import {
  taxConfigNamed,
  ticketCases,
  type ParityCatalogue,
  type PricingHooks,
} from '../../test/support/parityCases';

interface RecordedTotals {
  subtotal: number;
  total: number;
  promoDiscount: number;
  manualDiscount: number;
}

const fixture = JSON.parse(
  readFileSync(new URL('../../test/fixtures/one-calculator-parity.json', import.meta.url), 'utf8'),
) as { catalogue: ParityCatalogue; ticket: Record<string, RecordedTotals> };

const setMode = (mode: RateMode) =>
  setBranchRateMode({ mode, reason: mode === 'weekend' ? 'Weekend pricing' : 'Weekday pricing', date: branchTradingDate() });

const hooks: PricingHooks = {
  ticketLine: (base, mode) => {
    setMode(mode);
    return computeLineTotal(base, mode);
  },
  fnbLine: (item, selected, qty, mode) => fnbLineTotal(item, selected, qty, mode),
  merchLine: (item, qty, mode) => merchLineTotal(item, qty, mode),
};

/** The live seed, in the fixture's own terms, so the two can be compared. */
const live: ParityCatalogue = {
  ...fixture.catalogue,
  ticketTypes: getTicketTypes(),
  addOns: getAddOns(),
  taxConfig: getTaxConfig(),
};
const sameSeed =
  JSON.stringify(JSON.parse(JSON.stringify(live.ticketTypes))) === JSON.stringify(fixture.catalogue.ticketTypes) &&
  JSON.stringify(JSON.parse(JSON.stringify(live.addOns))) === JSON.stringify(fixture.catalogue.addOns) &&
  JSON.stringify(live.taxConfig) === JSON.stringify(fixture.catalogue.taxConfig);
console.log('rate mode:', todayRateMode());
console.log(
  sameSeed
    ? 'seed: the one the prototype figures were taken against — comparing with them too.'
    : 'seed: CHANGED since the prototype figures were taken — comparing the two roads to the engine only.',
);

let checks = 0;
let failures = 0;
let designed = 0;

for (const c of ticketCases(live, hooks)) {
  checks += 1;
  setMode(c.mode);
  const config = taxConfigNamed(c.config, live.taxConfig);
  const drawn = ticketTotals(c.lines, c.discounts, c.manual, { mode: c.mode, config });
  let quoted: number | null = null;
  try {
    quoted = localQuote(c.lines, c.discounts, c.manual, { mode: c.mode, config }).satang?.total ?? null;
  } catch {
    // The engine refuses a cart it did not price (a drop-off child with no play
    // length, a sale read on the other rate mode); the screens re-derive it.
  }
  const problems: string[] = [];
  if (drawn.staleLineIds.length === 0 && quoted !== drawn.satang.total) {
    problems.push(`quote ${quoted} satang, screens ${drawn.satang.total}`);
  }
  const recorded = fixture.ticket[c.id];
  if (sameSeed && recorded) {
    const was = toSatang(recorded.total);
    if (was !== drawn.satang.total) {
      if (c.differs) {
        designed += 1;
        console.log(`by design (${c.differs}) ${c.id}: prototype ${was}, engine ${drawn.satang.total} satang`);
      } else {
        problems.push(`prototype ${was} satang, engine ${drawn.satang.total}`);
      }
    }
    if (toSatang(recorded.subtotal) !== drawn.satang.subtotal) {
      problems.push(`subtotal: prototype ${toSatang(recorded.subtotal)}, engine ${drawn.satang.subtotal}`);
    }
  }
  if (problems.length > 0) {
    failures += 1;
    console.log(`MISMATCH ${c.id}: ${problems.join('; ')}`);
  } else {
    console.log(`ok ${c.id}: ฿${drawn.total} (subtotal ฿${drawn.subtotal}, tax ฿${drawn.taxTotal})`);
  }
}

// --- and the ids the platform will accept -----------------------------------
// `POST /sales` refuses anything but a uuid for a cart line id and a discount
// id, and the till mints neither. `platformId` translates at the wire; if it
// ever produced something that is not a uuid, or two ids that collide, every
// sale from that cart would be refused — or worse, two lines would merge.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const samples: string[] = [
  'promo-ICECREAM', 'promo-STAFF10', 'promo-MEMBER20', 'line-ci-1', 'line-ci-2',
  'md-abc1234', 'md-abc1235', 'x7f2k9', 'x7f2k8', 'a', 'b', '',
  '11111111-2222-4333-8444-555555555555',
];
for (let i = 0; i < 400; i += 1) samples.push(Math.random().toString(36).substring(7));
const seen = new Map<string, string>();
let idFailures = 0;
for (const sample of samples) {
  const mapped = platformId(sample);
  if (!UUID.test(mapped)) {
    idFailures += 1;
    console.log(`BAD UUID from "${sample}": ${mapped}`);
  }
  const clash = seen.get(mapped);
  if (clash !== undefined && clash !== sample) {
    idFailures += 1;
    console.log(`COLLISION: "${sample}" and "${clash}" both map to ${mapped}`);
  }
  seen.set(mapped, sample);
  if (platformId(sample) !== mapped) {
    idFailures += 1;
    console.log(`NOT DETERMINISTIC: "${sample}"`);
  }
}
console.log(
  `\nid translation: ${samples.length - idFailures}/${samples.length} ids are well-formed, ` +
    `unique and stable (e.g. promo-ICECREAM → ${platformId('promo-ICECREAM')}).`,
);

console.log(
  `\n${checks - failures}/${checks} carts agree; ${designed} differ from the prototype by design; ` +
    `${failures + idFailures} mismatch(es).`,
);
if (failures + idFailures > 0) process.exitCode = 1;
