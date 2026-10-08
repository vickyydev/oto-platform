// seed: none — touches no row. Not a Playwright file.
//
// S2-17b round 3 — how many timers `startScheduledJobs` registers under the
// OTOAPP_JOBS this process was started with, without letting one of them fire.
// `setTimeout` and `setInterval` are counted, not scheduled, for the length of
// the one call, then put back. tests/night-jobs.check.ts runs it once under
// each switch: `platform` must register none (the platform's job runner owns
// the schedule), `inprocess` the app's own (00:01, 03:00, six-hourly presence,
// and from round 4b the Attention engine's and the no-show check's first runs
// and intervals: seven).
//
// Run from apps/oto-app with the environment the boot guard asks for:
//   OTOAPP_JOBS=platform npx tsx tests/harness/start-scheduler.ts
// It prints `TIMERS=<n> STARTED=<true|false>` and exits.
import "../../server/config/env";
import { startScheduledJobs } from "../../server/scheduled-jobs";

const realTimeout = globalThis.setTimeout;
const realInterval = globalThis.setInterval;
let timers = 0;

const counted = ((..._args: unknown[]) => {
  timers += 1;
  // A real timer that does nothing and never holds the process open.
  return realTimeout(() => undefined, 0).unref();
}) as unknown as typeof setTimeout;

globalThis.setTimeout = counted;
globalThis.setInterval = counted as unknown as typeof setInterval;
let started = false;
try {
  started = startScheduledJobs();
} finally {
  globalThis.setTimeout = realTimeout;
  globalThis.setInterval = realInterval;
}

console.log(`TIMERS=${timers} STARTED=${started}`);
process.exit(0);
