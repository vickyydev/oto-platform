import { verify as verifyArgon } from '@node-rs/argon2';
import {
  createBoxAgent,
  memoryCredentialStore,
  type AgentFetch,
  type BoxAgent,
} from '@oto/box-agent';
import { boxStoreFor } from '../src/lib/box-store';
import { currentBandKey } from '../src/services/bands';
import { issueClaimCode } from '../src/services/box';
import type { TestContext } from './helpers';

/**
 * A counter box joined to the platform under test by a link a test can cut
 * (offline plan Round 3, the convergence harness).
 *
 * The box is `createBoxAgent` — the code a Raspberry Pi runs — over the
 * `edge` schema of the test database, as the virtual box runs; its calls to
 * the platform go through `app.inject`. With `link.cut` set, every one of them
 * fails at the network, which is what a mall's router going down looks like
 * from the box.
 */
export interface CuttableLink {
  cut: boolean;
}

export function injectedTransport(ctx: TestContext, link: CuttableLink): AgentFetch {
  return async (url, init) => {
    if (link.cut) throw new Error('ECONNRESET: the mall link is down');
    const res = await ctx.app.inject({
      method: init.method as 'GET',
      url: url.replace(/^https?:\/\/[^/]+/, ''),
      headers: init.headers,
      payload: init.body,
    });
    return {
      status: res.statusCode,
      json: async () => (res.body ? JSON.parse(res.body) : null),
      text: async () => res.body,
      header: (name) => {
        const value = res.headers[name.toLowerCase()];
        return typeof value === 'string' ? value : null;
      },
    };
  };
}

/**
 * A registered-on-first-use box for one seeded box row, with argon2id for its
 * unlocks. With `devices` (offline plan Round 4) it also runs its printers and
 * card terminals — the seed's, all simulated — and holds the park's band key,
 * as the virtual box does, so a sale taken on it prints and is banded.
 */
export function linkedAgent(
  ctx: TestContext,
  boxId: string,
  name: string,
  link: CuttableLink,
  opts: { devices?: boolean } = {},
): BoxAgent {
  return createBoxAgent({
    apiBaseUrl: `http://${name}.test`,
    credentials: memoryCredentialStore(),
    hostname: name,
    fetch: injectedTransport(ctx, link),
    store: boxStoreFor(ctx.db),
    claimCode: async () => (await issueClaimCode(ctx.db, boxId)).code,
    booth: { verifySecret: (hash, secret) => verifyArgon(hash, secret) },
    bridge: { verifyPassword: (hash, password) => verifyArgon(hash, password) },
    ...(opts.devices
      ? {
          printing: { retryDelayMs: 0 },
          terminal: { timeouts: { saleMs: 300, probeMs: 300 } },
          bands: { key: currentBandKey },
        }
      : { printing: { enabled: false }, terminal: { enabled: false } }),
  });
}
