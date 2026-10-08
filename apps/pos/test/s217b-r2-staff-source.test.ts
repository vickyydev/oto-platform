import * as React from 'react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  STAFF_SOURCE_LABELS,
  StaffSourceChip,
} from '@/components/admin/staff-benefits/StaffSourceChip';

/**
 * S2-17b round 2 — Admin > Staff Benefits says where each record is kept (a
 * UI addition; lift PLAN section 5 "The swap"). The staff list is fed by the
 * OTO App's copy (`job:otoapp.employee_sync`): a copied person is "OTO App",
 * whose details are changed there; the platform's own rows (the dev seed's)
 * are "Platform". The API has always answered `source`.
 */

// The node runner compiles the components' JSX to `React.createElement` (vitest.config.ts).
Object.assign(globalThis, { React });

const html = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

describe('S2-17b round 2 — the staff row says where the record is kept', () => {
  it('a copied person reads "OTO App", in the panel’s chip style, and says where to change them', () => {
    const out = html(React.createElement(StaffSourceChip, { source: 'otoapp' }));
    expect(out).toContain('>OTO App<');
    expect(out).toContain('data-staff-source="otoapp"');
    expect(out).toContain('rounded-full bg-foreground/5 px-2 py-0.5 text-xs text-foreground/60');
    expect(out).toMatch(/title="Copied from the OTO App[^"]*change their details there\."/);
  });

  it('a platform record reads "Platform"', () => {
    expect(html(React.createElement(StaffSourceChip, { source: 'platform' }))).toContain('>Platform<');
  });

  it('every source the API answers has a label', () => {
    expect(Object.keys(STAFF_SOURCE_LABELS).sort()).toEqual(['otoapp', 'platform']);
  });

  it('the panel draws it on every staff row, beside the benefit role', () => {
    const panel = readFileSync(
      fileURLToPath(
        new URL('../src/components/admin/staff-benefits/StaffBenefitsPanel.tsx', import.meta.url),
      ),
      'utf8',
    );
    expect(panel).toContain('<StaffSourceChip source={op.source} />');
  });
});
