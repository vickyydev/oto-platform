import { redact, redactBindings, scrubText, type RedactOptions } from './redact';

/**
 * The seam that makes redaction the default rather than a discipline.
 *
 * Every rule in `redact.ts` is worth nothing if a caller can write
 * `log.info({ phone })` and be heard. Wrapping the logger once, at the point
 * it is created, means there is no unredacted logger to reach for: the api's
 * request logger, the job runner's and the box agent's are all the wrapped
 * one, and a binding is scrubbed whether or not the person writing the line
 * thought about it.
 *
 * It takes a pino-like logger by structure rather than importing pino. The
 * api already depends on pino and the box agent will; this package does not
 * need to pin a version of it to wrap one, and staying dependency-free is
 * what lets the POS import the same module.
 */

export interface LogFn {
  (obj: unknown, msg?: string, ...args: unknown[]): void;
  (msg: string, ...args: unknown[]): void;
}

export interface PinoLike {
  level?: string;
  trace: LogFn;
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  fatal: LogFn;
  silent?: LogFn;
  child(bindings: Record<string, unknown>, options?: unknown): PinoLike;
  flush?: (cb?: (err?: Error) => void) => void;
  bindings?: () => Record<string, unknown>;
  isLevelEnabled?: (level: string) => boolean;
}

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'] as const;
type Level = (typeof LEVELS)[number];

function isErrorLike(value: unknown): boolean {
  if (value instanceof Error) return true;
  if (!value || typeof value !== 'object') return false;
  const v = value as { message?: unknown; stack?: unknown };
  return typeof v.message === 'string' && typeof v.stack === 'string';
}

/** The overloads collapsed to one signature, so `.call` type-checks. */
type AnyLogFn = (first: unknown, ...args: unknown[]) => void;

function levelFn(logger: PinoLike, level: Level, options: RedactOptions): LogFn {
  return ((first: unknown, ...rest: unknown[]): void => {
    const fn = logger[level] as AnyLogFn | undefined;
    if (typeof fn !== 'function') return;
    // A message string gets swept too: `log.info(\`looking up ${phone}\`)` is
    // the same leak wearing different clothes.
    const tail = rest.map((a) => (typeof a === 'string' ? scrubText(a) : a));
    if (typeof first === 'string') {
      fn.call(logger, scrubText(first), ...tail);
      return;
    }
    if (first === undefined || first === null) {
      fn.call(logger, first, ...tail);
      return;
    }
    // `err` is pino's own key for a thrown thing, so a wrapped error still
    // lands where every log search already looks for it.
    const payload = isErrorLike(first)
      ? { err: redact(first, options) }
      : redactBindings(first, options);
    fn.call(logger, payload, ...tail);
  }) as LogFn;
}

/**
 * Wrap a logger so nothing reaches it unredacted. Children are wrapped too,
 * and their bindings are redacted once at creation — a binding set on a child
 * is repeated on every line it writes, which makes it the worst place to leak.
 */
export function safeLogger<L extends PinoLike>(logger: L, options: RedactOptions = {}): L {
  const wrapped: Partial<PinoLike> = {
    child: (bindings: Record<string, unknown>, childOptions?: unknown) =>
      safeLogger(logger.child(redactBindings(bindings, options), childOptions), options),
  };

  for (const level of LEVELS) {
    if (typeof logger[level] !== 'function') continue;
    wrapped[level] = levelFn(logger, level, options);
  }

  // Forwarded rather than reimplemented: level is read and set at runtime,
  // and `flush` is what a SIGTERM handler calls before the process exits.
  Object.defineProperty(wrapped, 'level', {
    get: () => logger.level,
    set: (value: string) => {
      logger.level = value;
    },
    enumerable: true,
    configurable: true,
  });
  if (typeof logger.flush === 'function') wrapped.flush = (cb) => logger.flush?.(cb);
  if (typeof logger.bindings === 'function') wrapped.bindings = () => logger.bindings?.() ?? {};
  if (typeof logger.isLevelEnabled === 'function') {
    wrapped.isLevelEnabled = (level: string) => logger.isLevelEnabled?.(level) ?? true;
  }

  // The wrapper implements the logging surface plus the three helpers above;
  // the cast is what lets it stand in for the logger it wraps at the call
  // sites that already type against pino's own interface.
  return wrapped as unknown as L;
}
