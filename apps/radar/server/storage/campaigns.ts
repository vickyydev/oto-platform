import { randomBytes } from "crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, pool } from "../db";
import {
  campaigns,
  campaignQrs,
  campaignClicks,
  type Campaign,
  type CampaignQr,
  type CampaignWithStats,
  type InsertCampaign,
} from "@shared/schema";

export type RedeemError =
  | "not_found"
  | "already_used"
  | "expired"
  | "disabled"
  | "cap_reached";

export type RedeemResult =
  | {
      ok: true;
      qr: CampaignQr;
      campaign: Campaign;
      alreadyUsed?: boolean;
    }
  | {
      ok: false;
      error: RedeemError;
      qr?: CampaignQr;
      campaign?: Campaign;
    };

function generateToken(): string {
  return randomBytes(12).toString("base64url");
}

const SHORT_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SHORT_CODE_LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const SHORT_CODE_LENGTH = 4;
function generateShortCode(): string {
  const bytes = randomBytes(SHORT_CODE_LENGTH);
  // Legacy campaign codes must always contain a letter. This reserves the
  // all-numeric four-digit namespace for the separate Spin Wheel ledger,
  // without changing any codes that were already issued.
  let out = SHORT_CODE_LETTERS[bytes[0] % SHORT_CODE_LETTERS.length];
  for (let i = 1; i < SHORT_CODE_LENGTH; i++) {
    out += SHORT_CODE_ALPHABET[bytes[i] % SHORT_CODE_ALPHABET.length];
  }
  return out;
}

const PINNED_PROMO_CODES = ["6a6facd56246266e"];

export async function listCampaignsWithStats(): Promise<CampaignWithStats[]> {
  const allRaw = await db.select().from(campaigns).orderBy(desc(campaigns.createdAt));
  if (allRaw.length === 0) return [];
  const pinnedRank = (code: string) => {
    const i = PINNED_PROMO_CODES.indexOf(code);
    return i === -1 ? PINNED_PROMO_CODES.length : i;
  };
  const all = [...allRaw].sort((a, b) => pinnedRank(a.promoCode) - pinnedRank(b.promoCode));

  const clickRows = await db
    .select({
      campaignId: campaignClicks.campaignId,
      c: sql<number>`COUNT(*)::int`,
    })
    .from(campaignClicks)
    .groupBy(campaignClicks.campaignId);

  const qrRows = await db
    .select({
      campaignId: campaignQrs.campaignId,
      status: campaignQrs.status,
      c: sql<number>`COUNT(*)::int`,
    })
    .from(campaignQrs)
    .groupBy(campaignQrs.campaignId, campaignQrs.status);

  const clicks = new Map<string, number>();
  for (const r of clickRows) clicks.set(r.campaignId, Number(r.c));

  type Counts = { issued: number; saved: number; redeemed: number };
  const qrCounts = new Map<string, Counts>();
  for (const r of qrRows) {
    const cur = qrCounts.get(r.campaignId) ?? { issued: 0, saved: 0, redeemed: 0 };
    const n = Number(r.c);
    if (r.status === "issued") cur.issued += n;
    if (r.status === "saved") cur.saved += n;
    if (r.status === "redeemed") cur.redeemed += n;
    qrCounts.set(r.campaignId, cur);
  }

  return all.map((c) => {
    const q = qrCounts.get(c.id) ?? { issued: 0, saved: 0, redeemed: 0 };
    const issuedTotal = q.issued + q.saved + q.redeemed;
    const savedTotal = q.saved + q.redeemed;
    return {
      ...c,
      clicks: clicks.get(c.id) ?? 0,
      issued: issuedTotal,
      saved: savedTotal,
      redeemed: q.redeemed,
    };
  });
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  const [row] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  return row ?? null;
}

export async function createCampaign(data: InsertCampaign): Promise<Campaign> {
  const [row] = await db
    .insert(campaigns)
    .values({
      name: data.name,
      promoCode: data.promoCode,
      status: data.status ?? "active",
      expiresAt: data.expiresAt ?? null,
      usageCap: data.usageCap ?? null,
    })
    .returning();
  return row;
}

export async function updateCampaign(
  id: string,
  data: Partial<InsertCampaign>,
): Promise<Campaign | null> {
  const update: Record<string, unknown> = { updatedAt: new Date() };
  if (data.name !== undefined) update.name = data.name;
  if (data.promoCode !== undefined) update.promoCode = data.promoCode;
  if (data.status !== undefined) update.status = data.status;
  if (data.expiresAt !== undefined) update.expiresAt = data.expiresAt;
  if (data.usageCap !== undefined) update.usageCap = data.usageCap;
  const [row] = await db
    .update(campaigns)
    .set(update)
    .where(eq(campaigns.id, id))
    .returning();
  return row ?? null;
}

export async function deleteCampaign(id: string): Promise<void> {
  await db.delete(campaigns).where(eq(campaigns.id, id));
}

export async function recordCampaignClick(
  campaignId: string,
  deviceId: string | null,
): Promise<void> {
  await db.insert(campaignClicks).values({ campaignId, deviceId });
}

function validateCampaignActive(
  campaign: Campaign,
  redeemedCount: number,
): RedeemError | null {
  if (campaign.status === "disabled") return "disabled";
  if (campaign.expiresAt && campaign.expiresAt.getTime() < Date.now()) return "expired";
  if (campaign.usageCap != null && redeemedCount >= campaign.usageCap) return "cap_reached";
  return null;
}

export async function getOrIssueQrForDevice(
  campaignId: string,
  deviceId: string,
): Promise<{ ok: true; qr: CampaignQr; campaign: Campaign } | { ok: false; error: RedeemError; campaign?: Campaign }> {
  const campaign = await getCampaign(campaignId);
  if (!campaign) return { ok: false, error: "not_found" };

  const [existing] = await db
    .select()
    .from(campaignQrs)
    .where(and(eq(campaignQrs.campaignId, campaignId), eq(campaignQrs.deviceId, deviceId)))
    .limit(1);
  if (existing) return { ok: true, qr: existing, campaign };

  const redeemedCount = await countRedeemed(campaignId);
  const err = validateCampaignActive(campaign, redeemedCount);
  if (err) return { ok: false, error: err, campaign };

  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const token = generateToken();
      const shortCode = generateShortCode();
      const [row] = await db
        .insert(campaignQrs)
        .values({ campaignId, deviceId, token, shortCode })
        .returning();
      return { ok: true, qr: row, campaign };
    } catch (err) {
      // Possible race: concurrent insert of QR for same (campaign_id, device_id)
      // hit the unique index, or token collided. Re-check existing row before retrying.
      const [raced] = await db
        .select()
        .from(campaignQrs)
        .where(and(eq(campaignQrs.campaignId, campaignId), eq(campaignQrs.deviceId, deviceId)))
        .limit(1);
      if (raced) return { ok: true, qr: raced, campaign };
      if (attempt === 4) throw err;
    }
  }
  throw new Error("failed to issue qr");
}

export async function markQrSaved(token: string): Promise<CampaignQr | null> {
  const [row] = await db
    .update(campaignQrs)
    .set({ status: "saved", savedAt: new Date() })
    .where(and(eq(campaignQrs.token, token), eq(campaignQrs.status, "issued")))
    .returning();
  if (row) return row;
  const [existing] = await db.select().from(campaignQrs).where(eq(campaignQrs.token, token));
  return existing ?? null;
}

async function countRedeemed(campaignId: string): Promise<number> {
  const [row] = await db
    .select({ c: sql<number>`COUNT(*)::int` })
    .from(campaignQrs)
    .where(and(eq(campaignQrs.campaignId, campaignId), eq(campaignQrs.status, "redeemed")));
  return Number(row?.c ?? 0);
}

export async function lookupQrByToken(token: string): Promise<{ qr: CampaignQr; campaign: Campaign } | null> {
  const [qr] = await db.select().from(campaignQrs).where(eq(campaignQrs.token, token));
  if (!qr) return null;
  const campaign = await getCampaign(qr.campaignId);
  if (!campaign) return null;
  return { qr, campaign };
}

export async function lookupQrByShortCode(
  shortCode: string,
): Promise<{ qr: CampaignQr; campaign: Campaign } | null> {
  const normalized = shortCode.trim().toUpperCase();
  const [qr] = await db.select().from(campaignQrs).where(eq(campaignQrs.shortCode, normalized));
  if (!qr) return null;
  const campaign = await getCampaign(qr.campaignId);
  if (!campaign) return null;
  return { qr, campaign };
}

export async function redeemQrByToken(
  token: string,
  redeemedBy: string | null,
): Promise<RedeemResult> {
  // Run the whole check + update inside a transaction with SELECT ... FOR UPDATE
  // on the campaign row so concurrent redemptions of the same campaign are
  // serialized and the usage cap cannot be overshot.
  return await db.transaction(async (tx) => {
    const [qr] = await tx.select().from(campaignQrs).where(eq(campaignQrs.token, token));
    if (!qr) return { ok: false, error: "not_found" } as RedeemResult;

    // Lock the campaign row for the duration of this transaction so concurrent
    // redemptions of the same campaign are serialized.
    const [campaign] = await tx
      .select()
      .from(campaigns)
      .where(eq(campaigns.id, qr.campaignId))
      .for("update");
    if (!campaign) return { ok: false, error: "not_found" } as RedeemResult;

    // Re-read the qr after taking the lock so we see committed updates from
    // any concurrent redemption that just released the lock.
    const [qrFresh] = await tx.select().from(campaignQrs).where(eq(campaignQrs.token, token));
    if (!qrFresh) return { ok: false, error: "not_found" } as RedeemResult;
    if (qrFresh.status === "redeemed") {
      return { ok: false, error: "already_used", qr: qrFresh, campaign } as RedeemResult;
    }

    const countRows = await tx
      .select({ c: sql<number>`COUNT(*)::int` })
      .from(campaignQrs)
      .where(and(eq(campaignQrs.campaignId, campaign.id), eq(campaignQrs.status, "redeemed")));
    const redeemedCount = Number(countRows[0]?.c ?? 0);

    const err = validateCampaignActive(campaign, redeemedCount);
    if (err) return { ok: false, error: err, qr: qrFresh, campaign } as RedeemResult;

    const [updated] = await tx
      .update(campaignQrs)
      .set({
        status: "redeemed",
        redeemedAt: new Date(),
        redeemedBy: redeemedBy ?? null,
      })
      .where(and(eq(campaignQrs.token, token), sql`${campaignQrs.status} <> 'redeemed'`))
      .returning();

    if (!updated) {
      return { ok: false, error: "already_used", qr, campaign } as RedeemResult;
    }
    return { ok: true, qr: updated, campaign } as RedeemResult;
  });
}

export type CampaignDashboardStats = {
  totals: { clicks: number; issued: number; saved: number; redeemed: number };
  campaigns: CampaignWithStats[];
  recentRedemptions: Array<{
    token: string;
    shortCode: string;
    campaignId: string;
    campaignName: string;
    promoCode: string;
    redeemedAt: Date;
    redeemedBy: string | null;
  }>;
};

export async function getCampaignDashboardStats(): Promise<CampaignDashboardStats> {
  const cs = await listCampaignsWithStats();
  const totals = cs.reduce(
    (acc, c) => {
      acc.clicks += c.clicks;
      acc.issued += c.issued;
      acc.saved += c.saved;
      acc.redeemed += c.redeemed;
      return acc;
    },
    { clicks: 0, issued: 0, saved: 0, redeemed: 0 },
  );

  const recentRows = await db
    .select({
      token: campaignQrs.token,
      shortCode: campaignQrs.shortCode,
      campaignId: campaignQrs.campaignId,
      campaignName: campaigns.name,
      promoCode: campaigns.promoCode,
      redeemedAt: campaignQrs.redeemedAt,
      redeemedBy: campaignQrs.redeemedBy,
    })
    .from(campaignQrs)
    .innerJoin(campaigns, eq(campaigns.id, campaignQrs.campaignId))
    .where(eq(campaignQrs.status, "redeemed"))
    .orderBy(desc(campaignQrs.redeemedAt))
    .limit(20);

  const recentRedemptions = recentRows
    .filter((r) => r.redeemedAt != null)
    .map((r) => ({
      token: r.token,
      shortCode: r.shortCode,
      campaignId: r.campaignId,
      campaignName: r.campaignName,
      promoCode: r.promoCode,
      redeemedAt: r.redeemedAt as Date,
      redeemedBy: r.redeemedBy,
    }));

  return { totals, campaigns: cs, recentRedemptions };
}

// ============================================
// Time-bucketed campaign analytics (task-143)
// ============================================

export type CampaignGranularity = "day" | "week" | "month";

export type CampaignTimeBucket = {
  bucket: string; // YYYY-MM-DD, start of the bucket in Bangkok local time
  scanned: number;
  saved: number;
  redeemed: number;
};

type CampaignTotals = { scanned: number; saved: number; redeemed: number };

export type CampaignTimeSeries = {
  granularity: CampaignGranularity;
  start: string;
  end: string;
  buckets: string[];
  combined: CampaignTimeBucket[];
  perCampaign: Array<{
    campaignId: string;
    campaignName: string;
    promoCode: string;
    buckets: CampaignTimeBucket[];
    totals: CampaignTotals;
  }>;
  totals: CampaignTotals;
};

const BANGKOK_TZ = "Asia/Bangkok";

function fmtDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function startOfWeekMondayUTC(d: Date): Date {
  const day = d.getUTCDay(); // 0 Sun..6 Sat
  const diff = day === 0 ? 6 : day - 1;
  const r = new Date(d);
  r.setUTCDate(d.getUTCDate() - diff);
  return r;
}

// Generate the full ordered list of bucket keys spanning [start, end] at the
// given granularity, mirroring Postgres date_trunc semantics (week = Monday,
// month = 1st). Done in UTC date math on plain Y-M-D strings so it matches the
// Bangkok-local buckets produced by the SQL below without timezone drift.
function generateBucketKeys(
  start: string,
  end: string,
  granularity: CampaignGranularity,
): string[] {
  const [sy, sm, sd] = start.split("-").map(Number);
  const [ey, em, ed] = end.split("-").map(Number);
  if (!sy || !ey) return [];
  const endDate = new Date(Date.UTC(ey, em - 1, ed));
  const keys: string[] = [];
  if (granularity === "month") {
    let cur = new Date(Date.UTC(sy, sm - 1, 1));
    while (cur <= endDate) {
      keys.push(fmtDate(cur));
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    }
  } else if (granularity === "week") {
    let cur = startOfWeekMondayUTC(new Date(Date.UTC(sy, sm - 1, sd)));
    while (cur <= endDate) {
      keys.push(fmtDate(cur));
      cur = new Date(cur);
      cur.setUTCDate(cur.getUTCDate() + 7);
    }
  } else {
    let cur = new Date(Date.UTC(sy, sm - 1, sd));
    while (cur <= endDate) {
      keys.push(fmtDate(cur));
      cur = new Date(cur);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
  }
  return keys;
}

async function countByCampaignBucket(
  table: "campaign_clicks" | "campaign_qrs",
  tsColumn: "clicked_at" | "saved_at" | "redeemed_at",
  start: string,
  end: string,
  granularity: CampaignGranularity,
): Promise<Map<string, Map<string, number>>> {
  // granularity is whitelisted to avoid SQL injection in date_trunc.
  const gran = granularity;
  const bucketExpr = `to_char(date_trunc('${gran}', ${tsColumn} AT TIME ZONE '${BANGKOK_TZ}'), 'YYYY-MM-DD')`;
  const text = `
    SELECT campaign_id AS "campaignId",
           ${bucketExpr} AS bucket,
           COUNT(*)::int AS c
    FROM ${table}
    WHERE ${tsColumn} IS NOT NULL
      AND (${tsColumn} AT TIME ZONE '${BANGKOK_TZ}') >= $1::timestamp
      AND (${tsColumn} AT TIME ZONE '${BANGKOK_TZ}') < ($2::date + 1)::timestamp
    GROUP BY campaign_id, bucket
  `;
  const result = await pool.query(text, [start, end]);
  const map = new Map<string, Map<string, number>>();
  for (const row of result.rows) {
    const cid = row.campaignId as string;
    const bucket = row.bucket as string;
    const c = Number(row.c) || 0;
    if (!map.has(cid)) map.set(cid, new Map());
    map.get(cid)!.set(bucket, c);
  }
  return map;
}

export async function getCampaignTimeSeries(
  start: string,
  end: string,
  granularity: CampaignGranularity,
): Promise<CampaignTimeSeries> {
  const bucketKeys = generateBucketKeys(start, end, granularity);

  const [scannedMap, savedMap, redeemedMap] = await Promise.all([
    countByCampaignBucket("campaign_clicks", "clicked_at", start, end, granularity),
    countByCampaignBucket("campaign_qrs", "saved_at", start, end, granularity),
    countByCampaignBucket("campaign_qrs", "redeemed_at", start, end, granularity),
  ]);

  const allRaw = await db
    .select({ id: campaigns.id, name: campaigns.name, promoCode: campaigns.promoCode })
    .from(campaigns)
    .orderBy(desc(campaigns.createdAt));
  const pinnedRank = (code: string) => {
    const i = PINNED_PROMO_CODES.indexOf(code);
    return i === -1 ? PINNED_PROMO_CODES.length : i;
  };
  const campaignList = [...allRaw].sort(
    (a, b) => pinnedRank(a.promoCode) - pinnedRank(b.promoCode),
  );

  const emptyBuckets = (): CampaignTimeBucket[] =>
    bucketKeys.map((b) => ({ bucket: b, scanned: 0, saved: 0, redeemed: 0 }));

  const combinedByBucket = new Map<string, CampaignTimeBucket>();
  for (const b of bucketKeys) {
    combinedByBucket.set(b, { bucket: b, scanned: 0, saved: 0, redeemed: 0 });
  }

  const totals: CampaignTotals = { scanned: 0, saved: 0, redeemed: 0 };

  const perCampaign = campaignList.map((c) => {
    const buckets = emptyBuckets();
    const byKey = new Map(buckets.map((b) => [b.bucket, b]));
    const cTotals: CampaignTotals = { scanned: 0, saved: 0, redeemed: 0 };

    const apply = (
      map: Map<string, Map<string, number>>,
      field: keyof CampaignTotals,
    ) => {
      const perBucket = map.get(c.id);
      if (!perBucket) return;
      perBucket.forEach((count, bucket) => {
        const target = byKey.get(bucket);
        if (target) target[field] += count;
        cTotals[field] += count;
        totals[field] += count;
        const combined = combinedByBucket.get(bucket);
        if (combined) combined[field] += count;
      });
    };
    apply(scannedMap, "scanned");
    apply(savedMap, "saved");
    apply(redeemedMap, "redeemed");

    return {
      campaignId: c.id,
      campaignName: c.name,
      promoCode: c.promoCode,
      buckets,
      totals: cTotals,
    };
  });

  return {
    granularity,
    start,
    end,
    buckets: bucketKeys,
    combined: bucketKeys.map((b) => combinedByBucket.get(b)!),
    perCampaign,
    totals,
  };
}
