import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

/**
 * SCRUM-994 — THE CHOSEN SUB-CATEGORY STANDS OUT ON THE LIGHT THEME.
 *
 * The F&B menu's sub-categories stand in rows of equal chips
 * (`components/fnb/MenuGrid.tsx`, SUB_CATEGORY_GRID). The chosen chip was drawn
 * for the dark theme only, `bg-amber-500/20 text-amber-400 border-amber-500`:
 * on the light theme that is amber text on a pale amber wash over cream, about
 * 1.4:1, and the chosen chip hardly stood out among the white ones. Asked
 * "Make the chosen sub-category stand out more in the light theme?", the owner
 * ticked "Make it stronger" (18 November).
 *
 * Light: solid amber-500, amber-950 text, an amber-700 outline. Dark: the
 * classes it always had, behind `dark:` (the till's `dark` variant is
 * `&:is(.dark *)`, so they win wherever the staff screens are dark). Colour
 * only: the 1px border stays, so the chip's size and the rows do not move
 * (`s994-fnb-sub-rows-measured.test.ts` measures those).
 *
 * Pinned twice, as `scrum-879-amber-on-light.test.ts` pins its strips: the
 * classes, and the contrast of those classes worked out from Tailwind's own
 * amber values and the till's theme tokens in `src/index.css`.
 */

const src = (file: string) => readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8');
const grid = src('components/fnb/MenuGrid.tsx');
const css = src('index.css');
const tailwind = readFileSync(createRequire(import.meta.url).resolve('tailwindcss/theme.css'), 'utf8');

/** The class string of the chosen chip (`SUB_CHIP_CHOSEN`). */
function chosenClasses(): string[] {
  const m = grid.match(/const SUB_CHIP_CHOSEN =\s*'([^']+)';/);
  if (!m) throw new Error('SUB_CHIP_CHOSEN not in MenuGrid.tsx');
  return m[1]!.split(/\s+/);
}

describe('SCRUM-994 — the chosen sub-category chip, light and dark', () => {
  const classes = chosenClasses();
  const light = classes.filter((c) => !c.startsWith('dark:'));
  const dark = classes.filter((c) => c.startsWith('dark:'));

  it('the chips draw the chosen one with SUB_CHIP_CHOSEN', () => {
    expect(grid).toContain('aria-pressed={isActive}');
    expect(grid).toMatch(/isActive\s*\?\s*SUB_CHIP_CHOSEN\s*:/);
  });

  it('light: solid amber-500, amber-950 text, an amber-700 outline — never the pale wash again', () => {
    expect(light).toEqual(['bg-amber-500', 'text-amber-950', 'border', 'border-amber-700']);
    // The wash and the pale ink belong to the dark theme only.
    expect(light.filter((c) => /^(bg-amber-\d+\/|text-amber-[1-4]00$)/.test(c))).toEqual([]);
  });

  it('dark: exactly the classes it always had, each behind dark:', () => {
    expect(dark).toEqual(['dark:bg-amber-500/20', 'dark:text-amber-400', 'dark:border-amber-500']);
    // Every colour set for light is set again for dark, so nothing of light shows through there.
    const kind = (c: string) => c.replace(/^dark:/, '').replace(/-amber-.*$/, '');
    expect(dark.map(kind).sort()).toEqual(light.filter((c) => c !== 'border').map(kind).sort());
  });

  it("the till's dark variant is the ancestor .dark the staff theme sets", () => {
    expect(css).toContain('@custom-variant dark (&:is(.dark *));');
  });

  it('colour only: the chip keeps its 1px border, height, corners and padding', () => {
    expect(classes.filter((c) => /^(border-\d|min-h|h-|p[xy]?-|rounded)/.test(c))).toEqual([]);
    expect(grid).toContain(
      "'min-h-10 px-1.5 rounded-[1.25rem] flex items-center justify-center text-center text-sm font-semibold leading-tight transition-all active:scale-95'",
    );
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

describe('SCRUM-994 — the chosen chip reads on the light theme', () => {
  const page = token(':root,', 'background');
  const card = token(':root,', 'card');
  // What stands behind the chips: the page (the phone till), or the desk's menu column (`bg-card/20` over it).
  const behind = [page, over(card, page, 0.2)];

  it('its text reaches AA (4.5:1) on its fill', () => {
    expect(contrast(amber(950), amber(500))).toBeGreaterThanOrEqual(4.5);
  });

  it('its outline reaches 3:1 on what stands behind it', () => {
    for (const bg of behind) expect(contrast(amber(700), bg)).toBeGreaterThanOrEqual(3);
  });

  it('its fill stands clear of a white chip and the page, where the old wash did not', () => {
    for (const bg of [card, ...behind]) {
      expect(contrast(amber(500), bg)).toBeGreaterThan(1.9);
      expect(contrast(over(amber(500), bg, 0.2), bg)).toBeLessThan(1.25);
    }
  });

  it('the old light-theme chip really was unreadable (the defect this pins)', () => {
    for (const bg of behind) {
      expect(contrast(amber(400), over(amber(500), bg, 0.2))).toBeLessThan(1.5);
    }
  });
});

// --- SCRUM-997: three more places where writing was hard to read ------------

/**
 * SCRUM-997 — found while the chosen chip above was made stronger, and fixed
 * on the owner's "Fix them" (18 November). Colours only, from inks the till
 * already uses, each with its dark (or light) side kept exactly as it was:
 *   - light, F&B and Shop: the split view's top line ("Test harness — …") and
 *     its Hide/Show button, pale amber-300 on the amber wash; now the pair the
 *     Tickets screen got in SCRUM-879 (`text-amber-800 dark:text-amber-300`);
 *   - light, F&B: a sub-category not chosen, under the mouse, turned amber-400
 *     on its white chip; now amber-800 (`SUB_CHIP_IDLE`);
 *   - dark: the "out of stock" strip under the header wrote in the theme's own
 *     deep red (`--destructive`) on its red wash; now red-300 there, the
 *     shared token untouched.
 */

const order = src('pages/OrderStation.tsx');
const merch = src('pages/MerchStation.tsx');
const header = src('components/shared/StationHeader.tsx');

function lineWith(source: string, marker: string): string {
  const lines = source.split('\n').filter((l) => l.includes(marker));
  if (lines.length !== 1) throw new Error(`expected one line with ${marker}, found ${lines.length}`);
  return lines[0]!;
}

function palette(name: string, shade: number): Rgb {
  const m = tailwind.match(new RegExp(`--color-${name}-${shade}: oklch\\(([\\d.]+)% ([\\d.]+) ([\\d.]+)\\)`));
  if (!m) throw new Error(`${name}-${shade} not in tailwindcss/theme.css`);
  return oklchToRgb(Number(m[1]) / 100, Number(m[2]), Number(m[3]));
}

describe('SCRUM-997 — each place carries a readable ink and keeps its other theme', () => {
  for (const [name, source] of [['F&B (OrderStation)', order], ['Shop (MerchStation)', merch]] as const) {
    it(`${name}: the top line and its Hide/Show button`, () => {
      const banner = lineWith(source, 'bg-amber-500/10 border-b border-amber-500/30');
      expect(banner).toContain('text-amber-800 dark:text-amber-300');
      const button = lineWith(source, 'hover:bg-amber-500/20');
      expect(button).toContain('text-amber-800 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-200');
      // The pale inks only behind dark:.
      expect(banner + button).not.toMatch(/(?<!dark:(hover:)?)text-amber-(200|300)/);
      // Colour only: the line's size and spacing are as they were.
      expect(banner).toContain('shrink-0 flex items-center justify-between gap-4 px-4 py-2');
      expect(button).toContain('h-7 shrink-0');
    });
  }

  it('F&B: a sub-category not chosen, under the mouse', () => {
    const m = grid.match(/const SUB_CHIP_IDLE =\s*'([^']+)';/);
    expect(m).not.toBeNull();
    expect(m![1]!.split(/\s+/)).toEqual([
      'bg-card', 'border', 'text-muted-foreground', 'hover:text-amber-800', 'dark:hover:text-amber-400', 'hover:border-amber-500/50',
    ]);
    expect(grid).toMatch(/isActive\s*\?\s*SUB_CHIP_CHOSEN\s*:\s*SUB_CHIP_IDLE/);
    expect(grid).not.toMatch(/(?<!dark:)hover:text-amber-400/);
  });

  it('dark: the out-of-stock strip, without touching the shared red', () => {
    const strip = lineWith(header, 'bg-destructive/15');
    expect(strip).toContain("'bg-destructive/15 text-destructive dark:text-red-300 border-destructive/30'");
    // The theme's --destructive is shared by every button and badge: unchanged on both themes.
    expect(css.slice(css.indexOf(':root,'), css.indexOf('.dark {'))).toContain('--destructive: 0 72% 47%;');
    expect(css.slice(css.indexOf('.dark {'))).toContain('--destructive: 0 62.8% 30.6%;');
    // The names beside the count stay at 80%, as they were.
    expect(header).toContain('min-w-0 truncate font-normal opacity-80');
  });
});

describe('SCRUM-997 — the three reach AA (4.5:1) where they were hard to read', () => {
  const light = { page: token(':root,', 'background'), card: token(':root,', 'card') };
  const dark = { page: token('.dark {', 'background'), card: token('.dark {', 'card'), red: token('.dark {', 'destructive') };

  it('light: the top line on its amber wash (1.24:1 before, about 6.1:1 now), its button under the mouse (about 6.9:1)', () => {
    const wash = over(amber(500), light.page, 0.1);
    expect(contrast(amber(300), wash)).toBeLessThan(1.5);
    expect(contrast(amber(800), wash)).toBeGreaterThanOrEqual(4.5);
    const pressed = over(amber(500), wash, 0.2);
    expect(contrast(amber(900), pressed)).toBeGreaterThanOrEqual(4.5);
    // The dark side keeps amber-300, which reads there.
    expect(contrast(amber(300), over(amber(500), dark.page, 0.1))).toBeGreaterThanOrEqual(4.5);
  });

  it('light: the chip’s writing under the mouse on its white face (1.69:1 before, about 7.0:1 now)', () => {
    expect(contrast(amber(400), light.card)).toBeLessThan(2);
    expect(contrast(amber(800), light.card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(amber(400), dark.card)).toBeGreaterThanOrEqual(4.5);
  });

  it('dark: the strip’s count and names on its red wash (1.72:1 and 1.50:1 before, about 9.0:1 and 6.2:1 now)', () => {
    const wash = over(dark.red, dark.page, 0.15);
    expect(contrast(dark.red, wash)).toBeLessThan(2);
    expect(contrast(palette('red', 300), wash)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(over(palette('red', 300), wash, 0.8), wash)).toBeGreaterThanOrEqual(4.5);
  });
});
