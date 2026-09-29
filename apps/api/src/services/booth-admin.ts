import { createHash, randomInt } from 'node:crypto';
import { hash as argonHash } from '@node-rs/argon2';
import { and, asc, count, desc, eq, inArray, isNull } from 'drizzle-orm';
import {
  account,
  boothConfigVersion,
  boothLayout,
  boothPrize,
  boothSettings,
  boothStaffAssignment,
  branch,
  credential,
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
  businessDate,
  newId,
  parseDayStart,
} from '@oto/shared';
import { AppError } from '../lib/errors';
import { pgErrorOf } from '../lib/scrub';
import { atBranch } from '../lib/staff-scope';
import { assertDominatesAccount, outOfBranchScope } from './access-control';
import { audit } from './audit';
import type { EffectivePermission } from './permissions';
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
  /** Null is the box's own twelve hours (`BOOTH_STAFF_SESSION_DEFAULT_MINUTES`). */
  staffSessionMinutes: null as number | null,
  spinDurationSeconds: BOOTH_SPIN_DURATION_DEFAULT_SECONDS,
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
      staffSessionMinutes:
        settingsRow?.staffSessionMinutes ?? SETTINGS_DEFAULTS.staffSessionMinutes,
      spinDurationSeconds: settingsRow?.spinDurationSeconds ?? SETTINGS_DEFAULTS.spinDurationSeconds,
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
    [d.titleEn, d.titleTh, d.instructionEn, d.instructionTh].some((w) => w !== null && w !== ''),
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
      /**
       * Only when the administrator set one (SCRUM-400). Absent is the box's
       * own twelve hours, and absent rather than null keeps the hash of every
       * booth nobody has set — the reason `@oto/shared` made it optional.
       */
      ...(draft.settings.staffSessionMinutes !== null
        ? { staffSessionMinutes: draft.settings.staffSessionMinutes }
        : {}),
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

export interface BoothDraftView {
  booth: { id: string; name: string; branchId: string; codePrefix: string | null };
  settings: {
    layoutId: string | null;
    layoutName: string | null;
    buttonKey: string;
    eligibility: BoothEligibilityMode;
    dailySpinCap: number | null;
    /** Minutes a staff sign-in lasts; null is the box's own twelve hours. */
    staffSessionMinutes: number | null;
    spinDurationSeconds: number;
  };
  prizes: Array<{
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
  }>;
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

export async function boothDraft(db: Db, row: BoothStationRow): Promise<BoothDraftView> {
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
      staffSessionMinutes: draft.settings.staffSessionMinutes,
      spinDurationSeconds: draft.settings.spinDurationSeconds,
    },
    prizes: draft.prizes.map((p) => {
      const definition = p.voucherDefinitionId ? draft.definitions.get(p.voucherDefinitionId) : undefined;
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
    }),
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
  /** Minutes, at most one trading day; null goes back to the box's twelve hours. */
  staffSessionMinutes?: number | null;
  spinDurationSeconds?: number;
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
    const [before] = await tx
      .select()
      .from(boothSettings)
      .where(eq(boothSettings.stationId, row.stationId))
      .limit(1);

    const next = {
      layoutId: patch.layoutId !== undefined ? patch.layoutId : (before?.layoutId ?? null),
      buttonKey: patch.buttonKey ?? before?.buttonKey ?? SETTINGS_DEFAULTS.buttonKey,
      eligibility: patch.eligibility ?? before?.eligibility ?? SETTINGS_DEFAULTS.eligibility,
      dailySpinCap:
        patch.dailySpinCap !== undefined ? patch.dailySpinCap : (before?.dailySpinCap ?? null),
      staffSessionMinutes:
        patch.staffSessionMinutes !== undefined
          ? patch.staffSessionMinutes
          : (before?.staffSessionMinutes ?? null),
      spinDurationSeconds:
        patch.spinDurationSeconds ?? before?.spinDurationSeconds ?? SETTINGS_DEFAULTS.spinDurationSeconds,
    };

    if (before) {
      await tx
        .update(boothSettings)
        .set({ ...next, updatedAt: new Date() })
        .where(eq(boothSettings.stationId, row.stationId));
    } else {
      await tx.insert(boothSettings).values({
        stationId: row.stationId,
        operatorId: row.operatorId,
        branchId: row.branchId,
        ...next,
      });
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
            staffSessionMinutes: before.staffSessionMinutes,
            spinDurationSeconds: before.spinDurationSeconds,
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
 * Only the archive route uses it, and for one reason: a second archive of the
 * same prize is the same request, and answering 404 to it tells a manager the
 * archive failed at the moment it had in fact just succeeded. The console
 * sends this DELETE without an idempotency key, so a double press or a retry
 * after a dropped response arrives here with the row already archived — see
 * `archiveBoothPrize`, which returns it unchanged.
 *
 * EDITING an archived slice is still refused: that is `loadBoothPrize`, and
 * the PATCH route keeps it.
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

// --- Who may work the booth, and what they type -----------------------------

export interface BoothStaffView {
  accountId: string;
  addedAt: string;
  addedBy: string;
  /**
   * Whether this person has a booth PIN on record — set and not withdrawn.
   * **Never the PIN and never its hash** — the question a manager asks is "can
   * they get in", and that is all this and the next field answer.
   */
  hasPin: boolean;
  /**
   * When that PIN stops working (migration 0027), ISO 8601; null when it
   * never does or there is no PIN. A PIN past it is still `hasPin` — nobody
   * withdrew it — and opens no booth: the Console shows it as expired.
   */
  pinExpiresAt: string | null;
}

export async function listBoothStaff(
  db: Db,
  stationId: string,
): Promise<{ staff: BoothStaffView[] }> {
  const rows = await db
    .select({
      accountId: boothStaffAssignment.accountId,
      addedAt: boothStaffAssignment.addedAt,
      addedBy: boothStaffAssignment.addedBy,
    })
    .from(boothStaffAssignment)
    .where(eq(boothStaffAssignment.stationId, stationId))
    .orderBy(asc(boothStaffAssignment.addedAt));
  if (rows.length === 0) return { staff: [] };

  const pins = await db
    .select({ accountId: credential.accountId, expiresAt: credential.expiresAt })
    .from(credential)
    .where(
      and(
        inArray(credential.accountId, rows.map((r) => r.accountId)),
        eq(credential.kind, 'pin'),
        eq(credential.active, true),
      ),
    );
  const held = new Map(pins.map((p) => [p.accountId, p.expiresAt] as const));
  return {
    staff: rows.map((r) => ({
      accountId: r.accountId,
      addedAt: r.addedAt.toISOString(),
      addedBy: r.addedBy,
      hasPin: held.has(r.accountId),
      pinExpiresAt: held.get(r.accountId)?.toISOString() ?? null,
    })),
  };
}

/** An account of this operator that could actually sign in, or 400/404. */
async function requireStaffAccount(exec: Exec, operatorId: string, accountId: string): Promise<void> {
  const [row] = await exec
    .select({ id: account.id, operatorId: account.operatorId, status: account.status })
    .from(account)
    .where(eq(account.id, accountId))
    .limit(1);
  if (!row || row.operatorId !== operatorId) {
    throw new AppError(404, 'ACCOUNT_NOT_FOUND', 'No account with that id');
  }
  if (row.status === 'inactive') {
    throw new AppError(
      400,
      'ACCOUNT_INACTIVE',
      'That account is deactivated, so it would be refused at the booth anyway',
    );
  }
}

/**
 * Whether this account is one of the staff of the branch the booth stands in
 * (M9, closing audit of 25 September 2026).
 *
 * The same definition a till's staff list and the Console's person picker use
 * (`atBranch` in `lib/staff-scope.ts`): an employee record at the branch, a
 * role scoped to it, or an operator-wide administrator, and never a
 * deactivated account. The join to `employee` is required: the predicate
 * reads the employee's branch.
 */
async function isBranchStaff(
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

/** Whether this account is on this booth's staff list. */
async function isOnBooth(exec: Exec, stationId: string, accountId: string): Promise<boolean> {
  const [assigned] = await exec
    .select({ id: boothStaffAssignment.id })
    .from(boothStaffAssignment)
    .where(
      and(eq(boothStaffAssignment.stationId, stationId), eq(boothStaffAssignment.accountId, accountId)),
    )
    .limit(1);
  return assigned !== undefined;
}

/**
 * The caller of a PIN write: who they are, and every grant they hold.
 *
 * The grants are here because the dominance rule reads them
 * (`assertDominatesAccount`), and only the route has resolved them
 * (`req.effectivePermissions()`).
 */
export interface BoothPinActor {
  accountId: string;
  operatorId: string;
  effective: EffectivePermission[];
}

/**
 * Whose booth PIN this caller may set or withdraw (M9).
 *
 * A PIN signs somebody in at a booth, where the spins, the reprints and the
 * "Printed by" line then carry their name, and it is the PERSON's — one live
 * PIN per account, so a change here changes it at every booth they work. So
 * setting or withdrawing one is an act on that person, and it is fenced the
 * way a temporary password is (`routes/accounts.ts`), in the same order:
 *
 *   1. **The person works at this booth's branch**, or 403
 *      `OUT_OF_BRANCH_SCOPE`. The route has already checked that the caller
 *      holds `admin:booth:staff_assign` at that branch, so this is "is the
 *      person yours". It is the check that holds for somebody with no role
 *      at all, for whom rule 2 has nothing to walk.
 *   2. **The caller holds every permission of every role the person holds**,
 *      at a scope that covers it, or 403 `ROLE_NOT_DOMINATED`. An
 *      operator-wide administrator counts as staff of every branch, so rule 1
 *      alone would let a branch manager give the owner a PIN the manager
 *      chose and then sign in at the booth as the owner.
 *
 * Before these, a branch manager could set or withdraw the PIN of anybody in
 * the operator, at any park, from his own booth.
 */
async function requirePinTarget(
  db: Db,
  actor: BoothPinActor,
  row: BoothStationRow,
  accountId: string,
): Promise<void> {
  if (!(await isBranchStaff(db, actor.operatorId, row.branchId, accountId))) {
    throw outOfBranchScope(
      'That account does not work at this booth’s branch, so its booth PIN cannot be set or withdrawn here',
    );
  }
  await assertDominatesAccount(db, actor.effective, actor.operatorId, accountId);
}

/**
 * Put somebody on this booth's staff list.
 *
 * **Only the staff of the booth's branch** (M9): the same rule a till's staff
 * list keeps, with the same refusal, 400 `STAFF_NOT_AT_BRANCH`
 * (`validateStationWrite` in `services/fleet.ts`). An operator administrator
 * is staff of every branch and can still be added. Before this, a branch
 * manager could put anybody in the operator on his booth by a hand-made call,
 * and so put their password hash on his booth's box: the box's `staff` cache
 * scope carries it for everybody on the list of one of its booths
 * (`services/sync.ts`).
 */
export async function addBoothStaff(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  row: BoothStationRow,
  accountId: string,
): Promise<{ staff: BoothStaffView[] }> {
  await requireStaffAccount(db, actor.operatorId, accountId);
  if (!(await isBranchStaff(db, actor.operatorId, row.branchId, accountId))) {
    throw new AppError(
      400,
      'STAFF_NOT_AT_BRANCH',
      'That account is not among this branch’s staff, so it cannot be put on this booth',
      { accountId },
    );
  }
  await withTx(db, ctx, 'booth_staff.add', async (tx) => {
    const added = await tx
      .insert(boothStaffAssignment)
      .values({ id: newId(), stationId: row.stationId, accountId, addedBy: actor.accountId })
      .onConflictDoNothing({
        target: [boothStaffAssignment.stationId, boothStaffAssignment.accountId],
      })
      .returning({ id: boothStaffAssignment.id });
    // Already on the list: no row, and no audit entry claiming a change.
    if (added.length === 0) return;
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: row.operatorId,
      branchId: row.branchId,
      action: 'booth_staff.add',
      entityType: 'booth_staff_assignment',
      entityId: added[0]!.id,
      after: { stationId: row.stationId, accountId },
      requestId: ctx.requestId,
    });
  });
  return listBoothStaff(db, row.stationId);
}

/**
 * Take somebody off this booth.
 *
 * A plain delete, as on `station_staff`: who was on the list and when is
 * carried by the audit row, which is where that question is asked from anyway.
 *
 * **Their PIN is not revoked by this.** A PIN belongs to the ACCOUNT — one
 * live PIN per person, `credential_active_kind_unique` — and somebody taken
 * off Booth 1 may still work Booth 2. What stops them at this booth is
 * `allowedStaff`, which rides beside the published bundle on the `booth`
 * cache scope (`sync-booth.ts`) rather than inside it — so it reaches the box
 * at its next pull, with no publish — and which the box checks before it
 * verifies anything; revoking the PIN as well is the separate act below, and
 * it comes FIRST: a PIN is withdrawn only through a booth whose list still
 * names the person (`clearBoothPin`).
 */
export async function removeBoothStaff(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  row: BoothStationRow,
  accountId: string,
): Promise<{ staff: BoothStaffView[] }> {
  await withTx(db, ctx, 'booth_staff.remove', async (tx) => {
    const gone = await tx
      .delete(boothStaffAssignment)
      .where(
        and(
          eq(boothStaffAssignment.stationId, row.stationId),
          eq(boothStaffAssignment.accountId, accountId),
        ),
      )
      .returning({ id: boothStaffAssignment.id });
    if (gone.length === 0) {
      throw new AppError(404, 'BOOTH_STAFF_NOT_FOUND', 'That account is not on this booth');
    }
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: row.operatorId,
      branchId: row.branchId,
      action: 'booth_staff.remove',
      entityType: 'booth_staff_assignment',
      entityId: gone[0]!.id,
      before: { stationId: row.stationId, accountId },
      requestId: ctx.requestId,
    });
  });
  return listBoothStaff(db, row.stationId);
}

/**
 * A booth PIN is EXACTLY five digits (owner, 28 September): typed at the api,
 * in the Console and on the box's number pad, and refused anywhere else with
 * the same sentence. A fixed length is what lets the box's pad know a PIN is
 * complete, and one fewer thing to get wrong at a wheel.
 */
export const BOOTH_PIN_LENGTH = 5;
const BOOTH_PIN_SHAPE = new RegExp(`^[0-9]{${BOOTH_PIN_LENGTH}}$`);
export const BOOTH_PIN_RULE = `A booth PIN is exactly ${BOOTH_PIN_LENGTH} digits (0–9).`;

export function isBoothPin(pin: string | null | undefined): pin is string {
  return typeof pin === 'string' && BOOTH_PIN_SHAPE.test(pin);
}

/**
 * Five digits drawn by the platform, from the operating system's secure
 * source. Every one of the hundred thousand is equally likely — leading zeros
 * included, which is why it is padded rather than drawn from 10000 upwards.
 */
function drawBoothPin(): string {
  return String(randomInt(0, 10 ** BOOTH_PIN_LENGTH)).padStart(BOOTH_PIN_LENGTH, '0');
}

/** What setting a PIN takes: one typed, or one drawn here — and when it ends. */
export interface BoothPinInput {
  /** Five digits typed by the administrator. Exactly one of this and `generate`. */
  pin?: string;
  /** Draw a random five-digit PIN here and hand it back once. */
  generate?: boolean;
  /** When it stops working. Null or absent: never. Must be in the future. */
  expiresAt?: Date | null;
}

export interface BoothPinSetResult {
  accountId: string;
  hasPin: true;
  pinExpiresAt: string | null;
  /**
   * The PIN the platform drew, present only when `generate` was asked for.
   * This answer is the only place it exists in clear: the row holds its
   * argon2id hash, the audit row says only that one was drawn, and the route
   * declares `secretResponse`, so the replay store never keeps this body.
   */
  pin?: string;
}

/**
 * Set somebody's booth PIN: five digits the administrator typed, or five the
 * platform draws and hands back once (`generate`), with an optional moment it
 * stops working (`expiresAt`, migration 0027).
 *
 * **Three rules, and each of them is about where the five digits go.**
 *
 *   - **Never onto the box command queue.** `edge.box_command.payload` is
 *     stored and rendered on a Console screen, which is why S2-07a left badge
 *     and PIN out of the simulator panel. The PIN reaches a booth only as an
 *     argon2id hash on the `staff` cache scope, which is the same path the
 *     password hash already takes.
 *   - **Never into the idempotency store.** That store keeps a request hash
 *     for a day, and a plain SHA-256 over a body holding five digits is a
 *     hundred thousand guesses. The route declares `secretResponse: true` so
 *     no key is claimed, no hash of this body is ever written, and the answer
 *     that carries a drawn PIN is never kept to be replayed.
 *   - **Never in the audit row.** The row says a PIN was set, by whom, for
 *     whom, whether the platform drew it and when it expires. Not what it is,
 *     and not its hash.
 *
 * The PIN is the ACCOUNT's, not this booth's: `credential_active_kind_unique`
 * allows one live `pin` per person, so setting a new one revokes the old in
 * the same transaction and the person types the same digits at every booth
 * they are allowed to work. That is why who may set it is decided about the
 * person, not the booth (`requirePinTarget`, M9): they must work at this
 * booth's branch, and the caller must hold every role they hold.
 */
export async function setBoothPin(
  db: Db,
  ctx: OpContext,
  actor: BoothPinActor,
  row: BoothStationRow,
  accountId: string,
  input: BoothPinInput,
): Promise<BoothPinSetResult> {
  const generated = input.generate === true;
  if (generated === (input.pin !== undefined)) {
    throw new AppError(
      400,
      'BOOTH_PIN_INPUT',
      'Type a five-digit PIN, or ask for one to be generated — one of the two.',
    );
  }
  if (!generated && !isBoothPin(input.pin)) {
    throw new AppError(400, 'BOOTH_PIN_INVALID', BOOTH_PIN_RULE);
  }
  const expiresAt = input.expiresAt ?? null;
  if (expiresAt && expiresAt.getTime() <= Date.now()) {
    throw new AppError(
      400,
      'BOOTH_PIN_EXPIRY_PAST',
      'A PIN’s expiry has to be in the future. Leave it empty for a PIN that does not expire.',
    );
  }
  await requireStaffAccount(db, actor.operatorId, accountId);
  await requirePinTarget(db, actor, row, accountId);
  if (!(await isOnBooth(db, row.stationId, accountId))) {
    throw new AppError(
      400,
      'BOOTH_STAFF_NOT_FOUND',
      'That account is not on this booth. Add them to the booth before giving them a PIN.',
    );
  }

  const pin = generated ? drawBoothPin() : input.pin!;
  const secretHash = await argonHash(pin);
  await withTx(db, ctx, 'booth_pin.set', async (tx) => {
    const now = new Date();
    // One live PIN per person: the old one is revoked, not replaced in place,
    // so "this person's PIN was changed on the 3rd" stays on the record.
    await tx
      .update(credential)
      .set({ active: false, revokedAt: now, revokedReason: 'replaced', updatedAt: now })
      .where(
        and(eq(credential.accountId, accountId), eq(credential.kind, 'pin'), eq(credential.active, true)),
      );
    const id = newId();
    await tx.insert(credential).values({
      id,
      operatorId: actor.operatorId,
      accountId,
      kind: 'pin',
      secretHash,
      label: `Booth PIN (${row.name})`,
      createdByAccountId: actor.accountId,
      expiresAt,
    });
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: row.operatorId,
      branchId: row.branchId,
      action: 'booth_pin.set',
      entityType: 'credential',
      entityId: id,
      // The fact, never the secret and never its hash — "drawn by the
      // platform" is said, the digits it drew are not.
      after: {
        accountId,
        kind: 'pin',
        stationId: row.stationId,
        generated,
        expiresAt: expiresAt?.toISOString() ?? null,
      },
      requestId: ctx.requestId,
    });
  });
  return {
    accountId,
    hasPin: true,
    pinExpiresAt: expiresAt?.toISOString() ?? null,
    ...(generated ? { pin } : {}),
  };
}

/**
 * Withdraw a booth PIN.
 *
 * `active = false` with a reason, never a delete: "this person's PIN was
 * withdrawn on the 3rd" is the fact an investigation needs.
 *
 * **What it does NOT do is reach the booth.** A box holds the cached staff
 * list until its next pull, and the withdrawal takes effect at the booth only
 * then: about a minute on a running box, whose agent pulls its cache on a
 * timer and on the Apply config command (SCRUM-275), and however long it
 * stays offline otherwise — an offline box cannot be told anything, which is
 * the price of a booth that keeps working without internet. The deny-list has
 * the same window, for the same reason.
 *
 * **Who may withdraw it (M9)** is decided as for setting one
 * (`requirePinTarget`), and the person must also be on THIS booth's list:
 * the PIN is withdrawn at every booth at once, and before this a branch
 * manager could withdraw a colleague's PIN at another park through his own
 * booth without that colleague being on it. Withdraw before taking somebody
 * off a booth. The PIN of somebody already off every booth's list cannot be
 * withdrawn here, and it opens no booth: a box tries a PIN only against its
 * own booth's list, so once each box has pulled that list the PIN does
 * nothing until the person is put on a booth again, when it can be withdrawn.
 */
export async function clearBoothPin(
  db: Db,
  ctx: OpContext,
  actor: BoothPinActor,
  row: BoothStationRow,
  accountId: string,
  reason: string | null,
): Promise<{ accountId: string; hasPin: false }> {
  await requireStaffAccount(db, actor.operatorId, accountId);
  await requirePinTarget(db, actor, row, accountId);
  if (!(await isOnBooth(db, row.stationId, accountId))) {
    throw new AppError(
      400,
      'BOOTH_STAFF_NOT_FOUND',
      'That account is not on this booth, so its booth PIN cannot be withdrawn here. Withdraw it from a booth they are on.',
    );
  }
  await withTx(db, ctx, 'booth_pin.revoke', async (tx) => {
    const now = new Date();
    const revoked = await tx
      .update(credential)
      .set({ active: false, revokedAt: now, revokedReason: reason ?? 'withdrawn', updatedAt: now })
      .where(
        and(eq(credential.accountId, accountId), eq(credential.kind, 'pin'), eq(credential.active, true)),
      )
      .returning({ id: credential.id });
    if (revoked.length === 0) {
      throw new AppError(404, 'BOOTH_PIN_NOT_SET', 'That account has no booth PIN');
    }
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: row.operatorId,
      branchId: row.branchId,
      action: 'booth_pin.revoke',
      entityType: 'credential',
      entityId: revoked[0]!.id,
      after: { accountId, kind: 'pin', stationId: row.stationId, reason: reason ?? 'withdrawn' },
      requestId: ctx.requestId,
    });
  });
  return { accountId, hasPin: false };
}

/** A PIN a box may verify: its argon2id hash, and when it stops working. */
export interface LiveBoothPin {
  secretHash: string;
  /** Null never expires. */
  expiresAt: Date | null;
}

/**
 * The live PINs of a set of accounts, for the `staff` cache scope.
 *
 * Exported because the scope is built in `services/sync.ts` and the query
 * belongs beside the table it is about. Returns argon2id hashes and their
 * expiry and nothing else — the same class of secret that scope already
 * carries in `passwordHash`, and the reason `BoothStaffCacheFields.pinHash` in
 * `@oto/shared` exists.
 *
 * Active PINs include their expiry even after it passes, so the box can
 * explain an expired PIN consistently before and after a cache pull.
 */
export async function livePinsByAccount(
  db: Db,
  accountIds: string[],
): Promise<Map<string, LiveBoothPin>> {
  if (accountIds.length === 0) return new Map();
  const rows = await db
    .select({
      accountId: credential.accountId,
      secretHash: credential.secretHash,
      expiresAt: credential.expiresAt,
    })
    .from(credential)
    .where(
      and(
        inArray(credential.accountId, accountIds),
        eq(credential.kind, 'pin'),
        eq(credential.active, true),
      ),
    );
  return new Map(
    rows.map((r) => [r.accountId, { secretHash: r.secretHash, expiresAt: r.expiresAt }] as const),
  );
}

/** The total the active slices must add up to, for the routes' descriptions. */
export const BOOTH_TOTAL_WEIGHT_BP = TOTAL_WEIGHT_BP;

/** The canonical hash of a bundle document, for whoever needs to compare one. */
export const boothBundleHash = hashBundle;
