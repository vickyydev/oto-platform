// SCRUM-1045 — ONE scale for the Inbox's sizes, read from the source as
// dark-theme.test.ts reads the colours: the type sizes, control heights,
// gutters and faces live in `index.css` in three densities (a phone's
// comfortable, a tablet's compact, a wide desktop's regular), handed to
// Tailwind as `text-body`, `min-h-ctl`, `px-pane`, `size-face`; no component
// carries a size of its own, a breakpoint switch of a type size, or one of
// Tailwind's own sizes. Nothing is under 11 px; a control drawn under 44 px
// keeps a 44 px target on a touch screen.
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BADGE, BTN_ICON, BTN_MAIN, BTN_OUTLINE, BTN_QUIET, BTN_SMALL, CHECK_LINE, HINT, INPUT, LABEL, SEGMENT } from '@/components/ui';
import { PILL } from '@/components/atoms';

const here = (...p: string[]) => path.resolve(import.meta.dirname, '..', ...p);
const css = readFileSync(here('src/index.css'), 'utf8');
const sources = (readdirSync(here('src'), { recursive: true }) as string[])
  .filter((f) => /\.tsx?$/.test(f))
  .map((f) => [f.replace(/\\/g, '/'), readFileSync(here('src', f), 'utf8')] as const);

const STEPS = ['caption', 'meta', 'note', 'ui', 'action', 'body', 'title', 'heading', 'figure', 'display'] as const;
const CONTROLS = ['h-sm', 'h', 'h-lg', 'h-icon'] as const;

/** The custom properties a CSS block declares, by name. */
function declared(block: string): Record<string, number> {
  return Object.fromEntries([...block.matchAll(/--(ui-[a-z-]+):\s*([\d.]+)px;/g)].map((m) => [m[1]!, Number(m[2])]));
}
/** The three densities' blocks, in the order the stylesheet gives them. */
function densities() {
  const comfortable = /:root,\s*\.density-window \{([^}]*)\}/.exec(css)![1]!;
  const compact = /@media \(min-width: 768px\) \{\s*:root,\s*\.density-window,\s*\[data-pane\] > \* \{([^}]*)\}/.exec(css)![1]!;
  const regular = /@media \(min-width: 1280px\) \{\s*:root,\s*\.density-window \{([^}]*)\}/.exec(css)![1]!;
  const regularPane = /@container pane \(min-width: 720px\) \{\s*\[data-pane\] > \* \{([^}]*)\}/.exec(css)![1]!;
  return { comfortable: declared(comfortable), compact: declared(compact), regular: declared(regular), regularPane: declared(regularPane) };
}

describe('SCRUM-1045: the scale in index.css', () => {
  it('declares every step in each of the three densities, the same names in each', () => {
    const d = densities();
    const names = Object.keys(d.comfortable).sort();
    for (const step of STEPS) expect(names, step).toContain(`ui-fs-${step}`);
    for (const c of CONTROLS) expect(names, c).toContain(`ui-${c}`);
    expect(Object.keys(d.compact).sort()).toEqual(names);
    expect(Object.keys(d.regular).sort()).toEqual(names);
    // A wide pane on a wide screen is regular: the same values as the window's.
    expect(d.regularPane).toEqual(d.regular);
  });

  it('nothing is under 11 px, and each density reads from small to large', () => {
    for (const [name, values] of Object.entries(densities())) {
      const sizes = STEPS.map((s) => values[`ui-fs-${s}`]!);
      for (const size of sizes) expect(size, name).toBeGreaterThanOrEqual(11);
      // `action` (a main button's words) stands beside the climb, the rest climb.
      expect(values['ui-fs-caption']!).toBeLessThanOrEqual(values['ui-fs-meta']!);
      expect(values['ui-fs-meta']!).toBeLessThanOrEqual(values['ui-fs-note']!);
      expect(values['ui-fs-note']!).toBeLessThanOrEqual(values['ui-fs-ui']!);
      expect(values['ui-fs-ui']!).toBeLessThanOrEqual(values['ui-fs-body']!);
      expect(values['ui-fs-body']!).toBeLessThanOrEqual(values['ui-fs-title']!);
      expect(values['ui-fs-title']!).toBeLessThanOrEqual(values['ui-fs-figure']!);
    }
  });

  it('a phone keeps the approved sizes; a tablet is smaller, as asked: 14 px names and bubbles, 11 px captions', () => {
    const { comfortable, compact } = densities();
    expect(comfortable['ui-fs-body']).toBe(15);
    expect(compact['ui-fs-body']).toBe(14);
    expect(compact['ui-fs-ui']).toBe(13);
    expect(compact['ui-fs-caption']).toBe(11);
    expect(compact['ui-fs-figure']).toBeGreaterThanOrEqual(17);
    expect(compact['ui-fs-figure']).toBeLessThanOrEqual(18);
    for (const step of STEPS) expect(compact[`ui-fs-${step}`]!, step).toBeLessThanOrEqual(comfortable[`ui-fs-${step}`]!);
  });

  it('controls are 44 px and more on a phone, 32 to 36 px on a tablet, and keep a 44 px target on a touch screen', () => {
    const { comfortable, compact, regular } = densities();
    for (const c of CONTROLS) expect(comfortable[`ui-${c}`]!, c).toBeGreaterThanOrEqual(44);
    expect(compact['ui-h']).toBe(32);
    expect(regular['ui-h']).toBe(34);
    expect(compact['ui-h-lg']).toBe(36);
    // The touch target: an invisible extension of every `.hit` control on a coarse pointer.
    expect(css).toMatch(/@media \(any-pointer: coarse\) \{[^]*?\.hit::after \{[^}]*width: max\(100%, 44px\);[^}]*height: max\(100%, 44px\);/);
  });

  it('Tailwind gets the steps and nothing else: its own sizes are removed', () => {
    expect(css).toContain('--text-*: initial;');
    for (const step of STEPS) expect(css).toContain(`--text-${step}: var(--ui-fs-${step});`);
    for (const t of ['ctl-sm', 'ctl', 'ctl-lg', 'icon', 'pane', 'row', 'stack', 'face', 'face-sm']) expect(css).toMatch(new RegExp(`--spacing-${t}: var\\(--ui-`));
  });

  it('each pane is a size container that hands its content the density its own width calls for', () => {
    expect(css).toMatch(/\[data-pane\] \{\s*container-type: inline-size;/);
    for (const pane of ['list', 'chat', 'rail', 'panel', 'settings']) expect(css).toContain(`[data-pane='${pane}'] {\n  container-name: pane ${pane};`);
  });
});

describe('SCRUM-1045: no component carries a size of its own', () => {
  it('no type size in px, rem or em, and none of Tailwind’s own sizes', () => {
    const found = sources.flatMap(([file, src]) =>
      [...src.matchAll(/(?<![\w-])text-(?:\[(?:length:)?[\d.]+(?:px|rem|em)\]|xs|sm|base|lg|xl|[2-9]xl)(?![\w-])/g)].map((m) => `${file}: ${m[0]}`),
    );
    expect(found).toEqual([]);
  });

  it('no breakpoint switch of a type size: the density does that', () => {
    const steps = STEPS.join('|');
    const found = sources.flatMap(([file, src]) =>
      [...src.matchAll(new RegExp(`(?<![\\w-])(?:sm|md|lg|xl|2xl|max-md|max-lg):text-(?:${steps})(?![\\w-])`, 'g'))].map((m) => `${file}: ${m[0]}`),
    );
    expect(found).toEqual([]);
  });

  it('no control height of its own (44 / 48 px, or a breakpoint’s smaller one): the scale’s ctl and icon', () => {
    const found = sources.flatMap(([file, src]) =>
      [...src.matchAll(/(?<![\w-])(?:min-h-(?:8|9|10|11|12)|h-(?:11|12)|(?:sm|md|lg|xl):(?:min-h|h)-(?:8|9|10|11|12))(?![\w-])/g)].map((m) => `${file}: ${m[0]}`),
    );
    expect(found).toEqual([]);
  });

  it('the shared classes are on the scale, and every control among them keeps a 44 px target to a finger', () => {
    for (const [name, cls] of Object.entries({ BTN_MAIN, BTN_QUIET, BTN_OUTLINE, BTN_SMALL, BTN_ICON, SEGMENT, PILL, CHECK_LINE })) {
      expect(cls, name).toMatch(/(?:^|\s)(?:min-h|h|size)-(?:ctl|ctl-sm|ctl-lg|icon)(?:\s|$)/);
      expect(cls, name).toMatch(/(?:^|\s)hit(?:\s|$)/);
      // An icon-only button has no words to size.
      if (name !== 'BTN_ICON') expect(cls, name).toMatch(new RegExp(`(?:^|\\s)text-(?:${STEPS.join('|')})(?:\\s|$)`));
    }
    expect(INPUT).toContain('min-h-ctl-lg');
    expect(INPUT).toContain('text-body');
    for (const cls of [LABEL, HINT, BADGE]) expect(cls).toMatch(new RegExp(`(?:^|\\s)text-(?:${STEPS.join('|')})(?:\\s|$)`));
  });

  it('no control draws an edge thicker than 1 px: a chosen state is a ground and a fine edge', () => {
    const found = sources.flatMap(([file, src]) =>
      [...src.matchAll(/(?<![\w-])(?:ring-2|ring-4|border-2|border-4)(?![\w-])/g)]
        .filter((m) => {
          // The channel dot and the people's faces are cut out of their ground by a 2 px ring of that ground: not an edge.
          const line = src.slice(src.lastIndexOf('\n', m.index!), src.indexOf('\n', m.index!));
          return !/ChannelDot|ring-2 \$\{ring\}|border-mint-soft|rounded-full ring-2/.test(line);
        })
        .map((m) => `${file}: ${m[0]}`),
    );
    expect(found).toEqual([]);
  });
});
