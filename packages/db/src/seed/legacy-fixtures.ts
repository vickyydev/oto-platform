/**
 * TWO FROZEN LEGACY DAYS (S2-15b round 6, SCRUM-216; plan
 * docs/progress/plans/analytics/PLAN.md §5, §8 round 6, hazard H10).
 *
 * WHAT THEY STAND FOR. Before the platform, the parks reported through Pisell
 * (Central Floresta, Radar's formula v30) and Papaya (Robinson Chalong, v21).
 * Their history reaches the platform as `analytics.daily_summary` rows of
 * source `pisell` or `papaya`, written once and `frozen`: no rollup, no late
 * fact and no rerun of this loader ever rewrites one. Until the real history
 * is imported (S2-18 and the production dump), these two days stand in for it,
 * so the source switch (`analytics.branch_source_switch`) has something to
 * serve and Radar's legacy side something to show.
 *
 * WHERE. Demo Branch 2, beside the demo day's sales, and nowhere else: a live
 * park's figures never carry invented rows (hazard H11's rule, kept for these
 * too). Both sources sit at the one demo branch on purpose — a switch from
 * `pisell` to `papaya` there visibly changes which days the summary serves.
 *
 * THE FIGURES are invented, shaped like the two pipelines' daily summaries
 * (intake notes 03 and 04): no real takings, no member, no name. Revenue is
 * the five buckets added up, gross of VAT, as the platform's own rows are.
 *
 * WRITTEN ONCE. Each row is keyed by (branch, business date, source) and its
 * id, timestamps and fingerprint are derived from the fixture alone, so the
 * row is the same bytes wherever it is loaded; a second run inserts nothing
 * and touches nothing (`on conflict do nothing` takes no lock on, and writes
 * no version of, the row already there).
 */
import { createHash } from 'node:crypto';
import {
  ANALYTICS_LEGACY_FORMULA_VERSIONS,
  type AnalyticsDayFigures,
  type AnalyticsLegacySource,
} from '@oto/shared';
import type { Db } from '../index';
import * as s from '../schema/index';
import { stableId } from './stable-id';

export interface LegacyFixtureDay {
  source: AnalyticsLegacySource;
  /** The business date the legacy system reported. */
  businessDate: string;
  /** When the day was taken from the legacy system: the row's `computed_at`, `created_at` and `updated_at`. */
  importedAt: string;
  figures: AnalyticsDayFigures;
}

/** The fixture figures with revenue as the five buckets added up. */
function day(f: Omit<AnalyticsDayFigures, 'revenueSatang' | 'byChannel'>): AnalyticsDayFigures {
  return {
    ...f,
    revenueSatang: f.ticketsSatang + f.fnbSatang + f.merchSatang + f.partiesSatang + f.dropoffSatang,
    byChannel: {},
  };
}

/**
 * The two days: a Saturday as Pisell reported it and the Sunday after as
 * Papaya did. Fixed dates, so every environment holds the same history.
 */
export const LEGACY_FIXTURE_DAYS: readonly LegacyFixtureDay[] = [
  {
    source: 'pisell',
    businessDate: '2026-09-12',
    importedAt: '2026-09-13T01:15:00.000Z',
    figures: day({
      ticketsSatang: 3_845_000,
      fnbSatang: 1_154_000,
      merchSatang: 186_000,
      partiesSatang: 1_250_000,
      dropoffSatang: 298_000,
      txnCount: 142,
      creditPaidSatang: 0,
      guestsKids: 96,
      guestsAdults: 81,
      mix1h: 22,
      mix2h: 61,
      mixFullDay: 94,
      partiesCount: 2,
      refundsSatang: 45_000,
      discountsSatang: 120_000,
      compsSatang: 0,
      vatSatang: 440_477,
      serviceSatang: 0,
    }),
  },
  {
    source: 'papaya',
    businessDate: '2026-09-13',
    importedAt: '2026-09-14T01:15:00.000Z',
    figures: day({
      ticketsSatang: 2_196_000,
      fnbSatang: 632_000,
      merchSatang: 94_000,
      partiesSatang: 0,
      dropoffSatang: 149_000,
      txnCount: 74,
      creditPaidSatang: 0,
      guestsKids: 52,
      guestsAdults: 47,
      mix1h: 18,
      mix2h: 44,
      mixFullDay: 37,
      partiesCount: 0,
      refundsSatang: 0,
      discountsSatang: 35_000,
      compsSatang: 0,
      vatSatang: 200_907,
      serviceSatang: 0,
    }),
  },
];

/** The fingerprint a fixture row carries: of the fixture itself, so it never differs between loads. */
export function legacyFixtureFingerprint(fixture: LegacyFixtureDay): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        source: fixture.source,
        businessDate: fixture.businessDate,
        formulaVersion: ANALYTICS_LEGACY_FORMULA_VERSIONS[fixture.source],
        figures: fixture.figures,
      }),
    )
    .digest('hex');
}

/**
 * Load the fixture days into `branch` (the demo branch), once. Answers how
 * many rows this run wrote: two the first time, none after.
 */
export async function seedLegacyFixtureDays(
  db: Db,
  branch: { id: string; operatorId: string },
): Promise<number> {
  let written = 0;
  for (const fixture of LEGACY_FIXTURE_DAYS) {
    const at = new Date(fixture.importedAt);
    const { byChannel, ...figures } = fixture.figures;
    const rows = await db
      .insert(s.dailySummary)
      .values({
        id: stableId(`legacy-fixture/${branch.id}/${fixture.source}/${fixture.businessDate}`, at),
        operatorId: branch.operatorId,
        branchId: branch.id,
        businessDate: fixture.businessDate,
        source: fixture.source,
        formulaVersion: ANALYTICS_LEGACY_FORMULA_VERSIONS[fixture.source],
        provisional: false,
        frozen: true,
        computedAt: at,
        ...figures,
        byChannel,
        inputFingerprint: legacyFixtureFingerprint(fixture),
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing({
        target: [s.dailySummary.branchId, s.dailySummary.businessDate, s.dailySummary.source],
      })
      .returning({ id: s.dailySummary.id });
    written += rows.length;
  }
  return written;
}
