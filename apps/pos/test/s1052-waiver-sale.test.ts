import * as React from 'react';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateRegistrationSchema, CreateWaiverSchema, newId } from '@oto/shared';
import { ConsentCapture } from '@/components/till/ConsentCapture';
import { slotAge, type SupervisedSlot } from '@/components/till/SupervisionGate';
import { LanguageProvider } from '@/i18n/LanguageContext';
import { engineCartLine } from '@/lib/cartWire';
import { makeDropOffLine, normalizeDropOffFees, resolveDropOffPricing } from '@/lib/dropoff';
import { emptyGatePlace } from '@/lib/editDetails';
import { waiverCovers } from '@/lib/returningFamily';
import { resolveGroupRequirements, resolveSupervisionOutcome } from '@/lib/supervision';
import { getDropOffPricing } from '@/mockApi';
import { getTicketTypes } from '@/store/catalogStore';
import type { CartLine, CheckIn, SupervisionPolicy } from '@/types';

beforeEach(() => vi.stubGlobal('React', React));
afterEach(() => vi.unstubAllGlobals());

/**
 * SCRUM-1052 — A SALE PAID AFTER A SIBLING WAIVER, THROUGH THE TILL'S OWN
 * STEPS (the level the till's tests reach: the gate's rules, the bodies it
 * sends and the cart it rings up, without the page itself).
 *
 * On staging two children came with no adult: Mai, 6, needing drop-off, and
 * Tom, 10. Staff pressed "Waive — older sibling (9+) covers", and the till
 * (SCRUM-1018) put Tom on a plain ticket with no registration: the sale went
 * to payment with two children and nothing behind them, and the platform
 * refused it (SALE_KIDS_WITHOUT_REGISTRATION). The repair restores what the
 * counter did before 19 November on this one path: Tom is registered at no
 * fee, the waiver names that registration, and the sale carries Tom's line
 * under his stay, which is what the platform's unchanged rule reads.
 */

const policy: SupervisionPolicy = {
  bands: [
    { id: 'band-0-4', label: '0–4', minAge: 0, maxAge: 4, requirement: 'nanny' },
    { id: 'band-5-8', label: '5–8', minAge: 5, maxAge: 8, requirement: 'drop_off' },
    { id: 'band-9-up', label: '9+', minAge: 9, maxAge: null, requirement: 'none' },
  ],
  siblingWaiver: { enabled: true, guardianMinAge: 9, waivableRequirement: 'drop_off', staffOnly: true },
  confirmations: [{ id: 'confirm-15min', text: 'ZZ TEST within 15 minutes', required: true, order: 0 }],
};
const BRANCH = '0190a0a0-0000-7000-8000-00000000b001';

/** The kids-only ticket line the family is rung up on: two children, no adult. */
function cartLine(): CartLine {
  const ticket = getTicketTypes()[0]!;
  return { id: 'line-zz-1052', ticketType: ticket, tier: 'tourist', kids: 2, adults: 0, socks: 0, addOns: [], lineTotal: 0 } as CartLine;
}

/** What `openSupervisionGate` builds for the line, named and aged, Mai waived by staff. */
function gateAfterWaiver(line: CartLine): SupervisedSlot[] {
  const mai = { ...emptyGatePlace(line, { id: 'zz-mai' }), name: 'ZZ TEST Mai', age: '6', waived: true };
  const tom = { ...emptyGatePlace(line, { id: 'zz-tom' }), name: 'ZZ TEST Tom', age: '10' };
  return [mai, tom];
}

/** The partition `resolveSupervisionGate` makes: registered children, plain kids, the waivers to record. */
function partition(slots: SupervisedSlot[]) {
  const requirement = new Map(resolveGroupRequirements(slots.map((s) => ({ id: s.id, age: slotAge(s) ?? -1 })), policy)
    .map((r) => [r.id, r.requirement]));
  const covers = waiverCovers(slots, policy);
  const supervised: { slot: SupervisedSlot; service: 'nanny' | 'drop_off' | 'none' }[] = [];
  const plain: SupervisedSlot[] = [];
  for (const slot of slots) {
    const outcome = resolveSupervisionOutcome(requirement.get(slot.id) ?? 'none', slot.waived, slot.optIn);
    if (outcome.service !== null) supervised.push({ slot, service: outcome.service });
    else plain.push(slot);
  }
  return { supervised, plain, covers, requirement };
}

describe('SCRUM-1052: after a waiver the sale names a registration', () => {
  const line = cartLine();
  const slots = gateAfterWaiver(line);
  const { supervised, plain, covers, requirement } = partition(slots);

  it('the covering sibling is registered at no fee; the waived child plays on a plain ticket', () => {
    expect(supervised.map(({ slot, service }) => [slot.name, service])).toEqual([['ZZ TEST Tom', 'none']]);
    expect(plain.map((slot) => slot.name)).toEqual(['ZZ TEST Mai']);
    expect([...covers.entries()].map(([waived, covering]) => [waived, covering.id])).toEqual([['zz-mai', 'zz-tom']]);
  });

  it('the registration and the waiver the till sends are ones the platform accepts, the waiver naming the registration', () => {
    const registrationId = newId();
    const stayId = newId();
    const registration = CreateRegistrationSchema.safeParse({
      id: registrationId, branchId: BRANCH, guardianName: 'ZZ TEST Ploy', guardianPhone: '+66898020001',
      contactChannel: 'whatsapp', consentAcknowledged: true, acknowledgedConfirmationIds: ['confirm-15min'],
      contactConfirmation: null,
      children: supervised.map(({ slot, service }) => ({ checkinId: stayId, name: slot.name, ageYears: slotAge(slot) ?? 0,
        service, allergies: null, foodRestrictions: null, foodProvision: { mode: 'none', paidSatang: 0 } })),
    });
    expect(registration.success, JSON.stringify(registration.error?.issues)).toBe(true);
    const [waived, covering] = [...covers.entries()][0]!;
    const waiver = CreateWaiverSchema.safeParse({
      id: newId(), branchId: BRANCH, registrationId,
      child: { name: slots.find((s) => s.id === waived)!.name, ageYears: 6 },
      sibling: { name: covering.name, ageYears: slotAge(covering) ?? 0 },
      waivedRequirement: requirement.get(waived),
    });
    expect(waiver.success, JSON.stringify(waiver.error?.issues)).toBe(true);
    expect(waiver.data?.registrationId).toBe(registrationId);
  });

  it('the cart paid carries the sibling under the stay id, at no service fee, and the waived child on the plain line', () => {
    const pricing = resolveDropOffPricing(getDropOffPricing(), 'weekday');
    const stayId = newId();
    const stay = { id: stayId, registrationId: newId(), childName: 'ZZ TEST Tom', childAge: 10, mayOrderFood: false,
      serviceType: 'none', status: 'registered' } as unknown as CheckIn;
    // Till.tsx `stayLine`: the drop-off line goes under the STAY's id.
    const tomLine = { ...makeDropOffLine({ ci: stay, ticket: line.ticketType, tier: 'tourist', service: 'none', lengthChosen: true, pricing }), id: stayId };
    const residual = { ...line, kids: plain.length };
    const cart = normalizeDropOffFees([residual, tomLine], pricing);
    const wire = cart.map(engineCartLine);
    // No adult on the sale: the platform reads the kid lines' ids for a stay.
    expect(wire.reduce((sum, l) => sum + l.adults, 0)).toBe(0);
    expect(wire.reduce((sum, l) => sum + l.kids, 0)).toBe(2);
    expect(wire.filter((l) => l.kids > 0).map((l) => l.id)).toContain(stayId);
    // Registered free: the play ticket alone, no drop-off fee for Tom.
    expect(cart.find((l) => l.id === stayId)!.dropOff!.serviceFeeTHB).toBe(0);
  });

  it('the family is asked the form for the sibling, "registered at no fee", with the agreements', () => {
    vi.stubGlobal('window', {
      localStorage: { getItem: () => 'en', setItem: () => undefined },
      location: { search: '' },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    });
    const html = renderToStaticMarkup(createElement(LanguageProvider, { storageKey: 'zz-test-1052', children: createElement(ConsentCapture, {
      slots, parentName: '', consentAck: false, policy, onParentNameChange: () => undefined, onConsentAckChange: () => undefined,
      onUpdateChild: () => undefined, acknowledgedConfirmationIds: [], onToggleConfirmation: () => undefined,
    } as never) }));
    expect(html).toContain('Registered for supervised drop-off — no fee');
    expect(html).toContain('ZZ TEST within 15 minutes');
  });
});
