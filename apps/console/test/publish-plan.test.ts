import { describe, expect, it } from 'vitest';
import type { BoothDraft, BoothPrizeDraft, PublishBlocker } from '@/components/booth/boothApi';
import { buildPublishPlan } from '@/components/booth/publishPlan';

/**
 * WHAT PRESSING PUBLISH WOULD DO — `src/components/booth/publishPlan.ts`
 * (SCRUM-256).
 *
 * What blocks a publish is the API's list (`blockers` on the draft), passed on
 * verbatim and in its order; the Publish panel is closed exactly when that list
 * is not empty (`PublishPanel.tsx`: `blocked = plan.blockers.length > 0`). The
 * plan adds no refusal of its own — a second list re-derived here would agree
 * today and drift the day either side gains a rule. What it adds is the
 * sentence a manager stops on, two warnings, and the wheel's cost in baht.
 */

let nextId = 0;
function prize(over: Partial<BoothPrizeDraft> = {}): BoothPrizeDraft {
  nextId += 1;
  return {
    id: `prize-${nextId}`,
    nameEn: `Prize ${nextId}`,
    nameTh: null,
    wheelLabel: null,
    weightBp: 0,
    active: true,
    expiryDays: null,
    dailyCap: null,
    costSatang: 0,
    sliceColor: null,
    textColor: null,
    sortOrder: nextId,
    voucherDefinitionId: null,
    voucherDefinitionCode: null,
    effectiveExpiryDays: null,
    ...over,
  };
}

function draft(over: Partial<BoothDraft> = {}): BoothDraft {
  return {
    booth: { id: 'booth-1', name: 'Booth 1', branchId: 'branch-1', codePrefix: 'B1' },
    settings: {
      layoutId: 'layout-1',
      layoutName: 'Classic',
      buttonKey: ' ',
      eligibility: 'none',
      dailySpinCap: null,
    },
    prizes: [],
    bundle: {},
    bundleHash: 'hash-next',
    published: null,
    changed: true,
    lastEditedAt: null,
    blockers: [],
    ...over,
  };
}

const published = (version: number): NonNullable<BoothDraft['published']> => ({
  id: `version-${version}`,
  version,
  publishedAt: '2026-09-29T03:00:00.000Z',
  bundleHash: 'hash-published',
  note: null,
  publishedByAccountId: null,
});

/** Three prizes that add to 100 %, each costed and capped: nothing to warn about. */
const balanced = () => [
  prize({ nameEn: 'Sticker', weightBp: 6000, costSatang: 500, dailyCap: 200 }),
  prize({ nameEn: 'Balloon', weightBp: 3750, costSatang: 1500, dailyCap: 100 }),
  prize({ nameEn: '฿200 voucher', weightBp: 250, costSatang: 20_000, dailyCap: 5 }),
];

describe('what blocks a publish', () => {
  it('is the API’s list, passed on verbatim and in its order', () => {
    const blockers: PublishBlocker[] = [
      {
        field: 'prizes[Sticker].weightBp',
        code: 'weights_do_not_sum',
        message: 'The active weights add to 9,750.',
      },
      {
        field: 'settings.layoutId',
        code: 'no_layout',
        message: 'Choose a design before publishing.',
      },
      {
        field: 'prizes[Balloon].voucherDefinitionId',
        code: 'no_voucher',
        message: 'Balloon has no voucher.',
      },
    ];
    const plan = buildPublishPlan(draft({ prizes: balanced(), blockers }));
    expect(plan.blockers).toEqual(blockers);
    expect(plan.blockers.map((b) => b.code)).toEqual([
      'weights_do_not_sum',
      'no_layout',
      'no_voucher',
    ]);
  });

  it('a balanced wheel is still blocked by a refusal the API gives for something else', () => {
    const blockers = [
      { field: 'settings.layoutId', code: 'no_layout', message: 'Choose a design.' },
    ];
    const plan = buildPublishPlan(draft({ prizes: balanced(), blockers }));
    expect(plan.verdict.balanced).toBe(true);
    expect(plan.blockers).toHaveLength(1);
  });

  it('adds no refusal of its own: weights that do not add up are the API’s to refuse', () => {
    // The API would list this; the plan says the arithmetic in the headline
    // and leaves the refusing to the list it was given.
    const plan = buildPublishPlan(
      draft({
        prizes: [
          prize({ weightBp: 5000, costSatang: 1, dailyCap: 1 }),
          prize({ weightBp: 4950, costSatang: 1, dailyCap: 1 }),
        ],
      }),
    );
    expect(plan.verdict).toMatchObject({ totalBp: 9950, differenceBp: -50, balanced: false });
    expect(plan.blockers).toEqual([]);
    expect(plan.warnings).toEqual([]);
    expect(plan.headline).toContain('the odds add to 99.5% — 50 basis points short (0.5%)');
  });

  it('nothing blocks a clean draft with an empty list', () => {
    expect(buildPublishPlan(draft({ prizes: balanced() })).blockers).toEqual([]);
  });
});

describe('the version it would mint', () => {
  it('is 1 on a booth that has never published', () => {
    expect(buildPublishPlan(draft({ prizes: balanced() })).nextVersion).toBe(1);
  });

  it('is one past the last published version', () => {
    expect(
      buildPublishPlan(draft({ prizes: balanced(), published: published(4) })).nextVersion,
    ).toBe(5);
  });

  it('carries the API’s changed flag, and mints a version even when nothing changed', () => {
    const plan = buildPublishPlan(
      draft({ prizes: balanced(), published: published(4), changed: false }),
    );
    expect(plan.changed).toBe(false);
    expect(plan.nextVersion).toBe(5);
  });
});

describe('the headline', () => {
  it('on a booth that has never run a wheel', () => {
    expect(buildPublishPlan(draft({ prizes: balanced() })).headline).toBe(
      'This booth has never run a wheel. Publishing gives it version 1, with 3 prizes on it, and the odds add to 100% across 3 active prizes.',
    );
  });

  it('with one prize, in the singular', () => {
    const plan = buildPublishPlan(
      draft({ prizes: [prize({ weightBp: 10_000, costSatang: 1, dailyCap: 1 })] }),
    );
    expect(plan.headline).toBe(
      'This booth has never run a wheel. Publishing gives it version 1, with 1 prize on it, and the odds add to 100% across 1 active prize.',
    );
  });

  it('when nothing differs from the published version', () => {
    const plan = buildPublishPlan(
      draft({ prizes: balanced(), published: published(4), changed: false }),
    );
    expect(plan.headline).toBe(
      'Nothing differs from version 4, the version last published. Publishing would mint an identical version 5, and the odds add to 100% across 3 active prizes.',
    );
  });

  it('when it replaces a published version, naming what is switched off and the gap it leaves', () => {
    const [sticker, balloon, voucher] = balanced();
    const plan = buildPublishPlan(
      draft({
        prizes: [sticker!, balloon!, { ...voucher!, active: false }],
        published: published(4),
      }),
    );
    expect(plan.headline).toBe(
      "Version 5 replaces version 4 as this booth's published wheel: 2 active prizes, 1 switched off, and the odds add to 97.5% — 250 basis points short (2.5%).",
    );
  });

  it('says PUBLISHED and never “running”: what a box runs is not something the draft knows', () => {
    const plans = [
      buildPublishPlan(draft({ prizes: balanced() })),
      buildPublishPlan(draft({ prizes: balanced(), published: published(2), changed: false })),
      buildPublishPlan(draft({ prizes: balanced(), published: published(2) })),
    ];
    for (const plan of plans) expect(plan.headline).not.toMatch(/running/i);
  });
});

describe('the warnings', () => {
  it('none for a wheel that is costed and capped', () => {
    expect(buildPublishPlan(draft({ prizes: balanced() })).warnings).toEqual([]);
  });

  it('names the one active prize with no cost, in the singular', () => {
    const prizes = balanced();
    prizes[0] = { ...prizes[0]!, costSatang: 0 };
    expect(buildPublishPlan(draft({ prizes })).warnings).toEqual([
      '1 active prize has no cost recorded (Sticker), so every money figure on this page understates what the wheel gives away.',
    ]);
  });

  it('names every active uncosted prize, and leaves out one that is switched off', () => {
    const prizes = [
      prize({ nameEn: 'Sticker', weightBp: 6000, dailyCap: 1 }),
      prize({ nameEn: 'Balloon', weightBp: 4000, dailyCap: 1 }),
      prize({ nameEn: 'Mystery Box', weightBp: 0, dailyCap: 1, active: false }),
    ];
    expect(buildPublishPlan(draft({ prizes })).warnings).toEqual([
      '2 active prizes have no cost recorded (Sticker, Balloon), so every money figure on this page understates what the wheel gives away.',
    ]);
  });

  it('says so once when no active prize has a daily cap', () => {
    const prizes = balanced().map((p) => ({ ...p, dailyCap: null }));
    const warnings = buildPublishPlan(draft({ prizes })).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^No prize on this wheel has a daily cap/);
    // The question is about what is on the wheel: a switched-off prize, capped
    // or not, changes nothing.
    for (const dailyCap of [null, 10]) {
      const withOff = [...prizes, prize({ weightBp: 0, costSatang: 1, dailyCap, active: false })];
      expect(
        buildPublishPlan(draft({ prizes: withOff })).warnings,
        `off prize cap ${dailyCap}`,
      ).toEqual(warnings);
    }
  });

  it('does not, when one active prize is capped — and a switched-off prize’s missing cap does not count', () => {
    const oneCapped = balanced().map((p, i) => ({ ...p, dailyCap: i === 0 ? 10 : null }));
    expect(buildPublishPlan(draft({ prizes: oneCapped })).warnings).toEqual([]);
    const offUncapped = [
      ...balanced(),
      prize({ weightBp: 0, costSatang: 1, dailyCap: null, active: false }),
    ];
    expect(buildPublishPlan(draft({ prizes: offUncapped })).warnings).toEqual([]);
  });

  it('does not warn about caps on a wheel with no active prize', () => {
    const plan = buildPublishPlan(draft({ prizes: [prize({ weightBp: 10_000, active: false })] }));
    expect(plan.warnings).toEqual([]);
  });
});

describe('the summary, in baht', () => {
  it('counts the prizes on and off the wheel', () => {
    const [sticker, balloon, voucher] = balanced();
    const plan = buildPublishPlan(
      draft({ prizes: [sticker!, balloon!, { ...voucher!, active: false }] }),
    );
    expect(plan.summary.activePrizes).toBe(2);
    expect(plan.summary.inactivePrizes).toBe(1);
  });

  it('writes the cost a spin and per hundred spins, with grouping and satang where there are any', () => {
    const prizes = [
      prize({ weightBp: 1450, costSatang: 20_000, dailyCap: 1 }),
      prize({ weightBp: 8550, costSatang: 1_000, dailyCap: 1 }),
    ];
    // (1450 × 20,000 + 8550 × 1,000) / 10,000 = 3,755 satang a spin.
    const plan = buildPublishPlan(draft({ prizes }));
    expect(plan.summary.costPerSpin).toBe('฿37.55');
    expect(plan.summary.costPerHundred).toBe('฿3,755');
  });

  it('writes zero as ฿0 and a single satang as ฿0.01', () => {
    const prizes = [
      prize({ weightBp: 1, costSatang: 100, dailyCap: 1 }),
      prize({ weightBp: 9_999, costSatang: 0, dailyCap: 1, active: true, nameEn: 'Nothing' }),
    ];
    const plan = buildPublishPlan(draft({ prizes }));
    // ฿1 once in ten thousand spins: nothing a spin, one satang in a hundred.
    expect(plan.summary.costPerSpin).toBe('฿0');
    expect(plan.summary.costPerHundred).toBe('฿0.01');
  });

  it('writes a thousand baht a spin with its separator', () => {
    const plan = buildPublishPlan(
      draft({ prizes: [prize({ weightBp: 10_000, costSatang: 100_000, dailyCap: 1 })] }),
    );
    expect(plan.summary.costPerSpin).toBe('฿1,000');
    expect(plan.summary.costPerHundred).toBe('฿100,000');
  });

  it('costs an unbalanced list as it would really draw, renormalised', () => {
    // Typed 25 % at ฿100 and nothing else active: every spin is the ฿100.
    const plan = buildPublishPlan(
      draft({
        prizes: [
          prize({ weightBp: 2500, costSatang: 10_000, dailyCap: 1 }),
          prize({ weightBp: 7500, active: false }),
        ],
      }),
    );
    expect(plan.summary.costPerSpin).toBe('฿100');
  });
});
