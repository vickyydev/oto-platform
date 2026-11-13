import { describe, expect, it } from 'vitest';
import { partySlipComposeInputOf } from '../src/services/party-slips';

const snapshot = () => ({
  version: 1,
  partyName: 'ZZ TEST semantic slip',
  location: 'Party room 1',
  plan: {
    counts: { kidsExpected: 10, adultsExpected: 4 },
    setMenu: [{
      productCode: 'FOOD-1', name: 'Pizza', qty: 3,
      choiceGroup: 'Pizza', chosenOption: 'Margherita', note: 'No chilli',
      audience: 'kids', origin: 'set_menu', adultsNote: 'Mild',
      lineId: 'unneeded-line-id', unitPriceSatang: 12300, onTillMenu: true,
    }],
    barItems: [{ productCode: null, name: 'Juice', qty: 2, note: 'Later', unitPriceSatang: 999 }],
    kitchen: { kidsFoodTime: '14:00', adultsFoodTime: null, readyOffsetMinutes: 20, slipsTime: '11:00', barServiceTime: '14:30' },
    cake: { type: 'own', qty: 1, time: '15:00', note: 'Bring candles' },
  },
  prepStations: { 'FOOD-1': 'kitchen' },
});

describe('SCRUM-966 / SCRUM-945 independent snapshot review', () => {
  it('HIGH: JSON round trip keeps choice, audience, provenance, notes, counts, cake, times and resolved routing', () => {
    const parsed = partySlipComposeInputOf(JSON.parse(JSON.stringify(snapshot())));
    expect(parsed).not.toBeNull();
    expect(parsed!.plan!.setMenu[0]).toMatchObject({
      chosenOption: 'Margherita', audience: 'kids', origin: 'set_menu', qty: 3,
      note: 'No chilli', adultsNote: 'Mild',
    });
    expect(parsed!.plan!.counts).toEqual({ kidsExpected: 10, adultsExpected: 4 });
    expect(parsed!.plan!.kitchen?.barServiceTime).toBe('14:30');
    expect(parsed!.plan!.cake).toEqual({ type: 'own', qty: 1, time: '15:00', note: 'Bring candles' });
    expect(parsed!.prepStations).toEqual({ 'FOOD-1': 'kitchen' });
    expect(partySlipComposeInputOf(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  it('HIGH: a missing routing answer is unknown, while an explicitly absent live code remains null', () => {
    expect(partySlipComposeInputOf({ ...snapshot(), prepStations: {} })).toBeNull();
    expect(partySlipComposeInputOf({ ...snapshot(), prepStations: { 'FOOD-1': null } })?.prepStations['FOOD-1']).toBeNull();
  });

  it.each([undefined, null, {}, { ...snapshot(), version: 2 }, { ...snapshot(), version: '1' },
    { ...snapshot(), prepStations: { 'FOOD-1': 'somewhere' } },
    { ...snapshot(), plan: { ...snapshot().plan, counts: { kidsExpected: -1, adultsExpected: 4 } } },
  ])('HIGH: invalid or unsupported snapshot falls back without throwing (%j)', (value) => {
    expect(partySlipComposeInputOf(value)).toBeNull();
  });

  it('HIGH: the prospective empty state is distinct from a missing historical snapshot', () => {
    const empty = { version: 1, partyName: 'ZZ TEST empty', location: null, plan: null, prepStations: {} };
    expect(partySlipComposeInputOf(empty)).toEqual(empty);
    expect(partySlipComposeInputOf(undefined)).toBeNull();
  });

  it('MEDIUM: semantic persistence omits price, catalogue display flags and unrelated line identifiers', () => {
    const parsed = partySlipComposeInputOf(snapshot())!;
    expect(parsed.plan!.setMenu[0]).not.toHaveProperty('unitPriceSatang');
    expect(parsed.plan!.setMenu[0]).not.toHaveProperty('lineId');
    expect(parsed.plan!.setMenu[0]).not.toHaveProperty('onTillMenu');
    expect(parsed.plan!.barItems[0]).not.toHaveProperty('unitPriceSatang');
    expect(partySlipComposeInputOf({ ...snapshot(), customerPhone: 'not part of a slip' })).toBeNull();
  });
});
