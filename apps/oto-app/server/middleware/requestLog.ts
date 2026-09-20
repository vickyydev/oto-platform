import { randomUUID } from "node:crypto";
import type { Express, NextFunction, Request, Response } from "express";
import { logger, requestContext } from "../lib/logger";
import { scrubUrl } from "../lib/telemetry/scrub";

/**
 * One log line per request, carrying the id the caller brought with it.
 *
 * A person opens the launcher, is handed off to this app, and the app calls
 * the platform api. That is three services and, until now, three unrelated log
 * streams. `x-request-id` is what ties them together: the api mints one on the
 * way in and passes it on, this app adopts it rather than minting its own, and
 * the id comes back on the response so it can be read off a browser's network
 * tab when someone says "it failed at about half past two".
 */

/**
 * The same shape the platform api accepts (S2-01a). An inbound header is a
 * value a stranger chose, and it is about to be written onto every log line
 * this request produces: unbounded, it is a way to put newlines, control
 * characters or a megabyte of text into the log stream. Anything that does not
 * match is not an error — the request is served, with an id of our own.
 */
const SAFE_REQUEST_ID = /^[A-Za-z0-9._-]{8,64}$/;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      requestId: string;
    }
  }
}

export function registerRequestLogging(app: Express): void {
  app.use((req: Request, res: Response, next: NextFunction) => {
    const inbound = req.get("x-request-id");
    const requestId = inbound && SAFE_REQUEST_ID.test(inbound) ? inbound : randomUUID();
    req.requestId = requestId;
    res.setHeader("x-request-id", requestId);

    const start = Date.now();
    const path = req.path;

    res.on("finish", () => {
      // Only /api. The client bundle's own asset requests are Render's CDN
      // problem, and logging them buries the ones that mean something.
      if (!path.startsWith("/api")) return;
      logger.child({ requestId }).info(
        {
          method: req.method,
          // Path only. A query string here carries phone numbers, kiosk codes
          // and search terms; `scrubUrl` is the platform's own function for
          // exactly this line.
          url: scrubUrl(req.originalUrl),
          status: res.statusCode,
          durationMs: Date.now() - start,
          userId: (req.user as { id?: string } | undefined)?.id,
        },
        "request",
      );
    });

    // Everything this request goes on to do — a handler, a service, a query
    // that throws inside a PDF render — runs inside this store, so a line
    // written anywhere below can find the id without being handed it.
    requestContext.run({ requestId }, next);
  });
}
