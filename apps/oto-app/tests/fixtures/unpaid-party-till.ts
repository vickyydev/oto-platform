import { randomUUID } from "node:crypto";
import type { Express } from "express";
import { noQuoteAnswer } from "./till-billing";

/** Give the event and Day-of routes a real billing read for the suite's unpaid fixture parties. */
export function serveUnpaidPartyBilling(app: Express, origin: string, eventIds: readonly string[]): void {
  if (new URL(origin).hostname !== "127.0.0.1") throw new Error("The test till must use loopback.");
  const key = randomUUID();
  const parties = new Set(eventIds);
  app.get("/otoapp/parties/:eventId/billing", (req, res) => {
    if (req.get("authorization") !== `Bearer ${key}`) return res.sendStatus(401);
    if (!parties.has(req.params.eventId)) return res.sendStatus(404);
    return res.json({ ...noQuoteAnswer(req.params.eventId), beoLines: [] });
  });
  process.env.PLATFORM_API_URL = origin;
  process.env.OTOAPP_PROVISION_KEY = key;
}
