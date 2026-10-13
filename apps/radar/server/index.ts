// Every process on this platform stores UTC and converts at the edge with the
// branch's timezone; some of Radar's date maths also assumes a UTC server.
// The Dockerfile sets TZ too — this covers `npm run dev` and any other host.
process.env.TZ = "UTC";

import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { assertSchemaReady, DB_SCHEMA } from "./db";

const app = express();
const httpServer = createServer(app);

// Behind the platform's proxy: without this req.ip is the proxy's address and
// the spin-redeem rate limit (keyed on ip + user agent) is shared by everyone.
app.set("trust proxy", 1);

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: false, limit: "2mb" }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

/**
 * Liveness for the platform's health check. Unauthenticated by necessity, so
 * it reports build identity and presence only — never a value.
 */
app.get("/healthz", (_req, res) => {
  res.json({
    status: "ok",
    service: "radar",
    version: process.env.APP_VERSION || "unknown",
    changeId: process.env.APP_CHANGE_ID || null,
    schema: DB_SCHEMA,
  });
});

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: unknown;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      // Spin responses can contain a live voucher code. Keep endpoint timing
      // logs, but never serialize any Spin Wheel response payload.
      if (path.startsWith("/api/spin-wheel/")) {
        logLine += " :: [spin response body omitted]";
      } else if (capturedJsonResponse && process.env.LOG_RESPONSE_BODY !== "false") {
        const isLargeRangeResponse =
          path.includes("/range") ||
          (typeof capturedJsonResponse === "object" &&
            capturedJsonResponse !== null &&
            ("dailyHourly" in capturedJsonResponse || "dailyRevenue" in capturedJsonResponse));
        if (isLargeRangeResponse) {
          logLine += " :: [large response body omitted]";
        } else {
          const serialized = JSON.stringify(capturedJsonResponse);
          logLine += serialized.length <= 2_000
            ? ` :: ${serialized}`
            : ` :: [response body omitted, ${serialized.length} bytes]`;
        }
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Schema changes are applied by `npm run db:migrate` (the deploy's
  // pre-deploy step), never at boot: a boot-time migrator is how the export
  // came to create an entire HR schema on an empty database.
  await assertSchemaReady();
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = status >= 500 ? "Internal Server Error" : err.message || "Error";
    if (status >= 500) console.error("[express] unhandled error:", err);
    res.status(status).json({ message });
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);

  httpServer.listen({ port, host: "0.0.0.0" }, () => {
    log(`serving on port ${port} (schema ${DB_SCHEMA}, TZ ${process.env.TZ})`);
  });

  const shutdown = () => {
    console.log("[Server] Shutting down gracefully...");
    httpServer.close(() => {
      console.log("[Server] HTTP server closed.");
      process.exit(0);
    });
    httpServer.closeAllConnections();
    setTimeout(() => process.exit(1), 3000);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
})().catch((err) => {
  console.error("[Server] failed to start:", err?.message || err);
  process.exit(1);
});
