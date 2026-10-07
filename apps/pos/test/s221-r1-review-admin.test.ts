import * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { BenefitProfile as PlatformProfile } from '@oto/shared';
import { inForceOn, profileFromApi, profileToApi, sameProfile } from '@/api/benefits';
import { adminNav, type AdminPanel } from '@/components/admin/adminSections';
import { BenefitHistoryList, type BenefitHistoryEntry } from '@/components/admin/staff-benefits/BenefitHistoryList';
import { summarizeProfile } from '@/components/admin/staff-benefits/summary';

/**
 * SCRUM-218 review of lane I round 1 — Admin > Staff Benefits, the parts of
 * the screen that render without a browser:
 *
 *   - the staff and template summaries say the prototype's own words
 *     (StaffBenefitsPanel.tsx `summarizeProfile` in the prototype);
 *   - the history list (a UI addition) says when each version counts, in the
 *     panel's chip style, with the last day shown inclusive;
 *   - the editor's baht and the platform's satang meet at one boundary, and a
 *     profile read from the platform compares equal to itself on the way back
 *     — or Save would be live on a screen nobody has touched;
 *   - the nav entry asks for what the routes ask for, and is no longer local.
 */

// The node runner compiles the components' JSX to `React.createElement` (vitest.config.ts).
Object.assign(globalThis, { React });

const html = (el: React.ReactElement) =>
  renderToStaticMarkup(el).replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&quot;/g, '"');

const COFFEE_CATEGORY = '0199a7b0-0000-7000-8000-00000000c0ff';
const coffee = {
  id: 'coffee',
  label: 'Free coffee',
  target: { kind: 'fnbCategory' as const, category: COFFEE_CATEGORY },
  quotaPerPeriod: 2,
  period: 'daily' as const,
};
const MANAGER: PlatformProfile = {
  freeItems: [coffee],
  credit: { amountSatang: 50_000, period: 'monthly' },
  standingDiscount: { percent: 30, target: { kind: 'fnb' } },
};
const STAFF: PlatformProfile = { freeItems: [coffee], standingDiscount: { percent: 30, target: { kind: 'fnb' } } };

describe('SCRUM-218 review — the summaries say the prototype’s words', () => {
  it('Owner, Manager, Staff, nobody', () => {
    expect(summarizeProfile(profileFromApi({ comp: true }))).toBe('Full comp');
    expect(summarizeProfile(profileFromApi(MANAGER))).toBe(
      '2x Free coffee / day · ฿500 credit (Whole order) / mo · 30% off All F&B',
    );
    expect(summarizeProfile(profileFromApi(STAFF))).toBe('2x Free coffee / day · 30% off All F&B');
    expect(summarizeProfile(profileFromApi({}))).toBe('No benefit configured');
  });

  it('a satang credit reads in baht, as the prototype’s amountTHB would', () => {
    expect(summarizeProfile(profileFromApi({ credit: { amountSatang: 60_050, period: 'daily' } }))).toBe(
      '฿600.5 credit (Whole order) / day',
    );
  });
});

describe('SCRUM-218 review — baht in the editor, satang on the platform', () => {
  it('a profile read from the platform goes back unchanged (Save stays off until an edit)', () => {
    for (const p of [{ comp: true }, MANAGER, STAFF, {}] as PlatformProfile[]) {
      expect(profileToApi(profileFromApi(p))).toEqual(p);
      expect(sameProfile(profileToApi(profileFromApi(p)), p)).toBe(true);
    }
  });

  it('typed baht become whole satang, float noise included', () => {
    const typed = (amountTHB: number) =>
      profileToApi({ credit: { amountTHB, period: 'monthly' } }).credit!.amountSatang;
    expect(typed(500)).toBe(50_000);
    expect(typed(600)).toBe(60_000);
    expect(typed(19.99)).toBe(1_999);
    expect(typed(0.1 + 0.2)).toBe(30);
    expect(typed(1234.565)).toBe(123_457);
  });

  it('a switched-off comp and an emptied free-item list are not sent, so an edit undone compares equal', () => {
    expect(profileToApi({ comp: false, freeItems: [], standingDiscount: { percent: 30 } })).toEqual({
      standingDiscount: { percent: 30 },
    });
  });

  it('in force on a day: [from, to), an empty range never', () => {
    const v = (effectiveFrom: string, effectiveTo: string | null) => ({
      id: `${effectiveFrom}-${effectiveTo}`,
      effectiveFrom,
      effectiveTo,
      createdAt: '2026-10-07T00:00:00Z',
      createdBy: null,
    });
    const rows = [v('2026-01-01', '2026-10-08'), v('2026-10-08', '2026-10-08'), v('2026-10-08', null)];
    expect(inForceOn(rows, '2026-10-07')?.id).toBe('2026-01-01-2026-10-08');
    expect(inForceOn(rows, '2026-10-08')?.id).toBe('2026-10-08-null');
    expect(inForceOn(rows, '2025-12-31')).toBeUndefined();
  });
});

describe('SCRUM-218 review — the history list', () => {
  const today = '2026-10-07';
  const entry = (over: Partial<BenefitHistoryEntry>): BenefitHistoryEntry => ({
    id: Math.random().toString(36).slice(2),
    summary: 'Full comp',
    effectiveFrom: '2026-01-01',
    effectiveTo: null,
    createdAt: '2026-10-07T05:21:51Z',
    createdBy: null,
    ...over,
  });

  it('names every state a version can be in, and who saved it', () => {
    const out = html(
      React.createElement(BenefitHistoryList, {
        today,
        entries: [
          entry({ effectiveFrom: '2026-10-09', effectiveTo: null, createdBy: { name: 'Khun Anan (Owner)' } }),
          entry({ effectiveFrom: '2026-10-09', effectiveTo: '2026-10-09', createdBy: { name: null } }),
          entry({ effectiveFrom: '2026-10-07', effectiveTo: '2026-10-09' }),
          entry({ effectiveFrom: '2026-01-01', effectiveTo: '2026-10-07' }),
        ],
      }),
    );
    expect(out).toContain('Scheduled');
    expect(out).toContain('Replaced before it started');
    expect(out).toContain('In force');
    expect(out).toContain('Ended');
    // The last day shown is the day before the exclusive end.
    expect(out).toContain('2026-10-07 – 2026-10-08');
    expect(out).toContain('2026-01-01 – 2026-10-06');
    expect(out).toContain('From 2026-10-09');
    expect(out).toContain('Changed by Khun Anan (Owner)');
    expect(out).toContain('Changed by a staff account');
    expect(out).toContain('Seeded');
    // In the panel's own chip style.
    expect(out).toContain('rounded-full');
  });

  it('empty, loading and failed', () => {
    expect(html(React.createElement(BenefitHistoryList, { today, entries: [] }))).toContain('No changes saved yet.');
    expect(html(React.createElement(BenefitHistoryList, { today, entries: [], loading: true }))).toContain('Loading history');
    expect(html(React.createElement(BenefitHistoryList, { today, entries: [], error: 'Nope' }))).toContain('Nope');
  });
});

describe('SCRUM-218 review — the nav entry', () => {
  it('Staff Benefits asks for admin:benefit:read, the routes’ read, and is no longer local-only', () => {
    const panels: AdminPanel[] = adminNav.flatMap((e) => (e.kind === 'group' ? e.panels : [e.panel]));
    const panel = panels.find((p) => p.id === 'staff-benefits')!;
    expect(panel.label).toBe('Staff Benefits');
    expect(panel.permission).toBe('admin:benefit:read');
    expect(panel.localOnly).toBeUndefined();
  });
});
