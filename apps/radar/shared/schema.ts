import { sql } from "drizzle-orm";
import { pgTable, text, varchar, integer, timestamp, jsonb, boolean, index, uniqueIndex, date, uuid, numeric, check } from "drizzle-orm/pg-core";
import { z } from "zod";
import { createInsertSchema } from "drizzle-zod";

// ============================================
// VISITOR SURVEY
// ============================================

export const visitorSurveyBranches = ["floresta", "chalong"] as const;
export type VisitorSurveyBranch = typeof visitorSurveyBranches[number];

export const visitorTypes = ["Tourist", "Expat", "WinterBird", "Thai"] as const;
export type VisitorType = typeof visitorTypes[number];

export const discoveryChannels = ["Booth", "WordOfMouth", "Google", "Aquarium", "Meta"] as const;
export type DiscoveryChannel = typeof discoveryChannels[number];

export const visitorSurveyResponses = pgTable("visitor_survey_responses", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  branch: text("branch", { enum: visitorSurveyBranches }).notNull(),
  visitorType: text("visitor_type", { enum: visitorTypes }).notNull(),
  discoveryChannel: text("discovery_channel", { enum: discoveryChannels }).notNull(),
  submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_visitor_survey_branch_submitted").on(table.branch, table.submittedAt),
]);

export const insertVisitorSurveyResponseSchema = createInsertSchema(visitorSurveyResponses).omit({
  id: true,
  submittedAt: true,
});
export type InsertVisitorSurveyResponse = z.infer<typeof insertVisitorSurveyResponseSchema>;
export type VisitorSurveyResponse = typeof visitorSurveyResponses.$inferSelect;

export const VISITOR_SURVEY_BRANCH_LABELS: Record<VisitorSurveyBranch, string> = {
  floresta: "Central Floresta",
  chalong: "Robinsons Chalong",
};

// ============================================
// QR PROMO CAMPAIGNS
// ============================================

export const campaignStatuses = ["active", "disabled"] as const;
export type CampaignStatus = typeof campaignStatuses[number];

export const campaignQrStatuses = ["issued", "saved", "redeemed"] as const;
export type CampaignQrStatus = typeof campaignQrStatuses[number];

export const campaigns = pgTable("campaigns", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  promoCode: text("promo_code").notNull(),
  description: text("description"),
  status: text("status", { enum: campaignStatuses }).notNull().default("active"),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  usageCap: integer("usage_cap"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const campaignQrs = pgTable("campaign_qrs", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }).notNull(),
  token: text("token").notNull().unique(),
  shortCode: text("short_code").notNull().unique(),
  deviceId: text("device_id").notNull(),
  status: text("status", { enum: campaignQrStatuses }).notNull().default("issued"),
  issuedAt: timestamp("issued_at", { withTimezone: true }).defaultNow().notNull(),
  savedAt: timestamp("saved_at", { withTimezone: true }),
  redeemedAt: timestamp("redeemed_at", { withTimezone: true }),
  redeemedBy: text("redeemed_by"),
}, (table) => [
  index("idx_campaign_qrs_campaign").on(table.campaignId),
  uniqueIndex("uq_campaign_qrs_campaign_device").on(table.campaignId, table.deviceId),
  index("idx_campaign_qrs_token").on(table.token),
  // New codes are always 4 chars (see generateShortCode), but production
  // contains legacy 6-char codes from before the change — including ones
  // already redeemed/saved by real guests. Allow both lengths so the
  // constraint can be applied safely without invalidating saved vouchers.
  check("short_code_len_valid", sql`length(${table.shortCode}) IN (4, 6)`),
]);

export const campaignClicks = pgTable("campaign_clicks", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  campaignId: uuid("campaign_id").references(() => campaigns.id, { onDelete: "cascade" }).notNull(),
  deviceId: text("device_id"),
  clickedAt: timestamp("clicked_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_campaign_clicks_campaign").on(table.campaignId),
]);

// ============================================
// BOOTH EVENTS (Spin & Win game + future sales-booth apps push events here)
// ============================================

export const boothEventTypes = ["prize_won", "claimed", "redeemed", "re_redeemed", "expired"] as const;
export type BoothEventType = typeof boothEventTypes[number];

export const boothEvents = pgTable("booth_events", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  // Sender-supplied unique id — makes retries idempotent (duplicate sends are ignored).
  eventId: text("event_id").notNull().unique(),
  // Which app sent it, e.g. "spin_win". Future booth apps use their own source.
  source: text("source").notNull(),
  eventType: text("event_type", { enum: boothEventTypes }).notNull(),
  // Stable identifier of the prize claim (QR/barcode id) — groups events into one claim.
  claimId: text("claim_id").notNull(),
  prizeName: text("prize_name"),
  phone: text("phone"),
  // Radar voucher shortCode when the prize is a money voucher — lets us link
  // the game's redeem event to Radar's own QR redemption record.
  code: text("code"),
  occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
  // Full original payload for anything the columns don't capture.
  payload: jsonb("payload"),
  receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_booth_events_claim").on(table.claimId),
  index("idx_booth_events_occurred").on(table.occurredAt),
]);

export type BoothEvent = typeof boothEvents.$inferSelect;

// occurredAt must be an ISO-8601 timestamp WITH an explicit offset or Z
// (e.g. "2026-08-19T10:00:00+07:00"). Offset-less strings are ambiguous and
// null would silently coerce to the Unix epoch, so both are rejected.
const isoWithOffset = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

export const boothEventInputSchema = z.object({
  eventId: z.string().trim().min(1).max(160),
  source: z.string().trim().min(1).max(60).default("spin_win"),
  eventType: z.enum(boothEventTypes),
  claimId: z.string().trim().min(1).max(200),
  prizeName: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(40).optional(),
  code: z.string().trim().max(20).optional(),
  occurredAt: z
    .string()
    .trim()
    .regex(isoWithOffset, "occurredAt must be ISO-8601 with an explicit timezone offset or Z")
    .transform((s) => new Date(s))
    .refine((d) => !Number.isNaN(d.getTime()), "occurredAt is not a valid timestamp"),
  meta: z.record(z.unknown()).optional(),
});
export type BoothEventInput = z.infer<typeof boothEventInputSchema>;

// Exact event shape the Spin & Win game pushes to POST /api/ingest/spin-events.
// (The game was built to this contract; Radar adapts to it.)
export const spinEventTypeMap = {
  prize_won: "prize_won",
  prize_claimed: "claimed",
  prize_redeemed: "redeemed",
  prize_rearmed: "re_redeemed",
} as const;

export const spinEventSchema = z
  .object({
    eventId: z.string().trim().min(1).max(160),
    type: z.enum(["prize_won", "prize_claimed", "prize_redeemed", "prize_rearmed"]),
    source: z.string().trim().min(1).max(60).default("spin-win"),
    // Epoch ms, bounded: rejects seconds-vs-ms mixups (→1970) and far-future
    // values that would corrupt ordering/expiry. Allows 1h of clock skew.
    at: z
      .number()
      .int()
      .refine(
        (n) => n >= Date.UTC(2020, 0, 1) && n <= Date.now() + 3600_000,
        "at must be epoch milliseconds between 2020 and now (+1h skew)",
      ),
    prizeId: z.string().trim().max(120).optional(),
    prizeName: z.string().trim().max(200).optional(),
    winId: z.string().trim().max(120).optional(),
    claimId: z.string().trim().max(200).optional(),
    phone: z.string().trim().max(40).optional(),
    campaignId: z.string().trim().max(120).optional(),
    barcode: z.string().trim().max(60).optional(),
    code: z.string().trim().max(20).optional(),
    wonAt: z.number().int().positive().optional(),
    claimedAt: z.number().int().positive().optional(),
    redeemedAt: z.number().int().positive().optional(),
    reRedeem: z.boolean().optional(),
  })
  .passthrough();
export type SpinEvent = z.infer<typeof spinEventSchema>;

export const insertCampaignSchema = createInsertSchema(campaigns).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).extend({
  name: z.string().min(1, "Name is required").max(120),
  promoCode: z.string().min(1, "Promo code is required").max(60),
  description: z.string().max(500).nullable().optional(),
  expiresAt: z.coerce.date().nullable().optional(),
  usageCap: z.coerce.number().int().positive().nullable().optional(),
  status: z.enum(campaignStatuses).optional(),
});
export type InsertCampaign = z.infer<typeof insertCampaignSchema>;
export type Campaign = typeof campaigns.$inferSelect;

export type CampaignQr = typeof campaignQrs.$inferSelect;
export type CampaignClick = typeof campaignClicks.$inferSelect;

export type CampaignWithStats = Campaign & {
  clicks: number;
  saved: number;
  redeemed: number;
  issued: number;
};

// ============================================
// STAFF BIRTHDAYS
// ============================================
export const staffBirthdayBranches = ["floresta", "chalong"] as const;
export type StaffBirthdayBranch = (typeof staffBirthdayBranches)[number];

export const staffBirthdays = pgTable("staff_birthdays", {
  id: uuid("id").primaryKey().default(sql`gen_random_uuid()`),
  name: text("name").notNull(),
  fullName: text("full_name"),
  branch: text("branch", { enum: staffBirthdayBranches }).notNull(),
  department: text("department").notNull(),
  birthMonth: integer("birth_month").notNull(),
  birthDay: integer("birth_day").notNull(),
  birthYear: integer("birth_year"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("idx_staff_birthdays_branch").on(table.branch),
  index("idx_staff_birthdays_md").on(table.birthMonth, table.birthDay),
]);

export const insertStaffBirthdaySchema = createInsertSchema(staffBirthdays).omit({
  id: true,
  createdAt: true,
}).extend({
  name: z.string().min(1).max(80),
  fullName: z.string().max(160).nullable().optional(),
  branch: z.enum(staffBirthdayBranches),
  department: z.string().min(1).max(60),
  birthMonth: z.coerce.number().int().min(1).max(12),
  birthDay: z.coerce.number().int().min(1).max(31),
  birthYear: z.coerce.number().int().min(1900).max(2100).nullable().optional(),
});
export type InsertStaffBirthday = z.infer<typeof insertStaffBirthdaySchema>;
export type StaffBirthday = typeof staffBirthdays.$inferSelect;

// ============================================
// RADAR'S OWN SETTINGS (S2-18 R3)
// ============================================
// What survived the one-source ruling of Radar's runtime-created tables: the
// revenue planner's per-branch settings, the calendar's day notes and the pace
// forecast snapshots. Dates are YYYY-MM-DD text, as the code compares them.

export const branchSettings = pgTable("branch_settings", {
  branch: text("branch").notNull(),
  key: text("key").notNull(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("branch_settings_branch_key").on(table.branch, table.key),
]);

export const calendarNotes = pgTable("calendar_notes", {
  date: text("date").primaryKey(),
  note: text("note").notNull().default(""),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const paceForecastSnapshots = pgTable("pace_forecast_snapshots", {
  date: text("date").notNull(),
  branch: text("branch").notNull(),
  month: text("month").notNull(),
  forecastRevenue: numeric("forecast_revenue").notNull(),
  revenueToDate: numeric("revenue_to_date").notNull().default("0"),
  elapsedDays: integer("elapsed_days").notNull().default(0),
  target: numeric("target"),
  model: text("model"),
  recordedAt: timestamp("recorded_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  uniqueIndex("pace_forecast_snapshots_date_branch").on(table.date, table.branch),
  index("idx_pace_forecast_snapshots_branch_month").on(table.branch, table.month),
]);
