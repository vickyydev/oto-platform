import { randomBytes } from "node:crypto";
import type { Express, NextFunction, Request, RequestHandler, Response } from "express";
import { storage } from "./storage";
import { hashPassword } from "./auth";
import { legacyLoginEnabled } from "./middleware/platformSignOn";
import { SUITE_PROVISION_UNCONFIGURED, provisionSuiteSignIn, readPhone, suiteProvisionConfig } from "./lib/suiteSignIn";

/**
 * "Provision suite sign-in" on the Users screen and on an advisor's Core
 * Account tab (SCRUM-539). One press: the platform makes the person a phone
 * account, links it to their user here, and the temporary password comes back
 * to this screen once — the booth-PIN pattern. The platform call and what it
 * may do are in `lib/suiteSignIn.ts`.
 *
 *   POST /api/users/:id/suite-sign-in     { actionId, phone? }   Setup > Users
 *   GET  /api/people/:id/suite-sign-in                            advisor tab
 *   POST /api/people/:id/suite-sign-in    { actionId, phone? }   advisor tab
 *
 * Fenced exactly as the screens' own routes are: the users door for a user,
 * the people door for an advisor, each answering another park group's record
 * as not found.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SuiteSignInDeps {
  requireAuth: RequestHandler;
  requireAdmin: RequestHandler;
  requireGlobalAdmin: RequestHandler;
  managedUserTenant: (userId: string) => Promise<string | undefined>;
  userManagementTenant: (req: Request) => Promise<string | undefined>;
  personParkGroup: (person: { id: string; email: string; tenantId?: string | null }) => Promise<string | undefined>;
}

/** A password nothing accepts, for a login made while this app's own form is closed. */
export async function unusablePassword(): Promise<string> {
  return hashPassword(randomBytes(32).toString("base64url"));
}

/** Somebody else here already holds this phone (it is unique on users). */
async function phoneTakenByAnother(phoneE164: string, userId: string | null): Promise<boolean> {
  const holder = await storage.getUserByPhoneE164(phoneE164);
  return !!holder && holder.id !== userId;
}

function readBody(req: Request): { actionId: string; phone: unknown } | null {
  const body = req.body as { actionId?: unknown; phone?: unknown } | undefined;
  if (!body || typeof body.actionId !== "string" || !UUID_RE.test(body.actionId)) return null;
  return { actionId: body.actionId, phone: body.phone };
}

const NEEDS_PHONE = "A phone number is needed: it is what they sign in with at the launcher.";

/**
 * Save the phone (when one was typed), then ask the platform. Shared by both
 * doors; `userId` is the app user who gets the sign-in.
 */
async function provisionFor(
  req: Request,
  res: Response,
  userId: string,
  body: { actionId: string; phone: unknown },
  savePhone: (phone: { phoneNumber: string; phoneE164: string }) => Promise<void>,
  currentE164: string | null,
): Promise<Response> {
  const config = suiteProvisionConfig();
  if (!config) return res.status(503).json({ code: "UNCONFIGURED", message: SUITE_PROVISION_UNCONFIGURED });

  const typed = readPhone(body.phone);
  if (typed && !typed.ok) return res.status(400).json({ message: typed.message });
  const phoneE164 = typed?.ok ? typed.phoneE164 : currentE164;
  if (!phoneE164) return res.status(400).json({ code: "PHONE_REQUIRED", message: NEEDS_PHONE });
  if (typed?.ok) {
    if (await phoneTakenByAnother(typed.phoneE164, userId)) {
      return res.status(409).json({ message: "Another user here already has that phone number" });
    }
    await savePhone(typed);
  }

  const result = await provisionSuiteSignIn(
    config,
    { actionId: body.actionId, appUserId: userId, phone: phoneE164, actorAppUserId: req.user!.id },
    req.requestId,
  );
  if (!result.ok) return res.status(result.status).json({ code: result.code, message: result.message });

  await storage.createActivityLog({
    tenantId: req.userWithAccess?.tenantId ?? null,
    activityType: "USER_SUITE_SIGNIN_PROVISIONED",
    createdBy: req.user?.id || null,
    summaryText: `Gave user ${userId} a suite sign-in on ${result.phone}`,
  });
  // The answer carries a working password: nothing between here and the
  // screen may keep it.
  res.setHeader("Cache-Control", "no-store");
  return res.json({
    phone: result.phone,
    temporaryPassword: result.temporaryPassword,
    replayed: result.replayed,
  });
}

export function registerSuiteSignInRoutes(app: Express, deps: SuiteSignInDeps): void {
  app.post("/api/users/:id/suite-sign-in", deps.requireGlobalAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await deps.userManagementTenant(req);
      if (!tenantId) return res.status(403).json({ message: "Access denied" });
      if ((await deps.managedUserTenant(req.params.id)) !== tenantId) {
        return res.status(404).json({ message: "User not found" });
      }
      const body = readBody(req);
      if (!body) return res.status(400).json({ message: "Invalid request" });
      const user = await storage.getUser(req.params.id);
      if (!user) return res.status(404).json({ message: "User not found" });
      if (["global_admin", "operator_admin", "advisor"].includes(user.role)) {
        return res.status(403).json({ message: "This account is managed outside User Management" });
      }
      // An already linked person is the platform's answer to give, not ours: the
      // same press again is its replay, any other press its refusal.
      return await provisionFor(
        req,
        res,
        user.id,
        body,
        async (phone) => {
          await storage.updateUser(user.id, phone);
        },
        user.phoneE164 ?? null,
      );
    } catch (error) {
      next(error);
    }
  });

  /** Where an advisor stands: whether they have a login here, and a suite sign-in. */
  app.get("/api/people/:id/suite-sign-in", deps.requireAuth, deps.requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const person = await storage.getPerson(req.params.id);
      if (!person || person.personType !== "ADVISOR" || (await deps.personParkGroup(person)) !== req.userWithAccess?.tenantId) {
        return res.status(404).json({ message: "Advisor not found" });
      }
      const user = await storage.getUserByEmail(person.email);
      return res.json({
        hasLogin: !!user,
        linked: !!user?.platformUserId,
        phoneE164: person.phoneE164 ?? user?.phoneE164 ?? null,
        configured: suiteProvisionConfig() !== null,
        legacyLogin: legacyLoginEnabled(),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/people/:id/suite-sign-in", deps.requireAuth, deps.requireAdmin, async (req: Request, res: Response, next: NextFunction) => {
    try {
      const tenantId = await deps.userManagementTenant(req);
      if (!tenantId) return res.status(403).json({ message: "Access denied" });
      const person = await storage.getPerson(req.params.id);
      if (!person || person.personType !== "ADVISOR" || (await deps.personParkGroup(person)) !== tenantId) {
        return res.status(404).json({ message: "Advisor not found" });
      }
      const body = readBody(req);
      if (!body) return res.status(400).json({ message: "Invalid request" });
      let user = await storage.getUserByEmail(person.email);
      if (user && user.role !== "advisor") {
        return res.status(409).json({ message: "This email belongs to a user who is not an advisor; give them a sign-in from Setup > Users" });
      }
      // An already linked person is the platform's answer to give, not ours: the
      // same press again is its replay, any other press its refusal.

      const typed = readPhone(body.phone);
      if (typed && !typed.ok) return res.status(400).json({ message: typed.message });
      if (!typed && !person.phoneE164 && !user?.phoneE164) {
        return res.status(400).json({ code: "PHONE_REQUIRED", message: NEEDS_PHONE });
      }
      if (!suiteProvisionConfig()) {
        return res.status(503).json({ code: "UNCONFIGURED", message: SUITE_PROVISION_UNCONFIGURED });
      }

      if (!user) {
        /**
         * An advisor made without "Create Login Account" has no user here,
         * and the platform links a user. Made as `POST /api/people` makes one:
         * role "advisor" (the effective role comes from their access policy),
         * branch access from that policy — with a password nothing accepts,
         * because the launcher is their way in.
         */
        const policy = await storage.getAccessPolicy(person.id);
        if (!policy) {
          return res.status(409).json({ message: "Set this advisor's access policy (Manage Access) before giving them a sign-in" });
        }
        const phoneE164 = typed?.ok ? typed.phoneE164 : person.phoneE164 ?? null;
        if (phoneE164 && (await phoneTakenByAnother(phoneE164, null))) {
          return res.status(409).json({ message: "Another user here already has that phone number" });
        }
        user = await storage.createUser(
          {
            email: person.email,
            password: await unusablePassword(),
            fullName: person.fullName,
            role: "advisor",
            isActive: true,
            mustChangePassword: false,
            createdBy: req.user?.id,
            phoneNumber: typed?.ok ? typed.phoneNumber : person.phoneNumber ?? null,
            phoneE164,
          },
          tenantId,
        );
        const ids = (policy.branchIds as string[] | null) ?? [];
        await storage.setUserBranchAccess(
          user.id,
          policy.branchScope === "ALL" ? "all_branches" : "selected_branches",
          policy.branchScope === "ALL" ? [] : ids,
          tenantId,
        );
      }

      const advisorUser = user;
      return await provisionFor(
        req,
        res,
        advisorUser.id,
        body,
        async (phone) => {
          await storage.updatePerson(person.id, phone);
          await storage.updateUser(advisorUser.id, phone);
        },
        advisorUser.phoneE164 ?? person.phoneE164 ?? null,
      );
    } catch (error) {
      next(error);
    }
  });
}
