import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * SCRUM-879 — THE AMBER WARNINGS ARE READABLE ON THE LIGHT THEME.
 *
 * Three amber strips on the staff side were written for the dark theme only:
 * `text-amber-300` (and `text-amber-200/90` for the list) on a 10% amber wash.
 * On the light theme that is pale yellow on cream, about 1.3:1. They were:
 *   - the drop-off step's "Before payment" list (`SupervisionGate`),
 *   - the split view's "Test harness" banner and its Hide/Show button (`Till`),
 *   - the "7 overdue" bar and its "Review" link (`OverstayBanner`).
 *
 * The fix is the light/dark pair the till already uses for amber text
 * (`text-amber-800 dark:text-amber-300`, the prototype's own pattern of
 * `text-amber-700 dark:text-amber-300` one step darker, because 700 measures
 * 4.3:1 on this wash and AA asks 4.5). The dark theme keeps its classes.
 *
 * Pinned twice: the classes on each element, and the contrast of those
 * classes, worked out from Tailwind's own amber values and the till's theme
 * tokens in `src/index.css`, against AA (4.5:1) on both themes.
 */

const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const gate = src('components/till/SupervisionGate.tsx');
const till = src('pages/Till.tsx');
const overstay = src('components/dropoff/OverstayBanner.tsx');
const css = src('index.css');
const tailwind = readFileSync(createRequire(import.meta.url).resolve('tailwindcss/theme.css'), 'utf8');

/** The line of `source` that holds `marker`. */
function lineWith(source: string, marker: string): string {
  const line = source.split('\n').find((l) => l.includes(marker));
  if (!line) throw new Error(`no line with ${marker}`);
  return line;
}

describe('SCRUM-879 — each strip carries a light ink and keeps its dark one', () => {
  it('the Before payment heading and list', () => {
    const block = gate.slice(gate.indexOf('uniqueBlockers.length > 0 &&'), gate.indexOf('uniqueBlockers.map'));
    expect(block).toContain('text-amber-800 dark:text-amber-300');
    expect(block).toContain('text-amber-900/90 dark:text-amber-200/90');
    expect(block).not.toMatch(/(?<!dark:)text-amber-(200|300)/);
  });

  it('the test-harness banner and its Hide/Show customer display button', () => {
    const banner = lineWith(till, 'bg-amber-500/10 border-b border-amber-500/30');
    expect(banner).toContain('text-amber-800 dark:text-amber-300');
    const button = lineWith(till, 'hover:bg-amber-500/20');
    expect(button).toContain('text-amber-800 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-200');
    expect(banner + button).not.toMatch(/(?<!dark:(hover:)?)text-amber-(200|300)/);
  });

  it('the overdue bar and its Review link', () => {
    const bar = lineWith(overstay, 'border-amber-500/40 bg-amber-500/10');
    expect(bar).toContain('text-amber-800 dark:text-amber-300');
    expect(bar).not.toMatch(/(?<!dark:)text-amber-300/);
    // The link was dimmed to 80% for the dark theme; on the light one it keeps its full ink.
    expect(lineWith(overstay, 'Review →')).toContain('dark:opacity-80');
  });
});

// --- contrast ---------------------------------------------------------------

type Rgb = [number, number, number];

/** Tailwind v4 writes its palette in OKLCH; this is the CSS Color 4 conversion to sRGB (0–255, clamped). */
function oklchToRgb(l: number, c: number, h: number): Rgb {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const lin = [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
  return lin.map((v) => {
    const x = Math.min(1, Math.max(0, v));
    return 255 * (x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055);
  }) as Rgb;
}

function amber(shade: number): Rgb {
  const m = tailwind.match(new RegExp(`--color-amber-${shade}: oklch\\(([\\d.]+)% ([\\d.]+) ([\\d.]+)\\)`));
  if (!m) throw new Error(`amber-${shade} not in tailwindcss/theme.css`);
  return oklchToRgb(Number(m[1]) / 100, Number(m[2]), Number(m[3]));
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  s /= 100;
  l /= 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [f(0) * 255, f(8) * 255, f(4) * 255];
}

/** A theme token (`--background`, `--card`) from the block of `index.css` that starts at `selector`. */
function token(selector: string, name: string): Rgb {
  const block = css.slice(css.indexOf(selector));
  const m = block.match(new RegExp(`--${name}: ([\\d.]+) ([\\d.]+)% ([\\d.]+)%;`));
  if (!m) throw new Error(`--${name} not under ${selector}`);
  return hslToRgb(Number(m[1]), Number(m[2]), Number(m[3]));
}

const over = (fg: Rgb, bg: Rgb, alpha: number): Rgb => fg.map((v, i) => v * alpha + bg[i]! * (1 - alpha)) as Rgb;

function contrast(a: Rgb, b: Rgb): number {
  const lum = (c: Rgb) => {
    const [r, g, bl] = c.map((v) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    }) as Rgb;
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('SCRUM-879 — every ink reaches AA (4.5:1) on its wash, on both themes', () => {
  const themes = {
    light: { surfaces: [token(':root,', 'background'), token(':root,', 'card')] },
    dark: { surfaces: [token('.dark {', 'background'), token('.dark {', 'card')] },
  };
  // Each strip's wash is `bg-amber-500/10` over the page or a card.
  const wash = (surface: Rgb) => over(amber(500), surface, 0.1);

  const inks: Record<'light' | 'dark', { name: string; ink: (bg: Rgb) => Rgb }[]> = {
    light: [
      { name: 'amber-800 (headings, banner, button, bar, Review)', ink: () => amber(800) },
      { name: 'amber-900/90 (the list)', ink: (bg) => over(amber(900), bg, 0.9) },
    ],
    dark: [
      { name: 'amber-300 (headings, banner, button, bar)', ink: () => amber(300) },
      { name: 'amber-300 at 80% (Review)', ink: (bg) => over(amber(300), bg, 0.8) },
      { name: 'amber-200/90 (the list)', ink: (bg) => over(amber(200), bg, 0.9) },
    ],
  };

  for (const theme of ['light', 'dark'] as const) {
    for (const { name, ink } of inks[theme]) {
      it(`${theme}: ${name}`, () => {
        for (const surface of themes[theme].surfaces) {
          const bg = wash(surface);
          expect(contrast(ink(bg), bg)).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
  }

  it('the old light-theme ink really was unreadable (the defect this pins)', () => {
    const bg = wash(themes.light.surfaces[0]!);
    expect(contrast(amber(300), bg)).toBeLessThan(1.5);
  });
});
