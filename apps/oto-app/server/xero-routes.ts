import { Router, Request, Response } from "express";
import { XeroClient } from "xero-node";
import { db } from "./db";
import { xeroTokens } from "@shared/schema";
import { eq, and, desc, sql } from "drizzle-orm";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { assertFinanceOrganisationOwner, financeParkGroup, FinanceOrganisationAccessError } from "./lib/financeOrganisationAccess";

declare module "express-session" {
  interface SessionData {
    xeroConnection?: { state: string; parkGroup: string; userId: string };
  }
}

/**
 * Xero sends the person back here after they authorise, and the URI must match
 * one registered on the Xero app exactly. It was hard-coded to a Replit
 * workspace host, which is why the OAuth flow only ever completed on Replit
 * (intake note 01, finding 9). It is configuration now; unset, the routes
 * below refuse rather than sending anyone to a host that is not ours.
 */
const REDIRECT_URI = process.env.XERO_REDIRECT_URI ?? "";

const XERO_SCOPES = [
  "openid",
  "profile",
  "email",
  "accounting.transactions.read",
  "accounting.settings.read",
  "accounting.contacts.read",
  "accounting.reports.read",
  "offline_access",
];

function createXeroClient(state?: string): XeroClient {
  // Named here rather than left to fail inside the OAuth exchange: an empty
  // redirect URI produces an error from Xero's own servers that says nothing
  // about which of our variables is missing.
  if (!REDIRECT_URI) {
    throw new Error("XERO_REDIRECT_URI is not set — the Xero OAuth callback has nowhere to return to");
  }
  return new XeroClient({
    clientId: process.env.XERO_CLIENT_ID!,
    clientSecret: process.env.XERO_CLIENT_SECRET!,
    redirectUris: [REDIRECT_URI],
    scopes: XERO_SCOPES,
    state,
  });
}

async function getActiveTokenSet(parkGroup: string) {
  const [token] = await db.select().from(xeroTokens)
    .where(and(eq(xeroTokens.isActive, true), eq(xeroTokens.tenantId, parkGroup)))
    .orderBy(desc(xeroTokens.updatedAt)).limit(1);
  if (!token) return null;
  if (!token.xeroTenantId) throw new FinanceOrganisationAccessError(404, "Finance organisation not found");
  await assertFinanceOrganisationOwner(parkGroup, token.xeroTenantId);
  return token;
}

const saveSession = (req: Request) => new Promise<void>((resolve, reject) =>
  req.session.save((error) => error ? reject(error) : resolve()));

async function consumeConnectionIdentity(req: Request) {
  const parkGroup = financeParkGroup(req);
  const state = req.query.state;
  if (typeof state !== "string" || !/^[a-f0-9]{64}$/.test(state)) {
    throw new FinanceOrganisationAccessError(400, "Start the Xero connection again");
  }
  return db.transaction(async (tx) => {
    // Session reload under the same lock makes concurrent callbacks consume once.
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`otoapp:xero:callback:${req.sessionID}`}, 0))`);
    await new Promise<void>((resolve, reject) => req.session.reload((error) => error ? reject(error) : resolve()));
    const pending = req.session.xeroConnection;
    if (!pending || !/^[a-f0-9]{64}$/.test(pending.state) || pending.parkGroup !== parkGroup || pending.userId !== req.user?.id ||
        !timingSafeEqual(Buffer.from(state), Buffer.from(pending.state))) {
      throw new FinanceOrganisationAccessError(400, "Start the Xero connection again");
    }
    delete req.session.xeroConnection;
    await saveSession(req);
    return pending;
  });
}

async function refreshTokenIfNeeded(token: typeof xeroTokens.$inferSelect, createClient: (state?: string) => XeroClient) {
  const now = new Date();
  const expiresAt = new Date(token.expiresAt);
  const fiveMinBuffer = 5 * 60 * 1000;

  if (now.getTime() + fiveMinBuffer < expiresAt.getTime()) {
    return token;
  }

  console.log("[Xero] Token expired or expiring soon, refreshing...");
  const xero = createClient();

  try {
    const newTokenSet = await xero.refreshWithRefreshToken(
      process.env.XERO_CLIENT_ID!,
      process.env.XERO_CLIENT_SECRET!,
      token.refreshToken
    );

    const expiresIn = (newTokenSet as any).expires_in || 1800;
    const newExpiresAt = new Date(Date.now() + expiresIn * 1000);

    const [updated] = await db
      .update(xeroTokens)
      .set({
        accessToken: newTokenSet.access_token!,
        refreshToken: newTokenSet.refresh_token!,
        idToken: (newTokenSet as any).id_token || token.idToken,
        expiresAt: newExpiresAt,
        updatedAt: new Date(),
      })
      .where(eq(xeroTokens.id, token.id))
      .returning();

    console.log("[Xero] Token refreshed successfully");
    return updated;
  } catch (error: any) {
    console.error("[Xero] Token refresh failed:", error.message);
    await db
      .update(xeroTokens)
      .set({ isActive: false, updatedAt: new Date() })
      .where(eq(xeroTokens.id, token.id));
    throw new Error("Xero connection expired. Please reconnect.");
  }
}

export function createXeroRouter(createClient: (state?: string) => XeroClient = createXeroClient) {
  const router = Router();

  router.get("/connect", async (req: Request, res: Response) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }

    try {
      const parkGroup = financeParkGroup(req);
      const state = randomBytes(32).toString("hex");
      const xero = createClient(state);
      const consentUrl = await xero.buildConsentUrl();
      req.session.xeroConnection = { state, parkGroup, userId: req.user.id };
      await saveSession(req);
      res.redirect(consentUrl);
    } catch (error: any) {
      console.error("[Xero] Failed to build consent URL:", error.message);
      res.redirect("/analytics?xero=error&message=" + encodeURIComponent("Failed to start Xero connection"));
    }
  });

  router.get("/callback", async (req: Request, res: Response) => {
    if (!req.isAuthenticated?.() || !req.user) return res.status(401).json({ message: "Not authenticated" });
    try {
      const identity = await consumeConnectionIdentity(req);
      const xero = createClient(identity.state);
      const fullUrl = `${REDIRECT_URI}?${new URLSearchParams(req.query as Record<string, string>).toString()}`;
      const tokenSet = await xero.apiCallback(fullUrl);

      const expiresIn = (tokenSet as any).expires_in || 1800;
      const expiresAt = new Date(Date.now() + expiresIn * 1000);

      await xero.updateTenants();
      const xeroTenants = xero.tenants;
      const xeroTenant = xeroTenants[0];

      const organisation = xeroTenant?.tenantId;
      if (!organisation) throw new Error("No Xero organisation was returned");
      await db.transaction(async (tx) => {
        await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`otoapp:finance:organisation:${organisation}`}, 0))`);
        await assertFinanceOrganisationOwner(identity.parkGroup, organisation, tx, true);
        await tx.update(xeroTokens).set({ isActive: false, updatedAt: new Date() })
          .where(and(eq(xeroTokens.isActive, true), eq(xeroTokens.tenantId, identity.parkGroup)));
        await tx.insert(xeroTokens).values({
          tenantId: identity.parkGroup,
          xeroTenantId: organisation,
          xeroTenantName: xeroTenant.tenantName || null,
          accessToken: tokenSet.access_token!,
          refreshToken: tokenSet.refresh_token!,
          idToken: (tokenSet as any).id_token || null,
          expiresAt,
          scopes: XERO_SCOPES.join(" "),
          connectedBy: identity.userId,
          isActive: true,
        });
      });

      console.log(`[Xero] Connected to org: ${xeroTenant?.tenantName || "unknown"}`);
      res.redirect("/analytics?xero=connected");
    } catch (error: any) {
      console.error("[Xero] OAuth connection could not be completed");
      res.redirect("/analytics?xero=error&message=" + encodeURIComponent(error instanceof FinanceOrganisationAccessError ? error.message : "Failed to complete Xero connection"));
    }
  });

  router.get("/status", async (req: Request, res: Response) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const token = await getActiveTokenSet(financeParkGroup(req));
      if (!token) {
        return res.json({ connected: false });
      }
      const isExpired = new Date() > new Date(token.expiresAt);
      res.json({
        connected: true,
        xeroTenantName: token.xeroTenantName,
        connectedAt: token.createdAt,
        expiresAt: token.expiresAt,
        isExpired,
      });
    } catch (error: any) {
      res.status(error instanceof FinanceOrganisationAccessError ? error.status : 500).json({ message: error.message });
    }
  });

  router.post("/disconnect", async (req: Request, res: Response) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const parkGroup = financeParkGroup(req);
      await db
        .update(xeroTokens)
        .set({ isActive: false, updatedAt: new Date() })
        .where(and(eq(xeroTokens.isActive, true), eq(xeroTokens.tenantId, parkGroup)));
      res.json({ success: true });
    } catch (error: any) {
      res.status(error instanceof FinanceOrganisationAccessError ? error.status : 500).json({ message: error.message });
    }
  });

  router.get("/profit-and-loss", async (req: Request, res: Response) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const token = await getActiveTokenSet(financeParkGroup(req));
      if (!token) return res.status(400).json({ message: "Xero not connected" });

      const refreshed = await refreshTokenIfNeeded(token, createClient);
      const xero = createClient();
      xero.setTokenSet({
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken,
        id_token: refreshed.idToken || undefined,
        token_type: "Bearer",
      } as any);

      const { fromDate, toDate, periods, timeframe } = req.query;

      const response = await xero.accountingApi.getReportProfitAndLoss(
        refreshed.xeroTenantId!,
        fromDate as string || undefined,
        toDate as string || undefined,
        periods ? parseInt(periods as string) : undefined,
        timeframe as string || undefined,
      );

      res.json(response.body);
    } catch (error: any) {
      console.error("[Xero] P&L error:", error.message);
      res.status(error instanceof FinanceOrganisationAccessError ? error.status : 500).json({ message: error.message });
    }
  });

  router.get("/balance-sheet", async (req: Request, res: Response) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const token = await getActiveTokenSet(financeParkGroup(req));
      if (!token) return res.status(400).json({ message: "Xero not connected" });

      const refreshed = await refreshTokenIfNeeded(token, createClient);
      const xero = createClient();
      xero.setTokenSet({
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken,
        id_token: refreshed.idToken || undefined,
        token_type: "Bearer",
      } as any);

      const { date, periods, timeframe } = req.query;

      const response = await xero.accountingApi.getReportBalanceSheet(
        refreshed.xeroTenantId!,
        date as string || undefined,
        periods ? parseInt(periods as string) : undefined,
        timeframe as string || undefined,
      );

      res.json(response.body);
    } catch (error: any) {
      console.error("[Xero] Balance sheet error:", error.message);
      res.status(error instanceof FinanceOrganisationAccessError ? error.status : 500).json({ message: error.message });
    }
  });

  router.get("/invoices", async (req: Request, res: Response) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const token = await getActiveTokenSet(financeParkGroup(req));
      if (!token) return res.status(400).json({ message: "Xero not connected" });

      const refreshed = await refreshTokenIfNeeded(token, createClient);
      const xero = createClient();
      xero.setTokenSet({
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken,
        id_token: refreshed.idToken || undefined,
        token_type: "Bearer",
      } as any);

      const { status, page, modifiedSince } = req.query;
      const where = status ? `Status=="${status}"` : undefined;

      const response = await xero.accountingApi.getInvoices(
        refreshed.xeroTenantId!,
        modifiedSince ? new Date(modifiedSince as string) : undefined,
        where,
        "Date DESC",
        undefined,
        undefined,
        undefined,
        page ? parseInt(page as string) : 1,
      );

      res.json(response.body);
    } catch (error: any) {
      console.error("[Xero] Invoices error:", error.message);
      res.status(error instanceof FinanceOrganisationAccessError ? error.status : 500).json({ message: error.message });
    }
  });

  router.get("/accounts", async (req: Request, res: Response) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const token = await getActiveTokenSet(financeParkGroup(req));
      if (!token) return res.status(400).json({ message: "Xero not connected" });

      const refreshed = await refreshTokenIfNeeded(token, createClient);
      const xero = createClient();
      xero.setTokenSet({
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken,
        id_token: refreshed.idToken || undefined,
        token_type: "Bearer",
      } as any);

      const response = await xero.accountingApi.getAccounts(refreshed.xeroTenantId!);
      res.json(response.body);
    } catch (error: any) {
      console.error("[Xero] Accounts error:", error.message);
      res.status(error instanceof FinanceOrganisationAccessError ? error.status : 500).json({ message: error.message });
    }
  });

  router.get("/bank-summary", async (req: Request, res: Response) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const token = await getActiveTokenSet(financeParkGroup(req));
      if (!token) return res.status(400).json({ message: "Xero not connected" });

      const refreshed = await refreshTokenIfNeeded(token, createClient);
      const xero = createClient();
      xero.setTokenSet({
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken,
        id_token: refreshed.idToken || undefined,
        token_type: "Bearer",
      } as any);

      const { fromDate, toDate } = req.query;
      const response = await xero.accountingApi.getReportBankSummary(
        refreshed.xeroTenantId!,
        fromDate as string || undefined,
        toDate as string || undefined,
      );

      res.json(response.body);
    } catch (error: any) {
      console.error("[Xero] Bank summary error:", error.message);
      res.status(error instanceof FinanceOrganisationAccessError ? error.status : 500).json({ message: error.message });
    }
  });

  router.get("/organisation", async (req: Request, res: Response) => {
    if (!req.isAuthenticated?.() || !req.user) {
      return res.status(401).json({ message: "Not authenticated" });
    }
    try {
      const token = await getActiveTokenSet(financeParkGroup(req));
      if (!token) return res.status(400).json({ message: "Xero not connected" });

      const refreshed = await refreshTokenIfNeeded(token, createClient);
      const xero = createClient();
      xero.setTokenSet({
        access_token: refreshed.accessToken,
        refresh_token: refreshed.refreshToken,
        id_token: refreshed.idToken || undefined,
        token_type: "Bearer",
      } as any);

      const response = await xero.accountingApi.getOrganisations(refreshed.xeroTenantId!);
      res.json(response.body);
    } catch (error: any) {
      console.error("[Xero] Organisation error:", error.message);
      res.status(error instanceof FinanceOrganisationAccessError ? error.status : 500).json({ message: error.message });
    }
  });

  return router;
}

export default createXeroRouter();
