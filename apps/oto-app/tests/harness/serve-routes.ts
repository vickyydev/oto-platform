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
//
// With HARNESS_REQUEST_CONTEXT=1, every request runs inside the request
// context first, as server/index.ts installs it (`registerRequestLogging`):
// what a view-as window's mark is put on, so a row written deep inside a
// service can name who was really there (SCRUM-673). Off by default, so every
// other check runs on the harness exactly as before.
import "./fake-clock";
import "../../server/config/env";
import express, { type NextFunction, type Request, type Response } from "express";
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import { registerRequestLogging } from "../../server/middleware/requestLog";
import { registerRoutes } from "../../server/routes";

const app = express();
const httpServer: Server = createServer(app);
if (process.env.HARNESS_REQUEST_CONTEXT === "1") registerRequestLogging(app);
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
