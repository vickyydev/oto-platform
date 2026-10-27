import { z } from 'zod';

/**
 * SCRUM-648 (S2-23 Support tools) — what every app's view-as banner reads: the
 * window, who is really there, as whom, in which app, in which mode, and when
 * it ends. Carried additively on each app's own session read (`GET /me`,
 * `GET /inbox/me`, and through the platform for the OTO App and Radar).
 */
export const IMPERSONATION_BANNER_APPS = ['pos', 'oto_app', 'radar', 'inbox'] as const;

export const ImpersonationBannerSchema = z.object({
  id: z.string().uuid(),
  actor: z.object({ accountId: z.string().uuid(), name: z.string().nullable() }),
  subject: z.object({ accountId: z.string().uuid(), name: z.string().nullable() }),
  targetApp: z.enum(IMPERSONATION_BANNER_APPS),
  mode: z.enum(['read_only', 'write_allowed']),
  expiresAt: z.string().datetime(),
}).strict();
export type ImpersonationBanner = z.infer<typeof ImpersonationBannerSchema>;
