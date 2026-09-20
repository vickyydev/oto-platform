import "./sentry";
import * as Sentry from "@sentry/node";
import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { runFullReconciliation } from "./attention-engine";
import { startScheduledJobs } from "./scheduled-jobs";
import { storage } from "./storage";
import { hashPassword } from "./auth";
import path from "path";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: '50mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: '50mb' }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse && process.env.LOG_RESPONSE_BODY !== "false") {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
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
      
      // Run attention engine on startup and schedule every 6 hours
      setTimeout(async () => {
        try {
          log("Running initial attention engine reconciliation...", "attention");
          const result = await runFullReconciliation();
          log(`Attention engine: ${result.created} created, ${result.updated} updated, ${result.resolved} resolved`, "attention");
        } catch (error) {
          log(`Attention engine startup error: ${error}`, "attention");
        }
      }, 5000); // Wait 5 seconds after server start
      
      // Schedule reconciliation every 6 hours
      const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
      setInterval(async () => {
        try {
          log("Running scheduled attention engine reconciliation...", "attention");
          const result = await runFullReconciliation();
          log(`Attention engine: ${result.created} created, ${result.updated} updated, ${result.resolved} resolved`, "attention");
        } catch (error) {
          log(`Attention engine scheduled error: ${error}`, "attention");
        }
      }, SIX_HOURS_MS);
      
      // Start presence reconciliation and status transition jobs
      startScheduledJobs();
    },
  );
})();
