import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Branch } from '@/types';

/**
 * SCRUM-443 — THE HEADER'S BRANCH CHIP NAMES THE PARK IN FULL.
 *
 * At 1600px, with the customer display open or folded, the chip cut the seeded
 * parks to "Oto Play Park, Ce…" — one 110px line. The name now wraps onto a
 * second line inside the chip's own 32px height ("Oto Play Park," over
 * "Central Floresta", measured in a browser at 120px), so the chip grows by
 * about 10px and the header's nav — already short of room at that width —
 * gives up no more than that. A longer name is clamped at two lines and
 * given in full on hover.
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

describe('the branch chip', () => {
  it('with a switch to offer: the whole name, on up to two lines, never a one-line cut', () => {
    const span = nameSpan(html());
    expect(span?.[3]).toBe('Oto Play Park, Central Floresta');
    const classes = (span?.[1] ?? '').split(' ');
    expect(classes).toEqual(expect.arrayContaining(['line-clamp-2', 'max-w-[120px]', 'leading-tight']));
    expect(classes).not.toContain('truncate');
    expect(span?.[2]).toBe('Oto Play Park, Central Floresta');
  });

  it('a park with no other to switch to reads the same', () => {
    shown = [branches[1]!];
    const span = nameSpan(html());
    expect(span?.[3]).toBe('Oto Play Park, Robinson Chalong');
    expect((span?.[1] ?? '').split(' ')).toContain('line-clamp-2');
    expect(span?.[2]).toBe('Oto Play Park, Robinson Chalong');
  });
});
