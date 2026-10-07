import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Branch } from '@/types';

/**
 * SCRUM-443 — THE HEADER'S BRANCH CHIP NAMES THE PARK IN FULL.
 *
 * At 1600px, with the customer display open or folded, the chip cut the seeded
 * parks to "Oto Play Park, Ce…" — one 110px line. In the till header (768px
 * and up) the name now wraps onto a second line inside the chip's own 32px
 * height ("Oto Play Park," over "Central Floresta", measured in a browser at
 * 120px), so the chip grows by about 10px and the header's nav — already
 * short of room at that width — gives up no more than that. A longer name is
 * clamped at two lines and given in full on hover.
 *
 * The phone top bar (`MobileShell`, below 768px) renders the same chip and
 * keeps the one 110px line: a two-line name there shrank to its longest word
 * and read "Oto / Play…" for both parks. Measured in Chromium against the real
 * component, old and new: below 768px the chip's narrowest and widest layouts
 * are both 164px with one cut line, as on main; from 768px its narrowest is
 * still 164px (two lines, nothing cut, both parks) and its widest 174px. The
 * runner has no layout engine, so these checks pin the classes that do it.
 */
const branches: Branch[] = [
  { id: 'hkt-central', name: 'Oto Play Park, Central Floresta', active: true },
  { id: 'robinson-chalong', name: 'Oto Play Park, Robinson Chalong', active: true },
];
let shown: Branch[] = branches;

vi.mock('@/branch/BranchContext', () => ({
  useBranch: () => ({ branch: shown[0], branches: shown, switching: false, setActiveBranchId: () => undefined }),
}));

beforeEach(() => {
  vi.stubGlobal('React', React);
  shown = branches;
});

const { BranchSwitcher } = await import('@/components/shared/BranchSwitcher');
const html = () => renderToStaticMarkup(React.createElement(BranchSwitcher));
const nameSpan = (out: string) => /<span class="([^"]*)" title="([^"]*)">([^<]*)<\/span>/.exec(out);
const classesOf = (span: RegExpExecArray | null) => (span?.[1] ?? '').split(' ').filter(Boolean);
/** The classes that apply below 768px: those with no breakpoint prefix. */
const phoneClasses = (classes: string[]) => classes.filter((c) => !c.includes(':'));
/** The classes the till header (768px and up) adds over them. */
const tillClasses = (classes: string[]) => classes.filter((c) => c.startsWith('md:')).map((c) => c.slice(3));

describe('the branch chip', () => {
  it('in the till header: the whole name, on up to two lines, never narrower than the old line', () => {
    const span = nameSpan(html());
    expect(span?.[3]).toBe('Oto Play Park, Central Floresta');
    expect(span?.[2]).toBe('Oto Play Park, Central Floresta');
    const till = tillClasses(classesOf(span));
    expect(till).toEqual(
      expect.arrayContaining(['line-clamp-2', 'whitespace-normal', 'min-w-[110px]', 'max-w-[120px]', 'leading-tight']),
    );
    // Every class is either the phone line or a till-header override: no other breakpoint.
    expect(classesOf(span).every((c) => !c.includes(':') || c.startsWith('md:'))).toBe(true);
  });

  it('in the phone top bar: the one 110px line it had before, nothing that lets it wrap or shrink', () => {
    const phone = phoneClasses(classesOf(nameSpan(html())));
    // origin/main's span was `truncate max-w-[110px]`, and nothing else.
    expect(phone.sort()).toEqual(['max-w-[110px]', 'truncate']);
  });

  it('a park with no other to switch to reads the same', () => {
    shown = [branches[1]!];
    const span = nameSpan(html());
    expect(span?.[3]).toBe('Oto Play Park, Robinson Chalong');
    expect(span?.[2]).toBe('Oto Play Park, Robinson Chalong');
    expect(phoneClasses(classesOf(span)).sort()).toEqual(['max-w-[110px]', 'truncate']);
    expect(tillClasses(classesOf(span))).toEqual(expect.arrayContaining(['line-clamp-2', 'min-w-[110px]']));
  });
});
