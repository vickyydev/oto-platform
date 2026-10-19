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
export function buildLogger(nodeEnv: string, capture?: LogCapture): Logger {
  const dev = nodeEnv === 'development' && !capture;
  const options = {
    level: capture?.level ?? process.env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    ...(dev
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  };
  const base = capture ? pino(options, capture.stream) : pino(options);
  return safeLogger(base) as Logger;
}

/**
 * A test's window onto every line the api writes (S2-19 I2g): the PDPA
 * sentinel suite reads the lines back and asserts no message body is in any
 * of them. Never set outside a test.
 */
export interface LogCapture {
  stream: { write(line: string): void };
  level?: string;
}
