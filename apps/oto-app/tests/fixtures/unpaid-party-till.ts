import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Express } from "express";
import { noQuoteAnswer } from "./till-billing";

/** Handle only the billing read; the caller's till still handles its normal menu and additions routes. */
export function answerUnpaidPartyBilling(req: IncomingMessage, res: ServerResponse, parties: ReadonlySet<string>, key: string): boolean {
  const eventId = /^\/otoapp\/parties\/([^/?]+)\/billing(?:\?.*)?$/.exec(req.url ?? "")?.[1];
  if (req.method !== "GET" || !eventId) return false;
  if (req.headers.authorization !== `Bearer ${key}`) {
    res.writeHead(401).end();
  } else if (!parties.has(eventId)) {
    res.writeHead(404).end();
  } else {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ...noQuoteAnswer(eventId), beoLines: [] }));
  }
  return true;
}

/** Give the event and Day-of routes a real billing read for the suite's unpaid fixture parties. */
export function serveUnpaidPartyBilling(app: Express, origin: string, eventIds: readonly string[]): void {
  if (new URL(origin).hostname !== "127.0.0.1") throw new Error("The test till must use loopback.");
  const key = randomUUID();
  const parties = new Set(eventIds);
  app.use((req, res, next) => {
    if (!answerUnpaidPartyBilling(req, res, parties, key)) next();
  });
  process.env.PLATFORM_API_URL = origin;
  process.env.OTOAPP_PROVISION_KEY = key;
}
