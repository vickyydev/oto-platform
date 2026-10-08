// First, and it has to be first: importing it validates the whole environment
// and refuses to go further on a configuration that does not belong to this
// deployment. Everything below builds something — a Sentry client, a
// connection pool, a session store — out of the values it checks.
import "./config/env";
import "./sentry";
import * as Sentry from "@sentry/node";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { startScheduledJobs } from "./scheduled-jobs";
import { storage } from "./storage";
import { hashPassword } from "./auth";
import { assertSearchPath } from "./db";
import { bindConsole, logger } from "./lib/logger";
import { registerRequestLogging } from "./middleware/requestLog";
import path from "path";

// Everything written through `console.*` from here on goes through the
// redacting logger — see lib/logger.ts for why the global is rebound rather
// than 466 call sites rewritten.
bindConsole();

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

// First, so that everything after it — the body parsers included — runs
// inside the request's async context and can find its id. This replaces the
// middleware that captured every JSON response body and wrote it into the log
// whenever LOG_RESPONSE_BODY was not exactly "false", which is how the old
// stack's log stream came to hold children's records, reset tokens and kiosk
// codes (intake note 01, finding 6). The body is not captured at all now, so
// there is no variable left to set wrongly.
registerRequestLogging(app);

app.use(
  express.json({
    limit: '50mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: '50mb' }));

/**
 * The app's own helper, used by the boot and schedule lines below and exported
 * as it always was. It writes a structured line now instead of a formatted
 * timestamp: `source` was the bracketed tag in the old output ("[attention]",
 * "[seed]") and becomes a field, so a log search can ask for one subsystem.
 */
export function log(message: string, source = "express") {
  logger.info({ source }, message);
}

(async () => {
  // Before a single route is registered. The app emits unqualified table
  // names, so if the search path fell through to `public` it would read and
  // write another application's schema perfectly happily and report itself
  // healthy doing it. There is no symptom to watch for afterwards, which is
  // why this is a refusal to start rather than a warning.
  await assertSearchPath();

  Sentry.setupExpressErrorHandler(app);

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
  });

  // Serve the OTO App Map at /app-map (standalone, no auth required)
  app.get("/app-map", (_req, res) => {
    res.sendFile(path.resolve(__dirname, "public", "app-map.html"));
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      ...(process.platform === "linux" ? { reusePort: true } : {}),
    },
    () => {
      log(`serving on port ${port}`);
      
      // Auto-seed admin user on startup if none exists
      setTimeout(async () => {
        try {
          const seedEmail = process.env.SEED_ADMIN_EMAIL;
          const seedPassword = process.env.SEED_ADMIN_PASSWORD;
          
          if (seedEmail && seedPassword) {
            const existingAdmin = await storage.getUserByEmail(seedEmail);
            if (!existingAdmin) {
              const allUsers = await storage.getUsers();
              if (allUsers.length === 0) {
                await storage.createUser({
                  email: seedEmail,
                  password: await hashPassword(seedPassword),
                  fullName: "Admin User",
                  role: "admin",
                  mustChangePassword: true,
                });
                log(`Created admin user: ${seedEmail}`, "seed");
              }
            }
          }
        } catch (error) {
          log(`Auto-seed error: ${error}`, "seed");
        }
      }, 2000);
      
      // Reconciliation remains paused until a tenant-owned, locked job can
      // record its outcome in the platform run ledger.
      // Start presence reconciliation and status transition jobs — unless
      // OTOAPP_JOBS=platform, under which the platform's job runner runs them
      // through the directory job endpoint and no timer starts here
      // (S2-17b round 3).
      startScheduledJobs();
    },
  );
})().catch((error) => {
  // A boot failure has to be loud and has to exit non-zero: Render reads the
  // exit code, cancels the deploy and leaves the previous instance serving.
  // An unhandled rejection would do the same thing by accident; this says so.
  logger.fatal({ err: error }, "boot failed");
  process.exit(1);
});
