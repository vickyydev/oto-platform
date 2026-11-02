import http from 'node:http';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openChannel } from '../src/routes/stations';
import { stationChannels } from '../src/lib/station-channel';

const stationId = '00000000-0000-4000-8000-000000000726';

describe('SCRUM-726 station channel close review', () => {
  afterEach(() => stationChannels._reset());

  it('PIN: a connected stream retains its headers and detaches exactly once', async () => {
    const app = Fastify();
    const detach = vi.fn();
    let ended!: () => void;
    const closed = new Promise<void>(resolve => { ended = resolve; });
    app.get('/stream', (req, reply) => {
      openChannel(req, reply, stationId, 'staff', () => {
        reply.raw.write(': ZZ TEST connected\n\n');
        return () => { detach(); ended(); };
      });
    });
    const origin = await app.listen({ port: 0, host: '127.0.0.1' });
    const controller = new AbortController();
    try {
      const response = await fetch(origin + '/stream', { signal: controller.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
      expect(response.headers.get('cache-control')).toBe('no-cache, no-transform');
      expect(stationChannels.total()).toBe(1);
      controller.abort();
      await response.body!.cancel().catch(() => undefined);
      await closed;
      expect(detach).toHaveBeenCalledTimes(1);
      expect(stationChannels.total()).toBe(0);
    } finally {
      controller.abort();
      await app.close();
    }
  });

  it('HIGH: a disconnect during authorization must not attach a stream afterwards; check the raw closed state before subscribing', async () => {
    const app = Fastify();
    const attach = vi.fn(() => vi.fn());
    let arrived!: () => void;
    let release!: () => void;
    let disconnected!: () => void;
    let handled!: () => void;
    const started = new Promise<void>(resolve => { arrived = resolve; });
    const authorization = new Promise<void>(resolve => { release = resolve; });
    const closed = new Promise<void>(resolve => { disconnected = resolve; });
    const completed = new Promise<void>(resolve => { handled = resolve; });
    app.get('/stream', async (req, reply) => {
      reply.raw.once('close', disconnected);
      arrived();
      await authorization;
      openChannel(req, reply, stationId, 'staff', attach);
      handled();
    });
    const origin = await app.listen({ port: 0, host: '127.0.0.1' });
    const client = http.get(origin + '/stream');
    client.on('error', () => undefined);
    try {
      await started;
      client.destroy();
      await closed;
      release();
      await completed;
      expect(attach).not.toHaveBeenCalled();
      expect(stationChannels.total()).toBe(0);
    } finally {
      release();
      client.destroy();
      await app.close();
    }
  });
});
