import { describe, expect, it } from 'vitest';
import { BOOTH_VOUCHER_DESIGN_DEFAULTS } from '@oto/shared';
import type { BoothDraft, BoothSettingsDraft } from '@/components/booth/boothApi';
import {
  SLIP_STANDING,
  publishedSlip,
  slipDirty,
  slipFromSettings,
  slipInput,
  slipProblems,
  slipStanding,
  slipSummary,
} from '@/components/booth/voucherSlip';

/**
 * THE VOUCHER SLIP CARD'S MODEL — `src/components/booth/voucherSlip.ts`
 * (SCRUM-471).
 *
 * What the form starts from, what it sends, when it is "changed", and the
 * chip's three standings: an unsaved edit, a saved slip that is not in the
 * published wheel yet, and a saved slip that is. The card knows what was
 * PUBLISHED, never what the box is printing (gate finding, SCRUM-471).
 */

const TODAY: Required<Pick<
  BoothSettingsDraft,
  'voucherShowLogo' | 'voucherHeaderText' | 'voucherFooterText' | 'voucherShowStaff' | 'voucherShowTerms'
>> = {
  voucherShowLogo: true,
  voucherHeaderText: null,
  voucherFooterText: null,
  voucherShowStaff: true,
  voucherShowTerms: true,
};

function settings(over: Partial<BoothSettingsDraft> = {}): BoothSettingsDraft {
  return {
    layoutId: 'layout-1',
    layoutName: 'Classic',
    buttonKey: 'Space',
    eligibility: 'none',
    dailySpinCap: null,
    ...TODAY,
    ...over,
  };
}

function draft(s: BoothSettingsDraft, publishedSettings: Record<string, unknown> | null): BoothDraft {
  return {
    booth: { id: 'booth-1', name: 'Booth 1', branchId: 'branch-1', codePrefix: 'B1' },
    settings: s,
    prizes: [],
    bundle: null,
    bundleHash: null,
    published: null,
    publishedBundle:
      publishedSettings === null
        ? null
        : { settings: { eligibility: 'none', buttonKey: 'Space', dailySpinCap: null, ...publishedSettings } },
    changed: false,
    lastEditedAt: null,
    blockers: [],
  };
}

describe('the voucher slip card (SCRUM-471)', () => {
  it('starts from the saved slip, with "no line" as an empty box', () => {
    expect(slipFromSettings(settings())).toEqual({
      showLogo: true,
      headerText: '',
      footerText: '',
      showStaff: true,
      showTerms: true,
      design: BOOTH_VOUCHER_DESIGN_DEFAULTS,
    });
    expect(slipFromSettings(settings({ voucherFooterText: 'Bye', voucherShowStaff: false }))).toMatchObject({
      footerText: 'Bye',
      showStaff: false,
    });
  });

  it('offers no form on a deployment that does not send the slip', () => {
    const older: BoothSettingsDraft = {
      layoutId: null,
      layoutName: null,
      buttonKey: 'Space',
      eligibility: 'none',
      dailySpinCap: null,
    };
    expect(slipFromSettings(older)).toBeNull();
  });

  it('sends trimmed text, and blank text as no line', () => {
    const edit = slipFromSettings(settings())!;
    expect(slipInput({ ...edit, headerText: '  Spin to win  ', footerText: '   ' })).toEqual({
      voucherShowLogo: true,
      voucherHeaderText: 'Spin to win',
      voucherFooterText: null,
      voucherShowStaff: true,
      voucherShowTerms: true,
      voucherDesign: null,
    });
  });

  it('is not "changed" by spaces alone', () => {
    const s = settings({ voucherFooterText: 'Bye' });
    const edit = slipFromSettings(s)!;
    expect(slipDirty(edit, s)).toBe(false);
    expect(slipDirty({ ...edit, footerText: '  Bye ' }, s)).toBe(false);
    expect(slipDirty({ ...edit, footerText: 'Goodbye' }, s)).toBe(true);
    expect(slipDirty({ ...edit, showLogo: false }, s)).toBe(true);
  });

  it('refuses text past the platform’s limits', () => {
    const edit = slipFromSettings(settings())!;
    expect(slipProblems({ ...edit, headerText: 'h'.repeat(200), footerText: 'f'.repeat(400) })).toEqual({});
    expect(slipProblems({ ...edit, headerText: 'h'.repeat(201) }).header).toMatch(/200/);
    expect(slipProblems({ ...edit, footerText: 'f'.repeat(401) }).footer).toMatch(/400/);
  });

  it('reads the published slip the way the box does — absent fields are today’s slip', () => {
    expect(publishedSlip(draft(settings(), null))).toBeNull();
    expect(publishedSlip(draft(settings(), {}))).toEqual({
      showLogo: true,
      headerText: null,
      footerText: null,
      showStaff: true,
      showTerms: true,
      design: BOOTH_VOUCHER_DESIGN_DEFAULTS,
    });
    expect(publishedSlip(draft(settings(), { voucherShowTerms: false, voucherFooterText: 'Bye' }))).toMatchObject({
      showTerms: false,
      footerText: 'Bye',
    });
  });

  it('says where the slip stands: unsaved, saved but not published, or in the published wheel', () => {
    const untouched = settings();
    // An untouched booth's published wheel carries today's slip, which is what is saved.
    expect(slipStanding(slipFromSettings(untouched)!, draft(untouched, {}))).toBe('published');

    const saved = settings({ voucherFooterText: 'Bye' });
    expect(slipStanding(slipFromSettings(saved)!, draft(saved, {}))).toBe('unpublished');
    expect(slipStanding(slipFromSettings(saved)!, draft(saved, { voucherFooterText: 'Bye' }))).toBe('published');
    expect(slipStanding(slipFromSettings(saved)!, draft(saved, null))).toBe('unpublished');

    const editing = { ...slipFromSettings(saved)!, showLogo: false };
    expect(slipStanding(editing, draft(saved, { voucherFooterText: 'Bye' }))).toBe('unsaved');
  });

  it('never tells a manager the booth is printing or running the slip — it knows only what was published', () => {
    // Straight after a publish, and for as long as the box has not taken the
    // version (offline, not restarted, or on software that drops the fields),
    // the booth still prints the old slip. The chip's words must hold then too.
    expect(SLIP_STANDING.published.label).toBe('In the published wheel');
    for (const { label } of Object.values(SLIP_STANDING)) {
      expect(label).not.toMatch(/print|running|live|at the booth/i);
    }
    expect(Object.keys(SLIP_STANDING).sort()).toEqual(['published', 'unpublished', 'unsaved']);
  });

  it('names what a publish would change about the slip, in the review', () => {
    expect(slipSummary(settings())).toBe('the standard slip');
    expect(
      slipSummary(settings({ voucherShowLogo: false, voucherFooterText: 'Bye', voucherShowTerms: false })),
    ).toBe('no logo · a footer line · no terms');
    expect(
      slipSummary({ layoutId: null, layoutName: null, buttonKey: 'Space', eligibility: 'none', dailySpinCap: null }),
    ).toBeNull();
  });
});
