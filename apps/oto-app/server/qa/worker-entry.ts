import { randomUUID } from "node:crypto";
import { setTimeout as pause } from "node:timers/promises";
import { claimNextReport, qaPool } from "./store";
import { processQaClaim, boundedSetting } from "./worker";
import { publishBundledSourceIndex } from "./source-index";

let stopping = false;
process.once("SIGTERM", () => { stopping = true; });
process.once("SIGINT", () => { stopping = true; });

async function main(): Promise<void> {
  const workerId = "qa-" + randomUUID();
  const poll = boundedSetting("QA_WORKER_POLL_MS", 5000, 1000, 30_000);
  await publishBundledSourceIndex();
  while (!stopping) {
    try {
      if (process.env.QA_REPORTS_ENABLED === "true") {
        const claim = await claimNextReport(workerId);
        if (claim) { await processQaClaim(claim); continue; }
      }
    } catch { console.error("QA worker is waiting for its configured services; saved reports remain queued."); }
    await pause(poll);
  }
}

main().catch(() => { console.error("QA worker could not start; check its configuration names."); process.exitCode = 1; }).finally(() => qaPool.end());
