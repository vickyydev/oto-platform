import pino from 'pino';
import { openDb } from './db.js';
import { createDigest } from './digest.js';
import { loadEnv } from './env.js';
import { createOutbox } from './outbox.js';
import { alertOwner } from './ownerAlert.js';
import { createRenderApi } from './render.js';
import { buildServer } from './server.js';
import { usePgAuthState } from './whatsapp/authState.js';
import { createWaClient } from './whatsapp/client.js';

const env = loadEnv();
const log = pino({
  level: env.LOG_LEVEL,
  ...(process.stdout.isTTY ? { transport: { target: 'pino-pretty' } } : {}),
});

const db = await openDb(env.DATABASE_URL, env.DB_SCHEMA);
const auth = await usePgAuthState(db);

// The outbox needs the client to send and the client needs the outbox to
// drain on connect; `drain` is filled in once both exist.
let drain: () => Promise<void> = async () => undefined;
const kick = () => void drain().catch((err) => log.error({ err }, 'draining the outbox failed'));

const wa = createWaClient({
  auth,
  phone: env.WHATSAPP_PHONE,
  log,
  onOpen: kick,
  onDead: (reason) =>
    void alertOwner(
      env,
      db,
      log,
      `whatsapp_${reason}`,
      reason === 'banned'
        ? 'WhatsApp has blocked the bot number. The morning digests have stopped.'
        : 'The bot was unlinked from WhatsApp. Pair it again (POST /admin/pair) to resume the morning digests.',
    ),
});
drain = createOutbox(db, env, wa, log).drain;

const digest = createDigest({
  db,
  env,
  render: createRenderApi(env.RENDER_API_KEY),
  log,
  onQueued: kick,
});

const app = await buildServer({ env, db, wa, digest, log, onQueued: kick });
await app.listen({ port: env.PORT, host: '0.0.0.0' });

// One timer does both jobs: check whether it is time for today's digest, and
// send any queued message that has come due (the later parts of a long one).
const ticker = setInterval(() => {
  void digest
    .tick()
    .then(kick)
    .catch((err) => log.error({ err }, 'tick failed'));
}, 60_000);

let closing = false;
const shutdown = async (signal: string) => {
  if (closing) return;
  closing = true;
  log.info({ signal }, 'shutting down');
  clearInterval(ticker);
  await app.close().catch(() => undefined);
  await wa.stop().catch(() => undefined);
  await db.close().catch(() => undefined);
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
