/**
 * The "preview and print cannot drift" guarantee, enforced rather than asserted
 * in a comment.
 *
 * The claim is that there is exactly one path from a layout to dots, so the PNG
 * the admin panel shows and the raster the head lays down are the same bitmap.
 * `emit.test.ts` cannot hold that up: it round-trips the emitted bytes and
 * would stay green if someone added `previewHtml()` or a second rasteriser
 * beside `render()`.
 *
 * What actually makes the guarantee true is that `raster/fill` — the only code
 * in the package that turns outlines into coverage and coverage into dots — has
 * exactly one caller. This reads the source and fails if that stops being so.
 * It is a blunt test, and deliberately: a second drawing path has to either go
 * through `fill` (and fail here) or reimplement scanline filling from scratch,
 * which is not something anyone does by accident.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const srcDir = fileURLToPath(new URL('../src/', import.meta.url));

function sourceFiles(dir: string, prefix = ''): { path: string; text: string }[] {
  const out: { path: string; text: string }[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = `${dir}${entry}`;
    if (statSync(full).isDirectory()) {
      out.push(...sourceFiles(`${full}/`, `${prefix}${entry}/`));
    } else if (entry.endsWith('.ts')) {
      out.push({ path: `${prefix}${entry}`, text: readFileSync(full, 'utf8') });
    }
  }
  return out;
}

const files = sourceFiles(srcDir);

/** `import … from './raster/fill'` in any spelling of the relative path. */
function importsFill(text: string): boolean {
  return /from\s+['"][^'"]*raster\/fill['"]/.test(text);
}

describe('there is exactly one path from a layout to dots', () => {
  it('finds the source it is meant to be checking', () => {
    // A refactor that moves or renames files must not turn this test into one
    // that silently passes over an empty list.
    expect(files.length).toBeGreaterThan(10);
    expect(files.map((f) => f.path)).toContain('render.ts');
    expect(files.map((f) => f.path)).toContain('raster/fill.ts');
  });

  it('lets only render.ts reach the rasteriser', () => {
    const callers = files.filter((f) => importsFill(f.text)).map((f) => f.path);
    expect(callers).toEqual(['render.ts']);
  });

  it('keeps the preview a container, not a second drawing path', () => {
    const preview = files.find((f) => f.path === 'emit/preview.ts');
    expect(preview).toBeDefined();
    // It may know about a finished Bitmap1 and nothing earlier in the
    // pipeline: no shaping, no layout, no outlines.
    expect(preview?.text).not.toMatch(/from\s+['"][^'"]*(fonts|layout)\//);
    expect(importsFill(preview?.text ?? '')).toBe(false);
  });

  it('keeps the emitters containers too', () => {
    for (const path of ['emit/escpos.ts', 'emit/tspl.ts']) {
      const file = files.find((f) => f.path === path);
      expect(file, path).toBeDefined();
      expect(file?.text, path).not.toMatch(/from\s+['"][^'"]*(fonts|layout)\//);
      expect(importsFill(file?.text ?? ''), path).toBe(false);
    }
  });
});
