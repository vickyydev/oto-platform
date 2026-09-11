import { getDb } from '@oto/db';
import { buildApp } from './app';
import { loadEnv } from './env';
import { buildFileStorage } from './services/files';

const env = loadEnv();
const db = getDb(env.DATABASE_URL);
const app = await buildApp({ env, db, fileStorage: buildFileStorage(env) });

app.listen({ port: env.API_PORT, host: '0.0.0.0' }).catch((err) => {
  app.log.error(err, 'failed to start');
  process.exit(1);
});
