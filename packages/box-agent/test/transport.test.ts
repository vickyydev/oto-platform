import assert from 'node:assert/strict';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { createServer, type Server, type Socket } from 'node:net';
import { test } from 'node:test';

import { AgentTimeoutError, httpTransport } from '../src/transport';

/**
 * SCRUM-223 — the box's HTTP transport gives up on a cloud that does not
 * answer, instead of waiting out `fetch`'s five minutes.
 *
 * Real sockets on this machine: a server that takes the connection and never
 * says a word (what a hung instance or a captive portal looks like from a
 * box), and one that answers its headers at once and then takes its time
 * over the body (what a large cache bundle on a slow line looks like).
 */

async function silentServer(): Promise<{ url: string; connections(): number; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server: Server = createServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on('data', () => {});
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/box/v1/config`,
    connections: () => connections,
    close: () =>
      new Promise((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** Headers at once; the body `bodyAfterMs` later, or never when null. */
async function slowBodyServer(bodyAfterMs: number | null): Promise<{ url: string; close(): Promise<void> }> {
  const server: HttpServer = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.flushHeaders();
    res.write('{"ok":');
    if (bodyAfterMs !== null) setTimeout(() => res.end('true}'), bodyAfterMs);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/box/v1/cache`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

const GET = { method: 'GET', headers: { accept: 'application/json' } };

test('a cloud that takes the connection and never answers is given up on, by name', async () => {
  const cloud = await silentServer();
  try {
    const call = httpTransport({ answerTimeoutMs: 200 });
    const began = Date.now();
    await assert.rejects(
      () => call(cloud.url, GET),
      (err: unknown) => err instanceof AgentTimeoutError && /did not answer within 200 ms/.test(err.message),
    );
    const waited = Date.now() - began;
    assert.ok(waited >= 150 && waited < 2_000, `gave up after ${waited} ms`);
    assert.equal(cloud.connections(), 1, 'the connection was made; the answer never came');
  } finally {
    await cloud.close();
  }
});

test('one call may ask for less than the transport allows, never more', async () => {
  const cloud = await silentServer();
  try {
    const call = httpTransport({ answerTimeoutMs: 400 });
    // Which allowance was used is read off the transport's own word for it —
    // the error names the allowance it timed (`answerMs`, the lesser of the
    // call's and the ceiling) — rather than off a stopwatch that a loaded
    // runner reads differently (SCRUM-423).
    await assert.rejects(
      () => call(cloud.url, { ...GET, answerTimeoutMs: 100 }),
      (err: unknown) => err instanceof AgentTimeoutError && /within 100 ms/.test(err.message),
      'the shorter allowance was the one used',
    );
    await assert.rejects(
      () => call(cloud.url, { ...GET, answerTimeoutMs: 60_000 }),
      (err: unknown) => err instanceof AgentTimeoutError && /within 400 ms/.test(err.message),
      'and a longer one was held to the ceiling',
    );
  } finally {
    await cloud.close();
  }
});

test('an answer that has begun may take longer than the answer allowance to finish', async () => {
  const cloud = await slowBodyServer(500);
  try {
    const call = httpTransport({ answerTimeoutMs: 200, bodyTimeoutMs: 5_000 });
    const res = await call(cloud.url, GET);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true }, 'a large bundle on a slow line still lands');
  } finally {
    await cloud.close();
  }
});

test('a body that stops arriving is given up on too', async () => {
  const cloud = await slowBodyServer(null);
  try {
    const call = httpTransport({ answerTimeoutMs: 1_000, bodyTimeoutMs: 300 });
    const res = await call(cloud.url, GET);
    assert.equal(res.status, 200);
    await assert.rejects(
      () => res.json(),
      (err: unknown) => err instanceof AgentTimeoutError && /did not finish within 300 ms/.test(err.message),
    );
  } finally {
    await cloud.close();
  }
});
