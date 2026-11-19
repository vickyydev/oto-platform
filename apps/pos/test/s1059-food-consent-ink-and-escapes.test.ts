import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SCRUM-1059 (4) — "FOOD NOT AUTHORIZED" READS ON THE LIGHT THEME.
 *
 * At F&B, a band whose parent did not authorize food opens the box
 * (`components/fnb/FoodConsentModal.tsx`). It was drawn for the dark theme
 * only: amber-300 for the title and the words "not authorize", amber-100 at
 * 90% for "Only override after confirming with the parent or duty manager...",
 * which on the light theme's cream is pale yellow on cream (staging's n9).
 * Light now takes the warning inks of the F&B screen's own "Food not
 * authorized" banner beside it (`pages/OrderStation.tsx`); dark keeps the
 * classes it always had, behind `dark:`. Pinned as `s994` pins its inks: the
 * classes, and their contrast worked out from Tailwind's own values and the
 * till's theme tokens.
 *
 * SCRUM-1059 (5) — THE F&B ORDER-CONFIRMED SCREEN READ "F\&B credit": a JSX
 * attribute string does not take escapes, so the backslash was drawn. Swept
 * for the till: no attribute string anywhere in it carries a backslash.
 */

const SRC = new URL('../src/', import.meta.url);
const src = (file: string) => readFileSync(new URL(file, SRC), 'utf8');
const modal = src('components/fnb/FoodConsentModal.tsx');
const css = src('index.css');
const tailwind = readFileSync(createRequire(import.meta.url).resolve('tailwindcss/theme.css'), 'utf8');

type Rgb = [number, number, number];

/** Tailwind v4 writes its palette in OKLCH; the CSS Color 4 conversion to sRGB (0–255, clamped). */
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

/** A theme token from the block of `index.css` that starts at `selector`. */
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

/** The class list on the one line of the modal that carries `marker`. */
function classesWith(marker: string): string[] {
  const lines = modal.split('\n').filter((l) => l.includes(marker));
  if (lines.length !== 1) throw new Error(`expected one line with ${marker}, found ${lines.length}`);
  const m = lines[0]!.match(/className="([^"]+)"/);
  if (!m) throw new Error(`no className on the line with ${marker}`);
  return m[1]!.split(/\s+/);
}

describe('SCRUM-1059 (4): the "Food not authorized" box, light and dark', () => {
  const parts = {
    warning: classesWith('bg-amber-500/10 p-4 text-sm'),
    title: classesWith('text-center text-2xl font-bold'),
    words: classesWith('not authorize</span>'),
    shield: classesWith('rounded-full bg-amber-500/20'),
    utensils: classesWith('<UtensilsCrossed'),
  };
  const light = (cls: string[]) => cls.filter((c) => /^text-amber-/.test(c));
  const dark = (cls: string[]) => cls.filter((c) => /^dark:text-amber-/.test(c));

  it("light: the F&B banner's own warning inks", () => {
    expect(light(parts.warning)).toEqual(['text-amber-900']);
    expect(light(parts.title)).toEqual(['text-amber-800']);
    expect(light(parts.words)).toEqual(['text-amber-800']);
    expect(light(parts.shield)).toEqual(['text-amber-700']);
    expect(light(parts.utensils)).toEqual(['text-amber-700']);
    const banner = src('pages/OrderStation.tsx');
    expect(banner).toContain('bg-amber-500/15 px-4 py-3 text-amber-900 dark:text-amber-100');
    expect(banner).toContain('text-sm font-bold uppercase tracking-wide text-amber-800 dark:text-amber-200');
  });

  it('dark: exactly the inks it always had, each behind dark:', () => {
    expect(dark(parts.warning)).toEqual(['dark:text-amber-100/90']);
    expect(dark(parts.title)).toEqual(['dark:text-amber-300']);
    expect(dark(parts.words)).toEqual(['dark:text-amber-300']);
    expect(dark(parts.shield)).toEqual(['dark:text-amber-400']);
    expect(dark(parts.utensils)).toEqual(['dark:text-amber-400']);
    expect(css).toContain('@custom-variant dark (&:is(.dark *));');
  });

  it('colour only: the box, its wash and its border are as they were', () => {
    expect(parts.warning.filter((c) => !/text-amber-/.test(c))).toEqual(['rounded-xl', 'border', 'border-amber-500/30', 'bg-amber-500/10', 'p-4', 'text-sm']);
    expect(modal).toContain('<DialogContent className="max-h-[90vh] overflow-y-auto border-amber-500/50 sm:max-w-lg">');
  });

  for (const [theme, selector, inks] of [
    ['light', ':root,', { warning: amber(900), title: amber(800), icon: amber(700) }],
    ['dark', '.dark {', { warning: null, title: amber(300), icon: amber(400) }],
  ] as const) {
    it(`${theme}: every line reads at 4.5:1 or more, the icons at 3:1`, () => {
      const dialog = token(selector, 'popover');
      const box = over(amber(500), dialog, 0.1);
      const warning = inks.warning ?? over(amber(100), box, 0.9);
      expect(contrast(warning, box)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(inks.title, dialog)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(inks.icon, box)).toBeGreaterThanOrEqual(3);
      expect(contrast(inks.icon, over(amber(500), dialog, 0.2))).toBeGreaterThanOrEqual(3);
    });
  }

  it('the old light-theme inks really were unreadable (the defect this pins)', () => {
    const dialog = token(':root,', 'popover');
    const box = over(amber(500), dialog, 0.1);
    expect(contrast(over(amber(100), box, 0.9), box)).toBeLessThan(1.5);
    expect(contrast(amber(300), dialog)).toBeLessThan(2);
  });
});

describe('SCRUM-1059 (5): no stray escape in a label the till draws', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = path.join(dir, name);
      return statSync(full).isDirectory() ? files(full) : full.endsWith('.tsx') ? [full] : [];
    });

  it('the F&B order-confirmed screen reads "F&B credit"', () => {
    const confirmation = src('components/fnb/FnbConfirmation.tsx');
    expect(confirmation).toContain('<PaidRow icon={Wallet} label="F&B credit" amount={payment.creditUsed} />');
    expect(confirmation).not.toContain('\\&');
  });

  it('no JSX attribute string in the till carries a backslash', () => {
    const found = files(path.join(import.meta.dirname, '..', 'src')).flatMap((file) =>
      readFileSync(file, 'utf8').split('\n').flatMap((line, i) =>
        /\s[\w-]+="[^"{}]*\\[^"]*"/.test(line) ? [`${path.relative(path.join(import.meta.dirname, '..'), file)}:${i + 1}`] : []));
    expect(found).toEqual([]);
  });
});
