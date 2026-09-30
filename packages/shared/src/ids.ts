import { uuidv7 } from 'uuidv7';

/**
 * The one ID generator for the whole platform (CLAUDE.md §3): UUIDv7,
 * generated in the application so IDs stay client-generatable for the
 * later offline queue.
 */
export function newId(): string {
  return uuidv7();
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 128 bits from a string: four 32-bit lanes, each stirred by every character
 * and then mixed into the others (the public-domain `cyrb128` construction).
 *
 * AN ID, NOT A SECRET. Nothing here needs to resist a person choosing inputs:
 * what is required is that the same text always gives the same bits on every
 * machine that computes it — the till, the box and the platform — and that two
 * different texts do not land on the same 74 bits. It is written out here
 * rather than imported because `@oto/shared` is bundled into the browser, and
 * a Node-only hash in the barrel breaks the POS build. The golden value in
 * `apps/api/test/id-conformance.test.ts` pins it, so a "tidy-up" that changed
 * a constant would rename every sale line not yet saved.
 */
function hash128(text: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < text.length; i += 1) {
    const k = text.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4;
  h2 ^= h1;
  h3 ^= h1;
  h4 ^= h1;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

/**
 * AN ID NAMED FROM ANOTHER ONE (SCRUM-270): the same parent and the same name
 * give the same id, wherever and whenever it is computed.
 *
 * It exists for the rows one minted record fans out into, where the fan-out is
 * decided by code both sides run rather than by a person: a till names a sale
 * and each of its cart lines, and the platform stores every priced unit of a
 * cart line — kids, adults, socks, each add-on — as a row of its own. Nobody
 * can mint an id per unit ahead of time, because nobody knows the units until
 * the cart is priced; but anybody holding the sale's id, the cart line's id and
 * the unit's key can NAME the row before it is saved. That is what lets a box
 * print a band that points at a sale line the platform has not written yet
 * (plan `offline/PLAN.md` §2.6, round 4), and what makes a replay of the same
 * cart land on the same rows.
 *
 * THE LAYOUT IS UUIDv7's, deliberately: the first 48 bits are the parent's own
 * millisecond timestamp, so a sale's lines sit beside the sale in every
 * time-ordered index the way `newId()` rows do, then the version nibble (7) and
 * the RFC 4122 variant, and the remaining 74 bits from `hash128`. It passes
 * every check a UUIDv7 passes, because to an index it is one.
 */
export function deriveId(parentId: string, name: string): string {
  if (!UUID_SHAPE.test(parentId)) {
    throw new Error('deriveId needs a uuid to derive from');
  }
  const parent = parentId.toLowerCase();
  const [a, b, c, d] = hash128(`${parent}\u0000${name}`);
  const hex8 = (n: number): string => n.toString(16).padStart(8, '0');
  const bits = `${hex8(a)}${hex8(b)}${hex8(c)}${hex8(d)}`;
  const time = parent.replace(/-/g, '').slice(0, 12);
  // Version 7 in the 13th hex digit; the variant's top two bits (10) in the
  // 17th. Everything else is hash.
  const variant = ((parseInt(bits[3]!, 16) & 0x3) | 0x8).toString(16);
  const hex = `${time}7${bits.slice(0, 3)}${variant}${bits.slice(4, 7)}${bits.slice(7, 19)}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * The id of one priced unit of a sale — one `pos.sale_line` row — named from
 * what the till minted: the sale, the cart line the unit came out of, the
 * unit's component key (`kids`, `adults-free`, an add-on id, `promo-item:<id>`)
 * and, for the rare cart line carrying one key twice, which occurrence it is.
 *
 * `commitSale` writes every line under this id, so the till, a box and the
 * platform all name the same row the same way (OD-12: the till mints the sale
 * and every line; the rows a line fans out into are named from those).
 */
export function deriveSaleLineId(
  saleId: string,
  cartLineId: string,
  componentKey: string,
  occurrence = 0,
): string {
  return deriveId(saleId, `sale_line:${cartLineId.toLowerCase()}:${componentKey}:${occurrence}`);
}
