import { closeDb, getDb } from '@oto/db';
import { buildApp } from './app';
import { loadEnv } from './env';
import { buildFileStorage } from './services/files';

/**
 * Process entry point. Everything here exists because of how the api is
 * actually run (S2-01b): one Render web service, restarted on every deploy,
 * behind a load balancer that stops sending traffic the moment it sees the
 * container go away.
 */
const env = loadEnv();
const db = getDb(env.DATABASE_URL, { applicationName: `oto-api-${env.NODE_ENV}` });
const app = await buildApp({ env, db, fileStorage: buildFileStorage(env) });

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

app.listen({ port, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err, 'failed to start');
  process.exit(1);
});
