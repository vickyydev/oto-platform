/**
 * The agent's HTTP surface, narrowed to what it actually uses.
 *
 * Deliberately not the DOM `fetch` type. The agent has to be drivable from a
 * test that never opens a socket — the api's own suite runs it against
 * `app.inject` — and a four-method interface is something a test can satisfy
 * honestly, where a `Response` is something a test has to fake.
 */
export interface AgentRequestInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  /**
   * How long THIS call may wait for the cloud to start answering, when that is
   * less than the transport's own allowance (SCRUM-223). Never more: the
   * transport's figure is the ceiling. A transport with no timeouts — a
   * test's, or `app.inject` — ignores it.
   */
  answerTimeoutMs?: number;
}

export interface AgentResponse {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  header(name: string): string | null;
}

export type AgentFetch = (url: string, init: AgentRequestInit) => Promise<AgentResponse>;

/**
 * How long a box waits for the cloud to START answering — to connect, send,
 * and get the status line and headers back (SCRUM-223).
 *
 * `fetch` on its own waits as long as undici's header timeout, five minutes,
 * and a cloud that accepts the connection and never answers — a hung
 * instance, a captive portal holding the request, a half-open path — is the
 * case that meets it. A booth box waited that out four times in a row inside
 * `start()` (measured: the first call gave up 5 min 8 s after boot). Fifteen
 * seconds is far above any answer the api gives a box on the bench (tens to
 * hundreds of milliseconds) and short enough that start-up gives up inside a
 * minute and carries on offline.
 */
export const AGENT_ANSWER_TIMEOUT_MS = 15_000;

/**
 * How long the body may then take, from the headers (SCRUM-223). Longer,
 * because a cloud that has sent its headers is answering, and a cache bundle
 * — a branch's members, bookings and bands — can be large on a slow line.
 */
export const AGENT_BODY_TIMEOUT_MS = 120_000;

export class AgentTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export interface HttpTransportOptions {
  /** See `AGENT_ANSWER_TIMEOUT_MS`. */
  answerTimeoutMs?: number;
  /** See `AGENT_BODY_TIMEOUT_MS`. */
  bodyTimeoutMs?: number;
}

/**
 * The real one: global `fetch`, which is what a Pi on Node 22 will use — with
 * the two limits above, because `fetch` has none worth the name.
 *
 * One `AbortController` per call: aborted when no answer has begun within the
 * answer allowance, or when a body that has begun has not finished within the
 * body allowance. Either way the call rejects with an `AgentTimeoutError`,
 * which the agent treats like any other request that got no answer — the link
 * is down, and the next tick tries again.
 */
export function httpTransport(options: HttpTransportOptions = {}): AgentFetch {
  const answerCeilingMs = options.answerTimeoutMs ?? AGENT_ANSWER_TIMEOUT_MS;
  const bodyMs = options.bodyTimeoutMs ?? AGENT_BODY_TIMEOUT_MS;
  return async (url, init) => {
    const answerMs = Math.min(init.answerTimeoutMs ?? answerCeilingMs, answerCeilingMs);
    const controller = new AbortController();
    const answerTimer = setTimeout(
      () => controller.abort(new AgentTimeoutError(`the cloud did not answer within ${answerMs} ms`)),
      answerMs,
    );
    // Never the reason a process stays alive: the socket already is, while it lasts.
    answerTimer.unref?.();
    let res: Response;
    try {
      res = await fetch(url, {
        method: init.method,
        headers: init.headers,
        body: init.body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(answerTimer);
    }
    const read = <T>(body: () => Promise<T>): Promise<T> => {
      const bodyTimer = setTimeout(
        () =>
          controller.abort(new AgentTimeoutError(`the cloud's answer did not finish within ${bodyMs} ms`)),
        bodyMs,
      );
      bodyTimer.unref?.();
      return body().finally(() => clearTimeout(bodyTimer));
    };
    return {
      status: res.status,
      json: () => read(() => res.json() as Promise<unknown>),
      text: () => read(() => res.text()),
      header: (name) => res.headers.get(name),
    };
  };
}

/** What the agent logs through. Shaped like pino, so the api passes its own. */
export interface AgentLog {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export const silentLog: AgentLog = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
