import { describe, expect, it } from 'vitest';
import { SUITE_SCREENS, type SuiteScreen } from '@oto/shared';
import { CONSOLE_SECTIONS } from '@/components/consoleSections';

/**
 * SCRUM-591 (internal assistant, round I1, lane b) — the deep-link map census
 * (plan docs/progress/plans/internal-assistant-build/PLAN.md §C, §F.3).
 *
 * The assistant offers a console page only when the asker could open it. The
 * map's `worthOffering` for each `console.*` key is a COPY of the page's own
 * gate, so this compares the two: a page whose gate moves, or a link to a page
 * that is not there, fails here until the map follows.
 */

const consoleScreens = (SUITE_SCREENS as readonly SuiteScreen[]).filter((s) => s.app === 'console');

describe('the deep-link map against the console (§F.3)', () => {
  it('links only to pages the console has, by their own route', () => {
    const routes = new Set(CONSOLE_SECTIONS.map((s) => `/${s.id}`));
    expect(consoleScreens.length).toBeGreaterThan(0);
    for (const screen of consoleScreens) expect(routes.has(screen.path), screen.key).toBe(true);
  });

  it("offers each console page on exactly that page's own permission", () => {
    for (const screen of consoleScreens) {
      const section = CONSOLE_SECTIONS.find((s) => `/${s.id}` === screen.path)!;
      expect(screen.worthOffering, screen.key).toEqual({ kind: 'permission', permission: section.permission });
    }
  });
});
