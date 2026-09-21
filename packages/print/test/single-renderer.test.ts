/**
 * The "preview and print cannot drift" guarantee, enforced rather than asserted
 * in a comment.
 *
 * The claim is that there is exactly one path from a template to dots, so the
 * PNG an admin panel shows and the raster the head lays down are the same
 * bitmap. `emit.test.ts` cannot hold that up: it round-trips the emitted bytes
 * and would stay green if someone added `previewHtml()` or a second rasteriser
 * beside `render()`.
 *
 * **This walks the whole repository, and it did not always.** The first version
 * read `packages/print/src` alone, and it was green throughout the months in
 * which the POS's template editor drew its own receipt in HTML — its own fonts,
 * its own line breaking, its own sample content — beside a comment claiming one
 * renderer. A test that can only see one side of a seam proves nothing about
 * the seam, which is the lesson this file exists to stop re-learning. So it
 * reads every `.ts` and `.tsx` file under `apps/` and `packages/` — both ends
 * of that seam and everything between them — skipping only `node_modules`,
 * `dist`, `build`, `coverage` and dot-directories, which are vendored or
 * generated. Nothing else is skipped, and `SKIP` says why.
 *
 * **And it is hashed on what it reads.** `turbo.json` gives this package's
 * `test` task an entry of its own with explicit `inputs` covering `apps/` and
 * `packages/`. Without it the task was hashed on the print package's own files:
 * with a second drawing path planted in `apps/pos`, `pnpm turbo run test
 * --filter=@oto/print` was a cache hit that replayed a stored pass and never
 * ran this file — a guard that only runs when the code it guards is not what
 * changed. That was measured before the entry was added, and measured again
 * after: the same planted file is now a cache miss and a red test.
 *
 * **What it checks, and what it does not.** It is structural. It cannot read
 * intent, so it looks for the three things a second drawing path needs and
 * cannot do without: the rasteriser, a preview surface that composes marks
 * instead of showing a picture, and sample content of its own. None of those
 * is proof on its own; together they are what an honest attempt to draw a
 * printout somewhere else would trip over, and they are blunt on purpose. What
 * it does NOT prove is that any particular preview is correct — that is
 * `apps/api/test/print-api.test.ts`, which compares the editor's preview with
 * the bytes the printer received, byte for byte.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/**
 * Directories that hold no authored TypeScript of ours: dependencies and build
 * output.
 *
 * `fixtures` was on this list for one round, and a reviewer planted a file
 * under `apps/pos/src/zzfixtures/fixtures/` that imported the rasteriser AND
 * defined its own sample content — the two things this file exists to catch —
 * and the suite ran green. A directory name is not a promise about what is in
 * it, and "somewhere the guard does not look" is the whole technique. So the
 * only things skipped now are ones that are generated or vendored, and a
 * `fixtures/` directory is walked like any other.
 */
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage']);

interface SourceFile {
  /** Repository-relative, with forward slashes. */
  path: string;
  text: string;
}

function walk(dir: string, prefix: string, out: SourceFile[]): void {
  for (const entry of readdirSync(dir).sort()) {
    if (SKIP.has(entry) || entry.startsWith('.')) continue;
    const full = `${dir}${entry}`;
    if (statSync(full).isDirectory()) {
      walk(`${full}/`, `${prefix}${entry}/`, out);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push({ path: `${prefix}${entry}`, text: readFileSync(full, 'utf8') });
    }
  }
}

const repo: SourceFile[] = [];
for (const top of ['apps', 'packages']) {
  walk(`${repoRoot}${top}/`, `${top}/`, repo);
}
const printPackage = repo.filter((f) => f.path.startsWith('packages/print/src/'));

/**
 * An import of the rasteriser module, in any spelling of the relative path.
 *
 * Written without an example of the import it matches: this file is inside the
 * repository it walks, and an example in a comment would make it its own first
 * offender.
 */
function importsFill(text: string): boolean {
  return /from\s+['"][^'"]*raster\/fill['"]/.test(text);
}

describe('there is exactly one path from a layout to dots', () => {
  it('finds the source it is meant to be checking', () => {
    // A refactor that moves or renames files must not turn this test into one
    // that silently passes over an empty list.
    expect(repo.length).toBeGreaterThan(200);
    expect(printPackage.map((f) => f.path)).toContain('packages/print/src/render.ts');
    expect(printPackage.map((f) => f.path)).toContain('packages/print/src/raster/fill.ts');
    expect(repo.some((f) => f.path.startsWith('apps/pos/src/'))).toBe(true);
    expect(repo.some((f) => f.path.startsWith('apps/console/src/'))).toBe(true);
  });

  it('lets only render.ts reach the rasteriser, anywhere in the repository', () => {
    const callers = repo.filter((f) => importsFill(f.text)).map((f) => f.path);
    expect(callers).toEqual(['packages/print/src/render.ts']);
  });

  it('keeps the preview a container, not a second drawing path', () => {
    const preview = printPackage.find((f) => f.path.endsWith('src/emit/preview.ts'));
    expect(preview).toBeDefined();
    // It may know about a finished Bitmap1 and nothing earlier in the
    // pipeline: no shaping, no layout, no outlines.
    expect(preview?.text).not.toMatch(/from\s+['"][^'"]*(fonts|layout)\//);
    expect(importsFill(preview?.text ?? '')).toBe(false);
  });

  it('keeps the emitters containers too', () => {
    for (const path of ['packages/print/src/emit/escpos.ts', 'packages/print/src/emit/tspl.ts']) {
      const file = printPackage.find((f) => f.path === path);
      expect(file, path).toBeDefined();
      expect(file?.text, path).not.toMatch(/from\s+['"][^'"]*(fonts|layout)\//);
      expect(importsFill(file?.text ?? ''), path).toBe(false);
    }
  });

  /**
   * Every printout preview in the repository shows a picture the renderer made.
   *
   * Named rather than discovered, because "is this component drawing a
   * printout" is not a question a regular expression can answer — but "has
   * somebody renamed or deleted the preview this test was watching" is, and
   * the first assertion is that. A new preview surface added elsewhere has to
   * be added here, which is a line in a diff rather than a silent second path.
   */
  const PREVIEW_SURFACES = [
    'apps/pos/src/components/admin/templates/PrintTemplatePreview.tsx',
    'apps/console/src/components/devices/PrintPanel.tsx',
  ];

  it.each(PREVIEW_SURFACES)('%s shows an image rather than composing one', (path) => {
    const file = repo.find((f) => f.path === path);
    expect(file, `${path} has moved — point this test at it`).toBeDefined();
    const text = file!.text;
    expect(text, 'a preview that is not an <img> is drawing the printout itself').toMatch(/<img\b/);
    /**
     * The marks a printout is made of. A preview that imports a barcode or a
     * QR component is composing one rather than showing one — which is exactly
     * what the POS editor did before this.
     */
    expect(text).not.toMatch(/from\s+['"][^'"]*\/(Barcode|QrCode)['"]/);
    expect(text).not.toMatch(/\bAPPLICABLE_FIELDS\b/);
  });

  it('has one set of printout sample content, and it is the renderer’s', () => {
    /**
     * A second drawing path cannot draw nothing: it needs sample lines, sample
     * prices, a sample allergy. There is one such set in the repository —
     * `packages/print/test/fixtures.ts`, which is also what a test print puts
     * on paper — and a file outside the print package that defines its own is
     * either a second path or on its way to being one.
     */
    const offenders = repo
      .filter((f) => !f.path.startsWith('packages/print/'))
      .filter((f) => /\b(sampleDataFor|TemplatePreviewData|sampleDataForTemplate)\b/.test(f.text))
      .map((f) => f.path);
    expect(offenders).toEqual([]);
  });
});
