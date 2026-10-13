import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { registerRoutes } from "./routes";
import { registerSignOnRoutes } from "./signOn";
import { censusGuard } from "./routeCensus";
import { DB_SCHEMA } from "./db";

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
 * Radar's Express app with every route registered and the census guard in
 * front of them, but not listening and not serving the client: `index.ts`
 * adds those, and the route census test builds this to walk the router.
 */
export async function buildApp(): Promise<{ app: Express; httpServer: Server }> {
  const app = express();
  const httpServer = createServer(app);

  // Behind the platform's proxy: without this req.ip is the proxy's address and
  // the spin-redeem rate limit (keyed on ip + user agent) is shared by everyone.
  app.set("trust proxy", 1);

  app.use(express.json({ limit: "2mb" }));
  app.use(express.urlencoded({ extended: false, limit: "2mb" }));

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
          const serialized = JSON.stringify(capturedJsonResponse);
          logLine += serialized.length <= 2_000
            ? ` :: ${serialized}`
            : ` :: [response body omitted, ${serialized.length} bytes]`;
        }
        log(logLine);
      }
    });

    next();
  });

  // Before every /api route: public and key routes pass, the rest need a
  // signed-in platform session with app:radar:access (routeCensus.ts).
  app.use(censusGuard);

  registerSignOnRoutes(app);
  await registerRoutes(httpServer, app);

  return { app, httpServer };
}
