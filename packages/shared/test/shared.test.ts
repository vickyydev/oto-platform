import { describe, expect, it } from 'vitest';
import {
  normalizePhone,
  phoneDigits,
  samePhone,
  satangFromBaht,
  bahtFromSatang,
  formatTHB,
  formatWWPrice,
  wwp,
  isoDateInTz,
  dayOfWeekInTz,
  isWeekendIsoDate,
  branchToday,
  getRateModeForDate,
  resolveRate,
  newId,
} from '../src/index';

describe('phone normalisation (SCRUM-17)', () => {
  it('normalises Thai local trunk format to E.164 (prototype rule)', () => {
    expect(normalizePhone('0818953926')).toBe('+66818953926');
    expect(normalizePhone('081-895-3926')).toBe('+66818953926');
  });
  it('normalises +66 international with spaces', () => {
    expect(normalizePhone('+66 81 895 3926')).toBe('+66818953926');
  });
  it('normalises 00 international prefix (prototype rule)', () => {
    expect(normalizePhone('0066818953926')).toBe('+66818953926');
  });
  it('keeps non-Thai international numbers', () => {
    expect(normalizePhone('+44 7911 123456')).toBe('+447911123456');
  });
  it('rejects garbage', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('abc')).toBeNull();
  });
  it('compares across formats', () => {
    expect(samePhone('0818953926', '+66 81 895 3926')).toBe(true);
    expect(phoneDigits('+66818953926')).toBe('66818953926');
  });
});

describe('money (SCRUM-17)', () => {
  it('round-trips satang', () => {
    expect(satangFromBaht(690)).toBe(69000);
    expect(bahtFromSatang(69000)).toBe(690);
    expect(satangFromBaht(10.5)).toBe(1050);
  });
  it('formats like the prototype (whole ฿, grouped)', () => {
    expect(formatTHB(satangFromBaht(1090))).toBe('฿1,090');
    expect(formatTHB(1050)).toBe('฿10.50');
  });
  it('formats weekday/weekend pairs like the prototype admin list', () => {
    expect(formatWWPrice(wwp(satangFromBaht(100)))).toBe('฿100');
    expect(formatWWPrice(wwp(satangFromBaht(100), satangFromBaht(150)))).toBe('฿100 / ฿150 wknd');
  });
});

describe('branch timezone dates (SCRUM-17)', () => {
  it('round-trips a UTC instant into the branch calendar day', () => {
    // 18:30 UTC = 01:30 next day in Asia/Bangkok (+07:00)
    const instant = new Date('2026-09-11T18:30:00Z');
    expect(isoDateInTz(instant, 'Asia/Bangkok')).toBe('2026-09-12');
    expect(isoDateInTz(instant, 'UTC')).toBe('2026-09-11');
    expect(dayOfWeekInTz(instant, 'Asia/Bangkok')).toBe(6); // Saturday in Bangkok
    expect(branchToday('Asia/Bangkok', instant)).toBe('2026-09-12');
  });
});

describe('rate mode resolver (SCRUM-36 core, ported from prototype pricingMode.ts)', () => {
  const holidays = [{ name: 'Songkran', startsOn: '2026-04-13', endsOn: '2026-04-15' }];
  it('weekday', () => {
    expect(getRateModeForDate('2026-09-09', holidays).mode).toBe('weekday'); // Wed
  });
  it('saturday and sunday are weekend', () => {
    expect(getRateModeForDate('2026-09-12', holidays).mode).toBe('weekend');
    expect(getRateModeForDate('2026-09-13', holidays).mode).toBe('weekend');
    expect(isWeekendIsoDate('2026-09-12')).toBe(true);
  });
  it('a weekday inside a holiday range bills weekend, with the holiday named', () => {
    const r = getRateModeForDate('2026-04-14', holidays); // Tuesday
    expect(r.mode).toBe('weekend');
    expect(r.reason).toBe('Weekend pricing — Songkran');
    expect(r.overrideName).toBe('Songkran');
  });
  it('range boundaries are inclusive on both ends', () => {
    expect(getRateModeForDate('2026-04-13', holidays).overrideName).toBe('Songkran');
    expect(getRateModeForDate('2026-04-15', holidays).overrideName).toBe('Songkran');
    expect(getRateModeForDate('2026-04-16', holidays).mode).toBe('weekday'); // Thursday after
  });
  it('resolves stored pairs per mode', () => {
    const p = wwp(69000, 79000);
    expect(resolveRate(p, 'weekday')).toBe(69000);
    expect(resolveRate(p, 'weekend')).toBe(79000);
    expect(resolveRate(undefined, 'weekday')).toBe(0);
  });
});

describe('ids', () => {
  it('generates monotonic-ish uuidv7', () => {
    const a = newId();
    const b = newId();
    expect(a).toMatch(/^[0-9a-f-]{36}$/);
    expect(a).not.toBe(b);
  });
});
