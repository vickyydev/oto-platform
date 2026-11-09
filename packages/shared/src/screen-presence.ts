import { z } from 'zod';

/**
 * SCRUM-771 — WHETHER A SCREEN IS STILL THERE, starting with the customer
 * display.
 *
 * A box says it is alive with its own heartbeat every 60 seconds, and the
 * watchdog calls it offline after `BOX_OFFLINE_AFTER_S` of silence. A screen is
 * judged by the same clock and the same threshold: the display by the calls it
 * already makes (its poll, or its stream's re-check every five seconds).
 */

export const SCREEN_PRESENCE_STATES = ['online', 'offline'] as const;
export type ScreenPresenceState = (typeof SCREEN_PRESENCE_STATES)[number];

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
