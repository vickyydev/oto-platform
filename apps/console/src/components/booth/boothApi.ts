/**
 * Booth management: what the Console asks the API for, and what it gets back.
 *
 * WHY IT IS HERE AND NOT IN `src/api/`. The same reason `simulatorApi.ts` sits
 * beside the panel that sends it: this is one page's surface, and keeping it
 * next to the page means one place to retarget a path.
 *
 * **Every shape below is copied from the API, not guessed at.** The routes are
 * `apps/api/src/routes/booth.ts` and the types are `BoothDraftView`,
 * `BoothListItem`, `PublishBlocker` and friends in
 * `apps/api/src/services/booth-admin.ts`. They are restated rather than
 * imported because the console does not depend on the api app and should not
 * start doing so for six interfaces — so when a field is added there, it is
 * added here, and a field that is quietly renamed shows up as a type error on
 * the first read of this file rather than as an undefined on a screen.
 *
 * Two shapes are deliberately NOT restated. `bundle` is left `unknown`: it is
 * the document the box applies whole, the api serves it unvalidated on
 * purpose so a newer box's field is not stripped in transit, and a console
 * that parsed it into a narrower type would be the one place that silently
 * drops what it does not recognise. And a blocker's `code` is a plain string
 * rather than a union, because the list of refusals is the API's to grow and a
 * console that type-errored on a new one would be a console that cannot be
 * told about a new way to be wrong.
 */
import { api, ApiError, idemKey, isMissingRoute } from '@/api/client';
import type { BoothEligibilityMode } from '@oto/shared';

export { isMissingRoute, ApiError };

// ---------------------------------------------------------------------------
// The booth list — asked per branch, like every other branch-scoped resource
// ---------------------------------------------------------------------------

/** `BoothListItem`. The live tiles are a separate read: `status` below. */
export interface BoothListRow {
  /** `core.station.id`. The booth IS a station; there is no second identity. */
  id: string;
  name: string;
  branchId: string;
  boxId: string | null;
  eligibility: BoothEligibilityMode;
  layoutName: string | null;
  /**
   * The newest version anybody has published here. Null means nobody has —
   * a television showing "Booth not set up, connect to internet" — which the
   * page names rather than drawing as a zero.
   */
  publishedVersion: number | null;
  publishedAt: string | null;
  activePrizes: number;
}

// ---------------------------------------------------------------------------
// One booth's live status (S2-07a — the route this page has always had)
// ---------------------------------------------------------------------------

export interface BoothStatus {
  booth: { id: string; name: string; operatorId: string; branchId: string };
  box: {
    id: string | null;
    slot: string | null;
    status: string | null;
    lastHeartbeatAt: string | null;
    /** A heartbeat inside the watchdog's silence window, measured when read. */
    online: boolean;
    inProcess: boolean;
  };
  config: {
    publishedVersion: number | null;
    publishedAt: string | null;
    /**
     * What the box last said it is running. **Null also means "not
     * reported"**, so a null here is not evidence the booth is running
     * nothing.
     */
    runningVersion: number | null;
  };
  printer: {
    deviceId: string;
    label: string | null;
    reachability: string;
    paperStatus: string;
    lastError: string | null;
    lastSeenAt: string | null;
  } | null;
  today: {
    businessDate: string;
    spins: number;
    unattributed: number;
    /** `booth.booth_prize.id` of the prizes that have hit their cap today. */
    dailyCapsReached: string[];
  };
  lastSpinAt: string | null;
}

// ---------------------------------------------------------------------------
// The draft — what would be published if somebody pressed Publish now
// ---------------------------------------------------------------------------

export interface BoothPrizeDraft {
  id: string;
  nameEn: string;
  nameTh: string | null;
  wheelLabel: string | null;
  /** Basis points. The active prizes must sum to 10,000 (D4). */
  weightBp: number;
  active: boolean;
  expiryDays: number | null;
  dailyCap: number | null;
  costSatang: number;
  sliceColor: string | null;
  textColor: string | null;
  sortOrder: number;
  voucherDefinitionId: string | null;
  /** The definition's own slug, so a row can say what a win produces. */
  voucherDefinitionCode: string | null;
  /** The prize's expiry, or the definition's where the prize sets none. */
  effectiveExpiryDays: number | null;
}

export interface BoothSettingsDraft {
  layoutId: string | null;
  layoutName: string | null;
  buttonKey: string;
  eligibility: BoothEligibilityMode;
  dailySpinCap: number | null;
}

/** What the API will refuse a publish for, with the field to put it against. */
export interface PublishBlocker {
  /** `prizes[<name>].weightBp`, `settings.layoutId`, and so on. */
  field: string;
  code: string;
  message: string;
}

export interface BoothVersionRow {
  id: string;
  version: number;
  publishedAt: string;
  bundleHash: string;
  note: string | null;
  publishedByAccountId: string | null;
}

/** `BoothDraftView`. One read: the settings, the slices, and every refusal. */
export interface BoothDraft {
  booth: { id: string; name: string; branchId: string };
  settings: BoothSettingsDraft;
  /** In slice order — `sortOrder`, then name, which is what a publish freezes. */
  prizes: BoothPrizeDraft[];
  /** Exactly what publishing would mint. Left unparsed; see the file note. */
  bundle: unknown;
  /**
   * The hash of that document, and the guard against publishing over somebody
   * else's edit: it goes back with the publish as `expectedBundleHash`.
   */
  bundleHash: string | null;
  published: BoothVersionRow | null;
  /** Whether the draft differs from the published wheel at all. */
  changed: boolean;
  /** The newest edit to anything in the bundle — a colleague's included. */
  lastEditedAt: string | null;
  /** Empty means this draft can be published as it stands. */
  blockers: PublishBlocker[];
}

export interface BoothLayoutRow {
  id: string;
  name: string;
  description: string | null;
  version: number;
  active: boolean;
  archivedAt: string | null;
}

export interface VoucherDefinitionRow {
  id: string;
  code: string;
  nameEn: string;
  nameTh: string | null;
  kind: string;
  valueType: string;
  valueSatang: number | null;
  valueBp: number | null;
  expiryDays: number | null;
  costSatang: number;
  active: boolean;
}

/** What a prize create or edit sends. Every field but the name is optional. */
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

export interface PublishResult {
  version: BoothVersionRow;
  prizes: number;
  activePrizes: number;
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

const at = (id: string) => `/booths/${encodeURIComponent(id)}`;

/**
 * Every write carries a fresh idempotency key, minted where the person pressed
 * the button — the platform's rule for all mutations, and what makes a double
 * press on Publish one version rather than two.
 */
export const boothApi = {
  /** Branch-nested, like every branch-scoped resource: the guard needs it in the path. */
  list: (branchId: string) =>
    api.get<{ booths: BoothListRow[] }>(`/branches/${encodeURIComponent(branchId)}/booths`),

  status: (id: string) => api.get<BoothStatus>(`${at(id)}/status`),

  draft: (id: string) => api.get<BoothDraft>(`${at(id)}/draft`),

  versions: (id: string) => api.get<{ versions: BoothVersionRow[] }>(`${at(id)}/versions`),

  layouts: () => api.get<{ layouts: BoothLayoutRow[] }>('/booth-layouts'),

  voucherDefinitions: () =>
    api.get<{ definitions: VoucherDefinitionRow[] }>('/voucher-definitions'),

  saveSettings: (id: string, settings: Partial<Omit<BoothSettingsDraft, 'layoutName'>>) =>
    api.patch<unknown>(`${at(id)}/settings`, settings, { idempotencyKey: idemKey() }),

  createPrize: (id: string, prize: PrizeInput) =>
    api.post<BoothPrizeDraft>(`${at(id)}/prizes`, prize, { idempotencyKey: idemKey() }),

  savePrize: (id: string, prizeId: string, prize: Partial<PrizeInput>) =>
    api.patch<BoothPrizeDraft>(`${at(id)}/prizes/${encodeURIComponent(prizeId)}`, prize, {
      idempotencyKey: idemKey(),
    }),

  /**
   * Archives the slice; it is not deleted. Every spin that ever won it points
   * at the row, and the platform does not hard-delete business records — so
   * this takes the prize off the wheel at the next publish and leaves last
   * month's report able to name what somebody won.
   */
  archivePrize: (id: string, prizeId: string) =>
    api.delete<unknown>(`${at(id)}/prizes/${encodeURIComponent(prizeId)}`),

  /**
   * Freeze the draft as version N+1.
   *
   * `expectedBundleHash` is the draft hash this screen was showing. If a
   * colleague has edited a weight since it was read, the API refuses instead
   * of publishing a wheel nobody reviewed — which is the whole point of the
   * confirmation, and it would be worthless without this field.
   */
  publish: (id: string, body: { note?: string | null; expectedBundleHash?: string }) =>
    api.post<PublishResult>(`${at(id)}/publish`, body, { idempotencyKey: idemKey() }),
};
