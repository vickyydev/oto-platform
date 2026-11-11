import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * SCRUM-849 — THE PHONE TILL PAYMENT CHECK KEEPS ITS PICTURES OUT OF THE
 * COMMITTED PROOF FOLDER.
 *
 * `e2e/phone-payment.spec.ts` takes two pictures of the payment step at 375 px.
 * It wrote them into docs/qa/proof-2026-11-11/SCRUM-801/local on every run, so
 * running the check rewrote two committed files. They now go to Playwright's
 * output folder for the test, and to a folder of the runner's choosing only
 * when `POS_E2E_SHOTS` names one — the convention of the other checks there.
 *
 * The check itself runs on the isolated harness, not here; what is pinned is
 * where it may write.
 */

const pos = path.resolve(import.meta.dirname, '..');
const root = path.resolve(pos, '..', '..');
const spec = readFileSync(path.resolve(pos, 'e2e', 'phone-payment.spec.ts'), 'utf8');

describe('SCRUM-849: where the phone payment check writes its pictures', () => {
  it('names no folder of the repository', () => {
    // Its own comment may say where a proof is kept; no path it builds does.
    const code = spec.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toContain('docs/');
    expect(code).not.toContain('proof-');
    expect(code).not.toContain('import.meta.dirname');
  });

  it('writes to the test’s own output folder unless POS_E2E_SHOTS names another', () => {
    expect(spec).toContain("const SHOTS = process.env.POS_E2E_SHOTS ?? '';");
    expect(spec).toContain('if (!SHOTS) return testInfo.outputPath(name);');
    expect(spec).toContain('return resolve(SHOTS, name);');
    // Both pictures, and no other, go through that one choice.
    const shots = [...spec.matchAll(/page\.screenshot\(\{ path: (.+?), mask:/g)].map((m) => m[1]);
    expect(shots).toEqual([
      "await picture(testInfo, 'phone-payment-375.png')",
      "await picture(testInfo, 'phone-payment-actions-375.png')",
    ]);
  });

  it('the output folder is one git does not track', () => {
    const ignore = readFileSync(path.resolve(root, '.gitignore'), 'utf8').split(/\r?\n/);
    expect(ignore).toContain('test-results');
    // Playwright's default: `test-results` beside the config, which sets no other.
    expect(readFileSync(path.resolve(pos, 'playwright.config.ts'), 'utf8')).not.toContain('outputDir');
  });
});
