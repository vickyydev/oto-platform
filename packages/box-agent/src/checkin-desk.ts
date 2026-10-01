import {
  BOX_CHECKIN_REFUSALS,
  BRIDGE_CHECKIN_INTENTS,
  BridgeCheckinCreateSchema,
  BridgeCheckinUpdateSchema,
  BridgeGuardianCreateSchema,
  BridgeReleaseCreateSchema,
  BridgeWaiverCreateSchema,
  CHECKIN_FACTS,
  CHECKIN_OVERLAY_KINDS,
  DEFAULT_DROP_OFF_PRICING,
  DEFAULT_SUPERVISION_POLICY,
  DROPPER_OFF_PICKUP_ID,
  PhotoCaptureSchema,
  RELEASE_REFUSALS,
  bandShortCode,
  buildAcknowledgedConfirmations,
  confirmationsSatisfied,
  normalizePhone,
  prepaidReconciliationOf,
  requirementLabel,
  resolveRequirement,
  revokedCollectorRefusal,
  supervisionBadgeOf,
  waiverRefusal,
  type BridgeCheckinChild,
  type BridgeCheckinCreate,
  type BridgeCheckinFamily,
  type BridgeCheckinUpdate,
  type BridgeGuardian,
  type BridgeNanny,
  type BridgeReleaseCreate,
  type BridgeReleaseRecord,
  type CheckinCacheItem,
  type DropOffPricingConfig,
  type OfflineCheckinCreated,
  type OfflineCheckinUpdated,
  type OfflineGuardianCreated,
  type OfflineReleaseCreated,
  type OfflineWaiverCreated,
  type PhotoTarget,
  type PickupView,
  type PrepaidReconciliation,
  type ReleaseView,
  type SupervisionPolicy,
} from '@oto/shared';
import { BlobStoreRefused, bytesOfDataUrl, type BlobStore } from './blob-store';
import { CheckinBandRefused, type CheckinBandPlan, type OfflineBandPlan, type SaleQueue } from './sale-queue';
import type { BoxOverlayKind, BoxStore, EnvelopeSealer, OverlayRecord, OverlayWrite, QueuedFact } from './store';
import type { AgentLog } from './transport';

/**
 * THE CHECK-IN DESK ON THE BOX (S2-13 round 4, plan §2.5).
 *
 * The till's gate, consent, "Check in now", the board's basics and the
 * release, answered by the counter's box when the link is down. It is the
 * station bridge's (`station-bridge.ts`), kept in its own file because the
 * bridge is already the size of three; the bridge hands it every intent named
 * in `BRIDGE_CHECKIN_INTENTS` and turns its refusals into `BridgeError`s.
 *
 * THE MODEL IS THE LANDED OFFLINE SALE, extended rather than replaced:
 *
 *   - every write is ONE store transaction — the facts on the outbox and the
 *     rows in the offline overlay together (`produce`), and for "Check in now"
 *     the supervised children's bands minted, their paper queued and the facts
 *     written in the sale queue's transaction (`SaleQueue.issueCheckinBands`);
 *   - every id is the till's (OD-12), so the same press again meets itself:
 *     a registration, a stay, a person on a list, a release answered from the
 *     overlay with what was written the first time, and nothing written twice;
 *   - reads come from the box's own copy — the `checkin` cache scope the agent
 *     pulls on every tick — with what this counter recorded laid over it;
 *   - every refusal is a sentence the counter can act on, the platform's own
 *     words where the platform has them.
 *
 * PHOTOS: a capture is kept in the box's bounded photo store (`blob-store.ts`),
 * named by the row it belongs to, and sent by the upload worker when the link
 * is back. `CHILD_PHOTOS_ENABLED` gates every capture. Never a photo of an
 * identity document (C9).
 */

/** A refusal; the bridge sends it as `{ error: { code, message, details } }` with this status. */
export class DeskRefusal extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'DeskRefusal';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const refuse = (
  status: number,
  refusal: { code: string; message: string },
  details?: Record<string, unknown>,
): DeskRefusal => new DeskRefusal(status, refusal.code, refusal.message, details);

export interface DeskCaller {
  accountId: string;
  can(permission: string): boolean;
  offlineFresh: boolean;
  jti: string | null;
}

export interface DeskStation {
  id: string;
  name: string;
  branchId: string;
  operatorId: string;
}

export interface CheckinDeskHost {
  boxId: string;
  store: BoxStore;
  now(): Date;
  log: AgentLog;
  sealer(): EnvelopeSealer | null;
  sales(): SaleQueue | null;
  blobs(): BlobStore | null;
  /** `CHILD_PHOTOS_ENABLED`: off, there is no capture path at all. */
  photosEnabled(): boolean;
  /**
   * A member as the box will file it — the survivor through the alias rule
   * (OD-7) — with the ids of the children the box shows under them. Null for
   * a member this box knows nothing of.
   */
  resolveMember(memberId: string): Promise<{ id: string; childIds: ReadonlySet<string> } | null>;
}

/** The deferred band a sale left for "Check in now" — kept in the sale's memo (`station-bridge.ts`). */
export interface DeferredBand extends OfflineBandPlan {
  stayHours: number | null;
}

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function rec(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function tabOf(children: readonly { status: string }[]): BridgeCheckinFamily['tab'] {
  if (children.some((c) => c.status === 'in_park')) return 'in_park';
  if (children.some((c) => c.status === 'registered')) return 'registered';
  return 'out';
}

/** One press per stay at a time on this box: two tills cannot both check in, or release, one child. */
const inHand = new Set<string>();

async function holding<T>(
  keys: readonly string[],
  busy: { code: string; message: string },
  run: () => Promise<T>,
): Promise<T> {
  const held = keys.filter((k) => inHand.has(k));
  if (held.length > 0) throw refuse(409, busy, { held });
  for (const k of keys) inHand.add(k);
  try {
    return await run();
  } finally {
    for (const k of keys) inHand.delete(k);
  }
}

/** The view of the box's check-in copy at one moment. */
interface DeskView {
  item: CheckinCacheItem | null;
  appliedAt: string | null;
  policy: SupervisionPolicy;
  pricing: DropOffPricingConfig;
  photoRetentionDays: number;
  nannies: BridgeNanny[];
  families: Map<string, BridgeCheckinFamily>;
  releases: Map<string, BridgeReleaseRecord>;
  /** Pending photos named by rows this counter recorded (`photoId` on the record). */
  photoOf: Map<string, string>;
}

export class CheckinDesk {
  private readonly host: CheckinDeskHost;

  constructor(host: CheckinDeskHost) {
    this.host = host;
  }

  handles(type: string): boolean {
    return (Object.values(BRIDGE_CHECKIN_INTENTS) as string[]).includes(type);
  }

  // --- reading the box's copy ---------------------------------------------------------

  private async cacheItem(): Promise<{ item: CheckinCacheItem | null; appliedAt: string | null }> {
    const bundle = await this.host.store.readBundle(this.host.boxId, 'checkin').catch(() => null);
    const items = rec(bundle?.payload)?.items;
    const first = Array.isArray(items) ? rec(items[0]) : null;
    return { item: (first as unknown as CheckinCacheItem | null) ?? null, appliedAt: bundle?.appliedAt ?? null };
  }

  private async overlay(kind: BoxOverlayKind, store: BoxStore = this.host.store): Promise<OverlayRecord[]> {
    if (!store.features().overlay) return [];
    return store.listOverlay(this.host.boxId, { kind });
  }

  /** The board as this box knows it: its copy, with what this counter recorded laid over it. */
  private async view(store: BoxStore = this.host.store): Promise<DeskView> {
    const { item, appliedAt } = await this.cacheItem();
    const config = rec(item?.config);
    const policy = (config?.policy as SupervisionPolicy | undefined) ?? DEFAULT_SUPERVISION_POLICY;
    const pricing = (config?.pricing as DropOffPricingConfig | undefined) ?? DEFAULT_DROP_OFF_PRICING;
    const families = new Map<string, BridgeCheckinFamily>();
    for (const fam of item?.families ?? []) {
      families.set(fam.registrationId, {
        ...fam,
        children: fam.children.map((c) => ({ ...c })),
        guardians: (fam.guardians ?? []).map((g) => ({ ...g })),
        origin: 'cache',
      });
    }
    const releases = new Map<string, BridgeReleaseRecord>();
    for (const r of item?.releases ?? []) releases.set(r.checkinId, { ...r });
    const photoOf = new Map<string, string>();

    for (const row of await this.overlay('registration', store)) {
      const record = row.record as Partial<BridgeCheckinFamily> & { photoId?: string | null };
      const held = families.get(row.entityId);
      const base: BridgeCheckinFamily = held ?? {
        registrationId: row.entityId,
        branchId: String(record.branchId ?? ''),
        memberId: (record.memberId as string | null | undefined) ?? null,
        guardianName: String(record.guardianName ?? ''),
        guardianPhone: (record.guardianPhone as string | null | undefined) ?? null,
        contactChannel: String(record.contactChannel ?? 'whatsapp'),
        consentRecordedAt: (record.consentRecordedAt as string | null | undefined) ?? null,
        source: String(record.source ?? 'till'),
        photoFileId: null,
        createdAt: String(record.createdAt ?? row.createdAt),
        contact: null,
        tab: 'registered',
        children: [],
        guardians: [],
        origin: 'overlay',
      };
      if (record.photoId) {
        photoOf.set(`registration:${row.entityId}`, record.photoId);
        if (!base.photoFileId) base.photoFileId = record.photoId;
      }
      families.set(row.entityId, base);
    }
    for (const row of await this.overlay('checkin', store)) {
      const fam = row.memberId ? families.get(row.memberId) : undefined;
      if (!fam) continue;
      const child = row.record as unknown as BridgeCheckinChild;
      const at = fam.children.findIndex((c) => c.id === row.entityId);
      if (at >= 0) fam.children[at] = { ...fam.children[at]!, ...child, id: row.entityId };
      else fam.children.push({ ...child, id: row.entityId });
    }
    for (const row of await this.overlay('guardian', store)) {
      const fam = row.memberId ? families.get(row.memberId) : undefined;
      if (!fam) continue;
      const guardian = row.record as unknown as BridgeGuardian & { photoId?: string | null };
      if (guardian.photoId) photoOf.set(`guardian:${row.entityId}`, guardian.photoId);
      const at = fam.guardians.findIndex((g) => g.id === row.entityId);
      const next = { ...guardian, id: row.entityId, photoFileId: guardian.photoFileId ?? guardian.photoId ?? null };
      if (at >= 0) fam.guardians[at] = next;
      else fam.guardians.push(next);
    }
    for (const row of await this.overlay('release', store)) {
      const release = row.record as unknown as BridgeReleaseRecord & { pickupPhotoId?: string | null };
      if (release.pickupPhotoId) photoOf.set(`release:${row.entityId}`, release.pickupPhotoId);
      releases.set(release.checkinId, { ...release, id: row.entityId });
    }
    const nannies = item?.nannies ?? [];
    const nannyName = new Map(nannies.map((n) => [n.id, n.name]));
    for (const fam of families.values()) {
      for (const c of fam.children) c.nannyName = c.nannyId ? (nannyName.get(c.nannyId) ?? c.nannyName ?? null) : null;
      fam.tab = tabOf(fam.children);
    }
    return {
      item,
      appliedAt,
      policy,
      pricing,
      photoRetentionDays: typeof config?.photoRetentionDays === 'number' ? config.photoRetentionDays : 30,
      nannies,
      families,
      releases,
      photoOf,
    };
  }

  private findStay(view: DeskView, checkinId: string): { family: BridgeCheckinFamily; child: BridgeCheckinChild } | null {
    for (const family of view.families.values()) {
      const child = family.children.find((c) => c.id === checkinId);
      if (child) return { family, child };
    }
    return null;
  }

  /** The cart lines that are supervised children's stays — their bands wait for "Check in now". */
  async supervisedLineIds(lineIds: readonly string[]): Promise<Set<string>> {
    const wanted = new Set(lineIds);
    const out = new Set<string>();
    if (wanted.size === 0) return out;
    const view = await this.view();
    for (const fam of view.families.values()) {
      for (const c of fam.children) if (wanted.has(c.id)) out.add(c.id);
    }
    return out;
  }

  /** The children those stays name, so a sale's other kids bands never take them. */
  async supervisedChildIds(lineIds: readonly string[]): Promise<Set<string>> {
    const wanted = new Set(lineIds);
    const out = new Set<string>();
    const view = await this.view();
    for (const fam of view.families.values()) {
      for (const c of fam.children) if (wanted.has(c.id) && c.childId) out.add(c.childId);
    }
    return out;
  }

  // --- answers in the till's own shapes ---------------------------------------------------

  private onShift(nanny: BridgeNanny, now: Date): boolean {
    const t = now.getTime();
    return nanny.shifts.some((s) => Date.parse(s.startsAt) <= t && Date.parse(s.endsAt) > t);
  }

  private roster(view: DeskView, now: Date) {
    const load = new Map<string, string[]>();
    for (const fam of view.families.values()) {
      for (const c of fam.children) {
        if (!c.nannyId || c.status === 'out') continue;
        load.set(c.nannyId, [...(load.get(c.nannyId) ?? []), c.childName]);
      }
    }
    return view.nannies
      .map((n) => ({
        id: n.id,
        name: n.name,
        onShift: this.onShift(n, now),
        load: load.get(n.id)?.length ?? 0,
        coveredNames: load.get(n.id) ?? [],
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  private boardOf(view: DeskView, now: Date) {
    const families = [...view.families.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const counts = { registered: 0, in_park: 0, out: 0 };
    for (const fam of families) for (const c of fam.children) counts[c.status] += 1;
    return {
      families,
      counts,
      unconfirmedFamilies: families.filter((f) => f.contact?.status !== 'confirmed').length,
      nannies: this.roster(view, now),
      nannyRatioSoftMax: view.pricing.nannyRatioSoftMax,
      prepaidFoodUnused: view.pricing.prepaidFoodUnused,
      source: 'box' as const,
      cacheAppliedAt: view.appliedAt,
    };
  }

  private registrationOf(fam: BridgeCheckinFamily) {
    return {
      id: fam.registrationId,
      branchId: fam.branchId,
      memberId: fam.memberId,
      guardianName: fam.guardianName,
      guardianPhone: fam.guardianPhone,
      contactChannel: fam.contactChannel,
      consentRecordedAt: fam.consentRecordedAt,
      acknowledgedConfirmations: [] as Array<{ itemId: string; text: string; acknowledgedAt: string }>,
      source: fam.source,
      photoFileId: fam.photoFileId,
      createdAt: fam.createdAt,
      children: fam.children.map(({ nannyName: _n, checkedOutAt: _o, ...c }) => c),
    };
  }

  private pickupsOf(fam: BridgeCheckinFamily, signUpPhotoFileId: string | null): PickupView[] {
    return [
      {
        id: DROPPER_OFF_PICKUP_ID,
        registrationId: fam.registrationId,
        name: fam.guardianName,
        phone: fam.guardianPhone,
        relationship: null,
        photoFileId: signUpPhotoFileId ?? fam.photoFileId,
        isDropperOff: true,
        source: 'dropper_off',
        addedByName: null,
        addedAt: fam.createdAt,
      },
      ...fam.guardians
        .filter((g) => !g.revoked)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .map((g) => ({
          id: g.id,
          registrationId: fam.registrationId,
          name: g.name,
          phone: g.phone,
          relationship: g.relationship,
          photoFileId: g.photoFileId,
          isDropperOff: false,
          source: g.source,
          addedByName: null,
          addedAt: g.createdAt,
        })),
    ];
  }

  private reconciliationOf(child: BridgeCheckinChild): PrepaidReconciliation | null {
    const fp = child.foodProvision;
    if (!fp || fp.mode === 'none') return null;
    const remaining = fp.mode === 'prepaid_credit' ? (fp.creditSatang ?? fp.paidSatang) : 0;
    return prepaidReconciliationOf(
      {
        mode: fp.mode,
        paidSatang: fp.paidSatang,
        ...(fp.creditSatang !== undefined ? { creditSatang: fp.creditSatang } : {}),
        ...(fp.items ? { items: fp.items.map((i) => ({ ...i, redeemedQty: i.redeemedQty ?? 0 })) } : {}),
      },
      remaining,
    );
  }

  private releaseViewOf(view: DeskView, release: BridgeReleaseRecord): ReleaseView {
    const stay = this.findStay(view, release.checkinId);
    const guardian = release.guardianId ? stay?.family.guardians.find((g) => g.id === release.guardianId) : undefined;
    const unused = release.prepaid?.unusedSatang ?? 0;
    return {
      id: release.id,
      checkinId: release.checkinId,
      registrationId: release.registrationId,
      childName: stay?.child.childName ?? '',
      guardianId: release.guardianId,
      collectorName: release.collectorName,
      collectorSource: release.guardianId ? (guardian?.source ?? 'in_person') : 'dropper_off',
      verifiedByAccountId: release.verifiedByAccountId,
      verifiedByName: null,
      pickupPhotoFileId: release.pickupPhotoFileId ?? (release as { pickupPhotoId?: string | null }).pickupPhotoId ?? null,
      stationId: release.stationId,
      checkedOutAt: release.checkedOutAt,
      settlement:
        release.prepaid && unused > 0
          ? {
              policy: release.prepaid.policy,
              unusedSatang: unused,
              refundId: null,
              refundedSatang: 0,
              // Refunds are online only: a refund-policy release taken here is
              // refunded by hand when the connection is back (the platform's
              // `refund_no_sale`).
              settlementError: release.prepaid.policy === 'refund' ? 'refund_no_sale' : null,
            }
          : null,
    };
  }

  // --- the intents -------------------------------------------------------------------------

  async intent(
    station: DeskStation,
    caller: DeskCaller,
    type: string,
    payload: Record<string, unknown>,
    actionId: string | null,
  ): Promise<Record<string, unknown>> {
    switch (type) {
      case BRIDGE_CHECKIN_INTENTS.board: {
        this.require(caller, 'pos:checkin:read');
        const now = this.host.now();
        return { ...this.boardOf(await this.view(), now) };
      }
      case BRIDGE_CHECKIN_INTENTS.config: {
        this.require(caller, 'pos:checkin:read');
        const view = await this.view();
        if (!view.item) throw refuse(409, BOX_CHECKIN_REFUSALS.noConfig);
        return {
          policy: view.policy,
          pricing: view.pricing,
          photoRetentionDays: view.photoRetentionDays,
          nannies: this.roster(view, this.host.now()),
          photosEnabled: this.host.photosEnabled(),
          source: 'box',
        };
      }
      case BRIDGE_CHECKIN_INTENTS.awaiting: {
        this.require(caller, 'pos:checkin:read');
        const view = await this.view();
        const registrations = [...view.families.values()]
          .filter((f) => f.children.some((c) => c.status === 'registered'))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .map((f) => this.registrationOf(f));
        return { registrations };
      }
      case BRIDGE_CHECKIN_INTENTS.context:
        return this.context(caller, payload);
      case BRIDGE_CHECKIN_INTENTS.photo:
        return this.capture(caller, payload);
      case BRIDGE_CHECKIN_INTENTS.create:
        return this.create(station, caller, payload, actionId);
      case BRIDGE_CHECKIN_INTENTS.update:
        return this.update(station, caller, payload, actionId);
      case BRIDGE_CHECKIN_INTENTS.waiver:
        return this.waiver(station, caller, payload, actionId);
      case BRIDGE_CHECKIN_INTENTS.guardian:
        return this.guardian(station, caller, payload, actionId);
      case BRIDGE_CHECKIN_INTENTS.release:
        return this.release(station, caller, payload, actionId);
      default:
        throw new DeskRefusal(400, 'STATION_UNKNOWN_INTENT', `This box does not know the intent ${type}`);
    }
  }

  private require(caller: DeskCaller, permission: string): void {
    if (!caller.can(permission)) throw new DeskRefusal(403, 'FORBIDDEN', `Missing permission: ${permission}`);
  }

  private parse<T>(
    schema: { safeParse(v: unknown): { success: true; data: T } | { success: false; error: unknown } },
    payload: unknown,
  ): T {
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      throw new DeskRefusal(400, 'VALIDATION', 'That request could not be read', { issue: String(parsed.error) });
    }
    return parsed.data;
  }

  /**
   * Facts and overlay rows in ONE store transaction (the bridge's `produce`,
   * for several at once). `check` runs inside the transaction first, against
   * what the store holds THEN, so a second till that got there in between is
   * refused rather than written over.
   */
  private async produce(
    station: DeskStation,
    caller: DeskCaller,
    writes: Array<{
      fact: { type: string; payload: Record<string, unknown> };
      overlay: Array<Omit<OverlayWrite, 'eventId'>>;
    }>,
    actionId: string | null,
    opts: { tx?: BoxStore; check?: (tx: BoxStore) => Promise<void>; extra?: (tx: BoxStore) => Promise<void> } = {},
  ): Promise<void> {
    const seal = this.host.sealer();
    if (!seal) {
      throw new DeskRefusal(
        503,
        'BOX_AGENT_ELSEWHERE',
        'This counter’s box is not running here, so it cannot record anything right now',
      );
    }
    if (!this.host.store.features().overlay) {
      throw new DeskRefusal(503, 'BOX_OVERLAY_MISSING', 'This box cannot keep an offline record yet — it needs updating');
    }
    const now = this.host.now().toISOString();
    const run = async (tx: BoxStore) => {
      await opts.check?.(tx);
      const facts: QueuedFact[] = writes.map((w) => ({
        type: w.fact.type,
        payload: caller.offlineFresh ? { ...w.fact.payload, offlineFresh: true } : w.fact.payload,
        occurredAt: now,
        stationId: station.id,
        actorKind: 'account',
        actorAccountId: caller.accountId,
        actionId: actionId ? actionId.slice(0, 200) : null,
      }));
      const records = await tx.enqueueMany(this.host.boxId, facts, seal, now);
      for (let i = 0; i < writes.length; i += 1) {
        const eventId = records[i]!.envelope.eventId;
        for (const row of writes[i]!.overlay) await tx.putOverlay(this.host.boxId, { ...row, eventId }, now);
      }
      await opts.extra?.(tx);
    };
    if (opts.tx) await run(opts.tx);
    else await this.host.store.atomically(run);
  }

  // --- photos ----------------------------------------------------------------------------

  private async capture(caller: DeskCaller, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (
      !['pos:checkin:create', 'pos:checkin:update', 'pos:checkin:release', 'pos:checkin:guardian_manage'].some((p) =>
        caller.can(p),
      )
    ) {
      throw new DeskRefusal(403, 'FORBIDDEN', 'Missing permission: pos:checkin:update');
    }
    // CHILD_PHOTOS_ENABLED off: there is no capture path at all.
    if (!this.host.photosEnabled()) throw refuse(409, BOX_CHECKIN_REFUSALS.photosOff);
    const body = this.parse(PhotoCaptureSchema, payload);
    const blobs = this.host.blobs();
    if (!blobs) throw refuse(503, BOX_CHECKIN_REFUSALS.photoStoreMissing);
    const bytes = bytesOfDataUrl(body.dataUrl);
    if (!bytes) throw refuse(400, BOX_CHECKIN_REFUSALS.photoNotImage);
    const now = this.host.now();
    await blobs.purge(now).catch(() => 0);
    try {
      const meta = await blobs.put(
        {
          id: body.photoId,
          registrationId: body.registrationId,
          purpose: body.purpose,
          contentType: 'image/jpeg',
          capturedAt: now.toISOString(),
        },
        bytes,
      );
      // The gate takes the consent photo AFTER the registration is written (the
      // till's order): a family this box knows is named as the photo's row
      // now, and one this counter registered offline shows it on the board.
      const registration = body.purpose === 'consent' ? await this.attachConsent(body.registrationId, meta.id) : null;
      return {
        photoId: meta.id,
        fileId: meta.id,
        size: meta.size,
        pendingUpload: !meta.linkedAt,
        ...(registration ? { registration } : {}),
      };
    } catch (err) {
      if (err instanceof BlobStoreRefused) {
        const usage = await blobs.usage().catch(() => null);
        this.host.log.warn(
          { module: 'checkin-desk', reason: err.reason, usage, detail: err.message },
          'a photo was not kept on the box',
        );
        if (err.reason === 'full') throw refuse(507, BOX_CHECKIN_REFUSALS.photoStoreFull, { usage });
        if (err.reason === 'too_big') throw refuse(413, BOX_CHECKIN_REFUSALS.photoTooBig);
        throw refuse(400, BOX_CHECKIN_REFUSALS.photoNotImage);
      }
      throw err;
    }
  }

  /**
   * A pending photo this box holds, for this registration and one of these
   * purposes; else the refusal. A photo taken at the counter for a collector
   * or a pickup may stand for either (the release modal takes both with one
   * camera); the sign-up photo never stands in for one taken at pickup (R-92).
   */
  private async pendingPhoto(
    photoId: string,
    registrationId: string,
    purpose: 'consent' | 'collector' | 'pickup',
  ) {
    const blobs = this.host.blobs();
    const meta = blobs ? await blobs.get(photoId) : null;
    const allowed = purpose === 'consent' ? ['consent'] : ['collector', 'pickup'];
    if (!meta || meta.registrationId !== registrationId || !allowed.includes(meta.purpose)) {
      throw refuse(404, BOX_CHECKIN_REFUSALS.photoUnknown);
    }
    return meta;
  }

  /** The consent photo, named for a registration this box knows; the family as the till reads it, or null. */
  private async attachConsent(registrationId: string, photoId: string) {
    const view = await this.view();
    const family = view.families.get(registrationId);
    if (!family) return null;
    if (family.photoFileId && family.photoFileId !== photoId) return this.registrationOf(family);
    await this.nameTarget(photoId, 'registration', registrationId);
    const row = await this.host.store.readOverlay(this.host.boxId, 'registration', registrationId).catch(() => null);
    if (row && !row.record.photoId) {
      await this.host.store.putOverlay(
        this.host.boxId,
        { kind: 'registration', entityId: registrationId, memberId: row.memberId, phone: null, record: { ...row.record, photoId }, eventId: row.eventId },
        this.host.now().toISOString(),
      );
    }
    const after = (await this.view()).families.get(registrationId);
    return after ? this.registrationOf(after) : null;
  }

  /** Name the row a photo belongs to, once the write naming it has committed. Best effort: the overlay names it too. */
  private async nameTarget(photoId: string | null | undefined, kind: PhotoTarget, id: string): Promise<void> {
    if (!photoId) return;
    await this.host
      .blobs()
      ?.update(photoId, { target: { kind, id } })
      .catch((err: unknown) => {
        this.host.log.warn({ module: 'checkin-desk', photoId, err: String(err) }, 'a photo could not be named; the overlay names it');
      });
  }

  // --- the gate: the registration ------------------------------------------------------------

  private async create(
    station: DeskStation,
    caller: DeskCaller,
    payload: Record<string, unknown>,
    actionId: string | null,
  ): Promise<Record<string, unknown>> {
    this.require(caller, 'pos:checkin:create');
    const body: BridgeCheckinCreate = this.parse(BridgeCheckinCreateSchema, payload);
    const view = await this.view();
    // The same id again: the till retrying through a lost answer.
    const known = view.families.get(body.registrationId);
    if (known) return { registration: this.registrationOf(known), replayed: true };
    if (!view.item) throw refuse(409, BOX_CHECKIN_REFUSALS.noConfig);
    const policy = view.policy;

    // The platform's own checks, in its words (`createRegistration`).
    const ids = body.children.map((c) => c.checkinId);
    if (new Set(ids).size !== ids.length) throw new DeskRefusal(400, 'BAD_REQUEST', 'Two children were sent under the same check-in id.');
    for (const c of body.children) {
      const base = resolveRequirement(c.ageYears, policy);
      if (base === c.service) continue;
      throw new DeskRefusal(
        409,
        'SERVICE_MISMATCH',
        base === 'none'
          ? `${c.name} is ${c.ageYears} and needs no supervision — register them with no service, or leave them on a plain ticket.`
          : `${c.name} is ${c.ageYears} and needs ${requirementLabel(base)}, not ${requirementLabel(c.service)} — check the age, or accept a sibling waiver for them.`,
        { checkinId: c.checkinId, required: base },
      );
    }
    for (const fam of view.families.values()) {
      const taken = fam.children.find((c) => ids.includes(c.id));
      if (taken) throw new DeskRefusal(409, 'ID_IN_USE', 'That id already names another check-in', { id: taken.id });
    }
    if (!body.consentAcknowledged) {
      throw new DeskRefusal(409, 'CONSENT_REQUIRED', 'The guardian has not given consent yet — finish the form on the customer screen.');
    }
    if (!confirmationsSatisfied(policy, body.acknowledgedConfirmationIds)) {
      throw new DeskRefusal(
        409,
        'CONFIRMATIONS_REQUIRED',
        'Every confirmation has to be ticked on the customer screen before the children can be registered.',
      );
    }
    let guardianPhone: string | null = null;
    if (body.guardianPhone?.trim()) {
      guardianPhone = normalizePhone(body.guardianPhone);
      if (!guardianPhone) throw new DeskRefusal(400, 'BAD_REQUEST', "That phone number doesn't look right — check it with the guardian.");
    }
    let memberId: string | null = null;
    const savedIds = body.children.map((c) => c.childId).filter((id): id is string => !!id);
    if (body.memberId) {
      const member = await this.host.resolveMember(body.memberId);
      if (!member) throw new DeskRefusal(404, 'NOT_FOUND', 'Member not found');
      memberId = member.id;
      if (savedIds.some((id) => !member.childIds.has(id))) {
        throw new DeskRefusal(400, 'BAD_REQUEST', "One or more children are not on this guardian's saved list — look the guardian up again.");
      }
    } else if (savedIds.length > 0) {
      throw new DeskRefusal(400, 'BAD_REQUEST', 'A saved child needs the guardian it is saved under — send the memberId too.');
    }
    if (body.photoId) {
      if (!this.host.photosEnabled()) throw refuse(409, BOX_CHECKIN_REFUSALS.photosOff);
      await this.pendingPhoto(body.photoId, body.registrationId, 'consent');
    }

    const now = this.host.now().toISOString();
    const acknowledged = buildAcknowledgedConfirmations(policy, body.acknowledgedConfirmationIds, now);
    const fact: OfflineCheckinCreated = {
      registrationId: body.registrationId,
      memberId,
      visitId: body.visitId ?? null,
      guardianName: body.guardianName.trim(),
      guardianPhone,
      contactChannel: body.contactChannel,
      consentRecordedAt: now,
      acknowledgedConfirmations: acknowledged,
      children: body.children,
      photoId: body.photoId ?? null,
    };
    const family: Omit<BridgeCheckinFamily, 'children' | 'guardians' | 'tab' | 'origin'> & { photoId: string | null } = {
      registrationId: body.registrationId,
      branchId: station.branchId,
      memberId,
      guardianName: fact.guardianName,
      guardianPhone,
      contactChannel: body.contactChannel,
      consentRecordedAt: now,
      source: 'till',
      photoFileId: null,
      photoId: body.photoId ?? null,
      createdAt: now,
      contact: null,
    };
    const children: BridgeCheckinChild[] = body.children.map((c) => {
      const provision =
        c.foodProvision && c.foodProvision.mode !== 'none' && c.foodProvision.paidSatang <= 0
          ? { mode: 'none' as const, paidSatang: 0 }
          : (c.foodProvision ?? null);
      return {
        id: c.checkinId,
        registrationId: body.registrationId,
        childId: c.childId ?? null,
        childName: c.name.trim(),
        childAgeYears: c.ageYears,
        dateOfBirth: c.dateOfBirth ?? null,
        allergies: c.allergies?.trim() || null,
        foodRestrictions: c.foodRestrictions?.trim() || null,
        mayOrderFood: !!provision && provision.mode !== 'none' && provision.paidSatang > 0,
        foodProvision: provision,
        service: c.service,
        status: 'registered',
        scheduledFor: null,
        bookedMinutes: null,
        nannyId: null,
        nannyName: null,
        checkedInAt: null,
        checkedOutAt: null,
        saleId: null,
        bandId: null,
        visitId: body.visitId ?? null,
        photoFileId: null,
      };
    });
    await this.produce(
      station,
      caller,
      [
        {
          fact: { type: CHECKIN_FACTS.created, payload: fact as unknown as Record<string, unknown> },
          overlay: [
            { kind: 'registration', entityId: body.registrationId, memberId, phone: null, record: family },
            ...children.map((c) => ({
              kind: 'checkin' as const,
              entityId: c.id,
              memberId: body.registrationId,
              phone: null,
              record: c as unknown as Record<string, unknown>,
            })),
          ],
        },
      ],
      actionId,
      {
        check: async (tx) => {
          if (await tx.readOverlay(this.host.boxId, 'registration', body.registrationId)) {
            throw new DeskRefusal(409, 'ID_IN_USE', 'That registration is being written by another till');
          }
        },
      },
    );
    await this.nameTarget(body.photoId, 'registration', body.registrationId);
    const after = (await this.view()).families.get(body.registrationId);
    return { registration: after ? this.registrationOf(after) : null };
  }

  private async waiver(
    station: DeskStation,
    caller: DeskCaller,
    payload: Record<string, unknown>,
    actionId: string | null,
  ): Promise<Record<string, unknown>> {
    this.require(caller, 'pos:checkin:update');
    const body = this.parse(BridgeWaiverCreateSchema, payload);
    const key = `checkin_waiver:${body.waiverId}`;
    if (this.host.store.features().boothRuntime && (await this.host.store.readRuntimeValue(this.host.boxId, key))) {
      return { id: body.waiverId, siblingName: body.sibling.name, replayed: true };
    }
    const view = await this.view();
    const refusal = waiverRefusal(
      { childAge: body.child.ageYears, siblingAge: body.sibling.ageYears, waivedRequirement: body.waivedRequirement },
      view.policy,
    );
    if (refusal) throw new DeskRefusal(409, 'WAIVER_REFUSED', refusal);
    const fact: OfflineWaiverCreated = { ...body };
    await this.produce(
      station,
      caller,
      [{ fact: { type: CHECKIN_FACTS.waiver, payload: fact as unknown as Record<string, unknown> }, overlay: [] }],
      actionId,
      {
        check: async (tx) => {
          if (tx.features().boothRuntime && (await tx.readRuntimeValue(this.host.boxId, key))) {
            throw new DeskRefusal(409, 'ID_IN_USE', 'That waiver is being written by another till');
          }
        },
        extra: async (tx) => {
          if (tx.features().boothRuntime) await tx.writeRuntimeValue(this.host.boxId, key, '1');
        },
      },
    );
    return { id: body.waiverId, siblingName: body.sibling.name.trim(), childName: body.child.name.trim() };
  }

  // --- after payment, and the board's edits -----------------------------------------------

  private async update(
    station: DeskStation,
    caller: DeskCaller,
    payload: Record<string, unknown>,
    actionId: string | null,
  ): Promise<Record<string, unknown>> {
    this.require(caller, 'pos:checkin:update');
    const body: BridgeCheckinUpdate = this.parse(BridgeCheckinUpdateSchema, payload);
    if (body.event === 'check_in_now') {
      return holding(
        body.entries.map((e) => `${this.host.boxId}:stay:${e.checkinId}`),
        {
          code: 'CHECKIN_IN_PROGRESS',
          message: 'Another till on this counter is checking this child in right now. Wait a moment, then look again.',
        },
        () => this.checkInNow(station, caller, body, actionId),
      );
    }
    if (body.event === 'leave_as_booked') return this.leaveAsBooked(station, caller, body, actionId);
    return this.edit(station, caller, body, actionId);
  }

  /** The sale's deferred bands, when this box took the sale: the ledger line each stay admits against. */
  private async deferredOf(saleId: string): Promise<{ onBox: boolean; bands: DeferredBand[] }> {
    const recorded = await this.host.sales()?.recorded(saleId).catch(() => null);
    if (!recorded) return { onBox: false, bands: [] };
    const memo = rec(recorded.memo);
    const deferred = Array.isArray(memo?.deferredBands) ? (memo.deferredBands as DeferredBand[]) : [];
    return { onBox: true, bands: deferred };
  }

  private nannyCheck(view: DeskView, nannyId: string, excludeCheckinId: string, now: Date): { name: string; warning: string | null } {
    const nanny = view.nannies.find((n) => n.id === nannyId);
    if (!nanny) throw new DeskRefusal(409, 'NANNY_NOT_ON_ROSTER', "That nanny is not on this park's roster.");
    if (!this.onShift(nanny, now)) {
      throw new DeskRefusal(409, 'NANNY_NOT_ON_SHIFT', `${nanny.name} is not on shift — pick a nanny who is working now.`);
    }
    let load = 0;
    for (const fam of view.families.values()) {
      for (const c of fam.children) if (c.nannyId === nannyId && c.status !== 'out' && c.id !== excludeCheckinId) load += 1;
    }
    const softMax = view.pricing.nannyRatioSoftMax;
    const after = load + 1;
    return {
      name: nanny.name,
      warning:
        after > softMax
          ? `${nanny.name} would be looking after ${after} children (over the suggested ${softMax}). Allowed — just double-check it's okay.`
          : null,
    };
  }

  /**
   * "CHECK IN NOW" with the link down — the platform's `checkInNow`, on the
   * box: every child validated before any is written; then, in ONE store
   * transaction, their bands minted with the park's key and their paper
   * queued (`SaleQueue.issueCheckinBands`), one `checkin.updated` fact per
   * child carrying its band, and the overlay showing them in the park. The
   * bands print after the commit, as a sale's do. A band that cannot be
   * minted checks nobody in.
   */
  private async checkInNow(
    station: DeskStation,
    caller: DeskCaller,
    body: Extract<BridgeCheckinUpdate, { event: 'check_in_now' }>,
    actionId: string | null,
  ): Promise<Record<string, unknown>> {
    const now = this.host.now();
    const view = await this.view();
    const stays = body.entries.map((e) => {
      const found = this.findStay(view, e.checkinId);
      if (!found) throw refuse(404, BOX_CHECKIN_REFUSALS.noCopy, { checkinId: e.checkinId });
      return { ...found, nannyId: e.nannyId ?? null };
    });
    // A retry of a check-in that landed: every child in the park on THIS sale with a band.
    if (stays.every((s) => s.child.status === 'in_park' && s.child.saleId === body.saleId && !!s.child.bandId)) {
      return {
        saleId: body.saleId,
        children: stays.map((s) => s.child),
        bands: stays.map((s) => ({ id: s.child.bandId!, checkinId: s.child.id, childName: s.child.childName, shortCode: null })),
        printJobs: [],
        notes: [],
        replay: true,
      };
    }
    const deferred = await this.deferredOf(body.saleId);
    for (const s of stays) {
      if (s.child.status !== 'registered') {
        throw new DeskRefusal(
          409,
          'CHECKIN_NOT_REGISTERED',
          `${s.child.childName} is already ${s.child.status === 'in_park' ? 'checked in' : 'checked out'}.`,
        );
      }
      if (s.child.saleId && s.child.saleId !== body.saleId) {
        throw new DeskRefusal(409, 'CHECKIN_OTHER_SALE', `${s.child.childName} was paid for on another sale.`);
      }
      if (deferred.onBox && !deferred.bands.some((b) => b.cartLineId === s.child.id)) {
        throw new DeskRefusal(
          409,
          'CHECKIN_NOT_ON_SALE',
          `${s.child.childName} is not on this sale — add their drop-off line and take the payment again.`,
        );
      }
    }
    const nannyOf = new Map<string, { id: string; name: string } | null>();
    for (const s of stays) {
      if (s.child.service !== 'nanny') {
        nannyOf.set(s.child.id, null);
        continue;
      }
      const id = s.nannyId ?? s.child.nannyId;
      if (!id) throw new DeskRefusal(409, 'NANNY_REQUIRED', `Assign a nanny to ${s.child.childName} before checking them in.`);
      const checked = this.nannyCheck(view, id, s.child.id, now);
      nannyOf.set(s.child.id, { id, name: checked.name });
    }
    const queue = this.host.sales();
    if (!queue) {
      throw new DeskRefusal(
        503,
        'BOX_AGENT_ELSEWHERE',
        'This counter’s box is not running here, so it cannot check anybody in right now',
      );
    }
    const seal = this.host.sealer();
    if (!seal) {
      throw new DeskRefusal(503, 'BOX_AGENT_ELSEWHERE', 'This counter’s box is not running here, so it cannot record anything right now');
    }
    const plans: CheckinBandPlan[] = stays.map((s) => {
      const plan = deferred.bands.find((b) => b.cartLineId === s.child.id);
      const nanny = nannyOf.get(s.child.id) ?? null;
      const hours = plan?.stayHours ?? (s.child.bookedMinutes ? s.child.bookedMinutes / 60 : null);
      return {
        kind: 'kid',
        cartLineId: s.child.id,
        saleLineId: plan?.saleLineId ?? null,
        childId: s.child.childId,
        childName: s.child.childName,
        allergies: s.child.allergies,
        medicalNotes: plan?.medicalNotes ?? null,
        dietary: s.child.foodRestrictions,
        supervisionBadge: supervisionBadgeOf(s.child.service),
        nannyName: nanny?.name ?? null,
        stayHours: hours,
      };
    });
    const at = now.toISOString();
    try {
      const issued = await queue.issueCheckinBands({
        stationId: station.id,
        saleId: body.saleId,
        actionId,
        staffName: body.staffName ?? null,
        bands: plans,
        write: async (tx, minted) => {
          const writes = stays.map((s, i) => {
            const band = minted[i]!;
            const plan = plans[i]!;
            const nanny = nannyOf.get(s.child.id) ?? null;
            const bookedMinutes = plan.stayHours ? Math.round(plan.stayHours * 60) : s.child.bookedMinutes;
            const next: BridgeCheckinChild = {
              ...s.child,
              status: 'in_park',
              checkedInAt: at,
              scheduledFor: null,
              bookedMinutes,
              nannyId: nanny?.id ?? null,
              nannyName: nanny?.name ?? null,
              saleId: body.saleId,
              bandId: band.id,
            };
            const fact: OfflineCheckinUpdated = {
              checkinId: s.child.id,
              event: 'check_in_now',
              at,
              saleId: body.saleId,
              scheduledFor: null,
              bookedMinutes: bookedMinutes ?? null,
              nannyId: nanny?.id ?? null,
              band: {
                id: band.id,
                code: band.code,
                kind: 'kid',
                cartLineId: s.child.id,
                saleLineId: band.saleLineId ?? null,
                childId: s.child.childId,
              },
            };
            return {
              fact: { type: CHECKIN_FACTS.updated, payload: fact as unknown as Record<string, unknown> },
              overlay: [
                {
                  kind: 'checkin' as const,
                  entityId: s.child.id,
                  memberId: s.family.registrationId,
                  phone: null,
                  record: { ...next, bandShortCode: bandShortCode(band.code) } as unknown as Record<string, unknown>,
                },
              ],
            };
          });
          await this.produce(station, caller, writes, actionId, {
            tx,
            check: async (inner) => {
              // Another till on this box got there first: nothing half-lands.
              for (const s of stays) {
                const held = await inner.readOverlay(this.host.boxId, 'checkin', s.child.id);
                const status = (held?.record as { status?: string } | undefined)?.status;
                if (status && status !== 'registered') {
                  throw new DeskRefusal(409, 'CHECKIN_NOT_REGISTERED', `${s.child.childName} is already checked in.`);
                }
              }
            },
          });
        },
      });
      const after = await this.view();
      return {
        saleId: body.saleId,
        children: stays.map((s) => this.findStay(after, s.child.id)?.child ?? s.child),
        bands: issued.bands.map((b, i) => ({
          id: b.id,
          checkinId: stays[i]!.child.id,
          childName: stays[i]!.child.childName,
          shortCode: bandShortCode(b.code),
        })),
        printJobs: issued.printing.jobs.map((j) => ({ id: j.id, kind: j.kind, status: j.status })),
        notes: issued.printing.notes,
        replay: false,
      };
    } catch (err) {
      if (err instanceof CheckinBandRefused) throw new DeskRefusal(503, err.code, err.message);
      throw err;
    }
  }

  /** "LEAVE AS BOOKED": the booked start and length and the sale linked — no band. */
  private async leaveAsBooked(
    station: DeskStation,
    caller: DeskCaller,
    body: Extract<BridgeCheckinUpdate, { event: 'leave_as_booked' }>,
    actionId: string | null,
  ): Promise<Record<string, unknown>> {
    const view = await this.view();
    const deferred = await this.deferredOf(body.saleId);
    const scheduledFor = body.scheduledFor ?? this.host.now().toISOString();
    const stays = body.entries.map((e) => {
      const found = this.findStay(view, e.checkinId);
      if (!found) throw refuse(404, BOX_CHECKIN_REFUSALS.noCopy, { checkinId: e.checkinId });
      if (found.child.status !== 'registered') {
        throw new DeskRefusal(
          409,
          'CHECKIN_NOT_REGISTERED',
          `${found.child.childName} is already ${found.child.status === 'in_park' ? 'checked in' : 'checked out'}.`,
        );
      }
      if (found.child.saleId && found.child.saleId !== body.saleId) {
        throw new DeskRefusal(409, 'CHECKIN_OTHER_SALE', `${found.child.childName} was paid for on another sale.`);
      }
      return found;
    });
    if (stays.every((s) => s.child.saleId === body.saleId && s.child.scheduledFor)) {
      return { saleId: body.saleId, children: stays.map((s) => s.child), replay: true };
    }
    const at = this.host.now().toISOString();
    await this.produce(
      station,
      caller,
      stays.map((s) => {
        const plan = deferred.bands.find((b) => b.cartLineId === s.child.id);
        const bookedMinutes = plan?.stayHours ? Math.round(plan.stayHours * 60) : s.child.bookedMinutes;
        const fact: OfflineCheckinUpdated = {
          checkinId: s.child.id,
          event: 'leave_as_booked',
          at,
          saleId: body.saleId,
          scheduledFor,
          bookedMinutes: bookedMinutes ?? null,
        };
        return {
          fact: { type: CHECKIN_FACTS.updated, payload: fact as unknown as Record<string, unknown> },
          overlay: [
            {
              kind: 'checkin' as const,
              entityId: s.child.id,
              memberId: s.family.registrationId,
              phone: null,
              record: { ...s.child, scheduledFor, bookedMinutes, saleId: body.saleId } as unknown as Record<string, unknown>,
            },
          ],
        };
      }),
      actionId,
    );
    const after = await this.view();
    return { saleId: body.saleId, children: stays.map((s) => this.findStay(after, s.child.id)?.child ?? s.child) };
  }

  /** The board's audited edit and the nanny assignment, offline. */
  private async edit(
    station: DeskStation,
    caller: DeskCaller,
    body: Extract<BridgeCheckinUpdate, { event: 'edit' | 'assign_nanny' }>,
    actionId: string | null,
  ): Promise<Record<string, unknown>> {
    const now = this.host.now();
    const view = await this.view();
    const found = this.findStay(view, body.checkinId);
    if (!found) throw refuse(404, BOX_CHECKIN_REFUSALS.noCopy, { checkinId: body.checkinId });
    const stay = found.child;
    const warnings: string[] = [];
    const fields: NonNullable<OfflineCheckinUpdated['fields']> = body.event === 'edit' ? body.fields : {};
    const next: BridgeCheckinChild = {
      ...stay,
      ...(fields.childName !== undefined ? { childName: fields.childName.trim() } : {}),
      ...(fields.childAgeYears !== undefined ? { childAgeYears: fields.childAgeYears } : {}),
      ...(fields.service !== undefined ? { service: fields.service } : {}),
      ...(fields.mayOrderFood !== undefined ? { mayOrderFood: fields.mayOrderFood } : {}),
      ...(fields.foodRestrictions !== undefined ? { foodRestrictions: fields.foodRestrictions?.trim() || null } : {}),
      ...(fields.allergies !== undefined ? { allergies: fields.allergies?.trim() || null } : {}),
      ...(fields.bookedMinutes !== undefined ? { bookedMinutes: fields.bookedMinutes } : {}),
    };
    const nannyId: string | null | undefined = body.nannyId;
    if (body.event === 'assign_nanny') next.service = 'nanny';
    if (nannyId !== undefined) next.nannyId = nannyId;
    if (next.service !== 'nanny') next.nannyId = null;
    if (next.nannyId && next.nannyId !== stay.nannyId) {
      if (stay.status === 'out') {
        throw new DeskRefusal(409, 'CHECKIN_OUT', `${stay.childName} has already been collected — no nanny is needed.`);
      }
      const checked = this.nannyCheck(view, next.nannyId, stay.id, now);
      next.nannyName = checked.name;
      if (checked.warning) warnings.push(checked.warning);
    }
    if (!next.nannyId) next.nannyName = null;
    const changedKeys = (
      ['childName', 'childAgeYears', 'service', 'bookedMinutes', 'mayOrderFood', 'foodRestrictions', 'allergies', 'nannyId'] as const
    ).filter((k) => next[k] !== stay[k]);
    if (changedKeys.length === 0) {
      return { checkin: stay, changed: 0, warnings, contact: null };
    }
    const fact: OfflineCheckinUpdated = {
      checkinId: stay.id,
      event: body.event,
      at: now.toISOString(),
      ...(changedKeys.includes('nannyId') ? { nannyId: next.nannyId } : {}),
      fields: Object.fromEntries(
        changedKeys.filter((k) => k !== 'nannyId').map((k) => [k, next[k]]),
      ) as OfflineCheckinUpdated['fields'],
    };
    await this.produce(
      station,
      caller,
      [
        {
          fact: { type: CHECKIN_FACTS.updated, payload: fact as unknown as Record<string, unknown> },
          overlay: [
            {
              kind: 'checkin',
              entityId: stay.id,
              memberId: found.family.registrationId,
              phone: null,
              record: next as unknown as Record<string, unknown>,
            },
          ],
        },
      ],
      actionId,
    );
    return { checkin: next, changed: changedKeys.length, warnings, contact: null };
  }

  // --- pickups and release --------------------------------------------------------------------

  private async context(caller: DeskCaller, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.require(caller, 'pos:checkin:read');
    const checkinId = typeof payload.checkinId === 'string' ? payload.checkinId : '';
    const view = await this.view();
    const found = this.findStay(view, checkinId);
    if (!found) throw refuse(404, BOX_CHECKIN_REFUSALS.noCopy, { checkinId });
    const { family, child } = found;
    const signUp = child.photoFileId ?? family.photoFileId;
    const release = view.releases.get(child.id) ?? null;
    return {
      checkinId: child.id,
      registrationId: family.registrationId,
      branchId: family.branchId,
      childName: child.childName,
      childAgeYears: child.childAgeYears,
      guardianName: family.guardianName,
      status: child.status,
      signUpPhotoFileId: signUp,
      pickups: this.pickupsOf(family, signUp),
      reconciliation: this.reconciliationOf(child),
      prepaidPolicy: view.pricing.prepaidFoodUnused,
      release: release ? this.releaseViewOf(view, release) : null,
      photosEnabled: this.host.photosEnabled(),
      source: 'box',
    };
  }

  private async guardian(
    station: DeskStation,
    caller: DeskCaller,
    payload: Record<string, unknown>,
    actionId: string | null,
  ): Promise<Record<string, unknown>> {
    this.require(caller, 'pos:checkin:guardian_manage');
    const body = this.parse(BridgeGuardianCreateSchema, payload);
    const view = await this.view();
    const family = view.families.get(body.registrationId);
    if (!family) throw refuse(404, BOX_CHECKIN_REFUSALS.noCopy, { registrationId: body.registrationId });
    const again = family.guardians.find((g) => g.id === body.guardianId);
    if (again) return { ...this.pickupsOf(family, null).find((p) => p.id === again.id)!, replayed: true };
    const written = await this.writeGuardian(station, caller, view, family, body, actionId);
    return { ...written };
  }

  private validateGuardian(
    family: BridgeCheckinFamily,
    input: { guardianId: string; name: string; source: BridgeGuardian['source']; photoId?: string | null | undefined },
  ): void {
    if (!input.name.trim()) throw new DeskRefusal(400, 'COLLECTOR_NAME_REQUIRED', RELEASE_REFUSALS.COLLECTOR_NAME_REQUIRED);
    if (this.host.photosEnabled()) {
      if (!input.photoId && input.source === 'on_the_spot') {
        throw new DeskRefusal(400, 'COLLECTOR_PHOTO_REQUIRED', RELEASE_REFUSALS.COLLECTOR_PHOTO_REQUIRED);
      }
      if (!input.photoId && input.source === 'from_chat') {
        throw new DeskRefusal(400, 'CHAT_PHOTO_REQUIRED', 'Pick the chat photo to promote — a pickup from chat is added with that photo.');
      }
    } else if (input.photoId) {
      throw refuse(409, BOX_CHECKIN_REFUSALS.photosOff);
    }
    if (family.guardians.some((g) => g.id === input.guardianId)) {
      throw new DeskRefusal(409, 'ID_IN_USE', 'That id already names someone on a pickup list');
    }
  }

  private guardianWrite(
    family: BridgeCheckinFamily,
    input: { guardianId: string; name: string; relationship?: string | null; phone?: string | null; source: BridgeGuardian['source']; photoId?: string | null },
  ): { fact: OfflineGuardianCreated; record: BridgeGuardian & { photoId: string | null } } {
    let phone: string | null = null;
    if (input.phone?.trim()) {
      phone = normalizePhone(input.phone);
      if (!phone) throw new DeskRefusal(400, 'BAD_REQUEST', "That phone number doesn't look right — check it with the collector.");
    }
    const now = this.host.now().toISOString();
    return {
      fact: {
        guardianId: input.guardianId,
        registrationId: family.registrationId,
        name: input.name.trim(),
        relationship: input.relationship?.trim() || null,
        phone,
        source: input.source,
        photoId: input.photoId ?? null,
      },
      record: {
        id: input.guardianId,
        registrationId: family.registrationId,
        name: input.name.trim(),
        relationship: input.relationship?.trim() || null,
        phone,
        photoFileId: null,
        photoId: input.photoId ?? null,
        source: input.source,
        revoked: false,
        createdAt: now,
        photoPendingUpload: !!input.photoId,
      },
    };
  }

  private async writeGuardian(
    station: DeskStation,
    caller: DeskCaller,
    _view: DeskView,
    family: BridgeCheckinFamily,
    body: { guardianId: string; registrationId: string; name: string; relationship?: string | null; phone?: string | null; source: BridgeGuardian['source']; photoId?: string | null },
    actionId: string | null,
  ): Promise<PickupView> {
    this.validateGuardian(family, body);
    if (body.photoId) await this.pendingPhoto(body.photoId, family.registrationId, 'collector');
    const { fact, record } = this.guardianWrite(family, body);
    await this.produce(
      station,
      caller,
      [
        {
          fact: { type: CHECKIN_FACTS.guardian, payload: fact as unknown as Record<string, unknown> },
          overlay: [
            { kind: 'guardian', entityId: body.guardianId, memberId: family.registrationId, phone: null, record: record as unknown as Record<string, unknown> },
          ],
        },
      ],
      actionId,
    );
    await this.nameTarget(body.photoId, 'guardian', body.guardianId);
    return this.pickupsOf({ ...family, guardians: [...family.guardians, { ...record, photoFileId: body.photoId ?? null }] }, null).find(
      (p) => p.id === body.guardianId,
    )!;
  }

  /**
   * A RELEASE with the link down — the platform's `releaseChild`, on the box.
   * R-92 held HERE: the collector is the dropper-off, a listed and unrevoked
   * person, or someone added on the spot with their name and photo; the live
   * pickup photo is required while CHILD_PHOTOS_ENABLED is on. In ONE store
   * transaction: the on-the-spot person's `guardian.created`, the
   * `release.created` with `photo_pending_upload`, and the overlay showing the
   * child out. Unused prepaid food is recorded by policy and refunded by hand
   * when the link is back — refunds are online only.
   */
  private async release(
    station: DeskStation,
    caller: DeskCaller,
    payload: Record<string, unknown>,
    actionId: string | null,
  ): Promise<Record<string, unknown>> {
    this.require(caller, 'pos:checkin:release');
    const body: BridgeReleaseCreate = this.parse(BridgeReleaseCreateSchema, payload);
    return holding([`${this.host.boxId}:stay:${body.checkinId}`], BOX_CHECKIN_REFUSALS.releaseInProgress, () =>
      this.releaseHeld(station, caller, body, actionId),
    );
  }

  private async releaseHeld(
    station: DeskStation,
    caller: DeskCaller,
    body: BridgeReleaseCreate,
    actionId: string | null,
  ): Promise<Record<string, unknown>> {
    const view = await this.view();
    const found = this.findStay(view, body.checkinId);
    if (!found) throw refuse(404, BOX_CHECKIN_REFUSALS.noCopy, { checkinId: body.checkinId });
    const { family, child } = found;
    const already = view.releases.get(child.id);
    if (already) {
      if (already.id === body.releaseId) return { replay: true, release: this.releaseViewOf(view, already) };
      throw new DeskRefusal(409, 'ALREADY_RELEASED', `${child.childName} was already collected by ${already.collectorName}.`, {
        releaseId: already.id,
      });
    }
    if (child.status !== 'in_park') {
      throw new DeskRefusal(
        409,
        'CHECKIN_NOT_IN_PARK',
        child.status === 'registered'
          ? `${child.childName} has not been checked in yet — only a child in the park can be collected.`
          : `${child.childName} has already left the park.`,
      );
    }
    const photos = this.host.photosEnabled();
    if (photos) {
      if (!body.pickupPhotoId) throw new DeskRefusal(400, 'PICKUP_PHOTO_REQUIRED', RELEASE_REFUSALS.PICKUP_PHOTO_REQUIRED);
      // The live photo: never the sign-up photo it is compared with.
      if (body.pickupPhotoId === family.photoFileId || body.pickupPhotoId === child.photoFileId) {
        throw new DeskRefusal(400, 'PICKUP_PHOTO_REQUIRED', RELEASE_REFUSALS.PICKUP_PHOTO_REQUIRED);
      }
      await this.pendingPhoto(body.pickupPhotoId, family.registrationId, 'pickup');
    } else if (body.pickupPhotoId) {
      throw refuse(409, BOX_CHECKIN_REFUSALS.photosOff);
    }

    let guardianId: string | null = null;
    let collectorName = family.guardianName;
    let onTheSpot: ReturnType<CheckinDesk['guardianWrite']> | null = null;
    const collector = body.collector;
    if (collector.kind === 'guardian' && collector.guardianId !== DROPPER_OFF_PICKUP_ID) {
      const g = ID.test(collector.guardianId) ? family.guardians.find((x) => x.id === collector.guardianId) : undefined;
      if (!g) throw new DeskRefusal(409, 'COLLECTOR_NOT_LISTED', RELEASE_REFUSALS.COLLECTOR_NOT_LISTED);
      if (g.revoked) throw new DeskRefusal(409, 'COLLECTOR_REVOKED', revokedCollectorRefusal(g.name));
      guardianId = g.id;
      collectorName = g.name;
    } else if (collector.kind === 'on_the_spot') {
      const input = { ...collector, registrationId: family.registrationId, source: 'on_the_spot' as const };
      this.validateGuardian(family, input);
      if (collector.photoId) {
        if (collector.photoId === body.pickupPhotoId) {
          throw new DeskRefusal(400, 'COLLECTOR_PHOTO_REQUIRED', RELEASE_REFUSALS.COLLECTOR_PHOTO_REQUIRED);
        }
        await this.pendingPhoto(collector.photoId, family.registrationId, 'collector');
      }
      onTheSpot = this.guardianWrite(family, input);
      guardianId = collector.guardianId;
      collectorName = onTheSpot.record.name;
    }

    const reconciliation = this.reconciliationOf(child);
    const unused = reconciliation?.totalUnusedSatang ?? 0;
    const policy = view.pricing.prepaidFoodUnused;
    const at = this.host.now().toISOString();
    const record: BridgeReleaseRecord & { pickupPhotoId: string | null } = {
      id: body.releaseId,
      checkinId: child.id,
      registrationId: family.registrationId,
      guardianId,
      collectorName,
      verifiedByAccountId: caller.accountId,
      pickupPhotoFileId: null,
      pickupPhotoId: body.pickupPhotoId ?? null,
      photoPendingUpload: !!body.pickupPhotoId,
      stationId: station.id,
      checkedOutAt: at,
      prepaid: unused > 0 ? { policy, unusedSatang: unused } : null,
    };
    const fact: OfflineReleaseCreated = {
      releaseId: body.releaseId,
      checkinId: child.id,
      registrationId: family.registrationId,
      collector: guardianId ? { kind: 'guardian', guardianId } : { kind: 'dropper_off' },
      collectorName,
      pickupPhotoId: body.pickupPhotoId ?? null,
      releasedAt: at,
      prepaid: record.prepaid,
    };
    const writes: Parameters<CheckinDesk['produce']>[2] = [];
    if (onTheSpot) {
      writes.push({
        fact: { type: CHECKIN_FACTS.guardian, payload: onTheSpot.fact as unknown as Record<string, unknown> },
        overlay: [
          {
            kind: 'guardian',
            entityId: onTheSpot.record.id,
            memberId: family.registrationId,
            phone: null,
            record: onTheSpot.record as unknown as Record<string, unknown>,
          },
        ],
      });
    }
    writes.push({
      fact: { type: CHECKIN_FACTS.release, payload: fact as unknown as Record<string, unknown> },
      overlay: [
        { kind: 'release', entityId: body.releaseId, memberId: family.registrationId, phone: null, record: record as unknown as Record<string, unknown> },
        {
          kind: 'checkin',
          entityId: child.id,
          memberId: family.registrationId,
          phone: null,
          record: { ...child, status: 'out', checkedOutAt: at } as unknown as Record<string, unknown>,
        },
      ],
    });
    await this.produce(station, caller, writes, actionId, {
      check: async (tx) => {
        for (const row of await this.overlay('release', tx)) {
          const held = row.record as unknown as BridgeReleaseRecord;
          if (held.checkinId === child.id && row.entityId !== body.releaseId) {
            throw new DeskRefusal(409, 'ALREADY_RELEASED', `${child.childName} was already collected by ${held.collectorName}.`);
          }
        }
      },
    });
    await this.nameTarget(body.pickupPhotoId, 'release', body.releaseId);
    if (collector.kind === 'on_the_spot') await this.nameTarget(collector.photoId, 'guardian', collector.guardianId);
    const after = await this.view();
    const written = after.releases.get(child.id);
    return { replay: false, release: written ? this.releaseViewOf(after, written) : null };
  }

  // --- the overlay's end -------------------------------------------------------------------

  /**
   * Let the `checkin` copy speak for a row again: its fact ACCEPTED, and a
   * `checkin` pull landed after that. A row naming a photo the upload worker
   * has not linked yet is kept — the worker reads its row from here.
   */
  async pruneOverlay(): Promise<number> {
    const store = this.host.store;
    if (!store.features().overlay) return 0;
    const bundle = await store.readBundle(this.host.boxId, 'checkin').catch(() => null);
    if (!bundle) return 0;
    const pulledAt = Date.parse(bundle.appliedAt);
    const rows = (await store.allOverlay(this.host.boxId)).filter((r) =>
      (CHECKIN_OVERLAY_KINDS as readonly string[]).includes(r.kind),
    );
    if (rows.length === 0) return 0;
    const states = await store.outboxStates(
      this.host.boxId,
      rows.map((r) => r.eventId).filter((id): id is string => !!id),
    );
    const blobs = this.host.blobs();
    const done: Array<{ kind: BoxOverlayKind; entityId: string }> = [];
    for (const row of rows) {
      const state = row.eventId ? states.get(row.eventId) : undefined;
      if (!state || state.state !== 'acked' || !state.ackedAt) continue;
      if (Date.parse(state.ackedAt) >= pulledAt) continue;
      const photoId = (row.record.photoId ?? row.record.pickupPhotoId) as string | null | undefined;
      if (photoId && blobs) {
        const meta = await blobs.get(photoId);
        if (meta && !meta.linkedAt) continue;
      }
      done.push({ kind: row.kind, entityId: row.entityId });
    }
    return store.deleteOverlay(this.host.boxId, done);
  }

  /** The row a photo was taken for, from what this counter recorded — for the upload worker. */
  async photoTarget(photoId: string): Promise<{ kind: PhotoTarget; id: string } | null> {
    const view = await this.view();
    for (const [key, id] of view.photoOf) {
      if (id !== photoId) continue;
      const [kind, entityId] = key.split(':') as [PhotoTarget, string];
      return { kind, id: entityId };
    }
    return null;
  }
}
