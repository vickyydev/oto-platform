import { createHash } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  account,
  boothConfigVersion,
  boothLayout,
  boothPrize,
  boothSettings,
  branch,
  employee,
  spin,
  station,
  voucherDefinition,
  type BoothEligibilityMode,
  type Db,
} from '@oto/db';
import {
  BOOTH_BUNDLE_SCHEMA_VERSION,
  BOOTH_CODE_PREFIX_LENGTH,
  BOOTH_SPIN_DURATION_DEFAULT_SECONDS,
  BOOTH_VOUCHER_SLIP_DEFAULTS,
  BOOTH_VOUCHER_DESIGN_DEFAULTS,
  boothVoucherSlipBundleFields,
  boothVoucherText,
  businessDate,
  newId,
  parseDayStart,
  type BoothVoucherDesign,
} from '@oto/shared';
import { escposProfile, renderPreviewPng } from '@oto/print';
import { AppError } from '../lib/errors';
import { pgErrorOf } from '../lib/scrub';
import { atBranch } from '../lib/staff-scope';
import { audit } from './audit';
import { withTx, type Exec, type OpContext } from './tx';
import type { BoothStationRow } from './booth';

/**
 * The booth admin control panel's service half (S2-07b).
 *
 * S2-07a built the booth that RUNS: the box draws, mints the code, prints the
 * slip and records the spin, all from a published bundle it caches. This file
 * is the other end of that — what a manager changes, and the one act that
 * connects the two.
 *
 * **Publishing is the whole point of the file**, and everything else here
 * exists to make one honest. A published version is what a booth in a mall
 * actually runs, so it is minted whole, validated before it exists, and never
 * edited afterwards:
 *
 *   - **Validated before publishing, not after.** A bundle whose active
 *     weights do not add to 10,000, or whose prize has no voucher definition,
 *     is a booth handing out the wrong prizes — and the box cannot tell,
 *     because a cached bundle is the only thing it has to go on. So the
 *     refusals below happen while there is still only a draft to fix.
 *   - **Never edited.** `booth.spin` carries `booth_config_version_id`
 *     precisely so that "what were the odds when my daughter won" has an
 *     answer that tonight's edit cannot move. Publishing mints version N+1;
 *     nothing in this file updates a `booth_config_version` row.
 *   - **Refused when the wheel would be unplayable.** Every prize switched
 *     off, or every active prize already capped out today, makes the box
 *     refuse the press with "Booth not ready — please call staff" (D5). That
 *     is correct behaviour for an accident and a terrible thing to publish on
 *     purpose.
 *
 * **Where the draft lives, stated rather than implied.** There is no draft
 * table. `booth_settings`, `booth_prize` and `booth_layout` ARE the draft:
 * every edit here is saved immediately and reaches no booth at all until
 * somebody publishes. Two consequences a manager has to be told about, and
 * which `boothDraft` below is built to show:
 *
 *   - one booth has ONE draft, shared. Two managers editing at the same time
 *     are editing the same rows — last write wins per field, with the audit
 *     row naming who moved what;
 *   - a publish carries everything currently saved, including a colleague's
 *     edit made ten minutes ago. That is why `GET /booths/:id/draft` returns
 *     the exact bundle that would be published together with its hash, and
 *     why publish accepts `expectedBundleHash`: a manager can refuse to
 *     publish a draft they have not looked at, and gets the current hash back
 *     instead of a surprise on a television.
 *
 * **What is NOT here.** Marketing channels and campaigns
 * (`promo.marketing_channel`, `promo.campaign`) are part of S2-07b and are
 * not built: both are new tables, and migrations belong to another workflow
 * in this tree today. `voucher_definition` therefore carries no channel or
 * campaign, and nothing here pretends it does.
 */

// --- Canonical form ---------------------------------------------------------

/**
 * JSON with every object's keys in sorted order.
 *
 * `bundle_hash` is what a box compares to decide whether it is already running
 * a version, so it must not change because somebody wrote two fields in a
 * different order. The seed writes version 1 with exactly this rule
 * (`packages/db/src/seed/index.ts`), and this is the publish path taking
 * ownership of it, as the comment there says it would.
 */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
    const src = v as Record<string, unknown>;
    return Object.fromEntries(Object.keys(src).sort().map((k) => [k, src[k]]));
  });
}

function hashBundle(bundle: unknown): string {
  return createHash('sha256').update(stableJson(bundle)).digest('hex');
}

// --- The draft --------------------------------------------------------------

type PrizeRow = typeof boothPrize.$inferSelect;
type LayoutRow = typeof boothLayout.$inferSelect;

/**
 * The settings a booth nobody has configured runs on.
 *
 * A station of kind `booth` created from the fleet screens has no
 * `booth_settings` row until somebody opens the panel, so every reader here
 * takes these rather than failing — and `layoutId: null` is what then stops a
 * publish, which is the refusal that case deserves.
 */
const SETTINGS_DEFAULTS = {
  layoutId: null as string | null,
  buttonKey: 'Space',
  eligibility: 'none' as BoothEligibilityMode,
  dailySpinCap: null as number | null,
  spinDurationSeconds: BOOTH_SPIN_DURATION_DEFAULT_SECONDS,
  /** The voucher slip (SCRUM-471): today's slip, the column defaults of migration 0039. */
  voucherShowLogo: BOOTH_VOUCHER_SLIP_DEFAULTS.showLogo,
  voucherHeaderText: BOOTH_VOUCHER_SLIP_DEFAULTS.headerText as string | null,
  voucherFooterText: BOOTH_VOUCHER_SLIP_DEFAULTS.footerText as string | null,
  voucherShowStaff: BOOTH_VOUCHER_SLIP_DEFAULTS.showStaff,
  voucherShowTerms: BOOTH_VOUCHER_SLIP_DEFAULTS.showTerms,
  voucherDesign: null as BoothVoucherDesign | null,
};

export interface BoothDraft {
  settings: typeof SETTINGS_DEFAULTS & { updatedAt: Date | null };
  layout: LayoutRow | null;
  prizes: PrizeRow[];
  /** Keyed by `voucher_definition.id`, for the prizes this draft points at. */
  definitions: Map<string, typeof voucherDefinition.$inferSelect>;
  /**
   * The booth station's code prefix, as stored. Read for the publish check
   * only (`publishBlockers`) and never put in the bundle: the box takes the
   * prefix from its station config, not from the published wheel.
   */
  codePrefix: string | null;
}

/** Everything a publish reads, in one place, so validation and minting agree. */
async function loadDraft(exec: Exec, row: BoothStationRow): Promise<BoothDraft> {
  const [settingsRow] = await exec
    .select()
    .from(boothSettings)
    .where(eq(boothSettings.stationId, row.stationId))
    .limit(1);

  // `BoothStationRow` does not carry the prefix, so it is read here, with the
  // same executor as the rest of the draft: a publish checks it inside the
  // transaction that mints the version.
  const [stationRow] = await exec
    .select({ codePrefix: station.codePrefix })
    .from(station)
    .where(eq(station.id, row.stationId))
    .limit(1);

  const layout = settingsRow?.layoutId
    ? ((
        await exec
          .select()
          .from(boothLayout)
          .where(eq(boothLayout.id, settingsRow.layoutId))
          .limit(1)
      )[0] ?? null)
    : null;

  /**
   * Live slices only, in the publisher's order. `sort_order` then name, so
   * that two prizes a manager left on the same position do not swap places
   * between one publish and the next — the wheel's slice order is what
   * `SpinResponse.prizeIndex` indexes, and a list whose order depends on the
   * planner is a wheel that animates to a different slice after a vacuum.
   */
  const prizes = await exec
    .select()
    .from(boothPrize)
    .where(and(eq(boothPrize.stationId, row.stationId), isNull(boothPrize.archivedAt)))
    .orderBy(asc(boothPrize.sortOrder), asc(boothPrize.nameEn));

  const wanted = [...new Set(prizes.map((p) => p.voucherDefinitionId).filter(isNonNull))];
  const definitions = wanted.length
    ? await exec.select().from(voucherDefinition).where(inArray(voucherDefinition.id, wanted))
    : [];

  return {
    settings: {
      layoutId: settingsRow?.layoutId ?? SETTINGS_DEFAULTS.layoutId,
      buttonKey: settingsRow?.buttonKey ?? SETTINGS_DEFAULTS.buttonKey,
      eligibility: settingsRow?.eligibility ?? SETTINGS_DEFAULTS.eligibility,
      dailySpinCap: settingsRow?.dailySpinCap ?? SETTINGS_DEFAULTS.dailySpinCap,
      spinDurationSeconds: settingsRow?.spinDurationSeconds ?? SETTINGS_DEFAULTS.spinDurationSeconds,
      voucherShowLogo: settingsRow?.voucherShowLogo ?? SETTINGS_DEFAULTS.voucherShowLogo,
      voucherHeaderText: settingsRow?.voucherHeaderText ?? SETTINGS_DEFAULTS.voucherHeaderText,
      voucherFooterText: settingsRow?.voucherFooterText ?? SETTINGS_DEFAULTS.voucherFooterText,
      voucherShowStaff: settingsRow?.voucherShowStaff ?? SETTINGS_DEFAULTS.voucherShowStaff,
      voucherShowTerms: settingsRow?.voucherShowTerms ?? SETTINGS_DEFAULTS.voucherShowTerms,
      voucherDesign: settingsRow?.voucherDesign ?? SETTINGS_DEFAULTS.voucherDesign,
      updatedAt: settingsRow?.updatedAt ?? null,
    },
    layout,
    prizes,
    definitions: new Map(definitions.map((d) => [d.id, d])),
    codePrefix: stationRow?.codePrefix ?? null,
  };
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
}

/**
 * The park's words for the slips, for the definitions this draft's prizes
 * point at (SCRUM-400) — only those that carry a title or an instruction, in
 * id order so the document does not depend on the order prizes were edited.
 *
 * **A definition with neither contributes nothing, deliberately.** The bundle
 * is hashed as stored: had every definition gone in, every booth published
 * before this field existed would read as "changed" with nothing a manager
 * could see to review, and would need a publish to say the same thing again.
 *
 * An entry carries the terms too, and the box prints an entry's terms rather
 * than the cache's (`buildPrintJob` in `@oto/box-agent`), so a version
 * records what its slips said. What a slip prints therefore follows the
 * version a booth is running, not the definition as it is now: a definition
 * with no entry in that version — never worded, or worded only since —
 * prints the prize's own names, the generic redemption line and its terms
 * from the `booth` cache scope, which change at the box's next pull; one with
 * an entry prints the entry until the next publish, even once its title and
 * instruction are cleared. The rule in full is the note at the top of
 * `voucher-definitions.ts`. The expiry is not here: the box reads it when a
 * voucher is won, from the prize's own days or, when the prize names none,
 * from the definition on the cache scope, so a definition's changed expiry
 * applies from the box's next pull.
 */
function slipWording(draft: BoothDraft): Array<Record<string, string | null>> {
  const worded = [...draft.definitions.values()].filter((d) =>
    [d.titleEn, d.titleTh, d.instructionEn, d.instructionTh, d.legacyQrPayload].some((w) => w !== null && w !== ''),
  );
  return worded
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((d) => ({
      id: d.id,
      titleEn: d.titleEn,
      titleTh: d.titleTh,
      instructionEn: d.instructionEn,
      instructionTh: d.instructionTh,
      termsEn: d.termsEn,
      termsTh: d.termsTh,
      ...(d.legacyQrPayload !== null ? { legacyQrPayload: d.legacyQrPayload } : {}),
    }));
}

/**
 * The bundle a publish would mint, or null when there is no design to mint it
 * from.
 *
 * Every field is named exactly as its column, because the agent reads this
 * document and the two ends must not need a translation table between them
 * (`BoothConfigBundleSchema` in `@oto/shared`). **Inactive prizes are carried
 * too**: they are slices on the wheel the television draws, and the box's own
 * draw is what skips them. Dropping them here would renumber every slice after
 * the first prize somebody switched off.
 */
function bundleFrom(draft: BoothDraft): Record<string, unknown> | null {
  const layout = draft.layout;
  if (!layout) return null;
  const wording = slipWording(draft);
  return {
    schemaVersion: BOOTH_BUNDLE_SCHEMA_VERSION,
    settings: {
      eligibility: draft.settings.eligibility,
      buttonKey: draft.settings.buttonKey,
      dailySpinCap: draft.settings.dailySpinCap,
      // The default is implicit so untouched historical wheels keep their hash.
      ...(draft.settings.spinDurationSeconds !== BOOTH_SPIN_DURATION_DEFAULT_SECONDS
        ? { spinDurationSeconds: draft.settings.spinDurationSeconds }
        : {}),
      /*
       * `staffSessionMinutes` is retired by SCRUM-694 (nobody signs in at the
       * booth) and is never emitted: a booth whose retired column is still set
       * shows a changed draft once, and republishing drops it. Everybody else's
       * bundle, and its hash, are unchanged.
       */
      /**
       * The voucher slip (SCRUM-471), each field only when it differs from
       * its default — the same rule, for the same hash, as the duration above. The
       * box reads them back with `boothVoucherSlip`.
       */
      ...boothVoucherSlipBundleFields({
        showLogo: draft.settings.voucherShowLogo,
        headerText: draft.settings.voucherHeaderText,
        footerText: draft.settings.voucherFooterText,
        showStaff: draft.settings.voucherShowStaff,
        showTerms: draft.settings.voucherShowTerms,
        design: draft.settings.voucherDesign ?? BOOTH_VOUCHER_DESIGN_DEFAULTS,
      }),
    },
    layout: {
      id: layout.id,
      name: layout.name,
      version: layout.version,
      design: layout.design,
      assetManifest: layout.assetManifest,
    },
    prizes: draft.prizes.map((p) => ({
      id: p.id,
      nameEn: p.nameEn,
      nameTh: p.nameTh,
      wheelLabel: p.wheelLabel,
      weightBp: p.weightBp,
      active: p.active,
      dailyCap: p.dailyCap,
      expiryDays: p.expiryDays,
      costSatang: p.costSatang,
      sliceColor: p.sliceColor,
      textColor: p.textColor,
      sortOrder: p.sortOrder,
      voucherDefinitionId: p.voucherDefinitionId,
    })),
    ...(wording.length > 0 ? { voucherDefinitions: wording } : {}),
  };
}

// --- The code prefix a booth prints -----------------------------------------

/**
 * A booth's code prefix: exactly two capital letters or digits (H2, closing
 * audit of 25 September 2026).
 *
 * The box mints every voucher code itself — the prefix, eight drawn
 * characters and a check character (`mintBoothCode` in `@oto/shared`) — and
 * `mintBoothCode` upper-cases the prefix and throws unless it is then two of
 * `[0-9A-Z]`. Nothing before the box asked: a booth station saved with the
 * field empty, which is the Console form's default, or with `PI1`, was stored
 * and published, and then every press failed on the television with "Booth
 * not ready — please call staff" and no screen said why. So the rule is
 * checked where a station is written (`createStation` and `updateStation` in
 * `services/fleet.ts`) and again before a publish (`publishBlockers` below),
 * and this is the one statement of it that both read.
 *
 * **Capitals only**, although `mintBoothCode` would capitalise `b1` itself:
 * `station_code_prefix_unique` compares the stored text, so `b1` and `B1`
 * would pass it as two prefixes at one branch and mint codes from one code
 * space. The Console capitalises what it sends.
 */
const BOOTH_CODE_PREFIX = new RegExp(`^[0-9A-Z]{${BOOTH_CODE_PREFIX_LENGTH}}$`);

/** The rule in the words a refusal carries; the Console shows the message as it stands. */
export const BOOTH_CODE_PREFIX_RULE = `A booth’s code prefix must be exactly ${BOOTH_CODE_PREFIX_LENGTH} capital letters or digits (A–Z, 0–9), for example B1: it starts every voucher code the booth prints.`;

/** Whether a booth station could mint voucher codes with this prefix. */
export function isBoothCodePrefix(prefix: string | null | undefined): prefix is string {
  return typeof prefix === 'string' && BOOTH_CODE_PREFIX.test(prefix);
}

// --- What stops a publish ---------------------------------------------------

/** One reason this wheel cannot go on a television, with the field to fix. */
export interface PublishBlocker {
  /** Where the Console puts the error. `prizes[<name>].weightBp` and so on. */
  field: string;
  code: string;
  message: string;
}

/** The total the active slices must add up to. Basis points, integers (D4). */
const TOTAL_WEIGHT_BP = 10_000;

/**
 * Everything that would make the published wheel wrong, all of it, in one
 * pass.
 *
 * Every blocker rather than the first: a manager fixing a prize list one
 * refusal at a time publishes four times and finds a fifth problem, and each
 * of those attempts is a version number spent.
 *
 * **Weights are summed over the ACTIVE prizes only**, because that is the set
 * the box renormalises over per draw. An inactive slice's weight is not part
 * of anybody's odds, and demanding it add up would mean a manager switching a
 * prize off could not publish until they had redistributed it — which is the
 * moment they least want an argument with a form.
 */
async function publishBlockers(
  exec: Exec,
  row: BoothStationRow,
  draft: BoothDraft,
): Promise<PublishBlocker[]> {
  const blockers: PublishBlocker[] = [];

  /**
   * A booth whose station prefix breaks the rule above (H2).
   *
   * The prefix is not in the bundle — the box reads it from its station
   * config, so a corrected prefix reaches a running booth at the box's next
   * config pull, with no publish — and it is checked here anyway: a publish is
   * the moment a manager takes the booth to be ready, and a booth whose prefix
   * is empty or not two letters or digits refuses every press. A lower-case
   * one would print, and is refused for the reason in the note on
   * `BOOTH_CODE_PREFIX`. The station write refuses a bad prefix too; this
   * catches a booth saved before that rule existed.
   */
  if (!isBoothCodePrefix(draft.codePrefix)) {
    blockers.push({
      field: 'codePrefix',
      code: 'BOOTH_CODE_PREFIX_INVALID',
      message: `${BOOTH_CODE_PREFIX_RULE} Set it on this booth’s station under Devices, then publish.`,
    });
  }

  if (!draft.settings.layoutId || !draft.layout) {
    blockers.push({
      field: 'layoutId',
      code: 'BOOTH_NO_LAYOUT',
      message: 'This booth has no wheel design. Pick a layout before publishing.',
    });
  } else if (draft.layout.archivedAt) {
    blockers.push({
      field: 'layoutId',
      code: 'BOOTH_LAYOUT_ARCHIVED',
      message: `The layout "${draft.layout.name}" has been archived. Pick a live design before publishing.`,
    });
  }

  /**
   * `band` and `phone` (D15, `booth.md` open question 1).
   *
   * Both are implemented everywhere else — the column holds them, the bundle
   * carries them — and both are refused HERE, because a mall visitor has no
   * wristband and the television asks for no phone number. The day there is a
   * booth inside the park this is the line that changes, and nothing else is.
   */
  if (draft.settings.eligibility !== 'none') {
    blockers.push({
      field: 'eligibility',
      code: 'BOOTH_ELIGIBILITY_UNAVAILABLE',
      message: `Spin eligibility "${draft.settings.eligibility}" is not available until the park booth exists.`,
    });
  }

  const active = draft.prizes.filter((p) => p.active);
  if (active.length === 0) {
    blockers.push({
      field: 'prizes',
      code: 'BOOTH_NO_ACTIVE_PRIZE',
      message:
        'Every prize is switched off, so the wheel could not be played. Switch at least one prize on before publishing.',
    });
  } else {
    const sum = active.reduce((total, p) => total + p.weightBp, 0);
    if (sum !== TOTAL_WEIGHT_BP) {
      blockers.push({
        field: 'prizes[].weightBp',
        code: 'BOOTH_WEIGHTS_NOT_WHOLE',
        message: `The ${active.length} active prizes' weights add up to ${sum} basis points (${formatPercent(sum)}). They must add up to exactly ${TOTAL_WEIGHT_BP} (100%).`,
      });
    }
  }

  for (const prize of active) {
    const definition = prize.voucherDefinitionId
      ? draft.definitions.get(prize.voucherDefinitionId)
      : undefined;
    if (!definition) {
      blockers.push({
        field: `prizes[${prize.nameEn}].voucherDefinitionId`,
        code: 'BOOTH_PRIZE_NO_DEFINITION',
        message: `"${prize.nameEn}" has no voucher definition, so winning it would produce nothing to redeem. Give it one or switch it off.`,
      });
      continue;
    }
    if (definition.archivedAt || !definition.active) {
      blockers.push({
        field: `prizes[${prize.nameEn}].voucherDefinitionId`,
        code: 'BOOTH_PRIZE_DEFINITION_INACTIVE',
        message: `"${prize.nameEn}" points at the voucher "${definition.code}", which is no longer active.`,
      });
    }
    /**
     * No expiry is not a blocker (owner, 24 September: "expiry per prize, with
     * never allowed"). A prize with no expiry of its own and a definition that
     * never expires prints "No expiry" on the slip, the voucher carries a null
     * `expires_at`, and the till honours it at any date (`vouchers.ts`). This
     * used to refuse the publish; the decision to allow it is the owner's.
     */
  }

  /**
   * A wheel where every active prize has already hit its cap TODAY.
   *
   * Different in kind from the checks above — it is about this afternoon
   * rather than about the document — and it is checked anyway, because the box
   * refuses the press when nothing is eligible and a manager publishing at
   * five o'clock has no other way to find that out. Caps are per booth per
   * trading day, so tomorrow the same bundle is playable; the message says so
   * rather than implying the prize list is broken.
   */
  if (active.length > 0 && active.every((p) => p.dailyCap !== null)) {
    const today = await boothBusinessDate(exec, row.branchId);
    const given = await givenTodayByPrize(exec, row.stationId, today);
    const spent = active.filter((p) => (given.get(p.id) ?? 0) >= (p.dailyCap ?? 0));
    if (spent.length === active.length) {
      blockers.push({
        field: 'prizes[].dailyCap',
        code: 'BOOTH_ALL_PRIZES_CAPPED',
        message: `Every active prize has reached its daily cap for ${today}, so the wheel could not be played today. Raise a cap, switch another prize on, or publish tomorrow.`,
      });
    }
  }

  return blockers;
}

function formatPercent(bp: number): string {
  const whole = Math.trunc(bp / 100);
  const rest = Math.abs(bp % 100);
  return rest === 0 ? `${whole}%` : `${whole}.${String(rest).padStart(2, '0')}%`;
}

/** The branch's trading day, not the calendar one — as the spin rows are filed. */
async function boothBusinessDate(exec: Exec, branchId: string): Promise<string> {
  const [row] = await exec
    .select({ timezone: branch.timezone, businessDayStart: branch.businessDayStart })
    .from(branch)
    .where(eq(branch.id, branchId))
    .limit(1);
  if (!row) throw new AppError(404, 'BOOTH_NOT_FOUND', 'No booth with that id');
  return businessDate(new Date(), row.timezone, parseDayStart(row.businessDayStart));
}

/** How many of each prize this booth has given away today. Test runs excluded. */
async function givenTodayByPrize(
  exec: Exec,
  stationId: string,
  today: string,
): Promise<Map<string, number>> {
  const rows = await exec
    .select({ prizeId: spin.prizeId, given: count() })
    .from(spin)
    .where(
      and(
        eq(spin.stationId, stationId),
        eq(spin.businessDate, today),
        eq(spin.simulated, false),
      ),
    )
    .groupBy(spin.prizeId);
  const given = new Map<string, number>();
  for (const r of rows) if (r.prizeId) given.set(r.prizeId, r.given);
  return given;
}

// --- Reading the panel ------------------------------------------------------

export interface PublishedVersionView {
  id: string;
  version: number;
  publishedAt: string;
  bundleHash: string;
  note: string | null;
  publishedByAccountId: string | null;
}

/** One slice as the Console's prize table reads it. */
export interface BoothPrizeView {
  id: string;
  nameEn: string;
  nameTh: string | null;
  wheelLabel: string | null;
  weightBp: number;
  active: boolean;
  expiryDays: number | null;
  dailyCap: number | null;
  costSatang: number;
  sliceColor: string | null;
  textColor: string | null;
  sortOrder: number;
  voucherDefinitionId: string | null;
  /** The definition's own code and expiry, so the editor can show what a win produces. */
  voucherDefinitionCode: string | null;
  effectiveExpiryDays: number | null;
}

/** A slice taken off the wheel, as the "show archived" list reads it (SCRUM-468). */
export interface BoothArchivedPrizeView extends BoothPrizeView {
  archivedAt: string;
}

export interface BoothDraftView {
  booth: { id: string; name: string; branchId: string; codePrefix: string | null };
  settings: {
    layoutId: string | null;
    layoutName: string | null;
    buttonKey: string;
    eligibility: BoothEligibilityMode;
    dailySpinCap: number | null;
    spinDurationSeconds: number;
  } & BoothVoucherSlipSettings;
  prizes: BoothPrizeView[];
  /**
   * The slices archived off this booth, most recently archived first — only
   * when the caller asked for them (`includeArchived`), and absent otherwise,
   * so the draft everybody else reads is the draft it always was (SCRUM-468).
   *
   * Beside `prizes` rather than in it: `prizes` is what a publish would
   * freeze, and every total the Console draws from it — the odds, the money,
   * "adds to 100%" — would be wrong with a row in it the wheel will never
   * carry. Nothing here reaches the bundle or its hash.
   */
  archivedPrizes?: BoothArchivedPrizeView[];
  /** Exactly what publishing would mint, or null while there is no layout. */
  bundle: unknown;
  bundleHash: string | null;
  published: PublishedVersionView | null;
  /**
   * The document the booths are running now, beside the one above.
   *
   * Both, so that a before-and-after is possible at all: with only the hash,
   * the Console can say THAT the draft differs and never what changed, and
   * "the ฿200 voucher went from 14.5 % to 20 %" is the sentence a manager
   * wants before they publish odds to a machine in a shopping centre. Null
   * when nothing has ever been published for this booth.
   */
  publishedBundle: unknown;
  /** Whether the draft differs from the published wheel. False is "nothing to publish". */
  changed: boolean;
  /** The newest edit to anything in the bundle — a colleague's included. */
  lastEditedAt: string | null;
  /** Empty means this draft can be published as it stands. */
  blockers: PublishBlocker[];
}

/** A prize row as the Console reads it, its voucher definition looked up in `definitions`. */
function prizeView(
  p: PrizeRow,
  definitions: ReadonlyMap<string, typeof voucherDefinition.$inferSelect>,
): BoothPrizeView {
  const definition = p.voucherDefinitionId ? definitions.get(p.voucherDefinitionId) : undefined;
  return {
    id: p.id,
    nameEn: p.nameEn,
    nameTh: p.nameTh,
    wheelLabel: p.wheelLabel,
    weightBp: p.weightBp,
    active: p.active,
    expiryDays: p.expiryDays,
    dailyCap: p.dailyCap,
    costSatang: p.costSatang,
    sliceColor: p.sliceColor,
    textColor: p.textColor,
    sortOrder: p.sortOrder,
    voucherDefinitionId: p.voucherDefinitionId,
    voucherDefinitionCode: definition?.code ?? null,
    effectiveExpiryDays: p.expiryDays ?? definition?.expiryDays ?? null,
  };
}

/**
 * The booth's archived slices, most recently archived first (SCRUM-468) —
 * what "Show archived prizes" lists, each with its voucher definition's code
 * so a manager can tell them apart before bringing one back.
 */
async function archivedPrizeViews(
  exec: Exec,
  row: BoothStationRow,
  known: ReadonlyMap<string, typeof voucherDefinition.$inferSelect>,
): Promise<BoothArchivedPrizeView[]> {
  const rows = await exec
    .select()
    .from(boothPrize)
    .where(and(eq(boothPrize.stationId, row.stationId), isNotNull(boothPrize.archivedAt)))
    .orderBy(desc(boothPrize.archivedAt), asc(boothPrize.nameEn));
  const missing = [
    ...new Set(rows.map((p) => p.voucherDefinitionId).filter(isNonNull)),
  ].filter((id) => !known.has(id));
  const extra = missing.length
    ? await exec.select().from(voucherDefinition).where(inArray(voucherDefinition.id, missing))
    : [];
  const definitions = new Map([...known, ...extra.map((d) => [d.id, d] as const)]);
  return rows.map((p) => ({
    ...prizeView(p, definitions),
    // The WHERE above keeps only archived rows; the fallback is never taken.
    archivedAt: (p.archivedAt ?? new Date(0)).toISOString(),
  }));
}

export async function boothDraft(
  db: Db,
  row: BoothStationRow,
  opts: { includeArchived?: boolean } = {},
): Promise<BoothDraftView> {
  const draft = await loadDraft(db, row);
  const bundle = bundleFrom(draft);
  const blockers = await publishBlockers(db, row, draft);
  const [publishedRow] = await db
    .select()
    .from(boothConfigVersion)
    .where(eq(boothConfigVersion.stationId, row.stationId))
    .orderBy(desc(boothConfigVersion.version))
    .limit(1);
  const published = publishedRow ? versionView(publishedRow) : null;
  const bundleHash = bundle ? hashBundle(bundle) : null;

  // The worded definitions are part of the bundle now (SCRUM-400), so an edit
  // to their words is an edit to the draft.
  const worded = new Set(slipWording(draft).map((w) => w.id));
  const edits = [
    draft.settings.updatedAt,
    draft.layout?.updatedAt ?? null,
    ...draft.prizes.map((p) => p.updatedAt),
    ...[...draft.definitions.values()].filter((d) => worded.has(d.id)).map((d) => d.updatedAt),
  ].filter(isNonNull);
  const lastEditedAt = edits.length
    ? new Date(Math.max(...edits.map((d) => d.getTime()))).toISOString()
    : null;

  return {
    booth: { id: row.stationId, name: row.name, branchId: row.branchId, codePrefix: draft.codePrefix },
    settings: {
      layoutId: draft.settings.layoutId,
      layoutName: draft.layout?.name ?? null,
      buttonKey: draft.settings.buttonKey,
      eligibility: draft.settings.eligibility,
      dailySpinCap: draft.settings.dailySpinCap,
      spinDurationSeconds: draft.settings.spinDurationSeconds,
      voucherShowLogo: draft.settings.voucherShowLogo,
      voucherHeaderText: draft.settings.voucherHeaderText,
      voucherFooterText: draft.settings.voucherFooterText,
      voucherShowStaff: draft.settings.voucherShowStaff,
      voucherShowTerms: draft.settings.voucherShowTerms,
      voucherDesign: draft.settings.voucherDesign,
    },
    prizes: draft.prizes.map((p) => prizeView(p, draft.definitions)),
    ...(opts.includeArchived
      ? { archivedPrizes: await archivedPrizeViews(db, row, draft.definitions) }
      : {}),
    bundle,
    bundleHash,
    published,
    /**
     * Served as STORED, never re-serialised: the hash beside it is taken over
     * the document that was published, and a round trip through a projection
     * written here would drop whatever a newer build put in it.
     */
    publishedBundle: publishedRow?.bundle ?? null,
    changed: bundleHash !== null && bundleHash !== (published?.bundleHash ?? null),
    lastEditedAt,
    blockers,
  };
}

async function currentVersion(exec: Exec, stationId: string): Promise<PublishedVersionView | null> {
  const [row] = await exec
    .select()
    .from(boothConfigVersion)
    .where(eq(boothConfigVersion.stationId, stationId))
    /** The current wheel is the highest version there is; there is no flag. */
    .orderBy(desc(boothConfigVersion.version))
    .limit(1);
  return row ? versionView(row) : null;
}

function versionView(row: typeof boothConfigVersion.$inferSelect): PublishedVersionView {
  return {
    id: row.id,
    version: row.version,
    publishedAt: row.publishedAt.toISOString(),
    bundleHash: row.bundleHash,
    note: row.note,
    publishedByAccountId: row.publishedByAccountId,
  };
}

export async function listBoothVersions(
  db: Db,
  stationId: string,
  limit: number,
): Promise<{ versions: PublishedVersionView[] }> {
  const rows = await db
    .select()
    .from(boothConfigVersion)
    .where(eq(boothConfigVersion.stationId, stationId))
    .orderBy(desc(boothConfigVersion.version))
    .limit(limit);
  return { versions: rows.map(versionView) };
}

export interface BoothListItem {
  id: string;
  name: string;
  branchId: string;
  boxId: string | null;
  eligibility: BoothEligibilityMode;
  layoutName: string | null;
  publishedVersion: number | null;
  publishedAt: string | null;
  activePrizes: number;
}

/**
 * The Console's booth list for one branch. Status tiles are `GET /booths/:id/status`.
 *
 * **Takes the operator as well as the branch (SCRUM-267).** This answered with
 * whatever branch id it was handed, and its route did not load the branch
 * first, so one operator's administrator read another operator's booth list —
 * a permission guard cannot establish it, because an operator-scoped grant
 * matches on the operator alone and has no way to know which operator a branch
 * id belongs to. The route now loads the branch scoped to the caller before
 * this runs; the join here is the second fence, so a future caller that forgets
 * gets an empty list rather than somebody else's booths.
 */
export async function listBooths(
  db: Db,
  operatorId: string,
  branchId: string,
): Promise<{ booths: BoothListItem[] }> {
  const rows = await db
    .select({
      id: station.id,
      name: station.name,
      branchId: station.branchId,
      boxId: station.boxId,
      eligibility: boothSettings.eligibility,
      layoutName: boothLayout.name,
    })
    .from(station)
    .innerJoin(branch, eq(branch.id, station.branchId))
    .leftJoin(boothSettings, eq(boothSettings.stationId, station.id))
    .leftJoin(boothLayout, eq(boothLayout.id, boothSettings.layoutId))
    .where(
      and(
        eq(station.branchId, branchId),
        eq(branch.operatorId, operatorId),
        eq(station.kind, 'booth'),
        isNull(station.archivedAt),
      ),
    )
    .orderBy(asc(station.name));

  const booths: BoothListItem[] = [];
  for (const row of rows) {
    const published = await currentVersion(db, row.id);
    const [active] = await db
      .select({ n: count() })
      .from(boothPrize)
      .where(
        and(
          eq(boothPrize.stationId, row.id),
          eq(boothPrize.active, true),
          isNull(boothPrize.archivedAt),
        ),
      );
    booths.push({
      id: row.id,
      name: row.name,
      branchId: row.branchId,
      boxId: row.boxId,
      eligibility: row.eligibility ?? SETTINGS_DEFAULTS.eligibility,
      layoutName: row.layoutName ?? null,
      publishedVersion: published?.version ?? null,
      publishedAt: published?.publishedAt ?? null,
      activePrizes: active?.n ?? 0,
    });
  }
  return { booths };
}

// --- Publishing -------------------------------------------------------------

export interface PublishInput {
  note?: string | null;
  /**
   * The hash the manager was shown when they looked at the draft.
   *
   * Optional, and what it buys is the answer to "what does a second manager
   * editing at the same time see": a publish whose draft has moved since the
   * preview is refused with the current hash, rather than quietly putting
   * somebody else's half-finished edit on a television.
   */
  expectedBundleHash?: string | null;
}

export interface PublishResult {
  version: PublishedVersionView;
  prizes: number;
  activePrizes: number;
}

/**
 * Mint version N+1 of this booth's wheel.
 *
 * Validation, the bundle and the insert all happen inside ONE transaction, on
 * purpose: validating outside it would let a colleague's edit land in between,
 * and the version published would then be one nothing ever checked.
 *
 * The version number is allocated by reading the highest and adding one, which
 * is a race — and `booth_config_version_unique` on (station, version) is what
 * settles it. Two managers pressing Publish together produce one version and
 * one 409, never two rows claiming to be version 7.
 */
export async function publishBoothConfig(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  row: BoothStationRow,
  input: PublishInput,
): Promise<PublishResult> {
  try {
    return await withTx(db, ctx, 'booth_config.publish', async (tx) => {
      const draft = await loadDraft(tx, row);
      const blockers = await publishBlockers(tx, row, draft);
      if (blockers.length > 0) {
        throw new AppError(
          400,
          'BOOTH_PUBLISH_INVALID',
          'This wheel cannot be published yet',
          { blockers },
        );
      }
      // `publishBlockers` refuses a draft with no layout, so this is not null.
      const bundle = bundleFrom(draft)!;
      const bundleHash = hashBundle(bundle);

      if (input.expectedBundleHash && input.expectedBundleHash !== bundleHash) {
        throw new AppError(
          409,
          'BOOTH_PUBLISH_STALE',
          'This booth has been edited since you looked at it. Review the draft and publish again.',
          { bundleHash },
        );
      }

      const current = await currentVersion(tx, row.stationId);
      if (current && current.bundleHash === bundleHash) {
        throw new AppError(
          409,
          'BOOTH_PUBLISH_UNCHANGED',
          `Nothing has changed since version ${current.version}, so there is nothing to publish.`,
          { version: current.version },
        );
      }

      const id = newId();
      const version = (current?.version ?? 0) + 1;
      await tx.insert(boothConfigVersion).values({
        id,
        operatorId: row.operatorId,
        branchId: row.branchId,
        stationId: row.stationId,
        version,
        layoutId: draft.layout!.id,
        bundle,
        bundleHash,
        publishedByAccountId: actor.accountId,
        note: input.note ?? null,
      });

      const [written] = await tx
        .select()
        .from(boothConfigVersion)
        .where(eq(boothConfigVersion.id, id))
        .limit(1);

      /**
       * The audit row records the version, not the bundle: the bundle is
       * already immutable in the row above, and copying a six-prize document
       * into `after` would put the same thing in two places with only one of
       * them under a unique key.
       */
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: row.operatorId,
        branchId: row.branchId,
        action: 'booth_config.publish',
        entityType: 'booth_config_version',
        entityId: id,
        before: current ? { version: current.version, bundleHash: current.bundleHash } : null,
        after: {
          version,
          bundleHash,
          prizes: draft.prizes.length,
          activePrizes: draft.prizes.filter((p) => p.active).length,
          note: input.note ?? null,
        },
        requestId: ctx.requestId,
      });

      return {
        version: versionView(written!),
        prizes: draft.prizes.length,
        activePrizes: draft.prizes.filter((p) => p.active).length,
      };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'booth_config_version_unique')) {
      throw new AppError(
        409,
        'BOOTH_PUBLISH_RACE',
        'Somebody else published this booth a moment ago. Review the draft and publish again.',
      );
    }
    throw err;
  }
}

/**
 * Unwrapped before it is read: Drizzle raises its own error with the
 * database's as `cause`, so a check against the top-level object sees neither
 * the SQLSTATE nor the constraint name — and the generic handler's `DUPLICATE`
 * answers instead of the one that says which name is taken.
 */
function isUniqueViolation(err: unknown, constraint: string): boolean {
  const pg = pgErrorOf(err);
  return pg?.code === '23505' && pg.constraint === constraint;
}

// --- Settings ---------------------------------------------------------------

export interface BoothSettingsPatch {
  layoutId?: string | null;
  buttonKey?: string;
  eligibility?: BoothEligibilityMode;
  dailySpinCap?: number | null;
  spinDurationSeconds?: number;
  /** The voucher slip (SCRUM-471). Blank text is stored as null — "no line". */
  voucherShowLogo?: boolean;
  voucherHeaderText?: string | null;
  voucherFooterText?: string | null;
  voucherShowStaff?: boolean;
  voucherShowTerms?: boolean;
  voucherDesign?: BoothVoucherDesign | null;
}

/**
 * The five voucher slip choices, as `booth.booth_settings` stores them and the
 * draft reads them (SCRUM-471). Named exactly as their columns, like the rest
 * of the settings.
 */
export interface BoothVoucherSlipSettings {
  voucherShowLogo: boolean;
  /** A line under the venue line; null prints none. */
  voucherHeaderText: string | null;
  /** The slip's last line; null prints none. */
  voucherFooterText: string | null;
  voucherShowStaff: boolean;
  voucherShowTerms: boolean;
  voucherDesign: BoothVoucherDesign | null;
}

/**
 * Change what this booth is, before anybody publishes it.
 *
 * Upserted rather than updated: a booth station created from the fleet screens
 * has no settings row at all, and refusing the first edit because of that
 * would make the panel unusable on exactly the booth somebody has just
 * installed.
 */
export async function updateBoothSettings(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  row: BoothStationRow,
  patch: BoothSettingsPatch,
): Promise<{ settings: BoothDraftView['settings'] }> {
  if (patch.layoutId) await requireLayout(db, actor.operatorId, patch.layoutId);

  return withTx(db, ctx, 'booth_settings.update', async (tx) => {
    /**
     * The row is read FOR UPDATE because the write below rewrites every
     * column from `before` plus the patch. The booth page has two forms on
     * this one row (the settings drawer and the Voucher slip card), and two
     * people saving at once must each land on top of the other's committed
     * change, not on the row as it was when both started (SCRUM-471 gate).
     */
    const lockedRow = async () =>
      (
        await tx
          .select()
          .from(boothSettings)
          .where(eq(boothSettings.stationId, row.stationId))
          .for('update')
          .limit(1)
      )[0];
    let before = await lockedRow();
    let next = mergedSettings(before, patch);

    if (before) {
      await tx
        .update(boothSettings)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(boothSettings.stationId, row.stationId));
    } else {
      const inserted = await tx
        .insert(boothSettings)
        .values({
          stationId: row.stationId,
          operatorId: row.operatorId,
          branchId: row.branchId,
          ...next,
        })
        .onConflictDoNothing({ target: boothSettings.stationId })
        .returning({ stationId: boothSettings.stationId });
      if (inserted.length === 0) {
        // A colleague's first save wrote the row between the read and this
        // insert: theirs is now `before`, and this patch lands on top of it.
        before = await lockedRow();
        next = mergedSettings(before, patch);
        await tx
          .update(boothSettings)
          .set({ ...next, updatedAt: new Date() })
          .where(eq(boothSettings.stationId, row.stationId));
      }
    }

    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: row.operatorId,
      branchId: row.branchId,
      action: 'booth_settings.update',
      entityType: 'booth_settings',
      entityId: row.stationId,
      before: before
        ? {
            layoutId: before.layoutId,
            buttonKey: before.buttonKey,
            eligibility: before.eligibility,
            dailySpinCap: before.dailySpinCap,
            spinDurationSeconds: before.spinDurationSeconds,
            voucherShowLogo: before.voucherShowLogo,
            voucherHeaderText: before.voucherHeaderText,
            voucherFooterText: before.voucherFooterText,
            voucherShowStaff: before.voucherShowStaff,
            voucherShowTerms: before.voucherShowTerms,
            voucherDesign: before.voucherDesign,
          }
        : null,
      after: next,
      requestId: ctx.requestId,
    });

    const [layout] = next.layoutId
      ? await tx.select({ name: boothLayout.name }).from(boothLayout).where(eq(boothLayout.id, next.layoutId)).limit(1)
      : [];
    return { settings: { ...next, layoutName: layout?.name ?? null } };
  });
}

/**
 * The row a settings PATCH writes: the stored row (or the defaults, before
 * there is one) with the patch's fields on top. A field the patch leaves out
 * keeps its stored value, so the settings drawer and the Voucher slip card
 * never overwrite each other's fields.
 */
function mergedSettings(
  before: typeof boothSettings.$inferSelect | undefined,
  patch: BoothSettingsPatch,
) {
  return {
    layoutId: patch.layoutId !== undefined ? patch.layoutId : (before?.layoutId ?? null),
    buttonKey: patch.buttonKey ?? before?.buttonKey ?? SETTINGS_DEFAULTS.buttonKey,
    eligibility: patch.eligibility ?? before?.eligibility ?? SETTINGS_DEFAULTS.eligibility,
    dailySpinCap:
      patch.dailySpinCap !== undefined ? patch.dailySpinCap : (before?.dailySpinCap ?? null),
    spinDurationSeconds:
      patch.spinDurationSeconds ?? before?.spinDurationSeconds ?? SETTINGS_DEFAULTS.spinDurationSeconds,
    voucherShowLogo:
      patch.voucherShowLogo ?? before?.voucherShowLogo ?? SETTINGS_DEFAULTS.voucherShowLogo,
    // Trimmed, and blank is null: "no line" has one spelling in the column,
    // which is what keeps an emptied field out of the published bundle.
    voucherHeaderText:
      patch.voucherHeaderText !== undefined
        ? boothVoucherText(patch.voucherHeaderText)
        : (before?.voucherHeaderText ?? null),
    voucherFooterText:
      patch.voucherFooterText !== undefined
        ? boothVoucherText(patch.voucherFooterText)
        : (before?.voucherFooterText ?? null),
    voucherShowStaff:
      patch.voucherShowStaff ?? before?.voucherShowStaff ?? SETTINGS_DEFAULTS.voucherShowStaff,
    voucherShowTerms:
      patch.voucherShowTerms ?? before?.voucherShowTerms ?? SETTINGS_DEFAULTS.voucherShowTerms,
    voucherDesign:
      patch.voucherDesign !== undefined ? patch.voucherDesign : (before?.voucherDesign ?? null),
  };
}

// --- The voucher slip's live preview (SCRUM-471) ----------------------------

/**
 * The 80 mm head the preview is laid out for: 576 dots, the width every booth
 * voucher is drawn against today (`packages/print/src/templates/booth.ts`
 * explains why that number is an assumption). A preview of a booth whose
 * printer turns out to be 512 dots is the one thing this cannot show, and the
 * fixture beside the template is where that comparison lives.
 */
const BOOTH_VOUCHER_PREVIEW_DEVICE = escposProfile({
  id: 'booth-voucher-preview',
  label: 'Sample',
  model: '80 mm receipt printer',
  widthDots: 576,
});

/**
 * The sample the preview prints: every word visibly a placeholder, and none
 * of it read from anything real — no prize, no code, no member of staff, no
 * branch. What the preview is FOR is the booth's five choices, and those are
 * the only thing on it that comes from the request.
 */
const BOOTH_VOUCHER_PREVIEW_SAMPLE = {
  venueLine: 'Your branch name prints here',
  prizeLine: 'SAMPLE PRIZE',
  prizeLineThai: 'รางวัลตัวอย่าง',
  redemptionLine: 'Show this QR at OTO Reception to claim: Sample prize.',
  terms: ['Sample terms — the voucher type’s own terms print here.'],
  voucherCode: 'SAMPLECODE',
  issuedAt: '01 Jan 2026 12:00',
  booth: 'Sample branch · Sample booth',
  staff: 'Staff name (S-0000)',
  expiresAt: '15 Jan 2026',
  reprintNote: null,
} as const;

/** The draft a preview is drawn from: any of the five, the saved value for the rest. */
export type BoothVoucherPreviewDraft = Partial<BoothVoucherSlipSettings>;

/**
 * Draw this booth's voucher slip as the printer would, from DRAFT values the
 * Console has not saved yet, and answer with the PNG.
 *
 * Rendered by the same `@oto/print` renderer the box uses, at the same 80 mm
 * width, so "the preview looks right" and "the paper looks right" are the
 * same statement. It writes nothing and reads only this booth's saved slip,
 * for whatever the draft leaves out.
 */
export async function renderBoothVoucherPreview(
  db: Db,
  row: BoothStationRow,
  draft: BoothVoucherPreviewDraft,
): Promise<{ png: Uint8Array; widthDots: number }> {
  const [saved] = await db
    .select({
      voucherShowLogo: boothSettings.voucherShowLogo,
      voucherHeaderText: boothSettings.voucherHeaderText,
      voucherFooterText: boothSettings.voucherFooterText,
      voucherShowStaff: boothSettings.voucherShowStaff,
      voucherShowTerms: boothSettings.voucherShowTerms,
      voucherDesign: boothSettings.voucherDesign,
    })
    .from(boothSettings)
    .where(eq(boothSettings.stationId, row.stationId))
    .limit(1);
  const pick = <K extends keyof BoothVoucherSlipSettings>(key: K): BoothVoucherSlipSettings[K] =>
    draft[key] !== undefined
      ? (draft[key] as BoothVoucherSlipSettings[K])
      : (saved?.[key] ?? SETTINGS_DEFAULTS[key]);

  const png = renderPreviewPng(
    {
      kind: 'booth_voucher',
      data: {
        ...BOOTH_VOUCHER_PREVIEW_SAMPLE,
        terms: [...BOOTH_VOUCHER_PREVIEW_SAMPLE.terms],
        ...(pick('voucherDesign')?.layout === 'showcase'
          ? {
              prizeLine: '100 THB DISCOUNT',
              prizeLineThai: 'ส่วนลด 100 บาท',
              redemptionLine: 'Show this QR at OTO Reception to redeem your voucher.\nแสดงคิวอาร์โค้ดนี้ที่เคาน์เตอร์ OTO เพื่อใช้สิทธิ์',
              termsEn: ['Valid only at OTO Play Park Central.', 'Valid only with an admission ticket.'],
              termsTh: ['คูปองใช้ได้เฉพาะที่ OTO Play Park Central เท่านั้น', 'ใช้ได้เมื่อซื้อบัตรเข้าชมสวนสนุกเท่านั้น'],
            }
          : {}),
        showLogo: pick('voucherShowLogo'),
        headerLine: boothVoucherText(pick('voucherHeaderText')),
        footerLine: boothVoucherText(pick('voucherFooterText')) ?? '',
        showStaff: pick('voucherShowStaff'),
        showTerms: pick('voucherShowTerms'),
        design: pick('voucherDesign') ?? BOOTH_VOUCHER_DESIGN_DEFAULTS,
        issuedDate: '01 Jan 2026',
      },
    },
    { device: BOOTH_VOUCHER_PREVIEW_DEVICE },
  );
  return { png, widthDots: BOOTH_VOUCHER_PREVIEW_DEVICE.widthDots };
}

async function requireLayout(exec: Exec, operatorId: string, layoutId: string): Promise<LayoutRow> {
  const [layout] = await exec.select().from(boothLayout).where(eq(boothLayout.id, layoutId)).limit(1);
  if (!layout || layout.operatorId !== operatorId) {
    throw new AppError(404, 'BOOTH_LAYOUT_NOT_FOUND', 'No wheel layout with that id');
  }
  if (layout.archivedAt) {
    throw new AppError(400, 'BOOTH_LAYOUT_ARCHIVED', 'That wheel layout has been archived');
  }
  return layout;
}

// --- Prizes -----------------------------------------------------------------

export interface PrizeInput {
  nameEn: string;
  nameTh?: string | null;
  wheelLabel?: string | null;
  weightBp: number;
  active?: boolean;
  expiryDays?: number | null;
  dailyCap?: number | null;
  costSatang?: number;
  sliceColor?: string | null;
  textColor?: string | null;
  sortOrder?: number;
  voucherDefinitionId?: string | null;
}

export async function createBoothPrize(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  row: BoothStationRow,
  input: PrizeInput,
): Promise<{ prize: PrizeRow }> {
  if (input.voucherDefinitionId) {
    await requireDefinition(db, actor.operatorId, input.voucherDefinitionId);
  }
  const id = newId();
  try {
    return await withTx(db, ctx, 'booth_prize.create', async (tx) => {
      /**
       * A new slice goes on the end unless a position was asked for, which is
       * where somebody adding a prize expects to find it.
       */
      const [last] = await tx
        .select({ sortOrder: boothPrize.sortOrder })
        .from(boothPrize)
        .where(and(eq(boothPrize.stationId, row.stationId), isNull(boothPrize.archivedAt)))
        .orderBy(desc(boothPrize.sortOrder))
        .limit(1);

      await tx.insert(boothPrize).values({
        id,
        operatorId: row.operatorId,
        branchId: row.branchId,
        stationId: row.stationId,
        nameEn: input.nameEn,
        nameTh: input.nameTh ?? null,
        wheelLabel: input.wheelLabel ?? null,
        weightBp: input.weightBp,
        active: input.active ?? true,
        expiryDays: input.expiryDays ?? null,
        dailyCap: input.dailyCap ?? null,
        costSatang: input.costSatang ?? 0,
        sliceColor: input.sliceColor ?? null,
        textColor: input.textColor ?? null,
        sortOrder: input.sortOrder ?? (last ? last.sortOrder + 1 : 0),
        voucherDefinitionId: input.voucherDefinitionId ?? null,
      });
      const [prize] = await tx.select().from(boothPrize).where(eq(boothPrize.id, id)).limit(1);
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: row.operatorId,
        branchId: row.branchId,
        action: 'booth_prize.create',
        entityType: 'booth_prize',
        entityId: id,
        after: prize,
        requestId: ctx.requestId,
      });
      return { prize: prize! };
    });
  } catch (err) {
    throw prizeConflict(err);
  }
}

export async function updateBoothPrize(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  row: BoothStationRow,
  before: PrizeRow,
  patch: Partial<PrizeInput>,
): Promise<{ prize: PrizeRow }> {
  if (patch.voucherDefinitionId) {
    await requireDefinition(db, actor.operatorId, patch.voucherDefinitionId);
  }
  try {
    return await withTx(db, ctx, 'booth_prize.update', async (tx) => {
      const set: Partial<typeof boothPrize.$inferInsert> = { updatedAt: new Date() };
      if (patch.nameEn !== undefined) set.nameEn = patch.nameEn;
      if (patch.nameTh !== undefined) set.nameTh = patch.nameTh;
      if (patch.wheelLabel !== undefined) set.wheelLabel = patch.wheelLabel;
      if (patch.weightBp !== undefined) set.weightBp = patch.weightBp;
      if (patch.active !== undefined) set.active = patch.active;
      if (patch.expiryDays !== undefined) set.expiryDays = patch.expiryDays;
      if (patch.dailyCap !== undefined) set.dailyCap = patch.dailyCap;
      if (patch.costSatang !== undefined) set.costSatang = patch.costSatang;
      if (patch.sliceColor !== undefined) set.sliceColor = patch.sliceColor;
      if (patch.textColor !== undefined) set.textColor = patch.textColor;
      if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
      if (patch.voucherDefinitionId !== undefined) {
        set.voucherDefinitionId = patch.voucherDefinitionId;
      }
      await tx.update(boothPrize).set(set).where(eq(boothPrize.id, before.id));
      const [prize] = await tx.select().from(boothPrize).where(eq(boothPrize.id, before.id)).limit(1);
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: row.operatorId,
        branchId: row.branchId,
        action: 'booth_prize.update',
        entityType: 'booth_prize',
        entityId: before.id,
        before,
        after: prize,
        requestId: ctx.requestId,
      });
      return { prize: prize! };
    });
  } catch (err) {
    throw prizeConflict(err);
  }
}

/**
 * Take a slice off the wheel.
 *
 * Archived, never deleted: `booth.spin` points at the prize somebody won, and
 * a deleted row would take last month's report with it. The wheel only loses
 * it at the next publish, which is the same rule as every other edit here.
 */
export async function archiveBoothPrize(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  row: BoothStationRow,
  before: PrizeRow,
): Promise<{ prize: PrizeRow }> {
  // Already off the wheel. The archive that took it off is the one in the
  // audit trail; a second press changes nothing and records nothing, and the
  // caller gets the same answer the first press got.
  if (before.archivedAt) return { prize: before };

  return withTx(db, ctx, 'booth_prize.archive', async (tx) => {
    const archivedAt = new Date();
    await tx
      .update(boothPrize)
      .set({ archivedAt, active: false, updatedAt: archivedAt })
      .where(eq(boothPrize.id, before.id));
    const [prize] = await tx.select().from(boothPrize).where(eq(boothPrize.id, before.id)).limit(1);
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: row.operatorId,
      branchId: row.branchId,
      action: 'booth_prize.archive',
      entityType: 'booth_prize',
      entityId: before.id,
      before,
      after: prize,
      requestId: ctx.requestId,
    });
    return { prize: prize! };
  });
}

/**
 * Bring an archived slice back (SCRUM-468).
 *
 * Archiving was a one-way door: the slice left every list, and nothing on
 * the platform could put it back, so a prize taken off by mistake had to be
 * typed in again under a new id — and last month's spins then named a prize
 * the editor could no longer show.
 *
 * **It comes back switched off**, whatever it was when it was archived, with
 * its weight, cost and position as they were. A switched-off slice is drawn
 * by nobody and counts in no total, so restoring one changes no odds on its
 * own: somebody has to switch it on in the editor and re-fit the chances to
 * 100%, and the publish refuses the wheel until they do — the same rule as
 * every other edit here, and the only safe answer for a wheel whose other
 * slices were re-weighted while this one was away.
 *
 * **Refused while its voucher type is archived** (409): a slice pointing at
 * an archived type could never be switched on and published, so bringing it
 * back would only move the refusal to a later screen. The message says which
 * type, and that it is restored on Voucher types first.
 *
 * One that is not archived answers with itself and records nothing, like
 * `archiveBoothPrize` and the voucher types' own restore: a double press is
 * the same request. A live slice of the same name is the unique index's to
 * refuse, with the name said.
 */
export async function restoreBoothPrize(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  row: BoothStationRow,
  before: PrizeRow,
): Promise<{ prize: PrizeRow }> {
  if (!before.archivedAt) return { prize: before };

  try {
    return await withTx(db, ctx, 'booth_prize.restore', async (tx) => {
      // Read inside the transaction, so an archive of the type committed a
      // moment ago is seen rather than raced.
      if (before.voucherDefinitionId) {
        const definition = await requireDefinition(tx, actor.operatorId, before.voucherDefinitionId);
        if (definition.archivedAt) {
          throw new AppError(
            409,
            'BOOTH_PRIZE_VOUCHER_ARCHIVED',
            `“${before.nameEn}” cannot come back yet: its voucher type “${definition.nameEn}” is archived. Restore that voucher type on Voucher types first, then this prize.`,
            { voucherDefinitionId: definition.id },
          );
        }
      }
      const restoredAt = new Date();
      await tx
        .update(boothPrize)
        .set({ archivedAt: null, active: false, updatedAt: restoredAt })
        .where(eq(boothPrize.id, before.id));
      const [prize] = await tx.select().from(boothPrize).where(eq(boothPrize.id, before.id)).limit(1);
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: row.operatorId,
        branchId: row.branchId,
        action: 'booth_prize.restore',
        entityType: 'booth_prize',
        entityId: before.id,
        before,
        after: prize,
        requestId: ctx.requestId,
      });
      return { prize: prize! };
    });
  } catch (err) {
    if (isUniqueViolation(err, 'booth_prize_name_unique')) {
      throw new AppError(
        409,
        'BOOTH_PRIZE_NAME_TAKEN',
        `This booth already has a live prize called “${before.nameEn}”. Rename or archive that one first — two slices with one name cannot be told apart on the wheel.`,
      );
    }
    throw err;
  }
}

/**
 * The slice order, set as a whole list rather than a field at a time.
 *
 * The order IS the wheel — `SpinResponse.prizeIndex` indexes the published
 * array — so the input has to name every live prize exactly once. A partial
 * list would leave two slices sharing a position, and which of them the
 * television drew would depend on the planner.
 */
export async function reorderBoothPrizes(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  row: BoothStationRow,
  prizeIds: string[],
): Promise<{ prizes: PrizeRow[] }> {
  return withTx(db, ctx, 'booth_prize.reorder', async (tx) => {
    const live = await tx
      .select({ id: boothPrize.id, sortOrder: boothPrize.sortOrder })
      .from(boothPrize)
      .where(and(eq(boothPrize.stationId, row.stationId), isNull(boothPrize.archivedAt)));
    const held = new Set(live.map((p) => p.id));
    const asked = new Set(prizeIds);
    if (asked.size !== prizeIds.length) {
      throw new AppError(400, 'BOOTH_ORDER_DUPLICATE', 'A prize appears twice in the order');
    }
    if (asked.size !== held.size || [...asked].some((id) => !held.has(id))) {
      throw new AppError(
        400,
        'BOOTH_ORDER_INCOMPLETE',
        `The order must name every live prize exactly once — this booth has ${held.size}.`,
      );
    }

    const now = new Date();
    for (const [index, id] of prizeIds.entries()) {
      await tx.update(boothPrize).set({ sortOrder: index, updatedAt: now }).where(eq(boothPrize.id, id));
    }
    const prizes = await tx
      .select()
      .from(boothPrize)
      .where(and(eq(boothPrize.stationId, row.stationId), isNull(boothPrize.archivedAt)))
      .orderBy(asc(boothPrize.sortOrder), asc(boothPrize.nameEn));
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: row.operatorId,
      branchId: row.branchId,
      action: 'booth_prize.reorder',
      entityType: 'station',
      entityId: row.stationId,
      before: { order: live.sort((a, b) => a.sortOrder - b.sortOrder).map((p) => p.id) },
      after: { order: prizeIds },
      requestId: ctx.requestId,
    });
    return { prizes };
  });
}

/** Load one LIVE prize of THIS booth, or 404. */
export async function loadBoothPrize(db: Db, stationId: string, prizeId: string): Promise<PrizeRow> {
  const prize = await loadBoothPrizeIncludingArchived(db, stationId, prizeId);
  if (prize.archivedAt) {
    throw new AppError(404, 'BOOTH_PRIZE_NOT_FOUND', 'No prize with that id on this booth');
  }
  return prize;
}

/**
 * The same lookup, except that a slice already off the wheel comes back
 * rather than 404ing.
 *
 * The archive route uses it for one reason: a second archive of the same
 * prize is the same request, and answering 404 to it tells a manager the
 * archive failed at the moment it had in fact just succeeded. A double press
 * or a retry after a dropped response arrives here with the row already
 * archived — see `archiveBoothPrize`, which returns it unchanged. The restore
 * route (SCRUM-468) uses it because an archived row is exactly what it is for.
 *
 * EDITING an archived slice is still refused: that is `loadBoothPrize`, and
 * the PATCH route keeps it. Restore it first.
 */
export async function loadBoothPrizeIncludingArchived(
  db: Db,
  stationId: string,
  prizeId: string,
): Promise<PrizeRow> {
  const [prize] = await db.select().from(boothPrize).where(eq(boothPrize.id, prizeId)).limit(1);
  if (!prize || prize.stationId !== stationId) {
    throw new AppError(404, 'BOOTH_PRIZE_NOT_FOUND', 'No prize with that id on this booth');
  }
  return prize;
}

function prizeConflict(err: unknown): unknown {
  if (isUniqueViolation(err, 'booth_prize_name_unique')) {
    return new AppError(
      409,
      'BOOTH_PRIZE_NAME_TAKEN',
      'This booth already has a live prize with that name — two slices with one name cannot be told apart on the wheel',
    );
  }
  return err;
}

// --- Voucher definitions ----------------------------------------------------
//
// Created, edited, archived and listed in `services/voucher-definitions.ts`
// since SCRUM-400, beside their own routes. What stays here is the one read a
// prize needs: that the definition it names is this operator's.

type DefinitionRow = typeof voucherDefinition.$inferSelect;

async function requireDefinition(exec: Exec, operatorId: string, id: string): Promise<DefinitionRow> {
  const [row] = await exec.select().from(voucherDefinition).where(eq(voucherDefinition.id, id)).limit(1);
  if (!row || row.operatorId !== operatorId) {
    throw new AppError(404, 'VOUCHER_DEFINITION_NOT_FOUND', 'No voucher definition with that id');
  }
  return row;
}

// --- Layouts ----------------------------------------------------------------

export interface LayoutInput {
  name: string;
  description?: string | null;
  design?: Record<string, unknown>;
  assetManifest?: Record<string, unknown>;
  active?: boolean;
}

export async function listBoothLayouts(
  db: Db,
  operatorId: string,
  includeArchived: boolean,
): Promise<{ layouts: LayoutRow[] }> {
  const layouts = await db
    .select()
    .from(boothLayout)
    .where(
      and(
        eq(boothLayout.operatorId, operatorId),
        includeArchived ? undefined : isNull(boothLayout.archivedAt),
      ),
    )
    .orderBy(asc(boothLayout.name));
  return { layouts };
}

export async function createBoothLayout(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  input: LayoutInput,
): Promise<{ layout: LayoutRow }> {
  const id = newId();
  try {
    return await withTx(db, ctx, 'booth_layout.create', async (tx) => {
      await tx.insert(boothLayout).values({
        id,
        operatorId: actor.operatorId,
        name: input.name,
        description: input.description ?? null,
        design: input.design ?? {},
        assetManifest: input.assetManifest ?? {},
        active: input.active ?? true,
      });
      const [layout] = await tx.select().from(boothLayout).where(eq(boothLayout.id, id)).limit(1);
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: actor.operatorId,
        action: 'booth_layout.create',
        entityType: 'booth_layout',
        entityId: id,
        after: layout,
        requestId: ctx.requestId,
      });
      return { layout: layout! };
    });
  } catch (err) {
    throw layoutConflict(err);
  }
}

/**
 * Edit a design.
 *
 * **`version` is bumped on every edit**, as the column says, and that is what
 * lets a published bundle name the design it took: a booth running version 4
 * of a wheel whose layout has since moved to version 5 is a fact somebody can
 * read, rather than two documents that look the same and are not.
 *
 * A layout is shared between booths, so editing one changes what every booth
 * using it WOULD publish — and changes nothing any of them is running until
 * each publishes. That is the point of the split, and it is why the audit row
 * carries the whole design rather than a diff.
 */
export async function updateBoothLayout(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  before: LayoutRow,
  patch: Partial<LayoutInput> & { archived?: boolean },
): Promise<{ layout: LayoutRow }> {
  try {
    return await withTx(db, ctx, 'booth_layout.update', async (tx) => {
      const set: Partial<typeof boothLayout.$inferInsert> = { updatedAt: new Date() };
      if (patch.name !== undefined) set.name = patch.name;
      if (patch.description !== undefined) set.description = patch.description;
      if (patch.design !== undefined) set.design = patch.design;
      if (patch.assetManifest !== undefined) set.assetManifest = patch.assetManifest;
      if (patch.active !== undefined) set.active = patch.active;
      if (patch.archived !== undefined) set.archivedAt = patch.archived ? new Date() : null;
      /** Only when the DESIGN moved: a rename is not a new wheel. */
      if (patch.design !== undefined || patch.assetManifest !== undefined) {
        set.version = before.version + 1;
      }
      await tx.update(boothLayout).set(set).where(eq(boothLayout.id, before.id));
      const [layout] = await tx.select().from(boothLayout).where(eq(boothLayout.id, before.id)).limit(1);
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: actor.operatorId,
        action: 'booth_layout.update',
        entityType: 'booth_layout',
        entityId: before.id,
        before,
        after: layout,
        requestId: ctx.requestId,
      });
      return { layout: layout! };
    });
  } catch (err) {
    throw layoutConflict(err);
  }
}

export async function loadBoothLayout(db: Db, operatorId: string, id: string): Promise<LayoutRow> {
  const [row] = await db.select().from(boothLayout).where(eq(boothLayout.id, id)).limit(1);
  if (!row || row.operatorId !== operatorId) {
    throw new AppError(404, 'BOOTH_LAYOUT_NOT_FOUND', 'No wheel layout with that id');
  }
  return row;
}

function layoutConflict(err: unknown): unknown {
  if (isUniqueViolation(err, 'booth_layout_name_unique')) {
    return new AppError(409, 'BOOTH_LAYOUT_NAME_TAKEN', 'A live layout already has that name');
  }
  return err;
}

// --- Branch staff ----------------------------------------------------------

/**
 * Whether this account is one of the staff of the branch the booth stands in
 * (M9, closing audit of 25 September 2026) — what a manual add to today's
 * roster is checked against (`addManualBoothDuty`).
 *
 * The same definition a till's staff list and the Console's person picker use
 * (`atBranch` in `lib/staff-scope.ts`): an employee record at the branch, a
 * role scoped to it, or an operator-wide administrator, and never a
 * deactivated account. The join to `employee` is required: the predicate
 * reads the employee's branch.
 *
 * The booth's standing staff list and its PINs went with booth sign-in
 * (SCRUM-694); their tables stay, retired, for older rows.
 */
export async function isBranchStaff(
  exec: Exec,
  operatorId: string,
  branchId: string,
  accountId: string,
): Promise<boolean> {
  const [row] = await exec
    .select({ id: account.id })
    .from(account)
    .leftJoin(employee, eq(account.employeeId, employee.id))
    .where(and(eq(account.id, accountId), eq(account.operatorId, operatorId), atBranch(branchId)))
    .limit(1);
  return row !== undefined;
}

export const BOOTH_TOTAL_WEIGHT_BP = TOTAL_WEIGHT_BP;

/** The canonical hash of a bundle document, for whoever needs to compare one. */
export const boothBundleHash = hashBundle;
