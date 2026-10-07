import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isStaffBenefitReason } from '../src/index';

/**
 * S2-21 (SCRUM-218) round 4 — THE REVIEW'S ATTACK on the "Staff benefit"
 * reason fold (`isStaffBenefitReason`, H16): read by its letters alone, after
 * NFKC and after dropping what prints as nothing.
 *
 *   - the round 3 probes (U+3164, U+2800) and their relatives, each a reason
 *     that prints as "Staff benefit" or near enough, are recognised;
 *   - reasons that are not it stay ordinary manual discounts;
 *   - the probe set is strong enough to kill each plausible weakening of the
 *     function (a mutant per step of the fold), so a later "simplification"
 *     cannot pass these tests;
 *   - the platform and the box both call this one function and keep no copy.
 */

const RECOGNISED: string[] = [
  'Staff benefit',
  ' staff  BENEFIT ',
  'Staffㅤbenefit', // Hangul filler — a letter by category, prints blank
  'Staff⠀benefit', // braille pattern blank — a symbol, prints blank
  'Staffᅟbenefit', // Hangul choseong filler
  'Staffᅠbenefit', // Hangul jungseong filler
  'Staffﾠbenefit', // halfwidth Hangul filler
  'Staff​benefit', // zero-width space
  'Staff⁠benefit', // word joiner
  'Staff﻿benefit', // byte-order mark
  'Staff­benefit', // soft hyphen
  'Staff᠎benefit', // Mongolian vowel separator
  'Staff͏benefit', // combining grapheme joiner
  'Staff️benefit', // variation selector
  'Staff\u{E0100}benefit', // variation selector supplement
  'Staff\u{E0020}benefit', // tag space
  '‮Staff benefit‬', // bidi override and pop
  'Staff　benefit', // ideographic space
  'Staff benefit', // line separator
  'Staff\tbenefit',
  'Staff\nbenefit',
  'Staffbenefit',
  'STAFF-BENEFIT',
  'staff_benefit',
  'Staff. Benefit!',
  'Staff benefit 1',
  'S̶taff benefit', // combining long stroke overlay
  'Ｓｔａｆｆ ｂｅｎｅｆｉｔ', // full-width
  '\u{1D412}\u{1D42D}\u{1D41A}\u{1D41F}\u{1D41F} benefit', // mathematical bold
  'Ⓢⓣⓐⓕⓕ ⓑⓔⓝⓔⓕⓘⓣ', // circled letters
  'ſtaff benefit', // long s
  'Staﬀ benefit', // the "ff" ligature
];

const ORDINARY: Array<string | null | undefined> = [
  'Staff benefits',
  'Staff benefit adjustment',
  'Staffing benefit',
  'Benefit staff',
  'Staff / family',
  'Staff meal',
  'Service recovery',
  '',
  '   ',
  null,
  undefined,
];

describe('the "Staff benefit" reason, read by its letters (H16)', () => {
  it('recognises every spelling that prints as the reason', () => {
    for (const r of RECOGNISED) expect(isStaffBenefitReason(r), JSON.stringify(r)).toBe(true);
  });

  it('leaves every other reason an ordinary manual discount', () => {
    for (const r of ORDINARY) expect(isStaffBenefitReason(r), JSON.stringify(r)).toBe(false);
  });
});

/**
 * Each mutant is the real fold with one step weakened or swapped. The probe set
 * above must tell every one of them from the real function on at least one
 * probe, on the side the real function gets right.
 */
const MUTANTS: Record<string, (r: string | null | undefined) => boolean> = {
  'round 3’s spacing fold (no letters-only step)': (r) =>
    (r ?? '')
      .normalize('NFKC')
      .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
      .trim()
      .replace(/\s+/g, ' ')
      .toLowerCase() === 'staff benefit',
  'no NFKC': (r) =>
    (r ?? '')
      .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
      .replace(/[^\p{L}]/gu, '')
      .toLowerCase() === 'staffbenefit',
  'no default-ignorable strip': (r) =>
    (r ?? '')
      .normalize('NFKC')
      .replace(/[^\p{L}]/gu, '')
      .toLowerCase() === 'staffbenefit',
  'no case fold': (r) =>
    (r ?? '')
      .normalize('NFKC')
      .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
      .replace(/[^\p{L}]/gu, '') === 'staffbenefit',
  'only spaces dropped, not every non-letter': (r) =>
    (r ?? '')
      .normalize('NFKC')
      .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
      .replace(/[\s\p{Z}]/gu, '')
      .toLowerCase() === 'staffbenefit',
  'contains rather than equals': (r) =>
    (r ?? '')
      .normalize('NFKC')
      .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
      .replace(/[^\p{L}]/gu, '')
      .toLowerCase()
      .includes('staffbenefit'),
};

describe('the probe set kills every weakened fold', () => {
  for (const [name, mutant] of Object.entries(MUTANTS)) {
    it(`kills the mutant: ${name}`, () => {
      const killers = [...RECOGNISED, ...ORDINARY].filter((r) => mutant(r) !== isStaffBenefitReason(r));
      expect(killers.length, name).toBeGreaterThan(0);
    });
  }
});

describe('one fold for the platform and the box', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
  it('the sale service and the box’s offline pricing call the shared function and define no copy', () => {
    for (const file of ['apps/api/src/services/sale.ts', 'packages/box-agent/src/offline-pricing.ts']) {
      const text = readFileSync(join(ROOT, file), 'utf8');
      expect(text, file).toMatch(/isStaffBenefitReason,?[\s\S]*?from '@oto\/shared'/);
      expect(text, file).toMatch(/isStaffBenefitReason\(/);
      expect(text, file).not.toMatch(/function isStaffBenefitReason/);
      // No second, looser comparison of the reason beside it.
      expect(text, file).not.toMatch(/===\s*['"]staff benefit['"]/i);
    }
  });
});
