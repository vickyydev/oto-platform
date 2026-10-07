import * as React from 'react';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BENEFIT_CHECKOUT_WORDS, BENEFIT_WORDS } from '@oto/shared';
import { StaffBenefitBreakdown } from '@/components/fnb/StaffBenefitBreakdown';

// The runner compiles JSX to `React.createElement` without a React plugin.
Object.assign(globalThis, { React });

/**
 * S2-21 (SCRUM-218) round 3 — THE REVIEW, the till's half of the words.
 *
 * The prototype's dialog (`components/fnb/BenefitScanModal.tsx`) and its
 * breakdown (`StaffBenefitBreakdown.tsx`) were read side by side with this
 * round's copies in review: the title, the description, the placeholder, the
 * button, the footer and the two refusals are the prototype's word for word;
 * the only change to the dialog's markup is the button also waiting while the
 * platform answers. These cases hold the words that matter at the counter.
 */

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');
const text = (el: React.ReactElement) =>
  renderToStaticMarkup(el)
    .replace(/<[^>]+>/g, '|')
    .split('|')
    .map((s) => s.trim())
    .filter(Boolean);

describe('the refusals the dialog shows are the prototype’s two, word for word', () => {
  it('a QR this park did not issue, and a person with nothing set up', () => {
    expect(BENEFIT_WORDS.notFound('OTO-BENEFIT-OP-9')).toBe('No staff benefit found for "OTO-BENEFIT-OP-9".');
    expect(BENEFIT_WORDS.notConfigured('Nok (Reception)')).toBe('Nok (Reception) has no benefit configured.');
  });

  it('the dialog keeps its button word, and shows what the platform said', () => {
    const dialog = readFileSync(join(SRC, 'components', 'fnb', 'BenefitScanModal.tsx'), 'utf8');
    expect(dialog).toMatch(/>\s*Apply\s*<ArrowRight/);
    expect(dialog).toContain('<Gift className="w-5 h-5 text-primary" />');
    // No message of the dialog's own replaces the platform's words for a refusal.
    expect(dialog).not.toMatch(/setError\(`No staff benefit/);
    expect(dialog).not.toMatch(/has no benefit configured/);
  });
});

describe('the breakdown: the prototype’s labels, and “Online only” for what a box leaves', () => {
  const base = {
    scannedOperatorName: 'Som (Reception)',
    compedTHB: 0,
    freeItemsTHB: 0,
    creditTHB: 0,
    discountTHB: 0,
    totalReliefTHB: 0,
  };

  it('online, the four rows in the engine’s order, under the prototype’s labels, only where they relieved', () => {
    const shown = text(
      React.createElement(StaffBenefitBreakdown, {
        data: { ...base, freeItemsTHB: 120, creditTHB: 500, discountTHB: 33, totalReliefTHB: 653 },
      }),
    );
    expect(shown).toEqual([
      'Staff benefit',
      '-฿653',
      'Scanned: Som (Reception)',
      'Free item(s)',
      '-฿120',
      'Staff credit',
      '-฿500',
      'Standing discount',
      '-฿33',
    ]);
  });

  it('offline, the percent the box applied, and the free items and credit it left say “Online only”', () => {
    const shown = text(
      React.createElement(StaffBenefitBreakdown, {
        data: { ...base, discountTHB: 36, totalReliefTHB: 36, onlineOnly: ['freeItems', 'credit'] },
      }),
    );
    expect(shown).toEqual([
      'Staff benefit',
      '-฿36',
      'Scanned: Som (Reception)',
      'Standing discount',
      '-฿36',
      'Free item(s)',
      BENEFIT_CHECKOUT_WORDS.onlineOnly,
      'Staff credit',
      BENEFIT_CHECKOUT_WORDS.onlineOnly,
    ]);
    expect(BENEFIT_CHECKOUT_WORDS.onlineOnly).toBe('Online only');
  });

  it('nothing relieved and nothing waiting for the link: no card, as the prototype draws none', () => {
    expect(renderToStaticMarkup(React.createElement(StaffBenefitBreakdown, { data: base }))).toBe('');
  });
});
