import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { kvGet, type Db } from './db.js';
import type { createDigest } from './digest.js';
import type { Env } from './env.js';
import { enqueue } from './outbox.js';
import type { WaClient } from './whatsapp/client.js';

interface Deps {
  env: Env;
  db: Db;
  wa: WaClient;
  digest: ReturnType<typeof createDigest>;
  log: Logger;
  onQueued(): void;
}

const sendBody = z.object({ text: z.string().trim().min(1).max(4000) });

const digestQuery = z.object({
  mode: z.enum(['preview', 'send', 'test']).default('preview'),
  // Up to a week: the same distance the digest itself reads deploys back.
  hours: z.coerce.number().positive().max(168).optional(),
});

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Nothing here is public except /health. There is no inbound webhook: the bot
 * asks Render what was deployed, so the only callers are whoever holds
 * ADMIN_TOKEN — to pair the phone, find the group, preview a digest or send a
 * test message.
 */
export async function buildServer({ env, db, wa, digest, log, onQueued }: Deps) {
  const app = Fastify({ loggerInstance: log, bodyLimit: 64 * 1024 });

  const expected = Buffer.from(env.ADMIN_TOKEN);
  const requireAdmin = async (req: FastifyRequest, reply: FastifyReply) => {
    const given = Buffer.from((req.headers.authorization ?? '').replace(/^Bearer\s+/i, ''));
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return reply
        .code(401)
        .send({ error: { code: 'UNAUTHORIZED', message: 'Bad or missing token' } });
    }
  };

  // Render's health check. Deliberately says nothing about WhatsApp: a dropped
  // session is fixed by pairing again, not by restarting the process, and a
  // failing check would have Render restart it in a loop.
  app.get('/health', async () => ({ ok: true }));

  app.get('/admin/status', { preHandler: requireAdmin }, async () => {
    const waiting = await db.pool.query<{ n: string; next: Date | null }>(
      `select count(*) as n, min(send_after) as next from ${db.s}.outbox
       where sent_at is null and expires_at > now()`,
    );
    return {
      whatsapp: wa.status(),
      groupConfigured: Boolean(env.WHATSAPP_GROUP_ID),
      renderConfigured: Boolean(env.RENDER_API_KEY),
      summaries: env.ANTHROPIC_API_KEY ? env.SUMMARY_MODEL : 'off',
      lastDigestAt: await kvGet(db.pool, db.s, 'last_digest_at'),
      lastAnnouncedCommit: await kvGet(db.pool, db.s, 'last_announced_commit'),
      messagesWaiting: Number(waiting.rows[0]?.n ?? 0),
      nextSendAt: waiting.rows[0]?.next ?? null,
    };
  });

  app.post('/admin/pair', { preHandler: requireAdmin }, async (req, reply) => {
    const force = (req.query as { force?: string }).force === 'true';
    try {
      return {
        pairingCode: await wa.pair(force),
        how: 'On the phone: WhatsApp → Linked devices → Link a device → Link with phone number instead → enter this code. It is valid for about three minutes.',
      };
    } catch (err) {
      return reply.code(409).send({ error: { code: 'PAIRING_REFUSED', message: message(err) } });
    }
  });

  app.get('/admin/groups', { preHandler: requireAdmin }, async (_req, reply) => {
    try {
      return { groups: await wa.listGroups() };
    } catch (err) {
      return reply.code(409).send({ error: { code: 'NOT_CONNECTED', message: message(err) } });
    }
  });

  // The digest on demand, without waiting for the morning.
  //   ?mode=preview (default)  show what would be sent; nothing leaves
  //   ?mode=test               send it to the group now, record nothing — the
  //                            next real digest still covers the same changes
  //   ?mode=send               the morning run, now: sent and recorded
  //   &hours=24                look back this far and ignore what was already
  //                            announced, so there is something to show on a
  //                            day with nothing new
  app.post('/admin/digest', { preHandler: requireAdmin }, async (req, reply) => {
    if (!env.RENDER_API_KEY) {
      return reply
        .code(503)
        .send({ error: { code: 'NOT_CONFIGURED', message: 'RENDER_API_KEY is not set' } });
    }
    const query = digestQuery.safeParse(req.query);
    if (!query.success) {
      return reply
        .code(400)
        .send({ error: { code: 'INVALID_QUERY', message: query.error.message } });
    }
    try {
      const result = await digest.run(query.data);
      // A queued message only goes out while WhatsApp is connected and a group
      // is set; say so here rather than leave the caller watching the phone.
      return {
        ...result,
        whatsapp: wa.status().status,
        groupConfigured: Boolean(env.WHATSAPP_GROUP_ID),
      };
    } catch (err) {
      log.error({ err }, 'manual digest failed');
      return reply.code(502).send({ error: { code: 'DIGEST_FAILED', message: message(err) } });
    }
  });

  app.post('/send', { preHandler: requireAdmin }, async (req, reply) => {
    const body = sendBody.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: { code: 'INVALID_BODY', message: body.error.message } });
    }
    await enqueue(db.pool, db.s, body.data.text, 0, env.MESSAGE_TTL_HOURS);
    onQueued();
    return reply.code(202).send({ result: 'queued' });
  });

  return app;
}
