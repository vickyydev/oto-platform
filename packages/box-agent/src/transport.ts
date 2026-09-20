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
}

export interface AgentResponse {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  header(name: string): string | null;
}

export type AgentFetch = (url: string, init: AgentRequestInit) => Promise<AgentResponse>;

/** The real one: global `fetch`, which is what a Pi on Node 22 will use. */
export function httpTransport(): AgentFetch {
  return async (url, init) => {
    const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
    return {
      status: res.status,
      json: () => res.json() as Promise<unknown>,
      text: () => res.text(),
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
