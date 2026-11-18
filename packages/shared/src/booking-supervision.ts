import { z } from 'zod';
import { FoodProvisionSchema } from './supervision';

/** One named child on a public booking; fees and service are resolved by the park. */
export const BookingSupervisionInputSchema = z.object({
  childName: z.string().trim().min(1).max(120),
  ageYears: z.number().int().min(0).max(17),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  allergies: z.string().max(2000).optional(),
  foodRestrictions: z.string().max(2000).optional(),
  foodProvision: FoodProvisionSchema.nullable().optional(),
  nannyStartTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).optional(),
  /**
   * SCRUM-1011 — the child on the family's saved record this place is, when it
   * came from one (or was saved to it from this booking). Accepted only with
   * the family pass of the booking's member, and only for that member's
   * children; the paid booking's stay is then linked to it.
   */
  savedChildId: z.string().uuid().optional(),
}).strict();
export type BookingSupervisionInput = z.infer<typeof BookingSupervisionInputSchema>;

/** SCRUM-1011 — the contact apps a family may pick online, as the member record holds them. */
export const FAMILY_CONTACT_CHANNELS = ['whatsapp', 'telegram', 'line'] as const;

/**
 * SCRUM-1011 — ONE CHILD AS THE FAMILY CONFIRMED IT ONLINE, to be saved to its
 * record. Exactly one of the two ids: `savedChildId` for a child already on
 * the record, `newChildId` (minted by the booking site, so a second send is
 * the same child) for one the family adds.
 */
export const FamilyOnlineChildSchema = z.object({
  savedChildId: z.string().uuid().optional(),
  newChildId: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(120),
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  ageYears: z.number().int().min(0).max(17),
  allergies: z.string().max(2000).optional(),
  foodRestrictions: z.string().max(2000).optional(),
}).strict().refine((c) => Boolean(c.savedChildId) !== Boolean(c.newChildId), {
  message: 'Each child names exactly one of savedChildId or newChildId',
});
export type FamilyOnlineChild = z.infer<typeof FamilyOnlineChildSchema>;

/** The most children one family save may name (the booking site's own ceiling is 20 kids per line). */
export const FAMILY_ONLINE_SAVE_MAX = 20;

/** Frozen by the public quote; checkinId is added only after verified payment. */
export const BookingSupervisionSnapshotSchema = BookingSupervisionInputSchema.extend({
  service: z.enum(['none', 'drop_off', 'nanny']),
  minutes: z.number().int().positive(),
  serviceFeeSatang: z.number().int().nonnegative(),
  checkinId: z.string().uuid().optional(),
});
export type BookingSupervisionSnapshot = z.infer<typeof BookingSupervisionSnapshotSchema>;

export const PublicSupervisionConfigSchema = z.object({
  policy: z.object({
    bands: z.array(z.object({ id: z.string(), label: z.string(), minAge: z.number(), maxAge: z.number().nullable(), requirement: z.enum(['none', 'drop_off', 'nanny']) })),
    siblingWaiver: z.object({ enabled: z.boolean(), guardianMinAge: z.number(), waivableRequirement: z.enum(['none', 'drop_off', 'nanny']), staffOnly: z.boolean() }),
    confirmations: z.array(z.object({ id: z.string(), text: z.string(), required: z.boolean(), order: z.number() })),
  }),
  pricing: z.object({
    oneTimeFee: z.object({ weekday: z.number(), weekend: z.number() }),
    nannyHourly: z.object({ weekday: z.number(), weekend: z.number() }),
    extraHour: z.object({ weekday: z.number(), weekend: z.number() }),
    fullDayHours: z.number(), nannyRatioSoftMax: z.number(), prepaidFoodUnused: z.enum(['refund', 'forfeit']),
  }),
  photoRetentionDays: z.number(),
});
export type PublicSupervisionConfig = z.infer<typeof PublicSupervisionConfigSchema>;
