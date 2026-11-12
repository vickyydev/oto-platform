import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SCRUM-912 — THE TILL DRAWS THAI FROM ITS OWN FACE.
 *
 * CI's Linux Chromium broke the PromptPay tile's Thai name onto two lines:
 * its runner image has no Thai font, nor may the counter Pi's browser, so
 * Thai came from whatever the system found. The till now carries Noto Sans
 * Thai as 'Till Thai' (the printer's file, unmodified), names it after Inter,
 * precaches it for an offline load and serves it with its own type. The
 * browser measurement is in scrum-882-payment-tiles-whole-words.test.ts.
 */
const pos = (rel: string) => path.resolve(import.meta.dirname, '..', rel);
const read = (rel: string) => readFileSync(pos(rel), 'utf8');

describe('SCRUM-912 — the Thai face travels with the till', () => {
  it('fonts.css declares Till Thai from the printer\'s Noto Sans Thai, Thai only, Regular and Bold', () => {
    const css = read('src/fonts.css');
    const faces = css.match(/@font-face\s*\{[^}]*font-family:\s*'Till Thai'[^}]*\}/g) ?? [];
    expect(faces).toHaveLength(2);
    for (const [weight, file] of [['400', 'NotoSansThai-Regular.ttf'], ['700', 'NotoSansThai-Bold.ttf']] as const) {
      const face = faces.find((f) => f.includes(`font-weight: ${weight};`));
      expect(face).toContain(`src: url('../../../packages/print/fonts/${file}') format('truetype');`);
      expect(face).toContain('unicode-range: U+0E01-0E5B, U+200C-200D, U+25CC;');
      expect(face).toContain('font-display: swap;');
      expect(existsSync(pos(`../../packages/print/fonts/${file}`))).toBe(true);
    }
  });

  it('the till\'s sans stack names it right after Inter', () => {
    expect(read('src/index.css')).toContain("--app-font-sans: 'Inter', 'Till Thai', sans-serif;");
  });

  it('it is precached for an offline load and served as a font', () => {
    expect(read('vite.config.ts')).toMatch(/const PRECACHE_EXTENSIONS = \[[^\]]*'\.ttf'[^\]]*\];/);
    expect(read('server/static.ts')).toContain("'.ttf': 'font/ttf'");
  });
});
