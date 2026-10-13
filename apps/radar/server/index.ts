// Every process on this platform stores UTC and converts at the edge with the
// branch's timezone; some of Radar's date maths also assumes a UTC server.
// The Dockerfile sets TZ too — this covers `npm run dev` and any other host.
process.env.TZ = "UTC";

import type { Request, Response, NextFunction } from "express";
import { serveStatic } from "./static";
import { assertSchemaReady, DB_SCHEMA } from "./db";
import { buildApp, log } from "./app";

export { log };

(async () => {
  // Schema changes are applied by `npm run db:migrate` (the deploy's
  // pre-deploy step), never at boot: a boot-time migrator is how the export
  // came to create an entire HR schema on an empty database.
  await assertSchemaReady();
  const { app, httpServer } = await buildApp();

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
