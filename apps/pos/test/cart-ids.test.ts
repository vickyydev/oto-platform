import { describe, expect, it } from 'vitest';
import { buildCartPayload, localQuote, type CartIdentity } from '@/api/sales';
import { localIdFor, platformId } from '@/lib/cartWire';
import { computeLineTotal } from '@/lib/pricing';
import { getTicketTypes } from '@/store/catalogStore';
import type { CartLine, ManualDiscount } from '@/types';

/**
 * THE TILL NAMES WHAT IT SELLS — SCRUM-270, plan `offline/PLAN.md` OD-12.
 *
 * The till mints the sale's id and every line's, so both lanes — the platform
 * today, the box from round 4 — are sent the same names for the same cart, and
 * a replay with other line ids can be refused as the conflict it is. The
 * prototype's own line ids (`line-1`, `promo-ICECREAM`, `md-…`) stay the
 * screen's; `platformId` mints the UUIDv7 that goes on the wire, once per id,
 * and `localIdFor` reads an answer back.
 */

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const oneHour = getTicketTypes().find((ticket) => ticket.id === 't-1h')!;

function ticketLine(id: string, kids = 1): CartLine {
  const priced = { ticketType: oneHour, tier: 'tourist', kids, adults: 0, socks: 0, addOns: [] };
  return { id, ...priced, lineTotal: computeLineTotal(priced) };
}

const identity: CartIdentity = {
  branchId: 'branch-1',
  stationId: 'station-1',
  tier: 'tourist',
  accountId: 'account-1',
  accountName: 'Reception',
};

describe('platformId — a UUIDv7 the till mints, once per id of its own', () => {
  it('mints a UUIDv7 for an id that is not one, and the same one every time after', () => {
    const minted = platformId('line-ids-1');
    expect(minted).toMatch(UUID_V7);
    expect(platformId('line-ids-1')).toBe(minted);
    expect(platformId('line-ids-2')).not.toBe(minted);
  });

  it('passes an id that is already a uuid through untouched', () => {
    const uuid = '0192a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b';
    expect(platformId(uuid)).toBe(uuid);
  });

  it('is minted, not derived from the text: the same local id is not a fixed uuid', () => {
    // Until SCRUM-270 `promo-ICECREAM` hashed to one uuid in every sale from
    // every till. A minted id carries this till's clock instead.
    const before = Date.now();
    const id = platformId(`promo-CLOCK-${before}`);
    expect(parseInt(id.replace(/-/g, '').slice(0, 12), 16)).toBeGreaterThanOrEqual(before);
  });

  it('reads an answer back to the id the screen knows, and mints nothing doing it', () => {
    const sent = platformId('md-readback');
    expect(localIdFor(['md-other-never-sent', 'md-readback'], sent)).toBe('md-readback');
    // An id this till never put on the wire cannot be what an answer is keyed by.
    expect(localIdFor(['md-never-sent'], platformId('md-something-else'))).toBeNull();
  });
});

describe('buildCartPayload — the cart carries the ids the till minted', () => {
  it('names every line and every staff discount, and aims a line discount at the line it names', () => {
    const lines = [ticketLine('line-ids-a', 1), ticketLine('line-ids-b', 2)];
    const aimed: ManualDiscount = {
      id: 'md-ids-a',
      scope: 'line',
      targetLineId: 'line-ids-b',
      type: 'fixed',
      value: 50,
      reason: 'Service recovery',
      amountTHB: 50,
      appliedBy: 'Reception',
      appliedById: 'account-1',
      appliedAt: '2026-09-30T03:00:00.000Z',
    };
    const quote = localQuote(lines, [], [aimed]);
    const first = buildCartPayload(lines, [], [aimed], identity, quote.satang!);
    const again = buildCartPayload(lines, [], [aimed], identity, quote.satang!);

    for (const line of first.lines) expect(line.id).toMatch(UUID_V7);
    expect(first.lines.map((l) => l.id)).toEqual([platformId('line-ids-a'), platformId('line-ids-b')]);
    expect(first.manualDiscounts[0]!.id).toBe(platformId('md-ids-a'));
    expect(first.manualDiscounts[0]!.targetLineId).toBe(first.lines[1]!.id);
    // The quote and every retry of the commit describe the same cart by the
    // same names — which is what makes a retry a replay rather than a conflict.
    expect(again).toEqual(first);
  });
});
