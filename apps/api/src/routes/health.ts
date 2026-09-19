import { sql } from 'drizzle-orm';
import type { App } from '../app';

export async function healthRoutes(app: App): Promise<void> {
  app.get('/health', { config: { public: true } }, async () => ({ status: 'ok' }));

  app.get('/ready', { config: { public: true } }, async (_req, reply) => {
    try {
      await app.db.execute(sql`select 1`);
      return { status: 'ready' };
    } catch {
      return reply.status(503).send({ status: 'not_ready' });
    }
  });
}
