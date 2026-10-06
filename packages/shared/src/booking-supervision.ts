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
}).strict();
export type BookingSupervisionInput = z.infer<typeof BookingSupervisionInputSchema>;

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
