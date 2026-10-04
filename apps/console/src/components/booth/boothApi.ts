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
 * `apps/api/src/services/booth-admin.ts`; the voucher types are
 * `apps/api/src/routes/voucher-definitions.ts` and `VoucherDefinitionView` in
 * `apps/api/src/services/voucher-definitions.ts` (SCRUM-400). They are restated rather than
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
import { api, apiUrl, ApiError, idemKey, isMissingRoute } from '@/api/client';
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
   * a television on its no-wheel screen, "This booth is being set up — please
   * ask our staff" while its box is online and "Booth not set up, connect to
   * internet" while it is not — which the page names rather than drawing as a
   * zero.
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
    /**
     * The spins-per-day the PUBLISHED wheel allows, or null for no limit
     * (SCRUM-257). A draft the manager has not published yet is not this
     * number: the box enforces what it cached.
     */
    spinCap: number | null;
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

/**
 * `BoothArchivedPrizeView`: a slice archived off the booth, listed only when
 * the draft is read with `includeArchived` (SCRUM-468). It is never in
 * `prizes`, so no total on the page counts it.
 */
export interface BoothArchivedPrize extends BoothPrizeDraft {
  archivedAt: string;
}

export interface BoothSettingsDraft {
  layoutId: string | null;
  layoutName: string | null;
  buttonKey: string;
  eligibility: BoothEligibilityMode;
  dailySpinCap: number | null;
  /** Optional when reading an older deployment; absent means ten seconds. */
  spinDurationSeconds?: number;
  /**
   * How long a staff sign-in at this booth lasts, in minutes (SCRUM-400).
   * Null is the box's own twelve hours. Optional on the read because a
   * deployment older than the column does not send it.
   */
  staffSessionMinutes?: number | null;
  /**
   * The booth's voucher slip (SCRUM-471): show the logo, a header line under
   * the venue line, a footer line, show the Staff row, show the terms. All
   * optional on the read because a deployment older than migration 0039 does
   * not send them — which the Voucher slip card says rather than guessing.
   */
  voucherShowLogo?: boolean;
  voucherHeaderText?: string | null;
  voucherFooterText?: string | null;
  voucherShowStaff?: boolean;
  voucherShowTerms?: boolean;
}

/** The five slip fields, as the settings route and the preview route take them. */
export interface VoucherSlipInput {
  voucherShowLogo: boolean;
  voucherHeaderText: string | null;
  voucherFooterText: string | null;
  voucherShowStaff: boolean;
  voucherShowTerms: boolean;
}

/** A drawn sample slip: the PNG, and its width in printer dots. */
export interface VoucherSlipPicture {
  blob: Blob;
  widthDots: number;
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
  booth: { id: string; name: string; branchId: string; codePrefix: string | null };
  settings: BoothSettingsDraft;
  /** In slice order — `sortOrder`, then name, which is what a publish freezes. */
  prizes: BoothPrizeDraft[];
  /**
   * The archived slices, most recently archived first — present only when the
   * draft was read with `includeArchived` (SCRUM-468), and absent from a
   * deployment older than it.
   */
  archivedPrizes?: BoothArchivedPrize[];
  /** Exactly what publishing would mint. Left unparsed; see the file note. */
  bundle: unknown;
  /**
   * The hash of that document, and the guard against publishing over somebody
   * else's edit: it goes back with the publish as `expectedBundleHash`.
   */
  bundleHash: string | null;
  published: BoothVersionRow | null;
  /**
   * The document the booth is running now, as stored — null when nothing has
   * been published. Left unparsed like `bundle`; `publishedSessionMinutes`
   * reads the one field the page needs from it.
   */
  publishedBundle?: unknown;
  /** Whether the draft differs from the published wheel at all. */
  changed: boolean;
  /** The newest edit to anything in the bundle — a colleague's included. */
  lastEditedAt: string | null;
  /** Empty means this draft can be published as it stands. */
  blockers: PublishBlocker[];
}

/**
 * How long a staff sign-in lasts at the booth NOW, in minutes: the published
 * wheel's `settings.staffSessionMinutes`, or null — the box's own twelve
 * hours — when nothing is published or the version names no length. A length
 * saved under Booth settings is the draft's until it is published, and the
 * box grants this one meanwhile (SCRUM-400).
 */
export function publishedSessionMinutes(draft: BoothDraft): number | null {
  const published = draft.publishedBundle as
    { settings?: { staffSessionMinutes?: unknown } } | null | undefined;
  const minutes = published?.settings?.staffSessionMinutes;
  return typeof minutes === 'number' && Number.isInteger(minutes) && minutes > 0 ? minutes : null;
}

export interface BoothLayoutRow {
  id: string;
  name: string;
  description: string | null;
  version: number;
  active: boolean;
  archivedAt: string | null;
}

/** The product or ticket package a voucher type hands over, named. */
export interface VoucherLink {
  id: string;
  name: string;
  code: string | null;
  branchId: string | null;
  branchName: string | null;
  /** On sale: active and not archived. The till refuses one that is not. */
  live: boolean;
}

/** A booth prize pointing at a voucher type — what an edit to it reaches. */
export interface VoucherUse {
  boothId: string;
  boothName: string;
  branchId: string;
  prizeId: string;
  prizeName: string;
  /**
   * The prize's Thai name: what a slip prints under the title when the type
   * has no Thai title. Optional so a deployment that does not send it yet
   * still reads.
   */
  prizeNameTh?: string | null;
  active: boolean;
}

/**
 * `VoucherDefinitionView` in `apps/api/src/services/voucher-definitions.ts`.
 *
 * Everything past `active` arrived with SCRUM-400 and is optional here, so the
 * prize picker still reads a deployment that serves only the older fields.
 */
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
  productId?: string | null;
  ticketPackageId?: string | null;
  offlinePolicy?: string;
  singleUse?: boolean;
  titleEn?: string | null;
  titleTh?: string | null;
  instructionEn?: string | null;
  instructionTh?: string | null;
  termsEn?: string | null;
  termsTh?: string | null;
  /** 'fixed': every slip prints fixedCode (a code set up in another till system, say). */
  codeMode?: string;
  fixedCode?: string | null;
  archivedAt?: string | null;
  updatedAt?: string;
  product?: VoucherLink | null;
  ticketPackage?: VoucherLink | null;
  usedBy?: VoucherUse[];
  /**
   * Its vouchers still in families' hands — issued, not used, not void, not
   * past their date — counted when the row was read: what an edit to the
   * worth reprices (SCRUM-409). Optional so a deployment that does not send
   * it yet still reads.
   */
  unredeemedVouchers?: number;
}

/** What a voucher type create or edit sends. The API checks the whole row. */
export interface VoucherDefinitionInput {
  code?: string;
  nameEn: string;
  nameTh: string | null;
  kind: string;
  valueType: string;
  valueSatang: number | null;
  valueBp: number | null;
  productId: string | null;
  ticketPackageId: string | null;
  expiryDays: number | null;
  titleEn: string | null;
  titleTh: string | null;
  instructionEn: string | null;
  instructionTh: string | null;
  termsEn: string | null;
  termsTh: string | null;
  active: boolean;
  codeMode?: 'generated' | 'fixed';
  fixedCode?: string | null;
}

/** `GET /voucher-definitions/link-options`: what a voucher type can point at. */
export interface VoucherLinkOptions {
  products: Array<{
    id: string;
    name: string;
    code: string | null;
    kind: string;
    branchId: string | null;
    branchName: string | null;
    priceSatang: number;
  }>;
  packages: Array<{ id: string; name: string; branchId: string; branchName: string }>;
}

/**
 * Somebody who may sign in at a booth (`GET /booths/:id/staff`). Never a PIN
 * and never its hash — whether they have one is the whole answer.
 */
export interface BoothStaffRow {
  accountId: string;
  addedAt: string;
  addedBy: string;
  hasPin: boolean;
  pinExpiresAt: string | null;
}

export interface BoothPinInput {
  pin?: string;
  generate?: boolean;
  expiresAt?: string | null;
}
export interface BoothPinResult {
  accountId: string;
  hasPin: true;
  pinExpiresAt: string | null;
  pin?: string;
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
// The televisions paired to a booth (SCRUM-244)
// ---------------------------------------------------------------------------

/**
 * `BoothScreenView`. Never a code and never a hash — the API does not serve
 * either, and this page has no use for one after the moment it is read out.
 */
export interface BoothScreenRow {
  id: string;
  label: string | null;
  /** A code has been minted and nobody has typed it into a screen yet. */
  pairingOutstanding: boolean;
  pairingCodeExpiresAt: string | null;
  pairedAt: string | null;
  pairedByAccountId: string | null;
  /** When this screen last called the booth surface. */
  lastSeenAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
}

export interface MintedPairingCode {
  credential: BoothScreenRow;
  /** Shown once. It is not stored here, and asking again mints a new one. */
  pairingCode: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// The calls
// ---------------------------------------------------------------------------

const at = (id: string) => `/booths/${encodeURIComponent(id)}`;

/**
 * Every write carries a fresh idempotency key, minted where the person
 * pressed the button — the platform's rule for mutations, and what makes a
 * double press on Publish one version rather than two.
 *
 * `archivePrize` carries one too, since `api.delete` learned to take it. The
 * route is also forgiving on its own — archiving an already-archived slice
 * answers with that slice instead of 404 (`apps/api/src/routes/booth.ts`) —
 * so a double press was harmless before and is now also deduplicated.
 */
export const boothApi = {
  /** Branch-nested, like every branch-scoped resource: the guard needs it in the path. */
  list: (branchId: string) =>
    api.get<{ booths: BoothListRow[] }>(`/branches/${encodeURIComponent(branchId)}/booths`),

  status: (id: string) => api.get<BoothStatus>(`${at(id)}/status`),

  /**
   * `includeArchived` adds the archived slices beside the live ones, the way
   * `voucherDefinitions` below does for voucher types (SCRUM-468). The draft
   * itself — prizes, bundle, hash — is the same either way.
   */
  draft: (id: string, includeArchived = false) =>
    api.get<BoothDraft>(`${at(id)}/draft${includeArchived ? '?includeArchived=true' : ''}`),

  versions: (id: string) => api.get<{ versions: BoothVersionRow[] }>(`${at(id)}/versions`),

  layouts: () => api.get<{ layouts: BoothLayoutRow[] }>('/booth-layouts'),

  /**
   * The operator's voucher types. `includeArchived` is what lets a prize that
   * still points at an archived type name it, rather than showing an empty
   * picker the manager would read as "no voucher".
   */
  voucherDefinitions: (includeArchived = false) =>
    api.get<{ definitions: VoucherDefinitionRow[] }>(
      `/voucher-definitions${includeArchived ? '?includeArchived=true' : ''}`,
    ),

  voucherLinkOptions: () => api.get<VoucherLinkOptions>('/voucher-definitions/link-options'),

  createDefinition: (input: VoucherDefinitionInput) =>
    api.post<{ definition: VoucherDefinitionRow }>('/voucher-definitions', input, {
      idempotencyKey: idemKey(),
    }),

  saveDefinition: (id: string, input: Partial<VoucherDefinitionInput>) =>
    api.patch<{ definition: VoucherDefinitionRow }>(
      `/voucher-definitions/${encodeURIComponent(id)}`,
      input,
      { idempotencyKey: idemKey() },
    ),

  /** Archived, never deleted: vouchers already printed under it are still honoured. */
  archiveDefinition: (id: string) =>
    api.delete<{ definition: VoucherDefinitionRow }>(
      `/voucher-definitions/${encodeURIComponent(id)}`,
      { idempotencyKey: idemKey() },
    ),

  restoreDefinition: (id: string) =>
    api.post<{ definition: VoucherDefinitionRow }>(
      `/voucher-definitions/${encodeURIComponent(id)}/restore`,
      undefined,
      { idempotencyKey: idemKey() },
    ),

  saveSettings: (id: string, settings: Partial<Omit<BoothSettingsDraft, 'layoutName'>>) =>
    api.patch<unknown>(`${at(id)}/settings`, settings, { idempotencyKey: idemKey() }),

  /**
   * Draw a sample voucher slip from DRAFT slip choices (SCRUM-471) — the same
   * renderer as the paper, at the booth printer's 80 mm width. It saves
   * nothing, so it carries no idempotency key, like the till's template
   * preview. A PNG rather than JSON, so it is fetched here rather than through
   * the JSON client; a refusal still comes back as the platform's error.
   */
  voucherPreview: async (
    id: string,
    slip: Partial<VoucherSlipInput>,
    signal?: AbortSignal,
  ): Promise<VoucherSlipPicture> => {
    const res = await fetch(apiUrl(`${at(id)}/voucher-preview.png`), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(slip),
      signal,
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => null)) as {
        error?: { code?: string; message?: string; details?: unknown };
      } | null;
      throw new ApiError(
        res.status,
        body?.error?.code ?? 'UNKNOWN',
        body?.error?.message ?? res.statusText,
        body?.error?.details,
      );
    }
    const widthDots = Number(res.headers.get('x-oto-preview-width-dots'));
    return { blob: await res.blob(), widthDots: Number.isFinite(widthDots) && widthDots > 0 ? widthDots : 576 };
  },

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
    api.delete<unknown>(`${at(id)}/prizes/${encodeURIComponent(prizeId)}`, {
      idempotencyKey: idemKey(),
    }),

  /**
   * Brings an archived slice back, switched off (SCRUM-468). The API refuses
   * it while its voucher type is archived, and while a live slice has its
   * name; either refusal is said in the prizes panel.
   */
  restorePrize: (id: string, prizeId: string) =>
    api.post<unknown>(`${at(id)}/prizes/${encodeURIComponent(prizeId)}/restore`, undefined, {
      idempotencyKey: idemKey(),
    }),

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

  screens: (id: string) => api.get<{ screens: BoothScreenRow[] }>(`${at(id)}/screens`),

  /**
   * Mint the six digits somebody types into a television.
   *
   * **No idempotency key, and that is the API's rule rather than an
   * oversight.** The answer carries a credential, so the route declares
   * `secretResponse` and the platform's replay store refuses to hold it — a
   * key would be claimed and then released, and a retry would do the work
   * again regardless. What makes a double press safe is on the server: minting
   * revokes this booth's previous unredeemed code, so there is never more than
   * one live code and the one on screen is always the one that works.
   */
  mintPairingCode: (id: string, label?: string | null) =>
    api.post<MintedPairingCode>(`${at(id)}/pairing-codes`, { label: label ?? null }),

  /** Unpair a screen. The row stays; the secret goes. */
  unpairScreen: (id: string, credentialId: string, reason?: string | null) =>
    api.post<{ screen: BoothScreenRow }>(
      `${at(id)}/screens/${encodeURIComponent(credentialId)}/revoke`,
      { reason: reason ?? null },
      { idempotencyKey: idemKey() },
    ),

  // --- Who may sign in at the booth (SCRUM-400) ------------------------------

  staff: (id: string) => api.get<{ staff: BoothStaffRow[] }>(`${at(id)}/staff`),

  addStaff: (id: string, accountId: string) =>
    api.put<{ staff: BoothStaffRow[] }>(`${at(id)}/staff/${encodeURIComponent(accountId)}`, undefined, {
      idempotencyKey: idemKey(),
    }),

  /** Their PIN stays theirs — withdraw it separately when that is what is meant. */
  removeStaff: (id: string, accountId: string) =>
    api.delete<{ staff: BoothStaffRow[] }>(`${at(id)}/staff/${encodeURIComponent(accountId)}`, {
      idempotencyKey: idemKey(),
    }),

  /**
   * Set or replace somebody's booth PIN.
   *
   * **No idempotency key, by the API's rule.** The route declares
   * `secretResponse` for its REQUEST: the replay store keeps a hash of the
   * body for a day, and four digits behind a plain hash are ten thousand
   * guesses, so no key is claimed. A retry sets the same PIN again. The digits
   * go in this one request body and nowhere else — not in state after the
   * form clears, not in a log, not on screen.
   */
  setPin: (id: string, accountId: string, input: BoothPinInput) =>
    api.put<BoothPinResult>(`${at(id)}/staff/${encodeURIComponent(accountId)}/pin`, input),

  clearPin: (id: string, accountId: string, reason: string) =>
    api.delete<{ accountId: string; hasPin: false }>(
      `${at(id)}/staff/${encodeURIComponent(accountId)}/pin?reason=${encodeURIComponent(reason)}`,
      { idempotencyKey: idemKey() },
    ),

  // --- The day's booth staff (SCRUM-473) -------------------------------------

  duty: (id: string) => api.get<BoothDutyView>(`${at(id)}/duty`),

  /** Read the OTO App's schedule now and write the difference into today's roster. */
  syncDuty: (id: string) =>
    api.post<BoothDutySyncResult>(`${at(id)}/duty/sync`, undefined, { idempotencyKey: idemKey() }),

  /** An account of the branch's staff, or a name alone for somebody with none. */
  addDuty: (id: string, input: { accountId?: string | null; displayName?: string | null }) =>
    api.post<{ roster: BoothDutyAssignment[] }>(`${at(id)}/duty`, input, {
      idempotencyKey: idemKey(),
    }),

  removeDuty: (id: string, assignmentId: string) =>
    api.delete<{ roster: BoothDutyAssignment[] }>(
      `${at(id)}/duty/${encodeURIComponent(assignmentId)}`,
      { idempotencyKey: idemKey() },
    ),

  saveDutyRule: (id: string, rule: Partial<BoothDutyRule>) =>
    api.patch<BoothDutyRule>(`${at(id)}/duty/rule`, rule, { idempotencyKey: idemKey() }),
};

// ---------------------------------------------------------------------------
// The day's booth staff (SCRUM-473) — `BoothDutyView` and friends in
// `apps/api/src/services/booth-duty.ts`
// ---------------------------------------------------------------------------

/** How somebody came to be on the day's roster. */
export type BoothDutySource = 'app_schedule' | 'app_duty_block' | 'manual' | 'self_assigned';

/** What the last sync found about the OTO App itself. */
export type BoothDutyAppState = 'ok' | 'app_not_installed' | 'no_app_branch' | 'ambiguous_app_branch';

export interface BoothDutyAssignment {
  id: string;
  /** Null for a casual worker: named on the voucher, never signs in. */
  accountId: string | null;
  displayName: string;
  source: BoothDutySource;
  syncedAt: string | null;
  addedByAccountId: string | null;
  createdAt: string;
}

export interface BoothDutyUnmatched {
  name: string;
  /** `no_app_user`: the employee has no app login. `no_platform_account`: the login is not linked. */
  reason: 'no_app_user' | 'no_platform_account';
}

export interface BoothDutyRule {
  /** Matched inside a shift row's group, department or role name. */
  groupText: string;
  /** Matched inside a duty block's name. */
  dutyText: string;
}

export interface BoothDutyLogLine {
  at: string;
  action: string;
  actorAccountId: string | null;
  detail: Record<string, unknown> | null;
}

export interface BoothDutyView {
  businessDate: string;
  rule: BoothDutyRule;
  roster: BoothDutyAssignment[];
  /** What prints on every voucher today; null prints "unattributed". */
  label: string | null;
  lastSync: {
    syncedAt: string;
    appState: BoothDutyAppState;
    unmatched: BoothDutyUnmatched[];
    syncedByAccountId: string | null;
  } | null;
  log: BoothDutyLogLine[];
}

export interface BoothDutySyncResult {
  businessDate: string;
  appState: BoothDutyAppState;
  added: number;
  removed: number;
  unmatched: BoothDutyUnmatched[];
  roster: BoothDutyAssignment[];
}
