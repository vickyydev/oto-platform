import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getTillChoice, measuredTill, nextTill, resetTillChoiceForTests, subscribeTillChoice, type TillSurroundings } from '@/lib/tillChoice';
import { setSaleOpen } from '@/pwa/openSale';

/**
 * SCRUM-977 — WHICH TILL A DEVICE SHOWS, AND THAT A TURN OR A RESIZE NEVER
 * SWAPS IT UNDER A SALE.
 *
 * The prototype's gate chose its phone shell by the window's width alone
 * (`hooks/use-mobile.tsx`, 768): a 390 by 844 phone turned on its side is 844
 * wide and became the desk till, and the family's form and the sale were
 * gone. The rule now (`lib/tillChoice.ts`): under 768 wide is the phone till,
 * as before; so is a finger screen whose shorter side is under 600, held
 * either way; and the till showing stays while anything is open on it.
 */
const at = (viewportWidth: number, screen: [number, number], coarsePointer: boolean): TillSurroundings =>
  ({ viewportWidth, screenWidth: screen[0], screenHeight: screen[1], coarsePointer });

describe('the device classes (rules 1 and 2)', () => {
  it('a 390 phone: the phone till upright and on its side', () => {
    expect(measuredTill(at(390, [390, 844], true))).toBe('phone');
    expect(measuredTill(at(844, [844, 390], true))).toBe('phone');
    // iOS keeps screen.width/height as held upright: the shorter side is the same.
    expect(measuredTill(at(844, [390, 844], true))).toBe('phone');
  });

  it('a 430 phone on its side (932 wide), and a 360 by 740 phone either way', () => {
    expect(measuredTill(at(932, [932, 430], true))).toBe('phone');
    expect(measuredTill(at(360, [360, 740], true))).toBe('phone');
    expect(measuredTill(at(740, [740, 360], true))).toBe('phone');
  });

  it('a 768 tablet: the desk till upright (768 wide) and on its side, as today', () => {
    expect(measuredTill(at(768, [768, 1024], true))).toBe('desk');
    expect(measuredTill(at(1024, [1024, 768], true))).toBe('desk');
  });

  it('a tablet under 768 wide upright (an iPad mini, 744) shows the phone till as today, and the desk till on its side', () => {
    expect(measuredTill(at(744, [744, 1133], true))).toBe('phone');
    expect(measuredTill(at(1133, [1133, 744], true))).toBe('desk');
  });

  it('a 1024 laptop window, and a small laptop with a 512-pixel screen (a mouse or a touchpad), the desk till', () => {
    expect(measuredTill(at(1024, [1440, 900], false))).toBe('desk');
    expect(measuredTill(at(910, [910, 512], false))).toBe('desk');
  });

  it('a desk window resized below 768: the phone till, as today', () => {
    expect(measuredTill(at(700, [1920, 1080], false))).toBe('phone');
  });

  it('the old rule, width alone, is what made the turned phone a desk', () => {
    const widthAlone = (s: TillSurroundings) => (s.viewportWidth < 768 ? 'phone' : 'desk');
    expect(widthAlone(at(844, [844, 390], true))).toBe('desk');
    expect(measuredTill(at(844, [844, 390], true))).toBe('phone');
  });
});

describe('a till showing with something open stays (rule 3)', () => {
  it('keeps the till showing while something is open, and takes the measured one when nothing is', () => {
    expect(nextTill(null, 'desk', true)).toBe('desk');
    expect(nextTill('desk', 'phone', true)).toBe('desk');
    expect(nextTill('phone', 'desk', true)).toBe('phone');
    expect(nextTill('desk', 'phone', false)).toBe('phone');
  });
});

describe('the one store App.tsx and the shop read', () => {
  let size = { innerWidth: 1440, screen: { width: 1920, height: 1080 } };
  let coarse = false;
  const target = new EventTarget();
  beforeEach(() => {
    resetTillChoiceForTests();
    size = { innerWidth: 1440, screen: { width: 1920, height: 1080 } };
    coarse = false;
    // Getters, so the window reads the size of the moment (Object.assign would copy one value).
    Object.defineProperties(target, {
      innerWidth: { configurable: true, get: () => size.innerWidth },
      screen: { configurable: true, get: () => size.screen },
      matchMedia: { configurable: true, value: () => ({ get matches() { return coarse; }, addEventListener: () => undefined, removeEventListener: () => undefined }) },
    });
    vi.stubGlobal('window', target);
  });
  afterEach(() => {
    setSaleOpen('till', false);
    setSaleOpen('mobile-till', false);
    resetTillChoiceForTests();
    vi.unstubAllGlobals();
  });
  const resize = (innerWidth: number, screen = size.screen) => { size = { innerWidth, screen }; target.dispatchEvent(new Event('resize')); };

  it('a desk window resized to 700 and back with a sale open keeps the desk till; with nothing open it follows the width', () => {
    const heard = vi.fn();
    const stop = subscribeTillChoice(heard);
    expect(getTillChoice()).toBe('desk');
    setSaleOpen('till', true);
    resize(700);
    expect(getTillChoice()).toBe('desk');
    resize(1440);
    expect(getTillChoice()).toBe('desk');
    expect(heard).not.toHaveBeenCalled();
    // At 700 with the sale finished and the till cleared: the phone till, as today.
    resize(700);
    setSaleOpen('till', false);
    expect(getTillChoice()).toBe('phone');
    expect(heard).toHaveBeenCalledTimes(1);
    resize(1440);
    expect(getTillChoice()).toBe('desk');
    stop();
  });

  it('a phone turned with its form handed over stays the phone till both ways', () => {
    coarse = true;
    size = { innerWidth: 390, screen: { width: 390, height: 844 } };
    const stop = subscribeTillChoice(() => undefined);
    expect(getTillChoice()).toBe('phone');
    setSaleOpen('mobile-till', true);
    resize(844, { width: 844, height: 390 });
    expect(getTillChoice()).toBe('phone');
    resize(390, { width: 390, height: 844 });
    expect(getTillChoice()).toBe('phone');
    // And with nothing open: still a phone, being one.
    setSaleOpen('mobile-till', false);
    resize(844, { width: 844, height: 390 });
    expect(getTillChoice()).toBe('phone');
    stop();
  });
});

describe('the one place', () => {
  const src = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');
  it('the gate and the shop read the till choice; the prototype’s hook stays for station set-up and the sidebar', () => {
    expect(src('App.tsx')).toContain("const isMobile = useTillChoice() === 'phone';");
    expect(src('App.tsx')).not.toContain('useIsMobile');
    expect(src('pages/MerchStation.tsx')).toContain("const mobile = useTillChoice() === 'phone';");
    expect(src('pages/StationSetup.tsx')).toContain('const isMobile = useIsMobile();');
    expect(src('components/ui/sidebar.tsx')).toContain('const isMobile = useIsMobile()');
    expect(src('hooks/use-mobile.tsx')).toMatch(/const MOBILE_BREAKPOINT = 768\b/);
  });
});
