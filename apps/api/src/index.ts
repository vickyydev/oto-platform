import { closeDb, getDb } from '@oto/db';
import { buildApp } from './app';
import { loadEnv } from './env';
import { buildFileStorage } from './services/files';
import { createJobRunner } from './services/jobs';
import { startVirtualBox, stopVirtualBox } from './services/box';

/**
 * Process entry point. Everything here exists because of how the api is
 * actually run (S2-01b): one Render web service, restarted on every deploy,
 * behind a load balancer that stops sending traffic the moment it sees the
 * container go away.
 */
const env = loadEnv();
const db = getDb(env.DATABASE_URL, { applicationName: `oto-api-${env.NODE_ENV}` });
const app = await buildApp({ env, db, fileStorage: buildFileStorage(env) });

/**
 * The scheduled work, started here rather than inside `buildApp` (S2-03).
 *
 * Tests build an app per file, and a runner started there would mean every
 * one of them firing timers, sweeping tables and racing its neighbours. The
 * process entry point is the one place that knows this is a real deployment,
 * so it is the one place that starts them.
 *
 * `enabled` is false unless PROCESS_ROLES names `jobs`, and every method is
 * then a no-op — which is how the api stops competing with the worker service
 * on the day that role splits out.
 */
const jobs = createJobRunner({ db, env, log: app.log });
if (jobs.enabled) {
  await jobs.start();
  app.log.info({ jobs: jobs.jobs.map((j) => j.name) }, 'job runner started');
} else {
  app.log.info('job runner not started — PROCESS_ROLES does not name jobs');
}

// Render supplies PORT; API_PORT is the local default.
const port = Number(process.env.PORT ?? env.API_PORT);

/**
 * Drain rather than drop. On SIGTERM the platform has already stopped
 * routing new requests to us; finishing the ones in flight is the difference
 * between a deploy nobody notices and a till showing an error mid-sale.
 */
let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  app.log.info({ signal }, 'shutting down');
  try {
    await jobs.stop();
    stopVirtualBox();
    await app.close();
    await closeDb();
    process.exit(0);
  } catch (err) {
    app.log.error({ err }, 'shutdown failed');
    process.exit(1);
  }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

// A promise nobody handled is a bug, not a reason to kill the till: log it
// with the stack and keep serving. An uncaught exception is different — the
// process state is no longer trustworthy, so we go down and let Render
// restart us, after one last attempt to say why.
process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'unhandled rejection');
});
process.on('uncaughtException', (err) => {
  app.log.fatal({ err }, 'uncaught exception — exiting');
  void shutdown('uncaughtException').finally(() => process.exit(1));
});

try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  app.log.error(err, 'failed to start');
  process.exit(1);
}

/**
 * The virtual box (S2-04), started here for the same reason the job runner is:
 * tests build an app per file, and a box started inside `buildApp` would mean
 * every one of them registering itself and firing timers.
 *
 * It talks to this process over loopback, so it can only start once the port
 * is actually bound — and it is the ordinary agent from `@oto/box-agent`
 * rather than a simulation of one, which is what makes pairing, config
 * bundles, commands and heartbeats provable on Render with no hardware. It is
 * a no-op unless PROCESS_ROLES names `edge`.
 */
await startVirtualBox({ db, env, log: app.log, port });
