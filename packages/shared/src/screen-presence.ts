import { z } from 'zod';

/**
 * SCRUM-771 — WHETHER A SCREEN IS STILL THERE: a customer display, and the
 * till's own screen (an iPad, or any browser holding a staff session at a
 * station).
 *
 * A box says it is alive with its own heartbeat every 60 seconds, and the
 * watchdog calls it offline after `BOX_OFFLINE_AFTER_S` of silence. A screen is
 * judged by the same clock and the same threshold: the display by the calls it
 * already makes (its poll, or its stream's re-check every five seconds), the
 * till by a heartbeat of its own every `SCREEN_HEARTBEAT_INTERVAL_S`.
 *
 * The scanner a till's screen hears has no presence of its own. A cradle
 * plugged into an iPad is a keyboard to it, so the only thing the till can
 * know of it is the codes it types — and the heartbeat carries when the last
 * one arrived.
 */

/** How often a till's screen says it is still there. */
export const SCREEN_HEARTBEAT_INTERVAL_S = 60;

/** The oldest scan a heartbeat may report: older than this is not worth a timestamp. */
export const SCREEN_SCAN_AGE_MAX_S = 30 * 24 * 60 * 60;

export const SCREEN_PRESENCE_STATES = ['online', 'offline'] as const;
export type ScreenPresenceState = (typeof SCREEN_PRESENCE_STATES)[number];

/**
 * What a till's screen sends. The scan is an AGE, measured on the screen's own
 * monotonic clock, rather than a time of day: an iPad with a wrong clock would
 * otherwise stamp a scan hours away from when it happened. Null when nothing
 * has been scanned since the till was loaded.
 */
export const StationHeartbeatRequestSchema = z.object({
  lastScanSecondsAgo: z.number().int().min(0).max(SCREEN_SCAN_AGE_MAX_S).nullable().default(null),
});
export type StationHeartbeatRequest = z.infer<typeof StationHeartbeatRequestSchema>;

/**
 * A screen's presence as the platform reads it. The age is the api's own
 * count, so a back-office laptop with a wrong clock cannot paint a working
 * screen offline.
 */
export const ScreenPresenceSchema = z.object({
  state: z.enum(SCREEN_PRESENCE_STATES),
  lastSeenAt: z.string().nullable(),
  lastSeenAgeSeconds: z.number().int().nullable(),
  /** Quiet for longer than this and the screen is offline — the boxes' threshold. */
  offlineAfterSeconds: z.number().int(),
});
export type ScreenPresence = z.infer<typeof ScreenPresenceSchema>;

/** A till's screen, and the scanner it hears. */
export const TillScreenSchema = ScreenPresenceSchema.extend({
  scannerLastUsedAt: z.string().nullable(),
  scannerLastUsedAgeSeconds: z.number().int().nullable(),
});
export type TillScreen = z.infer<typeof TillScreenSchema>;

/** What the heartbeat answers: when this station's screen and scanner were last heard of. */
export const StationHeartbeatResponseSchema = z.object({
  stationId: z.string().uuid(),
  lastSeenAt: z.string(),
  scannerLastUsedAt: z.string().nullable(),
});
export type StationHeartbeatResponse = z.infer<typeof StationHeartbeatResponseSchema>;
