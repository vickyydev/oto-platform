import { z } from 'zod';
import { GUARDIAN_ADD_SOURCES } from './release';
import { FoodProvisionSchema, RegistrationChildSchema, SUPERVISION_REQUIREMENTS } from './supervision';

/**
 * S2-13 ROUND 4 — CHECK-IN, THE BOARD AND RELEASE ON THE BOX LANE (plan
 * docs/progress/plans/checkin/PLAN.md §2.5).
 *
 * The till's gate, consent, "Check in now", the board's basics and the release
 * answer from the counter's BOX when the link is down, exactly as selling does
 * (`station-bridge.ts`): each write is an intent the box turns into a FACT on
 * its outbox and a row in its offline overlay, in ONE store transaction, under
 * the ids the till minted (OD-12) — so a retry meets itself and the platform
 * files each fact once.
 *
 * This file is the wire both ends read: the intents a till sends its box, the
 * facts a box sends the platform (the sync handlers' own payloads, declared
 * once), the refusals in the counter's words, and the photo bounds.
 *
 * NEVER, under any flow, is a photo of an identity document taken (C9): every
 * photo here is a face — the child with the guardian, a collector, a pickup —
 * and nothing in this wire has a field for anything else.
 */

const Uuid = z.string().uuid();
const IsoDateTime = z.string().datetime({ offset: true });
const OfflineFresh = z.boolean().optional();

// --- The intents a till sends its box ----------------------------------------------

/**
 * The record intents (writes) and the two reads the box answers from its copy.
 * Write intents become the facts in `CHECKIN_FACTS`.
 */
export const BRIDGE_CHECKIN_INTENTS = {
  /** The gate's registration: consent, its confirmations, one `registered` stay per child. */
  create: 'checkin.create',
  /** Check in now, leave as booked, a board edit, a nanny assignment. */
  update: 'checkin.update',
  /** The staff-accepted sibling waiver (OD-C3). */
  waiver: 'waiver.create',
  /** Someone added to a registration's pickup list. */
  guardian: 'guardian.create',
  /** A child handed to their collector. */
  release: 'release.create',
  /** A photo the counter just took, kept on the box until the link is back. */
  photo: 'photo.capture',
  /** The board, from the box's copy with what this counter recorded laid over it. */
  board: 'checkin.board',
  /** The supervision config and nanny roster the gate reads. */
  config: 'checkin.config',
  /** Registrations still waiting to be checked in (the gate's waiting-bookings picker). */
  awaiting: 'checkin.awaiting',
  /** Everything the release modal shows for one stay. */
  context: 'release.context',
} as const;
export type BridgeCheckinIntent = (typeof BRIDGE_CHECKIN_INTENTS)[keyof typeof BRIDGE_CHECKIN_INTENTS];

export const BRIDGE_CHECKIN_INTENT_TYPES: ReadonlySet<string> = new Set(Object.values(BRIDGE_CHECKIN_INTENTS));

/** The facts a box queues for the platform (the sync handlers' names). */
export const CHECKIN_FACTS = {
  created: 'checkin.created',
  updated: 'checkin.updated',
  waiver: 'supervision_waiver.created',
  guardian: 'guardian.created',
  release: 'release.created',
} as const;

/** The overlay kinds a box keeps for the check-in domain (beside member, child, visit). */
export const CHECKIN_OVERLAY_KINDS = ['registration', 'checkin', 'guardian', 'release'] as const;
export type CheckinOverlayKind = (typeof CHECKIN_OVERLAY_KINDS)[number];

// --- Photos on the box ---------------------------------------------------------------

/**
 * THE BOX'S PHOTO STORE (plan §2.5). A photo captured with the link down is
 * kept on the Pi's own disk, uploaded through the platform when the link is
 * back, and deleted SEVEN days after the upload. The store is bounded: past
 * `capBytes` — or with less than `minFreeBytes` left on the disk — capture is
 * REFUSED in plain words before the disk suffers. A photo is never larger than
 * `maxPhotoBytes`: the till shrinks it on the box lane, and the box checks.
 */
export const OFFLINE_PHOTO_POLICY = {
  /** One photo, after the till's shrink to 960 px at JPEG 0.7 — typically 60–140 KB. */
  maxPhotoBytes: 400 * 1024,
  /** The whole store. A week of photos at the park's volume is far below this (see the round's measurement). */
  capBytes: 1024 * 1024 * 1024,
  /** Refuse capture before the card itself runs low, whatever the store holds. */
  minFreeBytes: 512 * 1024 * 1024,
  /** Uploaded photos are deleted this long after the upload. */
  purgeAfterUploadDays: 7,
  /** A photo nothing ever named (a capture abandoned mid-flow) is deleted this long after capture. */
  purgeUnlinkedAfterDays: 7,
  /** The longest edge the till shrinks a box-lane photo to. */
  shrinkToPx: 960,
} as const;

/** What a photo is OF, and so which row it is linked to once uploaded. */
export const PHOTO_TARGETS = ['registration', 'guardian', 'release'] as const;
export type PhotoTarget = (typeof PHOTO_TARGETS)[number];

/**
 * `CHILD_PHOTOS_ENABLED` (plan §2.5, OD-C2): on unless switched off. Every
 * capture on the box lane is gated by it — off, there is no capture path at
 * all, and the release goes ahead with the counter's own eyes on the stored
 * photo the platform already holds.
 */
export function childPhotosEnabled(raw: string | undefined | null): boolean {
  if (raw === undefined || raw === null || raw.trim() === '') return true;
  return !['false', '0', 'off', 'no'].includes(raw.trim().toLowerCase());
}

export const PhotoCaptureSchema = z
  .object({
    /** Client-minted; it becomes the platform's `file_object` id when the photo uploads. */
    photoId: Uuid,
    /** The registration the photo is taken for; the row it ends up on is named when it is used. */
    registrationId: Uuid,
    /** `consent` (child with guardian), `collector` (someone added on the spot), `pickup` (the handover). */
    purpose: z.enum(['consent', 'collector', 'pickup']),
    /** `data:image/jpeg;base64,…` — an image, never a document. */
    dataUrl: z.string().min(32).max(800_000),
  })
  .strict();
export type PhotoCapture = z.infer<typeof PhotoCaptureSchema>;

// --- The facts (the sync handlers' payloads) -------------------------------------------

/**
 * `checkin.created` — the family-level act, from the gate (`checkin.create`).
 * The consent's time and each confirmation's acknowledgement time are the
 * BOX's (stamped as the consent was given), so the record says when it
 * happened, not when the link came back.
 */
export const OfflineCheckinCreatedSchema = z.object({
  registrationId: Uuid,
  memberId: Uuid.nullish(),
  visitId: Uuid.nullish(),
  guardianName: z.string().trim().min(1).max(100),
  guardianPhone: z.string().max(40).nullish(),
  contactChannel: z.enum(['whatsapp', 'telegram', 'line']).default('whatsapp'),
  consentRecordedAt: IsoDateTime.nullable(),
  acknowledgedConfirmations: z
    .array(z.object({ itemId: z.string().min(1).max(200), text: z.string().max(1000), acknowledgedAt: IsoDateTime }))
    .max(50)
    .default([]),
  children: z.array(RegistrationChildSchema).min(1).max(20),
  /** The combined child-and-guardian photo taken offline, still on the box (OD-C2). */
  photoId: Uuid.nullish(),
  offlineFresh: OfflineFresh,
});
export type OfflineCheckinCreated = z.infer<typeof OfflineCheckinCreatedSchema>;

/** A band the box minted for a supervised child at "Check in now" (OD-13: the park's key, the box's id). */
export const OfflineCheckinBandSchema = z.object({
  id: Uuid,
  code: z.string().min(8).max(200),
  kind: z.literal('kid'),
  cartLineId: Uuid,
  saleLineId: Uuid.nullish(),
  childId: Uuid.nullish(),
});
export type OfflineCheckinBand = z.infer<typeof OfflineCheckinBandSchema>;

export const CHECKIN_UPDATE_EVENTS = ['check_in_now', 'leave_as_booked', 'edit', 'assign_nanny'] as const;
export type CheckinUpdateEvent = (typeof CHECKIN_UPDATE_EVENTS)[number];

/** `checkin.updated` — one stay's change, from the till's choice or the board. */
export const OfflineCheckinUpdatedSchema = z.object({
  checkinId: Uuid,
  event: z.enum(CHECKIN_UPDATE_EVENTS),
  /** When the counter did it, by the box's clock. */
  at: IsoDateTime,
  saleId: Uuid.nullish(),
  scheduledFor: IsoDateTime.nullish(),
  bookedMinutes: z.number().int().min(1).max(24 * 60).nullish(),
  nannyId: Uuid.nullish(),
  /**
   * `check_in_now` only: the service the stay was checked in on (the paid
   * line's Drop-Off / Nanny switch). Absent on a fact that does not carry
   * it = the stay's own service.
   */
  service: z.enum(SUPERVISION_REQUIREMENTS).nullish(),
  band: OfflineCheckinBandSchema.nullish(),
  fields: z
    .object({
      childName: z.string().trim().min(1).max(100).optional(),
      childAgeYears: z.number().int().min(0).max(17).optional(),
      service: z.enum(SUPERVISION_REQUIREMENTS).optional(),
      mayOrderFood: z.boolean().optional(),
      foodRestrictions: z.string().max(1000).nullable().optional(),
      allergies: z.string().max(1000).nullable().optional(),
      bookedMinutes: z.number().int().min(1).max(24 * 60).nullable().optional(),
    })
    .strict()
    .optional(),
  offlineFresh: OfflineFresh,
});
export type OfflineCheckinUpdated = z.infer<typeof OfflineCheckinUpdatedSchema>;

/** `supervision_waiver.created` — the staff-accepted sibling waiver, offline (OD-C3). */
export const OfflineWaiverCreatedSchema = z.object({
  waiverId: Uuid,
  registrationId: Uuid.nullish(),
  child: z.object({ name: z.string().trim().min(1).max(100), ageYears: z.number().int().min(0).max(17), childId: Uuid.nullish() }),
  sibling: z.object({ name: z.string().trim().min(1).max(100), ageYears: z.number().int().min(0).max(17), childId: Uuid.nullish() }),
  waivedRequirement: z.enum(['drop_off', 'nanny']),
  offlineFresh: OfflineFresh,
});
export type OfflineWaiverCreated = z.infer<typeof OfflineWaiverCreatedSchema>;

/** `guardian.created` — someone added to a pickup list; their photo (if any) is still on the box. */
export const OfflineGuardianCreatedSchema = z.object({
  guardianId: Uuid,
  registrationId: Uuid,
  name: z.string().trim().min(1).max(100),
  relationship: z.string().trim().max(100).nullish(),
  phone: z.string().max(40).nullish(),
  source: z.enum(GUARDIAN_ADD_SOURCES),
  photoId: Uuid.nullish(),
  offlineFresh: OfflineFresh,
});
export type OfflineGuardianCreated = z.infer<typeof OfflineGuardianCreatedSchema>;

/**
 * `release.created` — a child handed over with the link down. The pickup photo
 * is on the box (`photoPendingUpload`): the platform's row carries the flag
 * until the box's upload worker links the file, exactly once.
 */
export const OfflineReleaseCreatedSchema = z.object({
  releaseId: Uuid,
  checkinId: Uuid,
  registrationId: Uuid,
  collector: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('dropper_off') }),
    z.object({ kind: z.literal('guardian'), guardianId: Uuid }),
  ]),
  collectorName: z.string().trim().min(1).max(100),
  /** The live pickup photo, on the box until it uploads. Null only with CHILD_PHOTOS_ENABLED off. */
  pickupPhotoId: Uuid.nullish(),
  releasedAt: IsoDateTime,
  prepaid: z.object({ policy: z.enum(['refund', 'forfeit']), unusedSatang: z.number().int().min(0) }).nullish(),
  offlineFresh: OfflineFresh,
});
export type OfflineReleaseCreated = z.infer<typeof OfflineReleaseCreatedSchema>;

// --- The intents' bodies (what the till sends) ------------------------------------------

export const BridgeCheckinCreateSchema = z
  .object({
    registrationId: Uuid,
    memberId: Uuid.nullish(),
    visitId: Uuid.nullish(),
    guardianName: z.string().trim().min(1).max(100),
    guardianPhone: z.string().trim().max(40).nullish(),
    contactChannel: z.enum(['whatsapp', 'telegram', 'line']).default('whatsapp'),
    consentAcknowledged: z.boolean(),
    acknowledgedConfirmationIds: z.array(z.string().min(1).max(200)).max(50).default([]),
    children: z.array(RegistrationChildSchema).min(1).max(20),
    photoId: Uuid.nullish(),
  })
  .strict();
export type BridgeCheckinCreate = z.infer<typeof BridgeCheckinCreateSchema>;

export const BridgeCheckinUpdateSchema = z.discriminatedUnion('event', [
  z
    .object({
      event: z.literal('check_in_now'),
      saleId: Uuid,
      /**
       * `service` is the Drop-Off / Nanny switch the paid cart line carried
       * (the platform's `CheckInNowSchema` entry); absent = the stay keeps
       * the service it has.
       */
      entries: z
        .array(z.object({ checkinId: Uuid, nannyId: Uuid.nullish(), service: z.enum(SUPERVISION_REQUIREMENTS).optional() }).strict())
        .min(1)
        .max(20),
      /** Printed beside the band's name; never sent to the platform. */
      staffName: z.string().max(120).nullish(),
    })
    .strict(),
  z
    .object({
      event: z.literal('leave_as_booked'),
      saleId: Uuid,
      scheduledFor: IsoDateTime.optional(),
      entries: z.array(z.object({ checkinId: Uuid })).min(1).max(20),
    })
    .strict(),
  z
    .object({
      event: z.literal('edit'),
      checkinId: Uuid,
      fields: OfflineCheckinUpdatedSchema.shape.fields.unwrap(),
      nannyId: Uuid.nullish(),
    })
    .strict(),
  z.object({ event: z.literal('assign_nanny'), checkinId: Uuid, nannyId: Uuid }).strict(),
]);
export type BridgeCheckinUpdate = z.infer<typeof BridgeCheckinUpdateSchema>;

export const BridgeWaiverCreateSchema = z
  .object({
    waiverId: Uuid,
    registrationId: Uuid.nullish(),
    child: OfflineWaiverCreatedSchema.shape.child,
    sibling: OfflineWaiverCreatedSchema.shape.sibling,
    waivedRequirement: z.enum(['drop_off', 'nanny']),
  })
  .strict();

export const BridgeGuardianCreateSchema = z
  .object({
    guardianId: Uuid,
    registrationId: Uuid,
    name: z.string().trim().max(100),
    relationship: z.string().trim().max(100).nullish(),
    phone: z.string().trim().max(40).nullish(),
    source: z.enum(GUARDIAN_ADD_SOURCES).default('in_person'),
    photoId: Uuid.nullish(),
  })
  .strict();

export const BridgeReleaseCreateSchema = z
  .object({
    releaseId: Uuid,
    checkinId: Uuid,
    collector: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('dropper_off') }).strict(),
      z.object({ kind: z.literal('guardian'), guardianId: z.string().min(1).max(100) }).strict(),
      z
        .object({
          kind: z.literal('on_the_spot'),
          guardianId: Uuid,
          name: z.string().trim().max(100),
          relationship: z.string().trim().max(100).nullish(),
          phone: z.string().trim().max(40).nullish(),
          photoId: Uuid.nullish(),
        })
        .strict(),
    ]),
    pickupPhotoId: Uuid.nullish(),
  })
  .strict();
export type BridgeReleaseCreate = z.infer<typeof BridgeReleaseCreateSchema>;

// --- The refusals, in the counter's words -------------------------------------------------

export const BOX_CHECKIN_REFUSALS = {
  noCopy: {
    code: 'CHECKIN_NOT_ON_BOX',
    message:
      'This counter is offline and has no copy of that child’s check-in. Look on the board at another counter, or wait for the connection.',
  },
  noConfig: {
    code: 'CHECKIN_CONFIG_NOT_ON_BOX',
    message:
      'This counter has not had the drop-off set-up yet, so it cannot register children offline. Connect it to the internet once.',
  },
  photosOff: {
    code: 'CHILD_PHOTOS_DISABLED',
    message: 'Photos are switched off at this park. Check the collector against the list by eye and carry on without a photo.',
  },
  photoStoreFull: {
    code: 'PHOTO_STORE_FULL',
    message:
      'This counter’s box has no room left for more photos until it is back online. Ask a manager — photos are kept safely and sent when the connection returns.',
  },
  photoTooBig: {
    code: 'PHOTO_TOO_LARGE',
    message: 'That photo is too large for this counter to keep offline. Take it again.',
  },
  photoNotImage: {
    code: 'PHOTO_NOT_AN_IMAGE',
    message: 'That is not a photo this counter can keep. Take it again with the camera.',
  },
  photoStoreMissing: {
    code: 'PHOTO_STORE_UNAVAILABLE',
    message: 'This counter’s box cannot keep photos right now. Carry on without one and take it when the connection is back.',
  },
  photoUnknown: {
    code: 'PHOTO_NOT_ON_BOX',
    message: 'That photo is not on this counter’s box — take it again.',
  },
  releaseInProgress: {
    code: 'RELEASE_IN_PROGRESS',
    message: 'Another till on this counter is releasing this child right now. Wait a moment, then look again.',
  },
} as const;

// --- What the box answers (the till's own shapes) ------------------------------------------

/** One stay as the box answers it — the board's `ApiBoardChild`. */
export interface BridgeCheckinChild {
  id: string;
  registrationId: string;
  childId: string | null;
  childName: string;
  childAgeYears: number;
  dateOfBirth: string | null;
  allergies: string | null;
  foodRestrictions: string | null;
  mayOrderFood: boolean;
  foodProvision: z.infer<typeof FoodProvisionSchema> | null;
  service: (typeof SUPERVISION_REQUIREMENTS)[number];
  status: 'registered' | 'in_park' | 'out';
  scheduledFor: string | null;
  bookedMinutes: number | null;
  nannyId: string | null;
  nannyName: string | null;
  checkedInAt: string | null;
  checkedOutAt: string | null;
  saleId: string | null;
  bandId: string | null;
  visitId: string | null;
  photoFileId: string | null;
}

/** One person on a pickup list, as the box keeps it. */
export interface BridgeGuardian {
  id: string;
  registrationId: string;
  name: string;
  relationship: string | null;
  phone: string | null;
  photoFileId: string | null;
  source: (typeof GUARDIAN_ADD_SOURCES)[number];
  revoked: boolean;
  createdAt: string;
  /** True for one this counter added offline whose photo is still on the box. */
  photoPendingUpload?: boolean;
}

/** One family as the box answers it — the board's `ApiBoardFamily`, with its pickup list. */
export interface BridgeCheckinFamily {
  registrationId: string;
  branchId: string;
  memberId: string | null;
  guardianName: string;
  guardianPhone: string | null;
  contactChannel: string;
  consentRecordedAt: string | null;
  source: string;
  photoFileId: string | null;
  createdAt: string;
  contact: { status: 'pending' | 'confirmed' | 'failed'; sentAt: string | null; confirmedAt: string | null } | null;
  tab: 'registered' | 'in_park' | 'out';
  children: BridgeCheckinChild[];
  guardians: BridgeGuardian[];
  /** Where the answer came from: the box's copy, or what this counter recorded offline. */
  origin: 'cache' | 'overlay';
}

/** A release, as the box keeps it. */
export interface BridgeReleaseRecord {
  id: string;
  checkinId: string;
  registrationId: string;
  guardianId: string | null;
  collectorName: string;
  verifiedByAccountId: string;
  pickupPhotoFileId: string | null;
  photoPendingUpload: boolean;
  stationId: string | null;
  checkedOutAt: string;
  prepaid: { policy: 'refund' | 'forfeit'; unusedSatang: number } | null;
}

/** A nanny on the box's roster: her shifts, so "on shift" is answered with no internet. */
export interface BridgeNanny {
  id: string;
  name: string;
  shifts: Array<{ startsAt: string; endsAt: string }>;
}

/** The `checkin` cache scope's ONE item (plan §2.5), applied whole. */
export interface CheckinCacheItem {
  version: string;
  generatedAt: string;
  branchId: string;
  config: {
    policy: unknown;
    pricing: unknown;
    photoRetentionDays: number;
  };
  nannies: BridgeNanny[];
  families: Array<Omit<BridgeCheckinFamily, 'origin'>>;
  releases: BridgeReleaseRecord[];
}
