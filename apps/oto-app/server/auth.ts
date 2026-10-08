import passport from "passport";
import { Strategy as LocalStrategy } from "passport-local";
import { Express, Request, Response, NextFunction } from "express";
import session from "express-session";
import { scrypt, randomBytes, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { storage } from "./storage";
import { normalizePhoneToE164 } from "./twilio-service";
import { TRUST_PROXY } from "./config/env";
import {
  LEGACY_LOGIN_REFUSAL,
  legacyLoginEnabled,
  registerPlatformSignOn,
} from "./middleware/platformSignOn";
import { User as SelectUser } from "@shared/schema";

declare global {
  namespace Express {
    interface User extends SelectUser {}
  }
}

const scryptAsync = promisify(scrypt);

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

export function setupAuth(app: Express) {
  // The cookie used to be decided by Replit's own variables, because on Replit
  // the app ran in an iframe on replit.com and every fetch was cross-site —
  // which needs SameSite=None, which needs Secure. None of that is true here:
  // the client and the api are one origin, served by this process. So the
  // cookie is SameSite=Lax, and `secure` follows the build: HTTPS everywhere
  // this runs as a production build, plain HTTP on a laptop.
  //
  // The launcher hand-off still works under Lax. It arrives as a top-level
  // navigation to this app's own origin, which is the case Lax exists to
  // allow; the token travels in the URL fragment and is exchanged for this
  // cookie by a same-origin request afterwards.
  const secureCookie = process.env.NODE_ENV === "production";
  const sessionSettings: session.SessionOptions = {
    // No fallback. The boot guard refuses a deployment that has not set this
    // (server/config/env.ts) — a session secret from the source is a session
    // anyone holding the source can mint.
    secret: process.env.SESSION_SECRET || "contract-sender-secret-key-change-in-production",
    resave: false,
    saveUninitialized: false,
    store: storage.sessionStore,
    cookie: {
      maxAge: 24 * 60 * 60 * 1000,
      secure: secureCookie,
      sameSite: "lax",
      httpOnly: true,
    },
  };

  // Render terminates TLS at its load balancer and forwards plain HTTP to the
  // container, so `req.protocol` is "http" unless Express is told how many
  // hops in front of it are ours. express-session consults that before it will
  // set a `secure` cookie: at 0 hops on Render the app would authenticate a
  // person and then hand back no cookie at all, and the only symptom would be
  // a sign-in form that reappears.
  app.set("trust proxy", TRUST_PROXY);
  app.use(session(sessionSettings));
  app.use(passport.initialize());
  /**
   * Between the two, deliberately. `passport.initialize()` is what puts
   * `req.login` on the request, and running before `passport.session()` means
   * a hand-off spent on this request is deserialised on this request — through
   * `deserializeUser` and `getUserWithBranchAccess` like any other session, so
   * role, branch scope and tenant resolve the way they always did and no
   * handler below knows the difference.
   */
  registerPlatformSignOn(app);
  app.use(passport.session());

  passport.use(
    new LocalStrategy(
      { usernameField: "identifier" },
      async (identifier, password, done) => {
        try {
          const trimmed = identifier.trim();
          // Phone numbers arrive pre-composed from the client as E164 (e.g. "+66812345678")
          const isPhone = /^\+\d{7,15}$/.test(trimmed.replace(/[\s\-]/g, ""));
          const user = isPhone
            ? await storage.getUserByPhoneE164(normalizePhoneToE164(trimmed))
            : await storage.getUserByEmail(trimmed.toLowerCase());
          if (!user || !(await comparePasswords(password, user.password))) {
            return done(null, false, { message: "Invalid credentials" });
          }
          return done(null, user);
        } catch (err) {
          return done(err);
        }
      }
    )
  );

  passport.serializeUser((user, done) => done(null, user.id));
  passport.deserializeUser(async (id: string, done) => {
    try {
      // Use getUserWithBranchAccess to include tenantId in session
      const user = await storage.getUserWithBranchAccess(id);
      done(null, user || undefined);
    } catch (err) {
      done(err);
    }
  });

  // Public registration is disabled - users are created by admins only
  app.post("/api/register", async (req, res) => {
    return res.status(403).json({ 
      message: "Registration is disabled. Contact your administrator." 
    });
  });

  app.post("/api/login", (req, res, next) => {
    /**
     * A refusal, not a 404. Somebody has this address bookmarked, or has typed
     * it from memory for two years, and the one thing they need to be told is
     * where the door moved to. A missing route tells them the app is broken.
     */
    if (!legacyLoginEnabled()) {
      return res.status(403).json({ reason: "legacy_login_off", message: LEGACY_LOGIN_REFUSAL });
    }
    passport.authenticate("local", async (err: any, user: SelectUser | false, info: any) => {
      if (err) return next(err);
      if (!user) {
        return res.status(401).json({ message: info?.message || "Invalid credentials" });
      }
      
      // Check if user is active
      if (!user.isActive) {
        return res.status(403).json({ message: "Your account has been disabled. Contact your administrator." });
      }
      
      req.login(user, async (err) => {
        if (err) return next(err);
        // Update last login timestamp
        await storage.updateUser(user.id, { updatedAt: new Date() } as any);
        await storage.updateUserLastLogin(user.id);
        
        // Return user with branch access info so frontend has hasAllBranchesAccess
        const userWithAccess = await storage.getUserWithBranchAccess(user.id);
        if (!userWithAccess) {
          return res.status(500).json({ message: "Failed to load user data" });
        }
        const { password: _, ...safeUser } = userWithAccess;
        res.json(safeUser);
      });
    })(req, res, next);
  });

  app.post("/api/logout", (req, res, next) => {
    req.logout((err) => {
      if (err) return next(err);
      res.sendStatus(200);
    });
  });

  app.get("/api/user", requireAuth, async (req, res) => {
    // Get user with branch access info
    const userWithAccess = await storage.getUserWithBranchAccess(req.user!.id);
    if (!userWithAccess) {
      return res.sendStatus(401);
    }
    const { password: _, ...safeUser } = userWithAccess;
    res.json(safeUser);
  });

  // Change password endpoint (for first login password change and voluntary changes)
  app.post("/api/change-password", requireAuth, async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body;

      if (!currentPassword || !newPassword) {
        return res.status(400).json({ message: "Current password and new password are required" });
      }

      if (newPassword.length < 6) {
        return res.status(400).json({ message: "New password must be at least 6 characters long" });
      }

      // Get user to verify current password
      const user = await storage.getUser(req.user!.id);
      if (!user) {
        return res.status(404).json({ message: "User not found" });
      }

      // Verify current password
      const isValid = await comparePasswords(currentPassword, user.password);
      if (!isValid) {
        return res.status(401).json({ message: "Current password is incorrect" });
      }

      // Update password and clear mustChangePassword flag
      const newHash = await hashPassword(newPassword);
      await storage.updateUserPassword(user.id, newHash);

      // Log password change activity
      await storage.logActivity({
        // The caller's park group (S2-17b round 4a): the session's, as
        // getUserWithBranchAccess resolved it when the session was read.
        tenantId: (req.user as { tenantId?: string | null } | undefined)?.tenantId ?? null,
        activityType: "USER_PASSWORD_CHANGED",
        createdBy: user.id,
        summaryText: `User changed their password`,
      });

      // Return updated user
      const userWithAccess = await storage.getUserWithBranchAccess(user.id);
      if (!userWithAccess) {
        return res.status(500).json({ message: "Failed to load user data" });
      }
      const { password: _, ...safeUser } = userWithAccess;
      res.json(safeUser);
    } catch (error) {
      next(error);
    }
  });
}

// Export password comparison for use in other modules
export async function comparePasswords(supplied: string, stored: string) {
  const [hashed, salt] = stored.split(".");
  const hashedBuf = Buffer.from(hashed, "hex");
  const suppliedBuf = (await scryptAsync(supplied, salt, 64)) as Buffer;
  return timingSafeEqual(hashedBuf, suppliedBuf);
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.isAuthenticated()) {
    return res.status(401).json({ message: "Authentication required" });
  }
  const user = await storage.getUser(req.user!.id);
  if (!user || !user.isActive) {
    req.logout(() => {});
    return res.status(401).json({ message: "Your account has been disabled. Contact your administrator." });
  }
  next();
}
