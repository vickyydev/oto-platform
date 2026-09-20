import { AsyncLocalStorage } from "node:async_hooks";
import pino from "pino";
import { safeLogger } from "./telemetry/logger";
import { redact } from "./telemetry/redact";

/**
 * The app's one logger.
 *
 * Two things had to change from what was lifted. The first is the format: 466
 * `console.log` calls writing "2:31:07 PM [express] GET /api/... 200 in 12ms"
 * are fine in a terminal and useless in a hosted log stream, where the only
 * thing that makes a line findable months later is that it is JSON with a
 * request id on it.
 *
 * The second is redaction, and it is the reason the console is rebound below
 * rather than the call sites being rewritten. `safeLogger` wraps the logger
 * ONCE, at the point it is created, so there is no unredacted logger in the
 * process to reach for — a binding is scrubbed whether or not the person
 * writing the line thought about it. Rewriting 466 call sites would leave the
 * 467th unprotected, and the rules being enforced are the platform's own
 * (`./telemetry`, copied byte-for-byte from `packages/telemetry/src`), so this
 * app's log lines and the api's obey one list.
 */

const base = pino({
  level: process.env.LOG_LEVEL ?? "info",
  // Two fields the app never set and every log search needs first.
  base: {
    service: "oto-app",
    env: process.env.DEPLOY_ENV ?? "local",
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

export const logger = safeLogger(base);

/**
 * The request id for whatever is currently executing.
 *
 * It lives in async storage rather than being threaded through 796 handlers:
 * the point of the id is that a line written deep inside a service — a PDF
 * render, a Twilio call, a query that failed — can be tied to the request that
 * caused it, and a handler that has to be given the id is a handler that will
 * be written without it.
 */
export const requestContext = new AsyncLocalStorage<{ requestId: string }>();

/** The current request id, or undefined outside a request (a job, boot). */
export function currentRequestId(): string | undefined {
  return requestContext.getStore()?.requestId;
}

/**
 * A logger bound to the current request, so every line it writes carries the
 * id the hand-off brought in.
 */
export function log(): typeof logger {
  const requestId = currentRequestId();
  return requestId ? logger.child({ requestId }) : logger;
}

/** The printf placeholders pino understands, plus the `%%` escape. */
const FORMAT_PLACEHOLDER = /%[sdifjoOc%]/;

/**
 * Send `console.*` through the logger.
 *
 * Deliberate, and worth saying why rather than leaving it to be discovered.
 * The app writes almost everything through `console`, including inside
 * failure paths where the thing being printed is whatever the caller sent us.
 * Redirecting the global is the only change that covers all of it at once;
 * anything else is a list of call sites somebody maintains, and the leak is
 * always at the call site nobody put on the list.
 *
 * `console.debug` maps to `debug` and is therefore silent at the default
 * level, which is the one behaviour change: a debug line that used to appear
 * on a developer's terminal now needs `LOG_LEVEL=debug`. Everything else keeps
 * the severity it had.
 */
export function bindConsole(): void {
  const forward =
    (level: "debug" | "info" | "warn" | "error") =>
    (first?: unknown, ...rest: unknown[]): void => {
      const target = log();
      if (first === undefined && rest.length === 0) {
        target[level]("");
        return;
      }
      /**
       * The two logging interfaces disagree about trailing arguments, and the
       * disagreement loses data rather than announcing itself. `console.log`
       * prints every argument; pino's are interpolation VALUES, so it fills
       * the placeholders in the message and silently discards the rest —
       * `logger.info("saved", file)` writes `"saved"` and nothing about the
       * file. The app's commonest shape is exactly that:
       * `console.error("[PdfStorage] S3 stream error:", err)`.
       *
       * So a message with no placeholder keeps its trailing arguments under
       * `args`, where they are a field rather than a lost one — and where the
       * key rules apply to everything inside them, which they would not if
       * this flattened the call into a string.
       */
      if (typeof first === "string" && rest.length > 0 && !FORMAT_PLACEHOLDER.test(first)) {
        target[level]({ args: rest }, first);
        return;
      }
      // A message that does carry placeholders keeps them, and its values are
      // redacted on the way past: `safeLogger` scrubs a trailing STRING but
      // passes a trailing object through untouched, because to pino that is a
      // format value rather than a binding.
      const args = rest.map((arg) => (typeof arg === "string" ? arg : redact(arg)));
      (target[level] as (first: unknown, ...args: unknown[]) => void)(first, ...args);
    };

  console.log = forward("info");
  console.info = forward("info");
  console.warn = forward("warn");
  console.error = forward("error");
  console.debug = forward("debug");
}
