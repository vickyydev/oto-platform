import { describe, expect, it } from 'vitest';
import { boothReprintTarget } from '../src/booth';

/**
 * SCRUM-223, SCRUM-694 — which recent voucher a reprint at the booth means.
 *
 * The box and the page's fake transport both choose with this rule. The case
 * it exists for: on a booth with only the red button, holding the button for
 * the staff panel spins the wheel first (a ready wheel takes the press as a
 * guest's), so the newest voucher is that hold's own, and the one staff came
 * to reprint is the one before it.
 */

const V3 = { spinId: 'spin-3', code: 'DB0000003' };
const V2 = { spinId: 'spin-2', code: 'DB0000002' };
const V1 = { spinId: 'spin-1', code: 'DB0000001' };
const RECENT = [V3, V2, V1];

describe('boothReprintTarget', () => {
  it('with nothing asked, is the newest voucher', () => {
    expect(boothReprintTarget(RECENT, {})).toBe(V3);
  });

  it('with a spin named, is that spin’s voucher, or none when it is not on the list', () => {
    expect(boothReprintTarget(RECENT, { spinId: 'spin-2' })).toBe(V2);
    expect(boothReprintTarget(RECENT, { spinId: 'spin-9' })).toBeUndefined();
  });

  it('with a spin to go before, is the voucher issued just before it', () => {
    expect(boothReprintTarget(RECENT, { beforeSpinId: 'spin-3' })).toBe(V2);
    expect(boothReprintTarget(RECENT, { beforeSpinId: 'spin-2' })).toBe(V1);
  });

  it('with a spin to go before that left no voucher here, is the newest — already the one before it', () => {
    // Refused, nothing won, or its voucher not written yet: the newest on the
    // list is the voucher staff came for.
    expect(boothReprintTarget(RECENT, { beforeSpinId: 'spin-4' })).toBe(V3);
  });

  it('with nothing before the spin to go before, is nothing', () => {
    expect(boothReprintTarget(RECENT, { beforeSpinId: 'spin-1' })).toBeUndefined();
    expect(boothReprintTarget([], { beforeSpinId: 'spin-1' })).toBeUndefined();
    expect(boothReprintTarget([], {})).toBeUndefined();
  });

  it('a named spin wins over a spin to go before', () => {
    expect(boothReprintTarget(RECENT, { spinId: 'spin-1', beforeSpinId: 'spin-3' })).toBe(V1);
  });
});
