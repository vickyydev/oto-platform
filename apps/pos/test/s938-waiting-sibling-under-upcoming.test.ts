import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { earliestArrival, familyBoardTabs } from '@/lib/dropoff';
import type { CheckIn, CheckInStatus } from '@/types';

/**
 * SCRUM-938 — A WAITING SIBLING IS FOUND UNDER UPCOMING.
 *
 * SCRUM-909's proof, picture 02h: family B with child B2 checked in and B1
 * booked and paid but not yet arrived. The board counted B1 under Upcoming
 * (each tab counts children) but listed the family's card only under In Park,
 * because the prototype lists a family once, under its first tab of In Park,
 * Upcoming and Out. Staff looking for B1 among the arrivals could not find it.
 *
 * The family's card is now listed under both tabs while it has a child in
 * each: the board's existing card, with every child and its own status line
 * and every action, so checking B1 in from Upcoming is the same press as from
 * In Park. A family wholly in one state is listed exactly as before, and the
 * desk board and the phone board read the same rule.
 */
// The first argument only names the child for the reader.
const child = (_name: string, status: CheckInStatus, scheduledFor?: string): Pick<CheckIn, 'status' | 'scheduledFor'> => ({
  status,
  ...(scheduledFor ? { scheduledFor } : {}),
});

describe('the tabs a family is listed under', () => {
  it('one child in the park and a sibling still waiting: Upcoming and In Park', () => {
    expect(familyBoardTabs([child('b1', 'registered'), child('b2', 'in_park')])).toEqual(['registered', 'in_park']);
  });

  it('a family wholly in one state is listed once, as before', () => {
    expect(familyBoardTabs([child('a1', 'registered'), child('a2', 'registered')])).toEqual(['registered']);
    expect(familyBoardTabs([child('a1', 'in_park'), child('a2', 'in_park')])).toEqual(['in_park']);
    expect(familyBoardTabs([child('a1', 'out'), child('a2', 'out')])).toEqual(['out']);
    expect(familyBoardTabs([child('a1', 'registered')])).toEqual(['registered']);
  });

  it('a child gone home beside one in the park, or one waiting, is listed as before', () => {
    // In Park outranks Out, and Upcoming outranks Out: unchanged.
    expect(familyBoardTabs([child('c1', 'out'), child('c2', 'in_park')])).toEqual(['in_park']);
    expect(familyBoardTabs([child('c1', 'out'), child('c2', 'registered')])).toEqual(['registered']);
  });

  it('all three at once: Upcoming and In Park, never Out', () => {
    expect(familyBoardTabs([child('d1', 'out'), child('d2', 'in_park'), child('d3', 'registered')])).toEqual(['registered', 'in_park']);
  });
});

describe("the Upcoming tab's order", () => {
  it("is the waiting child's booked time, not the time of a sibling already in the park", () => {
    const family = [child('b1', 'registered', '2026-11-12T10:30:00.000Z'), child('b2', 'in_park', '2026-11-12T09:00:00.000Z')];
    expect(earliestArrival(family)).toBe(new Date('2026-11-12T10:30:00.000Z').getTime());
  });

  it('a family wholly waiting sorts by its earliest child as before; no booked time sorts last', () => {
    const family = [child('a1', 'registered', '2026-11-12T11:00:00.000Z'), child('a2', 'registered', '2026-11-12T10:00:00.000Z')];
    expect(earliestArrival(family)).toBe(new Date('2026-11-12T10:00:00.000Z').getTime());
    expect(earliestArrival([child('w1', 'registered')])).toBe(Infinity);
  });
});

describe('both boards read the rule, and still count children', () => {
  const read = (rel: string) => readFileSync(path.resolve(import.meta.dirname, '..', 'src', rel), 'utf8');
  for (const rel of ['pages/DropOff.tsx', 'components/mobile/dropoff/MobileDropOffBoard.tsx']) {
    it(rel, () => {
      const src = read(rel);
      expect(src).toContain('if (!familyBoardTabs(children).includes(tab)) continue;');
      expect(src).not.toMatch(/function familyTab\(/);
      expect(src).toContain('families.sort((a, b) => earliestArrival(a) - earliestArrival(b));');
      // Each tab's count is of children, one each, as the prototype counts them.
      expect(src).toMatch(/acc\[tabOf\(c\)\] \+= 1;/);
    });
  }
});
