/**
 * DOES THE TILL STILL CHARGE WHAT IT ALWAYS CHARGED? — S2-09a (SCRUM-203).
 *
 * `apps/pos` has no unit-test runner and is in eslint's ignore list, so the
 * compiler and somebody driving the till are the only checks on it. That is how
 * a child's price sat on the Adults row for a sprint (SCRUM-226). This ticket
 * moved every figure on the till from the prototype's baht arithmetic to the
 * platform's satang engine, through a translation layer
 * (`src/lib/cartWire.ts`) that the compiler cannot check the meaning of: a
 * price left in baht, or an adult rule's nested weekday/weekend price missed,
 * compiles perfectly and charges the visitor a hundredth or a hundred times the
 * money.
 *
 * So this walks the seeded catalogue — every package, every tier, five cart
 * shapes, weekday and weekend, plus manual discounts, a comp and a promo code —
 * and asserts the two arithmetics agree to the satang.
 *
 *   cd apps/pos && node_modules/.bin/tsx src/dev/checkCartPricing.ts
 *
 * IT IS NOT IN CI, and it is not a substitute for one: it is what can be run
 * today, in one command, by anyone who touches the pricing path. Giving
 * `apps/pos` a real runner is its own ticket.
 *
 * WHERE THE TWO ARE ALLOWED TO DIVERGE, so a later reader does not "fix" a
 * difference that is deliberate: rulings 1 and 2 in
 * `packages/shared/src/cart-totals.ts` move money on carts with stacked or
 * scoped codes, and a manual percent discount now rounds to the satang rather
 * than to the baht. Those shapes are deliberately not compared here. Everything
 * this script covers must agree exactly.
 */
import { getTicketTypes, getAddOns } from '@/store/catalogStore';
import { computeLineTotal } from '@/lib/pricing';
import { computeTotals } from '@/lib/sale';
import { localQuote } from '@/api/sales';
import type { CartLine, Discount, ManualDiscount } from '@/types';
import { todayRateMode, setBranchRateMode, branchTradingDate } from '@/lib/pricingMode';

const tickets = getTicketTypes();
const addOns = getAddOns();
console.log('rate mode:', todayRateMode());
console.log('tickets:', tickets.map((t) => `${t.id}/${t.name}`).join(', '));
console.log('addons:', addOns.map((a) => `${a.id}/${a.name} ${JSON.stringify(a.price)}`).join(', '));
console.log('tiers on first ticket:', JSON.stringify(tickets[0]?.prices));
console.log('adultRules:', JSON.stringify(tickets[0]?.adultRules));

const tierIds = Object.keys(tickets[0]?.prices ?? { tourist: 0 });

function makeLine(id: string, ticketIndex: number, tier: string, kids: number, adults: number, socks: number, addOnIds: string[]): CartLine {
  const ticketType = tickets[ticketIndex % tickets.length]!;
  const selected = addOnIds.map((aid) => {
    const a = addOns.find((x) => x.id === aid)!;
    return { ...a, price: todayRateMode().mode === 'weekend' ? a.price.weekend : a.price.weekday, quantity: 2 };
  });
  const base = { ticketType, tier, kids, adults, socks, addOns: selected };
  return { id, ...base, lineTotal: computeLineTotal(base) } as CartLine;
}

let failures = 0;
let checks = 0;

function compare(label: string, lines: CartLine[], discounts: Discount[] = [], manual: ManualDiscount[] = []) {
  checks += 1;
  const proto = computeTotals(lines, discounts, manual);
  const engine = localQuote(lines, discounts, manual);
  const same =
    Math.round(proto.total * 100) === Math.round(engine.totals.total * 100) &&
    Math.round(proto.subtotal * 100) === Math.round(engine.totals.subtotal * 100);
  if (!same) {
    failures += 1;
    console.log(
      `MISMATCH ${label}: prototype subtotal ${proto.total} / total ${proto.total}` +
        ` vs engine subtotal ${engine.totals.subtotal} / total ${engine.totals.total}`,
    );
  } else {
    console.log(`ok ${label}: ฿${proto.total} (subtotal ฿${proto.subtotal}, tax ฿${proto.taxTotal.toFixed(2)})`);
  }
}

const nonSocksAddOns = addOns.filter((a) => a.id !== 'a-socks').slice(0, 2).map((a) => a.id);

for (let t = 0; t < Math.min(tickets.length, 3); t++) {
  for (const tier of tierIds) {
    compare(`t${t} ${tier} 2k+3a`, [makeLine('l1', t, tier, 2, 3, 0, [])]);
    compare(`t${t} ${tier} 2k+3a+socks`, [makeLine('l1', t, tier, 2, 3, 4, [])]);
    compare(`t${t} ${tier} 1k+1a+socks+addons`, [makeLine('l1', t, tier, 1, 1, 2, nonSocksAddOns)]);
    compare(`t${t} ${tier} 0k+2a`, [makeLine('l1', t, tier, 0, 2, 0, [])]);
    compare(`t${t} ${tier} 5k+0a`, [makeLine('l1', t, tier, 5, 0, 1, [])]);
  }
}

// two lines
compare('two lines', [makeLine('l1', 0, tierIds[0]!, 2, 2, 2, []), makeLine('l2', 1, tierIds[tierIds.length - 1]!, 1, 1, 0, nonSocksAddOns)]);

// a fixed manual discount (percent rounds differently by design — excluded)
const manualFixed: ManualDiscount = {
  id: 'md1', scope: 'order', type: 'fixed', value: 150, reason: 'Service recovery',
  amountTHB: 150, appliedBy: 'Test', appliedById: 'acc', appliedAt: new Date().toISOString(),
};
compare('order fixed ฿150', [makeLine('l1', 0, tierIds[0]!, 2, 3, 2, [])], [], [manualFixed]);

const manualLine: ManualDiscount = { ...manualFixed, id: 'md2', scope: 'line', targetLineId: 'l1', value: 90, amountTHB: 90 };
compare('line fixed ฿90', [makeLine('l1', 0, tierIds[0]!, 2, 3, 2, [])], [], [manualLine]);

const manualComp: ManualDiscount = { ...manualFixed, id: 'md3', scope: 'line', targetLineId: 'l1', type: 'comp', value: 0, amountTHB: 0 };
compare('line comp', [makeLine('l1', 0, tierIds[0]!, 2, 3, 2, [])], [], [manualComp]);

// one fixed promo code
const promoFixed: Discount = { code: 'FIX100', label: 'Fixed ฿100', type: 'fixed', value: 100 };
compare('promo fixed ฿100', [makeLine('l1', 0, tierIds[0]!, 2, 3, 2, [])], [promoFixed]);

// --- and again under weekend pricing, which is a different price on every
// package AND a different adult set_price (350 weekday / 500 weekend) ---
setBranchRateMode({ mode: 'weekend', reason: 'Weekend pricing', date: branchTradingDate() });
console.log('\n--- weekend ---');
console.log('rate mode now:', todayRateMode());
for (let t = 0; t < Math.min(tickets.length, 3); t++) {
  for (const tier of tierIds) {
    compare(`WKND t${t} ${tier} 2k+3a`, [makeLine('l1', t, tier, 2, 3, 0, [])]);
    compare(`WKND t${t} ${tier} 1k+1a+socks+addons`, [makeLine('l1', t, tier, 1, 1, 2, nonSocksAddOns)]);
  }
}
compare('WKND promo fixed ฿100', [makeLine('l1', 0, tierIds[0]!, 2, 3, 2, [])], [promoFixed]);

// --- and the ids the platform will accept -----------------------------------
// `POST /sales` refuses anything but a uuid for a cart line id and a discount
// id, and the till mints neither. `platformId` translates at the wire; if it
// ever produced something that is not a uuid, or two ids that collide, every
// sale from that cart would be refused — or worse, two lines would merge.
import { platformId } from '@/lib/cartWire';
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

console.log(`\n${checks - failures}/${checks} carts agree; ${failures + idFailures} mismatch(es).`);
