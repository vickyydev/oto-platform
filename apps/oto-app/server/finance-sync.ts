import { db, pool } from "./db";
import {
  xeroTokens,
  xeroSyncRuns,
  xeroTrackingCategories,
  xeroTrackingOptions,
  xeroReportsRaw,
  plFacts,
  cashTxns,
  cashDaily,
} from "@shared/schema";
import { eq, and, desc, sql, gte, lte } from "drizzle-orm";

const XERO_TOKEN_URL = "https://identity.xero.com/connect/token";
const XERO_API_BASE = "https://api.xero.com/api.xro/2.0";

export async function ensureFreshToken(tenantId: string): Promise<string> {
  const [token] = await db
    .select()
    .from(xeroTokens)
    .where(and(eq(xeroTokens.xeroTenantId, tenantId), eq(xeroTokens.isActive, true)))
    .orderBy(desc(xeroTokens.updatedAt))
    .limit(1);

  if (!token) throw new Error(`No active Xero connection for tenant ${tenantId}`);

  const now = Date.now();
  const expiresAt = new Date(token.expiresAt).getTime();

  if (now + 60_000 < expiresAt) {
    return token.accessToken;
  }

  console.log("[FinanceSync] Token expired, refreshing via direct POST...");

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: token.refreshToken,
    client_id: process.env.XERO_CLIENT_ID!,
    client_secret: process.env.XERO_CLIENT_SECRET!,
  });

  const resp = await fetch(XERO_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error("[FinanceSync] Token refresh failed:", errText);
    await db
      .update(xeroTokens)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(xeroTokens.id, token.id));
    throw new Error("Xero token refresh failed. Please reconnect.");
  }

  const data = await resp.json();
  const newExpiresAt = new Date(Date.now() + (data.expires_in || 1800) * 1000);

  await db
    .update(xeroTokens)
    .set({
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      idToken: data.id_token || token.idToken,
      expiresAt: newExpiresAt,
      updatedAt: new Date(),
    })
    .where(eq(xeroTokens.id, token.id));

  console.log("[FinanceSync] Token refreshed, new refresh_token stored");
  return data.access_token;
}

async function xeroGet(accessToken: string, tenantId: string, path: string): Promise<any> {
  const url = `${XERO_API_BASE}${path}`;
  console.log(`[FinanceSync] GET ${url}`);
  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Xero-tenant-id": tenantId,
      Accept: "application/json",
    },
  });
  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Xero API error ${resp.status}: ${errText}`);
  }
  return resp.json();
}

async function logSyncRun(
  tenantId: string,
  syncType: string,
  fromDate: string | null,
  toDate: string | null,
  status: string,
  errorMessage?: string
) {
  await db.insert(xeroSyncRuns).values({
    tenantId,
    syncType,
    fromDate,
    toDate,
    status,
    errorMessage: errorMessage || null,
  });
}

export async function syncTracking(tenantId: string) {
  let accessToken: string;
  try {
    accessToken = await ensureFreshToken(tenantId);
  } catch (err: any) {
    await logSyncRun(tenantId, "TRACKING", null, null, "ERROR", err.message);
    throw err;
  }

  try {
    const data = await xeroGet(accessToken, tenantId, "/TrackingCategories");
    const categories = data.TrackingCategories || [];

    let locationCategoryId: string | null = null;
    const locationOptions: { id: string; name: string }[] = [];

    for (const cat of categories) {
      await db
        .insert(xeroTrackingCategories)
        .values({
          tenantId,
          trackingCategoryId: cat.TrackingCategoryID,
          name: cat.Name,
          status: cat.Status,
          rawJson: cat,
        })
        .onConflictDoUpdate({
          target: [xeroTrackingCategories.tenantId, xeroTrackingCategories.trackingCategoryId],
          set: { name: cat.Name, status: cat.Status, rawJson: cat },
        });

      for (const opt of cat.Options || []) {
        await db
          .insert(xeroTrackingOptions)
          .values({
            tenantId,
            trackingCategoryId: cat.TrackingCategoryID,
            trackingOptionId: opt.TrackingOptionID,
            name: opt.Name,
            status: opt.Status,
          })
          .onConflictDoUpdate({
            target: [xeroTrackingOptions.tenantId, xeroTrackingOptions.trackingOptionId],
            set: { name: opt.Name, status: opt.Status, trackingCategoryId: cat.TrackingCategoryID },
          });
      }

      if (cat.Name === "Location") {
        locationCategoryId = cat.TrackingCategoryID;
        for (const opt of cat.Options || []) {
          locationOptions.push({ id: opt.TrackingOptionID, name: opt.Name });
        }
      }
    }

    await logSyncRun(tenantId, "TRACKING", null, null, "OK");
    console.log(`[FinanceSync] Tracking synced: ${categories.length} categories`);
    return { trackingCategoryID: locationCategoryId, options: locationOptions };
  } catch (err: any) {
    await logSyncRun(tenantId, "TRACKING", null, null, "ERROR", err.message);
    throw err;
  }
}

export async function syncPL(tenantId: string, fromDate: string, toDate: string) {
  let accessToken: string;
  try {
    accessToken = await ensureFreshToken(tenantId);
  } catch (err: any) {
    await logSyncRun(tenantId, "PL", fromDate, toDate, "ERROR", err.message);
    throw err;
  }

  try {
    const [locationCat] = await db
      .select()
      .from(xeroTrackingCategories)
      .where(
        and(
          eq(xeroTrackingCategories.tenantId, tenantId),
          eq(xeroTrackingCategories.name, "Location")
        )
      )
      .limit(1);

    if (!locationCat) {
      throw new Error("Location tracking category not found. Run /finance/sync/tracking first.");
    }

    const trackingCategoryID = locationCat.trackingCategoryId;
    const path = `/Reports/ProfitAndLoss?fromDate=${fromDate}&toDate=${toDate}&trackingCategoryID=${trackingCategoryID}`;
    const data = await xeroGet(accessToken, tenantId, path);

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const rawInsert = await db
        .insert(xeroReportsRaw)
        .values({
          tenantId,
          reportType: "ProfitAndLoss",
          fromDate,
          toDate,
          trackingCategoryId: trackingCategoryID,
          rawJson: data,
        })
        .returning();

      const reportRawId = rawInsert[0].id;

      const facts = parsePLMultiColumn(data, reportRawId, tenantId, fromDate, toDate);

      if (facts.length > 0) {
        const BATCH = 500;
        for (let i = 0; i < facts.length; i += BATCH) {
          await db.insert(plFacts).values(facts.slice(i, i + BATCH));
        }
      }

      await client.query("COMMIT");
      await logSyncRun(tenantId, "PL", fromDate, toDate, "OK");
      console.log(`[FinanceSync] P&L synced: 1 report, ${facts.length} facts`);
      return { reportsStored: 1, factsStored: facts.length };
    } catch (txErr) {
      await client.query("ROLLBACK");
      throw txErr;
    } finally {
      client.release();
    }
  } catch (err: any) {
    await logSyncRun(tenantId, "PL", fromDate, toDate, "ERROR", err.message);
    throw err;
  }
}

function parsePLMultiColumn(
  data: any,
  reportRawId: string,
  tenantId: string,
  fromDate: string,
  toDate: string
): any[] {
  const facts: any[] = [];
  const reports = data?.Reports || data?.reports || [];
  const report = reports[0];
  if (!report) return facts;

  const rows = report.Rows || report.rows || [];

  const headerRow = rows.find((r: any) => (r.RowType || r.rowType) === "Header");
  if (!headerRow) return facts;

  const headerCells = headerRow.Cells || headerRow.cells || [];
  const locationNames: string[] = [];
  for (let i = 1; i < headerCells.length; i++) {
    locationNames.push(headerCells[i].Value || headerCells[i].value || `Column${i}`);
  }

  let currentSection = "Unknown";

  for (const row of rows) {
    const rowType = row.RowType || row.rowType || "";
    const title = row.Title || row.title || "";

    if (rowType === "Section") {
      if (title) currentSection = title;
      const innerRows = row.Rows || row.rows || [];
      for (const innerRow of innerRows) {
        const cells = innerRow.Cells || innerRow.cells || [];
        if (cells.length < 2) continue;

        const lineName = cells[0]?.Value || cells[0]?.value || "";
        if (!lineName) continue;

        for (let i = 1; i < cells.length && i <= locationNames.length; i++) {
          const rawVal = cells[i]?.Value || cells[i]?.value;
          if (rawVal === undefined || rawVal === null || rawVal === "") continue;

          const numVal = parseFloat(String(rawVal).replace(/,/g, ""));
          if (isNaN(numVal)) continue;

          facts.push({
            reportRawId,
            tenantId,
            fromDate,
            toDate,
            section: currentSection,
            lineName,
            locationName: locationNames[i - 1],
            value: String(numVal),
          });
        }
      }
    }
  }

  return facts;
}

export function normalizeXeroDate(input: any): string | null {
  if (input === null || input === undefined) return null;

  if (input instanceof Date) {
    if (isNaN(input.getTime())) return null;
    return input.toISOString().slice(0, 10);
  }

  const str = String(input).trim();
  if (!str) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;

  if (/^\d{4}-\d{2}-\d{2}T/.test(str)) return str.slice(0, 10);

  const msMatch = str.match(/^\/Date\((\d+)/);
  if (msMatch) {
    const ms = parseInt(msMatch[1], 10);
    const d = new Date(ms);
    if (isNaN(d.getTime())) return null;
    return d.toISOString().slice(0, 10);
  }

  const fallback = new Date(str);
  if (!isNaN(fallback.getTime())) return fallback.toISOString().slice(0, 10);

  return null;
}

{
  const t1 = normalizeXeroDate("/Date(1705536000000+0000)/");
  const t2 = normalizeXeroDate("2026-01-31");
  const t3 = normalizeXeroDate(null);
  const t4 = normalizeXeroDate(new Date("2025-06-15T00:00:00Z"));
  console.log(`[FinanceSync] normalizeXeroDate self-test:`);
  console.log(`  "/Date(1705536000000+0000)/" => "${t1}" (expect 2024-01-18)`);
  console.log(`  "2026-01-31" => "${t2}" (expect 2026-01-31)`);
  console.log(`  null => "${t3}" (expect null)`);
  console.log(`  Date("2025-06-15") => "${t4}" (expect 2025-06-15)`);
}

function safeNumeric(val: any): number | null {
  if (val === null || val === undefined) return null;
  const n = Number(val);
  return isNaN(n) ? null : n;
}

export async function syncCash(tenantId: string, fromDate: string, toDate: string) {
  let accessToken: string;
  try {
    accessToken = await ensureFreshToken(tenantId);
  } catch (err: any) {
    await logSyncRun(tenantId, "CASH", fromDate, toDate, "ERROR", err.message);
    throw err;
  }

  try {
    let page = 1;
    let allTxns: any[] = [];
    let hasMore = true;

    while (hasMore) {
      const where = encodeURIComponent(
        `Date >= DateTime(${fromDate.replace(/-/g, ",")}) AND Date <= DateTime(${toDate.replace(/-/g, ",")})`
      );
      const path = `/BankTransactions?where=${where}&order=Date ASC&page=${page}`;
      const data = await xeroGet(accessToken, tenantId, path);
      const txns = data.BankTransactions || data.bankTransactions || [];
      allTxns = allTxns.concat(txns);
      hasMore = txns.length === 100;
      page++;
      if (page > 50) break;
    }

    let inserted = 0;
    let skipped = 0;

    for (const txn of allTxns) {
      const txnId = txn.BankTransactionID || txn.bankTransactionID;

      const normalizedDate = normalizeXeroDate(
        txn.Date ?? txn.DateString ?? txn.DateUTC ?? txn.UpdatedDateUTC
      );

      if (!normalizedDate) {
        const rawDateVal = txn.Date ?? txn.DateString ?? txn.DateUTC ?? txn.UpdatedDateUTC;
        console.warn(`[FinanceSync] Skipping txn ${txnId}: unparseable date "${rawDateVal}"`);
        skipped++;
        continue;
      }

      const total = safeNumeric(txn.Total ?? txn.total);
      if (total === null) {
        console.warn(`[FinanceSync] Skipping txn ${txnId}: invalid Total "${txn.Total ?? txn.total}"`);
        skipped++;
        continue;
      }

      const direction = total >= 0 ? "in" : "out";

      await db
        .insert(cashTxns)
        .values({
          tenantId,
          xeroBankTransactionId: txnId,
          date: normalizedDate,
          bankAccountName: txn.BankAccount?.Name || txn.bankAccount?.name || null,
          type: txn.Type || txn.type || null,
          total: String(total),
          direction,
          rawJson: txn,
        })
        .onConflictDoUpdate({
          target: [cashTxns.tenantId, cashTxns.xeroBankTransactionId],
          set: {
            date: normalizedDate,
            bankAccountName: txn.BankAccount?.Name || txn.bankAccount?.name || null,
            type: txn.Type || txn.type || null,
            total: String(total),
            direction,
            rawJson: txn,
          },
        });
      inserted++;
    }

    await rebuildCashDaily(tenantId, fromDate, toDate);
    await logSyncRun(tenantId, "CASH", fromDate, toDate, "OK");
    console.log(`[FinanceSync] Cash synced: ${inserted} inserted, ${skipped} skipped of ${allTxns.length} total`);
    return { txnCount: inserted, skipped };
  } catch (err: any) {
    await logSyncRun(tenantId, "CASH", fromDate, toDate, "ERROR", err.message);
    throw err;
  }
}

async function rebuildCashDaily(tenantId: string, fromDate: string, toDate: string) {
  await db.delete(cashDaily).where(
    and(eq(cashDaily.tenantId, tenantId), gte(cashDaily.date, fromDate), lte(cashDaily.date, toDate))
  );

  await db.execute(sql`
    INSERT INTO cash_daily (tenant_id, date, cash_in, cash_out, net)
    SELECT
      tenant_id,
      date,
      COALESCE(SUM(CASE WHEN direction = 'in' THEN total ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN direction = 'out' THEN ABS(total) ELSE 0 END), 0),
      COALESCE(SUM(CASE WHEN direction = 'in' THEN total ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN direction = 'out' THEN ABS(total) ELSE 0 END), 0)
    FROM cash_txns
    WHERE tenant_id = ${tenantId}
      AND date >= ${fromDate}
      AND date <= ${toDate}
    GROUP BY tenant_id, date
    ON CONFLICT (tenant_id, date) DO UPDATE SET
      cash_in = EXCLUDED.cash_in,
      cash_out = EXCLUDED.cash_out,
      net = EXCLUDED.net
  `);
}

export async function queryPLCompare(params: {
  tenantId: string;
  fromDate: string;
  toDate: string;
  compareMode: "STLY" | "PREV_PERIOD";
}) {
  const { tenantId, fromDate, toDate, compareMode } = params;

  const baseFrom = new Date(fromDate);
  const baseTo = new Date(toDate);
  const durationMs = baseTo.getTime() - baseFrom.getTime();
  const durationDays = Math.round(durationMs / (1000 * 60 * 60 * 24));

  let compFrom: Date;
  let compTo: Date;

  if (compareMode === "STLY") {
    compFrom = new Date(baseFrom);
    compFrom.setFullYear(compFrom.getFullYear() - 1);
    compTo = new Date(baseTo);
    compTo.setFullYear(compTo.getFullYear() - 1);
  } else {
    compTo = new Date(baseFrom);
    compTo.setDate(compTo.getDate() - 1);
    compFrom = new Date(compTo);
    compFrom.setDate(compFrom.getDate() - durationDays);
  }

  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const [baseFacts, compFacts] = await Promise.all([
    db.select().from(plFacts).where(
      and(eq(plFacts.tenantId, tenantId), eq(plFacts.fromDate, fromDate), eq(plFacts.toDate, toDate))
    ),
    db.select().from(plFacts).where(
      and(eq(plFacts.tenantId, tenantId), eq(plFacts.fromDate, fmt(compFrom)), eq(plFacts.toDate, fmt(compTo)))
    ),
  ]);

  const aggregate = (facts: any[]) => {
    const byLocation: Record<string, { income: number; expenses: number; net: number }> = {};
    for (const f of facts) {
      const loc = f.locationName;
      if (!byLocation[loc]) byLocation[loc] = { income: 0, expenses: 0, net: 0 };
      const val = parseFloat(f.value) || 0;
      const section = (f.section || "").toLowerCase();
      if (section.includes("income") || section.includes("revenue")) {
        byLocation[loc].income += val;
      } else if (section.includes("expense") || section.includes("cost") || section.includes("overhead")) {
        byLocation[loc].expenses += Math.abs(val);
      }
    }
    for (const loc of Object.keys(byLocation)) {
      byLocation[loc].net = byLocation[loc].income - byLocation[loc].expenses;
    }
    return byLocation;
  };

  const base = aggregate(baseFacts);
  const compare = aggregate(compFacts);

  const totalBase = { income: 0, expenses: 0, net: 0 };
  const totalComp = { income: 0, expenses: 0, net: 0 };
  for (const v of Object.values(base)) { totalBase.income += v.income; totalBase.expenses += v.expenses; totalBase.net += v.net; }
  for (const v of Object.values(compare)) { totalComp.income += v.income; totalComp.expenses += v.expenses; totalComp.net += v.net; }

  const pct = (curr: number, prev: number) => prev !== 0 ? Math.round(((curr - prev) / Math.abs(prev)) * 10000) / 100 : curr !== 0 ? 100 : 0;

  return {
    basePeriod: { from: fromDate, to: toDate },
    comparePeriod: { from: fmt(compFrom), to: fmt(compTo) },
    base: { byLocation: base, total: totalBase },
    compare: { byLocation: compare, total: totalComp },
    variance: {
      incomePct: pct(totalBase.income, totalComp.income),
      expensesPct: pct(totalBase.expenses, totalComp.expenses),
      netPct: pct(totalBase.net, totalComp.net),
    },
  };
}

export async function queryCashSeries(params: {
  tenantId: string;
  fromDate: string;
  toDate: string;
  granularity: "day" | "week";
}) {
  const { tenantId, fromDate, toDate, granularity } = params;

  if (granularity === "day") {
    const rows = await db
      .select()
      .from(cashDaily)
      .where(and(eq(cashDaily.tenantId, tenantId), gte(cashDaily.date, fromDate), lte(cashDaily.date, toDate)))
      .orderBy(cashDaily.date);

    return rows.map((r) => ({
      date: r.date,
      cashIn: parseFloat(r.cashIn as string) || 0,
      cashOut: parseFloat(r.cashOut as string) || 0,
      net: parseFloat(r.net as string) || 0,
    }));
  }

  const weekRows = await db.execute(sql`
    SELECT
      date_trunc('week', date::date)::date AS date,
      SUM(cash_in)::numeric AS cash_in,
      SUM(cash_out)::numeric AS cash_out,
      SUM(net)::numeric AS net
    FROM cash_daily
    WHERE tenant_id = ${tenantId}
      AND date >= ${fromDate}
      AND date <= ${toDate}
    GROUP BY date_trunc('week', date::date)
    ORDER BY 1
  `);

  return (weekRows.rows || weekRows || []).map((r: any) => ({
    date: typeof r.date === "string" ? r.date : r.date?.toISOString?.()?.slice(0, 10),
    cashIn: parseFloat(r.cash_in) || 0,
    cashOut: parseFloat(r.cash_out) || 0,
    net: parseFloat(r.net) || 0,
  }));
}

export async function getSyncHistory(tenantId: string, limit = 20) {
  return db
    .select()
    .from(xeroSyncRuns)
    .where(eq(xeroSyncRuns.tenantId, tenantId))
    .orderBy(desc(xeroSyncRuns.createdAt))
    .limit(limit);
}

export async function getTrackingLocations(tenantId: string) {
  const [locationCat] = await db
    .select()
    .from(xeroTrackingCategories)
    .where(and(eq(xeroTrackingCategories.tenantId, tenantId), eq(xeroTrackingCategories.name, "Location")))
    .limit(1);

  if (!locationCat) return { categoryName: null, trackingCategoryID: null, options: [] };

  const opts = await db
    .select()
    .from(xeroTrackingOptions)
    .where(
      and(
        eq(xeroTrackingOptions.tenantId, tenantId),
        eq(xeroTrackingOptions.trackingCategoryId, locationCat.trackingCategoryId)
      )
    );

  return {
    categoryName: locationCat.name,
    trackingCategoryID: locationCat.trackingCategoryId,
    options: opts.map((o) => ({ id: o.trackingOptionId, name: o.name })),
  };
}
