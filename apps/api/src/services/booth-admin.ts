import { createHash } from 'node:crypto';
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
  spin,
  station,
  voucherDefinition,
  type BoothEligibilityMode,
  type Db,
  type VoucherKind,
  type VoucherOfflinePolicy,
  type VoucherValueType,
} from '@oto/db';
import { BOOTH_BUNDLE_SCHEMA_VERSION, businessDate, newId, parseDayStart } from '@oto/shared';
import { AppError } from '../lib/errors';
import { pgErrorOf } from '../lib/scrub';
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
};

export interface BoothDraft {
  settings: typeof SETTINGS_DEFAULTS & { updatedAt: Date | null };
  layout: LayoutRow | null;
  prizes: PrizeRow[];
  /** Keyed by `voucher_definition.id`, for the prizes this draft points at. */
  definitions: Map<string, typeof voucherDefinition.$inferSelect>;
}

/** Everything a publish reads, in one place, so validation and minting agree. */
async function loadDraft(exec: Exec, row: BoothStationRow): Promise<BoothDraft> {
  const [settingsRow] = await exec
    .select()
    .from(boothSettings)
    .where(eq(boothSettings.stationId, row.stationId))
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
      updatedAt: settingsRow?.updatedAt ?? null,
    },
    layout,
    prizes,
    definitions: new Map(definitions.map((d) => [d.id, d])),
  };
}

function isNonNull<T>(value: T | null): value is T {
  return value !== null;
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
  return {
    schemaVersion: BOOTH_BUNDLE_SCHEMA_VERSION,
    settings: {
      eligibility: draft.settings.eligibility,
      buttonKey: draft.settings.buttonKey,
      dailySpinCap: draft.settings.dailySpinCap,
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
  };
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
     * A prize whose expiry nobody set.
     *
     * The definition's null means "never expires", which is a real and
     * deliberate value for the legacy Radar codes the park still honours — but
     * a booth prize printed today with no expiry is a liability with no end
     * date, and the specification asks for an expiry per prize. So the prize
     * resolves one from itself or from its definition, and publishing without
     * one is refused rather than defaulted.
     */
    if ((prize.expiryDays ?? definition.expiryDays) === null) {
      blockers.push({
        field: `prizes[${prize.nameEn}].expiryDays`,
        code: 'BOOTH_PRIZE_NO_EXPIRY',
        message: `"${prize.nameEn}" has no expiry, and neither does the voucher "${definition.code}". Set one before publishing.`,
      });
    }
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
  booth: { id: string; name: string; branchId: string };
  settings: {
    layoutId: string | null;
    layoutName: string | null;
    buttonKey: string;
    eligibility: BoothEligibilityMode;
    dailySpinCap: number | null;
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

  const edits = [
    draft.settings.updatedAt,
    draft.layout?.updatedAt ?? null,
    ...draft.prizes.map((p) => p.updatedAt),
  ].filter(isNonNull);
  const lastEditedAt = edits.length
    ? new Date(Math.max(...edits.map((d) => d.getTime()))).toISOString()
    : null;

  return {
    booth: { id: row.stationId, name: row.name, branchId: row.branchId },
    settings: {
      layoutId: draft.settings.layoutId,
      layoutName: draft.layout?.name ?? null,
      buttonKey: draft.settings.buttonKey,
      eligibility: draft.settings.eligibility,
      dailySpinCap: draft.settings.dailySpinCap,
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

/** Load one prize of THIS booth, or 404. */
export async function loadBoothPrize(db: Db, stationId: string, prizeId: string): Promise<PrizeRow> {
  const [prize] = await db.select().from(boothPrize).where(eq(boothPrize.id, prizeId)).limit(1);
  if (!prize || prize.stationId !== stationId || prize.archivedAt) {
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

export interface VoucherDefinitionInput {
  code: string;
  nameEn: string;
  nameTh?: string | null;
  kind: VoucherKind;
  valueType?: VoucherValueType;
  valueSatang?: number | null;
  valueBp?: number | null;
  expiryDays?: number | null;
  offlinePolicy?: VoucherOfflinePolicy;
  singleUse?: boolean;
  costSatang?: number;
  termsEn?: string | null;
  termsTh?: string | null;
  active?: boolean;
}

type DefinitionRow = typeof voucherDefinition.$inferSelect;

/**
 * What a win is worth must actually be filled in.
 *
 * The column CHECKs allow a `percent` definition with no percentage in it —
 * they can only look at one column at a time — and a definition like that
 * prints a voucher whose value is blank. These are the cross-field rules the
 * database cannot state.
 */
function checkDefinitionValue(kind: VoucherKind, input: Partial<VoucherDefinitionInput>, row?: DefinitionRow): void {
  const valueType = input.valueType ?? row?.valueType ?? 'none';
  const valueSatang = input.valueSatang !== undefined ? input.valueSatang : (row?.valueSatang ?? null);
  const valueBp = input.valueBp !== undefined ? input.valueBp : (row?.valueBp ?? null);
  if (valueType === 'amount' && valueSatang === null) {
    throw new AppError(400, 'VOUCHER_VALUE_MISSING', 'A voucher worth an amount needs `valueSatang`');
  }
  if (valueType === 'percent' && valueBp === null) {
    throw new AppError(400, 'VOUCHER_VALUE_MISSING', 'A percentage voucher needs `valueBp` in basis points');
  }
  if (kind === 'wallet_credit' && valueSatang === null) {
    throw new AppError(400, 'VOUCHER_VALUE_MISSING', 'A wallet credit needs `valueSatang`');
  }
}

export async function listVoucherDefinitions(
  db: Db,
  operatorId: string,
  includeArchived: boolean,
): Promise<{ definitions: DefinitionRow[] }> {
  const definitions = await db
    .select()
    .from(voucherDefinition)
    .where(
      and(
        eq(voucherDefinition.operatorId, operatorId),
        includeArchived ? undefined : isNull(voucherDefinition.archivedAt),
      ),
    )
    .orderBy(asc(voucherDefinition.code));
  return { definitions };
}

export async function createVoucherDefinition(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  input: VoucherDefinitionInput,
): Promise<{ definition: DefinitionRow }> {
  checkDefinitionValue(input.kind, input);
  const id = newId();
  try {
    return await withTx(db, ctx, 'voucher_definition.create', async (tx) => {
      await tx.insert(voucherDefinition).values({
        id,
        operatorId: actor.operatorId,
        code: input.code,
        nameEn: input.nameEn,
        nameTh: input.nameTh ?? null,
        kind: input.kind,
        valueType: input.valueType ?? 'none',
        valueSatang: input.valueSatang ?? null,
        valueBp: input.valueBp ?? null,
        expiryDays: input.expiryDays ?? null,
        offlinePolicy: input.offlinePolicy ?? 'allow',
        singleUse: input.singleUse ?? true,
        costSatang: input.costSatang ?? 0,
        termsEn: input.termsEn ?? null,
        termsTh: input.termsTh ?? null,
        active: input.active ?? true,
      });
      const [definition] = await tx
        .select()
        .from(voucherDefinition)
        .where(eq(voucherDefinition.id, id))
        .limit(1);
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: actor.operatorId,
        action: 'voucher_definition.create',
        entityType: 'voucher_definition',
        entityId: id,
        after: definition,
        requestId: ctx.requestId,
      });
      return { definition: definition! };
    });
  } catch (err) {
    throw definitionConflict(err);
  }
}

export async function updateVoucherDefinition(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  before: DefinitionRow,
  patch: Partial<VoucherDefinitionInput>,
): Promise<{ definition: DefinitionRow }> {
  checkDefinitionValue(patch.kind ?? before.kind, patch, before);
  try {
    return await withTx(db, ctx, 'voucher_definition.update', async (tx) => {
      const set: Partial<typeof voucherDefinition.$inferInsert> = { updatedAt: new Date() };
      if (patch.code !== undefined) set.code = patch.code;
      if (patch.nameEn !== undefined) set.nameEn = patch.nameEn;
      if (patch.nameTh !== undefined) set.nameTh = patch.nameTh;
      if (patch.kind !== undefined) set.kind = patch.kind;
      if (patch.valueType !== undefined) set.valueType = patch.valueType;
      if (patch.valueSatang !== undefined) set.valueSatang = patch.valueSatang;
      if (patch.valueBp !== undefined) set.valueBp = patch.valueBp;
      if (patch.expiryDays !== undefined) set.expiryDays = patch.expiryDays;
      if (patch.offlinePolicy !== undefined) set.offlinePolicy = patch.offlinePolicy;
      if (patch.singleUse !== undefined) set.singleUse = patch.singleUse;
      if (patch.costSatang !== undefined) set.costSatang = patch.costSatang;
      if (patch.termsEn !== undefined) set.termsEn = patch.termsEn;
      if (patch.termsTh !== undefined) set.termsTh = patch.termsTh;
      if (patch.active !== undefined) set.active = patch.active;
      await tx.update(voucherDefinition).set(set).where(eq(voucherDefinition.id, before.id));
      const [definition] = await tx
        .select()
        .from(voucherDefinition)
        .where(eq(voucherDefinition.id, before.id))
        .limit(1);
      await audit.record(tx, {
        actorAccountId: actor.accountId,
        operatorId: actor.operatorId,
        action: 'voucher_definition.update',
        entityType: 'voucher_definition',
        entityId: before.id,
        before,
        after: definition,
        requestId: ctx.requestId,
      });
      return { definition: definition! };
    });
  } catch (err) {
    throw definitionConflict(err);
  }
}

export async function loadVoucherDefinition(
  db: Db,
  operatorId: string,
  id: string,
): Promise<DefinitionRow> {
  const [row] = await db.select().from(voucherDefinition).where(eq(voucherDefinition.id, id)).limit(1);
  if (!row || row.operatorId !== operatorId) {
    throw new AppError(404, 'VOUCHER_DEFINITION_NOT_FOUND', 'No voucher definition with that id');
  }
  return row;
}

async function requireDefinition(exec: Exec, operatorId: string, id: string): Promise<DefinitionRow> {
  const [row] = await exec.select().from(voucherDefinition).where(eq(voucherDefinition.id, id)).limit(1);
  if (!row || row.operatorId !== operatorId) {
    throw new AppError(404, 'VOUCHER_DEFINITION_NOT_FOUND', 'No voucher definition with that id');
  }
  return row;
}

function definitionConflict(err: unknown): unknown {
  if (isUniqueViolation(err, 'voucher_definition_code_unique')) {
    return new AppError(
      409,
      'VOUCHER_DEFINITION_CODE_TAKEN',
      'That voucher code is already used by another definition — codes are how imports and reports name one',
    );
  }
  return err;
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
   * Whether this person has a live booth PIN. **Never the PIN and never its
   * hash** — the question a manager asks is "can they get in", and that is all
   * this answers.
   */
  hasPin: boolean;
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
    .select({ accountId: credential.accountId })
    .from(credential)
    .where(
      and(
        inArray(credential.accountId, rows.map((r) => r.accountId)),
        eq(credential.kind, 'pin'),
        eq(credential.active, true),
      ),
    );
  const held = new Set(pins.map((p) => p.accountId));
  return {
    staff: rows.map((r) => ({
      accountId: r.accountId,
      addedAt: r.addedAt.toISOString(),
      addedBy: r.addedBy,
      hasPin: held.has(r.accountId),
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

export async function addBoothStaff(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  row: BoothStationRow,
  accountId: string,
): Promise<{ staff: BoothStaffView[] }> {
  await requireStaffAccount(db, actor.operatorId, accountId);
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
 * `allowedStaff` in the published bundle, which the box checks before it
 * verifies anything; revoking the PIN as well is the separate act below.
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
 * Set somebody's booth PIN.
 *
 * **Three rules, and each of them is about where the four digits go.**
 *
 *   - **Never onto the box command queue.** `edge.box_command.payload` is
 *     stored and rendered on a Console screen, which is why S2-07a left badge
 *     and PIN out of the simulator panel. The PIN reaches a booth only as an
 *     argon2id hash on the `staff` cache scope, which is the same path the
 *     password hash already takes.
 *   - **Never into the idempotency store.** That store keeps a request hash
 *     for a day, and a plain SHA-256 over a body holding four digits is ten
 *     thousand guesses. The route declares `secretResponse: true` so no key is
 *     claimed and no hash of this body is ever written.
 *   - **Never in the audit row.** The row says a PIN was set, by whom, for
 *     whom. Not what it is, and not its hash.
 *
 * The PIN is the ACCOUNT's, not this booth's: `credential_active_kind_unique`
 * allows one live `pin` per person, so setting a new one revokes the old in
 * the same transaction and the person types the same digits at every booth
 * they are allowed to work.
 */
export async function setBoothPin(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  row: BoothStationRow,
  accountId: string,
  pin: string,
): Promise<{ accountId: string; hasPin: true }> {
  await requireStaffAccount(db, actor.operatorId, accountId);
  const [assigned] = await db
    .select({ id: boothStaffAssignment.id })
    .from(boothStaffAssignment)
    .where(
      and(
        eq(boothStaffAssignment.stationId, row.stationId),
        eq(boothStaffAssignment.accountId, accountId),
      ),
    )
    .limit(1);
  if (!assigned) {
    throw new AppError(
      400,
      'BOOTH_STAFF_NOT_FOUND',
      'That account is not on this booth. Add them to the booth before giving them a PIN.',
    );
  }

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
    });
    await audit.record(tx, {
      actorAccountId: actor.accountId,
      operatorId: row.operatorId,
      branchId: row.branchId,
      action: 'booth_pin.set',
      entityType: 'credential',
      entityId: id,
      // The fact, never the secret and never its hash.
      after: { accountId, kind: 'pin', stationId: row.stationId },
      requestId: ctx.requestId,
    });
  });
  return { accountId, hasPin: true };
}

/**
 * Withdraw a booth PIN.
 *
 * `active = false` with a reason, never a delete: "this person's PIN was
 * withdrawn on the 3rd" is the fact an investigation needs.
 *
 * **What it does NOT do is reach the booth.** A box holds the cached staff
 * list until its next pull, so the withdrawal takes effect at the booth when
 * the box next syncs — minutes online, and however long it stays offline
 * otherwise. That is a property of a booth that keeps working without
 * internet, not a defect, and it is the same window the deny-list has.
 */
export async function clearBoothPin(
  db: Db,
  ctx: OpContext,
  actor: { accountId: string; operatorId: string },
  row: BoothStationRow,
  accountId: string,
  reason: string | null,
): Promise<{ accountId: string; hasPin: false }> {
  await requireStaffAccount(db, actor.operatorId, accountId);
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

/**
 * The live PIN hashes for a set of accounts, for the `staff` cache scope.
 *
 * Exported because the scope is built in `services/sync.ts` and the query
 * belongs beside the table it is about. Returns argon2id hashes and nothing
 * else — the same class of secret that scope already carries in
 * `passwordHash`, and the reason `BoothStaffCacheFields.pinHash` in
 * `@oto/shared` exists.
 */
export async function pinHashesByAccount(
  db: Db,
  accountIds: string[],
): Promise<Map<string, string>> {
  if (accountIds.length === 0) return new Map();
  const rows = await db
    .select({ accountId: credential.accountId, secretHash: credential.secretHash })
    .from(credential)
    .where(
      and(
        inArray(credential.accountId, accountIds),
        eq(credential.kind, 'pin'),
        eq(credential.active, true),
      ),
    );
  return new Map(rows.map((r) => [r.accountId, r.secretHash]));
}

/** The total the active slices must add up to, for the routes' descriptions. */
export const BOOTH_TOTAL_WEIGHT_BP = TOTAL_WEIGHT_BP;

/** The canonical hash of a bundle document, for whoever needs to compare one. */
export const boothBundleHash = hashBundle;
