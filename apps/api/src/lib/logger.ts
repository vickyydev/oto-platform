import { safeLogger } from '@oto/telemetry';
import { pino, type Logger } from 'pino';

/**
 * The api's logger, wrapped once so redaction cannot be forgotten (S2-03).
 *
 * Every line the api writes goes through here — Fastify's `req.log` is a child
 * of this instance, and so is every child of that — so wrapping at creation
 * means a binding added in a hurry is redacted whether or not whoever added it
 * thought about redaction. The ESLint rule catches the obvious cases at the
 * keyboard; this catches the ones that arrive inside an object nobody looked
 * at, which is how a phone number reached a log stream in Sprint 1.
 */
export function buildLogger(nodeEnv: string): Logger {
  const dev = nodeEnv === 'development';
  const base = pino({
    level: process.env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    ...(dev
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });
  return safeLogger(base) as Logger;
}
