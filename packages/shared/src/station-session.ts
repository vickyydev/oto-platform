import { z } from 'zod';
import { SUPPORTED_LANGS } from './i18n/index';

/**
 * The station session document and its lease (S2-05).
 *
 * In the park a till and a customer display are two devices, and the thing
 * between them is this document: the box owns it, is its only writer, and
 * pushes a FULL SNAPSHOT to both screens over the station channel after every
 * change (PLATFORM_PLAN §6, R-54, R-55; conflict C20 replaced Sprint 1's
 * `session.pending_lookup_phone` with exactly this). Snapshots rather than
 * patches because the document is small and a screen that reconnects is
 * correct again after one message — nothing can drift.
 *
 * The prototype's split view stays as a test harness; what changes is where
 * the state lives. These types are the contract for all three surfaces: the
 * till sends intents, the display sends a narrower set of intents, and both
 * receive snapshots of the same sequence number.
 */

/**
 * The customer-facing stage, ported unchanged from the prototype's
 * `CustomerStage` (`apps/pos/src/components/till/CustomerDisplay.tsx:70`). The
 * till derives it from its wizard step exactly as `pages/Till.tsx:1504-1510`
 * does, so the display component that already exists reads this document with
 * no translation layer.
 */
export const STATION_SESSION_STAGES = [
  'identify',
  'welcome',
  'order',
  'input',
  'payment',
  'thankyou',
] as const;
export type StationSessionStage = (typeof STATION_SESSION_STAGES)[number];

/** What holds a lease. A read-only observer holds none and never appears here. */
export const STATION_LEASE_HOLDER_KINDS = ['till', 'kiosk', 'booth', 'console'] as const;
export type StationLeaseHolderKind = (typeof STATION_LEASE_HOLDER_KINDS)[number];

/** Bumped when a field changes MEANING. Readers migrate on read. */
export const STATION_SESSION_SCHEMA_VERSION = 1;

/** The till renews every 15 seconds; a lease unrenewed for 60 is free to take. */
export const STATION_LEASE_HEARTBEAT_S = 15;
export const STATION_LEASE_TTL_S = 60;

/**
 * Who may see what.
 *
 * `staff` is the till's view — the whole document. `customer` is what the box
 * computes for the display: no staff notes, no allergy, medical or food-consent
 * data (R-58), no other visitor's details. The redaction happens on the way out
 * of the box, once, so no screen is trusted to hide anything.
 */
export const STATION_VIEWS = ['staff', 'customer'] as const;
export type StationView = (typeof STATION_VIEWS)[number];

export const StationLeaseSchema = z.object({
  /**
   * The fencing token. Minted on every claim and quoted by every intent, so a
   * till that was displaced and has not noticed is refused by VALUE rather
   * than by timing — the check does not depend on two clocks agreeing.
   */
  leaseId: z.string().uuid(),
  /** An opaque per-client id — a browser tab, not a person. */
  holder: z.string().min(1).max(64),
  holderKind: z.enum(STATION_LEASE_HOLDER_KINDS),
  /** Who is signed in at the holding till. What an audit of a takeover asks. */
  accountId: z.string().uuid().nullable(),
  startedAt: z.string().datetime(),
  heartbeatAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
});
export type StationLease = z.infer<typeof StationLeaseSchema>;

/**
 * The document itself.
 *
 * `cart`, `member`, `totals`, `payment` and `prompt` are held as open records
 * here on purpose: each is owned by a later ticket (the cart and totals by the
 * money path, payment by the gateway work) and pinning their shapes now would
 * mean a shared-package change in the middle of each of those. What IS pinned
 * is the frame around them — the sequence, the stage, the lease and the schema
 * version — because that frame is what every surface agrees on.
 */
export const StationSessionDocumentSchema = z.object({
  stationId: z.string().uuid(),
  boxId: z.string().uuid(),
  schemaVersion: z.number().int().positive().default(STATION_SESSION_SCHEMA_VERSION),
  /**
   * The fence around the station's writer: stamped by the box, never reused,
   * and moved by every change made by whoever is HOLDING the station. Two tabs
   * on one station showing the same number is the acceptance criterion; an
   * intent quoting an older one is stale.
   *
   * Two things deliberately change the document without moving it — the lease
   * renewal, and an intent sent with no lease, which is the customer display
   * choosing a language or answering a prompt. Neither belongs to the sale, and
   * a number any screen watching the station could move would be a number any
   * screen could use to make the holder's next intent stale.
   */
  sequence: z.number().int().min(0),
  stage: z.enum(STATION_SESSION_STAGES),
  /** The till's wizard position (the prototype's `step`). Absent on the display. */
  step: z.number().int().min(1).max(9).nullable().optional(),
  cart: z.record(z.unknown()).nullable().optional(),
  member: z.record(z.unknown()).nullable().optional(),
  totals: z.record(z.unknown()).nullable().optional(),
  payment: z.record(z.unknown()).nullable().optional(),
  /** What the display is being asked for: a phone number, a consent tick, a signature. */
  prompt: z.record(z.unknown()).nullable().optional(),
  language: z.enum(SUPPORTED_LANGS),
  lease: StationLeaseSchema.nullable(),
  /** How many times a live lease has been taken over. Zero is the normal state. */
  takeoverCount: z.number().int().min(0).default(0),
  updatedAt: z.string().datetime(),
});
export type StationSessionDocument = z.infer<typeof StationSessionDocumentSchema>;

/**
 * An intent: a request to change the document.
 *
 * Every intent carries the lease it was sent under and the last sequence its
 * sender saw, and the box applies it as one compare-and-set against both. A
 * miss is `409 STALE` carrying the current snapshot, which is why a displaced
 * till can say "session moved to another till" and rehydrate in the same
 * round trip rather than needing a second one.
 *
 * The display sends intents through the same shape and is held to a narrower
 * set of types, valid for the current stage only — choose language, type a
 * phone number, tick consent, sign. It never sends a cart change.
 */
export const StationIntentSchema = z.object({
  /** `cart.add_line`, `payment.start`, `display.set_language`. */
  type: z.string().min(3).max(64),
  /** Absent only for an observer's first read, which changes nothing. */
  leaseId: z.string().uuid().nullable().optional(),
  /** The sequence the sender last saw. The other half of the compare-and-set. */
  lastSeenSequence: z.number().int().min(0),
  payload: z.record(z.unknown()).default({}),
  /** `x-oto-action-id`, minted where the person tapped. */
  actionId: z.string().max(64).optional(),
});
export type StationIntent = z.infer<typeof StationIntentSchema>;

/** Why an intent was refused. `stale` is the one that carries a snapshot back. */
export const STATION_INTENT_REFUSALS = [
  /** The lease moved, or the sequence has advanced. Rehydrate and retry.  */
  'stale',
  /** No lease held, and this station already has a live one. */
  'no_lease',
  /** Valid lease, but this intent is not allowed at the current stage. */
  'wrong_stage',
  /** A display sending an intent only a till may send. */
  'not_permitted',
  /** The box does not know this intent type — usually a till newer than the box. */
  'unknown_intent',
] as const;
export type StationIntentRefusal = (typeof STATION_INTENT_REFUSALS)[number];

/**
 * What the box sends down the station channel.
 *
 * One message shape rather than several, so a client that reconnects mid-flow
 * handles exactly one thing: a snapshot. `refused` exists because a rejection
 * has to reach the sender that caused it and nobody else.
 */
export const STATION_CHANNEL_MESSAGES = ['snapshot', 'refused', 'lease', 'ping', 'scan'] as const;
export type StationChannelMessageKind = (typeof STATION_CHANNEL_MESSAGES)[number];

export interface StationSnapshotMessage {
  kind: 'snapshot';
  /** Which redaction this snapshot has had applied; a display never gets `staff`. */
  view: StationView;
  document: StationSessionDocument;
  /** The action that produced this sequence, for the Box log drawer. */
  actionId: string | null;
  serverTime: string;
}

export interface StationRefusedMessage {
  kind: 'refused';
  reason: StationIntentRefusal;
  /** One line a person can act on: "session moved to another till". */
  message: string;
  /** Sent with a `stale` refusal so the client rehydrates in the same round trip. */
  document: StationSessionDocument | null;
  actionId: string | null;
}

/**
 * A lease changed hands. Separate from a snapshot because a displaced till has
 * to be told, and it is the only message whose audience is somebody who is
 * about to stop receiving snapshots.
 */
export interface StationLeaseMessage {
  kind: 'lease';
  lease: StationLease | null;
  /** True when a manager took a LIVE lease; false when an expired one was claimed. */
  takenOver: boolean;
  /** The lease that was displaced, so the losing till recognises itself. */
  displacedLeaseId: string | null;
}

export interface StationPingMessage {
  kind: 'ping';
  serverTime: string;
  sequence: number;
}

/**
 * A scan reached the station (S2-06).
 *
 * The screens are told what was scanned and what became of it, by fingerprint
 * — the code itself stops at the box. `detail` is the registered handler's own
 * answer ("member found", "band already admitted") and is the only part that
 * can name anybody, so it is redacted for the customer view the same way the
 * document is.
 */
export interface StationScanMessage {
  kind: 'scan';
  /** The hardware it came from: `box_hid`, `box_serial`, `camera`, `simulator`, … */
  source: string;
  codeKind: string;
  /** SHA-256 of the code, first 16 hex characters. Never the code. */
  codeFingerprint: string;
  outcome: string;
  handler: string | null;
  errorCode: string | null;
  detail: Record<string, unknown> | null;
  actionId: string | null;
  scannedAt: string;
}

export type StationChannelMessage =
  | StationSnapshotMessage
  | StationRefusedMessage
  | StationLeaseMessage
  | StationPingMessage
  | StationScanMessage;
