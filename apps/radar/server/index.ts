import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";

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
  const { runMigrations } = await import("./ensureSchema");
  await runMigrations();
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  const port = parseInt(process.env.PORT || "5000", 10);

  httpServer.on("error", (err: any) => {
    if (err.code === "EADDRINUSE") {
      console.log(`[Server] Port ${port} in use, killing old process and retrying in 2s...`);
      import("child_process").then(({ execSync }) => {
        try { execSync(`kill -9 $(lsof -t -i:${port}) 2>/dev/null || true`); } catch {}
      }).catch(() => {});
      setTimeout(() => {
        httpServer.listen({ port, host: "0.0.0.0" }, () => log(`serving on port ${port}`));
      }, 2000);
    }
  });

  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      ...(process.platform === "linux" ? { reusePort: true } : {}),
    },
    () => {
      log(`serving on port ${port}`);

    },
  );

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
})();
