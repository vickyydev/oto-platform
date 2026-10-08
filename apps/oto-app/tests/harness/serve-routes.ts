// seed: none — the caller arranges its own rows. Not a Playwright file.
//
// The app's real API — `setupAuth` and every route `registerRoutes` adds — on
// a free port, without the client: no Vite, no static bundle, no night jobs
// (`startScheduledJobs` is only ever called by server/index.ts). It is what
// tests/route-fences.check.ts drives over HTTP, once as a developer's machine
// and once shaped like staging, so the fences are proven on the routes as
// registered rather than on a copy of them.
//
// Run from apps/oto-app with the environment the boot guard asks for:
//   npx tsx tests/harness/serve-routes.ts
// It prints `HARNESS_PORT=<port>` on stdout once it is listening.
//
// With HARNESS_FAKE_NOW set, the process's clock starts at that instant
// (./fake-clock.ts, imported first so it is in place before the app loads).
import "./fake-clock";
import "../../server/config/env";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { registerRoutes } from "../../server/routes";

const app = express();
const httpServer: Server = createServer(app);
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: false }));

(async () => {
  await registerRoutes(httpServer, app);
  // The same last word server/index.ts gives an error that escapes a route.
  app.use((err: { status?: number; statusCode?: number; message?: string }, _req: Request, res: Response, _next: NextFunction) => {
    res.status(err.status || err.statusCode || 500).json({ message: err.message || "Internal Server Error" });
  });
  httpServer.listen(0, "127.0.0.1", () => {
    const { port } = httpServer.address() as AddressInfo;
    console.log(`HARNESS_PORT=${port}`);
  });
})().catch((error) => {
  console.error("harness failed to start:", error);
  process.exit(1);
});
