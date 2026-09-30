/**
 * The gate's journal, as it crosses from a gate box to the platform (S2-12
 * round 2).
 *
 * Declared ONCE here because the box produces it (`@oto/box-agent`
 * `gate/decision.ts`) and the api applies it (`band.gate_event` in
 * `services/sync.ts`): two copies would be two descriptions of one wire, the
 * reason `station-bridge.ts` gives for the member and visit payloads.
 *
 * One fact per outcome the gate reaches about a band:
 *
 *   entry    a passage IN, credited to the band whose open preceded it;
 *   exit     a passage OUT, likewise — `exitWithoutEntry` when the box did not
 *            think the band was inside (OD-A4: a guest is always let out);
 *   denied   the reader was told not to open, with the reason;
 *   timeout  the lane opened and nobody passed, or the board went quiet;
 *   alarm    reverse or tailgating after an open — recorded against the band
 *            whose open it followed, and crediting nobody.
 *
 * `eventId` is minted on the box and becomes `pos.band_event.id`, which is
 * what makes a replay of the same fact write nothing the second time. The
 * band's CODE never travels: it is a credential (`scanning.ts`).
 */

import { z } from 'zod';

export const GATE_EVENT_TYPE = 'band.gate_event';

export const GATE_EVENT_KINDS = ['entry', 'exit', 'denied', 'timeout', 'alarm'] as const;
export type GateEventKind = (typeof GATE_EVENT_KINDS)[number];

/** Why the reader was told not to open. */
export const GATE_DENY_REASONS = [
  /** Not a band code at all — a booking QR, a voucher, a card. */
  'NOT_A_BAND',
  /** The box has no usable band key, so it can check nothing. */
  'BOX_NOT_READY',
  /** Shaped like a band and its signature does not match: altered or invented. */
  'BAND_INVALID',
  /** Revoked or replaced. */
  'BAND_REVOKED',
  /** A band this box has never heard of and the platform did not know either. */
  'BAND_NOT_FOUND',
  /** A band this box has never heard of, with no platform to ask (OD-A5). */
  'BAND_UNKNOWN_OFFLINE',
  /** Kids' bands never operate the gate (C8, OD-A6). */
  'KID_BAND',
  /** Entry while the band is already inside. */
  'ANTI_PASSBACK',
  /** An open is already pending on that side of the lane. */
  'GATE_BUSY',
  /** The lane cannot be opened: the opener refused, or the gate is held open. */
  'GATE_NOT_READY',
] as const;
export type GateDenyReason = (typeof GATE_DENY_REASONS)[number];

export const GATE_ALARMS = ['reverse', 'tailgating'] as const;
export type GateAlarm = (typeof GATE_ALARMS)[number];

export const GateEventPayloadSchema = z.object({
  /** Box-minted UUIDv7; becomes `pos.band_event.id`. */
  eventId: z.string().uuid(),
  bandId: z.string().uuid(),
  kind: z.enum(GATE_EVENT_KINDS),
  direction: z.enum(['entry', 'exit']),
  side: z.enum(['left', 'right']),
  reason: z.enum(GATE_DENY_REASONS).nullish(),
  alarm: z.enum(GATE_ALARMS).nullish(),
  /** An exit by a band the box did not think was inside (OD-A4). */
  exitWithoutEntry: z.boolean().optional(),
  /** Let out on a band the deny list names (a refunded guest leaving). */
  revoked: z.boolean().optional(),
  /** A timeout the box inferred because the board never reported one. */
  inferred: z.boolean().optional(),
  /** `timeout_in_lane`: the board timed out with somebody still in the lane. */
  personInLane: z.boolean().optional(),
  /** The box had no link to the platform when it decided. */
  offline: z.boolean().optional(),
  /** When the box decided, or when the board reported. */
  occurredAt: z.string().datetime(),
});
export type GateEventPayload = z.infer<typeof GateEventPayloadSchema>;
