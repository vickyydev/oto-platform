import { pino, type Logger } from 'pino';

export function buildLogger(nodeEnv: string): Logger {
  const dev = nodeEnv === 'development';
  return pino({
    level: process.env.LOG_LEVEL ?? (nodeEnv === 'test' ? 'silent' : 'info'),
    ...(dev
      ? { transport: { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss' } } }
      : {}),
  });
}
