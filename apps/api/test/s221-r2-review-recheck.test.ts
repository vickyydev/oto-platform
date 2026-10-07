import fs from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  account,
  auditLog,
  boxCommand,
  idempotencyKey,
  signingKey,
  station,
  stationEvent,
} from '@oto/db';
import {
  createBoxAgent,
  memoryCredentialStore,
  type AgentFetch,
  type BoxAgent,
} from '@oto/box-agent';
import { normalizePhone } from '@oto/shared';
import { ADMIN, createTestContext, signInAs, teardownAll, type TestContext } from './helpers';
import { boxStoreFor } from '../src/lib/box-store';
import { staffTokenKid } from '../src/lib/staff-token-key';
import { provisionVirtualBox } from '../src/services/box';

/**
 * SCRUM-218 review of lane I round 2 — RE-CHECK of the two rejects, from
 * outside the builder's suites, through the api's own doors:
 *
 *   REJECT 1 — a live QR refused at the till must not reach the guest's screen
 *   through the refusal's words. Driven here with the shapes a counter really
 *   reads a QR in, and on the box states that refuse a genuine QR for reasons of
 *   their own (a key not pulled yet, a holder with no benefit today).
 *
 *   REJECT 2 — a scanned QR must not be kept in the replay store. Driven with an
 *   Idempotency-Key on every door that answers with one (the scan door, the
 *   scanner simulator in both modes, the cloud's resolve), on handled and on
 *   refused scans, and the whole store read at the end with no exception for
 *   the scan door this time.
 *
 * And what the fix's new flag (`scannedCredential`) costs: a retried benefit
 * scan under one key runs again rather than replaying, and the backstop's
 * ERROR line is not raised by the scan door.
 */

// --- The log, captured (as s221-r2-review.test.ts does) -------------------------

const logLines: string[] = [];
const fsMutable = fs as unknown as {
  write: (...args: unknown[]) => unknown;
  writeSync: (...args: unknown[]) => unknown;
};
const realWrite = fsMutable.write;
const realWriteSync = fsMutable.writeSync;
const priorLogLevel = process.env.LOG_LEVEL;
const asText = (data: unknown): string =>
  typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
const byteLength = (data: unknown): number =>
  typeof data === 'string'
    ? Buffer.byteLength(data, 'utf8')
    : Buffer.isBuffer(data)
      ? data.length
      : 0;
fsMutable.write = (...args: unknown[]) => {
  const [fd, data] = args;
  if (fd !== 1 && fd !== 2) return realWrite.apply(fs, args);
  logLines.push(asText(data));
  const callback = args[args.length - 1];
  if (typeof callback === 'function') {
    process.nextTick(() => (callback as (err: null, n: number) => void)(null, byteLength(data)));
  }
  return undefined;
};
fsMutable.writeSync = (...args: unknown[]) => {
  const [fd, data] = args;
  if (fd !== 1 && fd !== 2) return realWriteSync.apply(fs, args);
  logLines.push(asText(data));
  return byteLength(data);
};
process.env.LOG_LEVEL = 'trace';

function keypair() {
  const pair = generateKeyPairSync('ed25519');
  const privateKeyPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicKeyPem = pair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  return { privateKeyPem, publicKeyPem, kid: staffTokenKid(publicKeyPem) };
}
const PARK = keypair();

let ctx: TestContext;
let tillId: string;
let boxId: string;
let agent: BoxAgent;
let admin = '';
let adminId = '';
let nokId = '';
let code = '';
let n = 0;
const idem = () => `s221-r2-recheck-${process.pid}-${Date.now()}-${n++}`;

/** Every run of eight characters of the live QR's signature. */
let windows: string[] = [];
const carriesSignature = (text: string) => windows.some((w) => text.includes(w));

interface Envelope {
  error?: { code: string; message: string };
}
interface ScanAnswer {
  kind: string;
  outcome: string;
  handler: string | null;
  errorCode: string | null;
  detail?: Record<string, unknown>;
}

async function call<T = Record<string, unknown>>(
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  payload?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: T & Envelope; raw: string; headers: Record<string, unknown> }> {
  const res = await ctx.app.inject({
    method,
    url,
    headers: { cookie: admin, ...headers },
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return {
    status: res.statusCode,
    body: (res.body ? res.json() : {}) as T & Envelope,
    raw: res.body,
    headers: res.headers as Record<string, unknown>,
  };
}

async function stored(key: string) {
  const [row] = await ctx.db
    .select()
    .from(idempotencyKey)
    .where(and(eq(idempotencyKey.key, key), eq(idempotencyKey.accountId, adminId)));
  return row ?? null;
}

const cursor = async () =>
  (await call<{ next: number }>('GET', `/stations/${tillId}/scans?view=customer`)).body.next;
const guestHeard = async (after: number) =>
  (
    await call<{ scans: unknown[] }>(
      'GET',
      `/stations/${tillId}/scans?view=customer&after=${after}`,
    )
  ).raw;

function injectTransport(): AgentFetch {
  return async (url, init) => {
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const res = await ctx.app.inject({
      method: init.method as 'GET',
      url: path,
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

/** The shapes a counter reads a live QR in — every one recoverable by eye. */
function shapes(g: string): Array<{ what: string; code: string }> {
  const dot = g.lastIndexOf('.');
  const sig = g.slice(dot + 1);
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const last = alphabet.indexOf(sig[85]!);
  const sibling = alphabet[(last & ~0x0f) | ((last + 1) & 0x0f)]!;
  return [
    { what: 'as printed', code: g },
    { what: 'padded, with the scanner’s CRLF', code: `  ${g}\r\n` },
    { what: 'all lower case', code: g.toLowerCase() },
    { what: 'all upper case', code: g.toUpperCase() },
    { what: 'header lower case', code: `oto-ben:v1:${g.slice('OTO-BEN:v1:'.length)}` },
    { what: 'read twice in one burst', code: `${g}${g}` },
    { what: 'trailing junk', code: `${g}X` },
    { what: 'the dot read as a comma', code: `${g.slice(0, dot)},${sig}` },
    { what: 'the dot dropped', code: `${g.slice(0, dot)}${sig}` },
    {
      what: 'one signature character changed',
      code: `${g.slice(0, dot + 11)}${sig[10] === 'A' ? 'B' : 'A'}${sig.slice(11)}`,
    },
    {
      what: 'the employee id altered, the genuine signature kept',
      code: g.replace(/:([0-9a-f]{8})-/, ':00000000-'),
    },
    {
      what: 'the last character’s padding bits changed',
      code: `${g.slice(0, dot + 1)}${sig.slice(0, 85)}${sibling}`,
    },
  ];
}

beforeAll(async () => {
  ctx = await createTestContext({ env: { BENEFIT_QR_PRIVATE_KEY: PARK.privateKeyPem } });
  admin = await signInAs(ctx.app, ADMIN.phone, ADMIN.password);
  const [adminRow] = await ctx.db
    .select({ id: account.id })
    .from(account)
    .where(eq(account.phone, normalizePhone(ADMIN.phone)!));
  adminId = adminRow!.id;

  const till = (await ctx.db.select().from(station)).find((s) => s.name === 'Reception Till 1')!;
  tillId = till.id;
  boxId = till.boxId!;
  agent = createBoxAgent({
    apiBaseUrl: 'http://virtual-box.test',
    credentials: memoryCredentialStore(),
    hostname: 's221-r2-recheck',
    fetch: injectTransport(),
    claimCode: async () => (await provisionVirtualBox(ctx.db, ctx.app.log))?.claimCode ?? null,
    store: boxStoreFor(ctx.db),
  });
  await agent.ensureRegistered();
  await agent.syncConfig();

  const staff = await call<{ staff: Array<{ employeeId: string; name: string }> }>(
    'GET',
    '/benefits/profiles',
  );
  nokId = staff.body.staff.find((s) => s.name === 'Nok (Reception)')!.employeeId;
  const issued = await call<{ credential: { id: string } }>(
    'POST',
    '/benefits/credentials',
    { employeeId: nokId },
    { 'idempotency-key': idem() },
  );
  expect(issued.status).toBe(200);
  code = (
    await call<{ code: string }>('GET', `/benefits/credentials/${issued.body.credential.id}/qr`)
  ).body.code;
  const sig = code.slice(code.lastIndexOf('.') + 1);
  expect(sig).toHaveLength(86);
  windows = Array.from({ length: sig.length - 7 }, (_, i) => sig.slice(i, i + 8));
  await agent.syncCache();
}, 180_000);

afterAll(async () => {
  agent?.stop();
  await ctx?.close();
  await teardownAll();
  fsMutable.write = realWrite;
  fsMutable.writeSync = realWriteSync;
  if (priorLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = priorLogLevel;
});

describe('REJECT 1 and 2 re-checked at the till’s scan door, with a key on every scan', () => {
  it('the QR as printed: the staff answer carries it, the replay store does not, a retry under the same key runs again', async () => {
    const key = idem();
    const tapeBefore = (
      await ctx.db
        .select({ id: stationEvent.id })
        .from(stationEvent)
        .where(eq(stationEvent.stationId, tillId))
    ).length;
    const first = await call<ScanAnswer>(
      'POST',
      `/stations/${tillId}/scan`,
      { code, source: 'camera' },
      {
        'idempotency-key': key,
      },
    );
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ kind: 'benefit', outcome: 'handled', handler: 'benefit' });
    expect(first.body.detail?.benefitCode).toBe(code);
    expect(await stored(key)).toBeNull();

    // `scannedCredential` gives the key back, so the same key is a fresh scan:
    // not a replay, not "in flight", not a mismatch — and taped again.
    const again = await call<ScanAnswer>(
      'POST',
      `/stations/${tillId}/scan`,
      { code, source: 'camera' },
      {
        'idempotency-key': key,
      },
    );
    expect(again.status).toBe(200);
    expect(again.headers['x-oto-replay']).toBeUndefined();
    expect(again.body.detail?.benefitCode).toBe(code);
    expect(await stored(key)).toBeNull();
    const tapeAfter = (
      await ctx.db
        .select({ id: stationEvent.id })
        .from(stationEvent)
        .where(eq(stationEvent.stationId, tillId))
    ).length;
    expect(tapeAfter).toBe(tapeBefore + 2);
  });

  it('every shape a counter reads it in, on a box that admits it: no signature in a refusal, in the guest’s poll or in the store', async () => {
    const from = await cursor();
    const outcomes: string[] = [];
    for (const shape of shapes(code)) {
      const key = idem();
      const res = await call<ScanAnswer>(
        'POST',
        `/stations/${tillId}/scan`,
        { code: shape.code, source: 'camera' },
        { 'idempotency-key': key },
      );
      expect(res.status, shape.what).toBe(200);
      outcomes.push(`${res.body.kind}:${res.body.outcome}`);
      if (res.body.outcome === 'handled' && res.body.kind === 'benefit') {
        // Handed to the staff screen, and only there; never kept.
        expect(typeof res.body.detail?.benefitCode, shape.what).toBe('string');
        expect(await stored(key), shape.what).toBeNull();
      } else {
        expect(res.body.detail?.benefitCode, shape.what).toBeUndefined();
        expect(carriesSignature(res.raw), `${shape.what}: ${res.raw.slice(0, 240)}`).toBe(false);
      }
      const row = await stored(key);
      expect(carriesSignature(JSON.stringify(row?.responseBody ?? null)), shape.what).toBe(false);
    }
    expect(outcomes).toContain('benefit:handled');
    expect(outcomes).toContain('benefit:refused');
    const heard = await guestHeard(from);
    expect(heard).toContain('"codeKind":"benefit"');
    expect(carriesSignature(heard), heard.slice(0, 400)).toBe(false);
  });

  it('a box that has not pulled the key, and one whose holder has no benefit today: the live QR refused, its words cut, nothing of it kept', async () => {
    const run = async (label: string) => {
      const from = await cursor();
      for (const shape of shapes(code).slice(0, 3)) {
        const key = idem();
        const res = await call<ScanAnswer>(
          'POST',
          `/stations/${tillId}/scan`,
          { code: shape.code, source: 'camera' },
          { 'idempotency-key': key },
        );
        expect(res.body.outcome, `${label} / ${shape.what}`).toBe('refused');
        expect(
          carriesSignature(res.raw),
          `${label} / ${shape.what}: ${res.raw.slice(0, 240)}`,
        ).toBe(false);
        const row = await stored(key);
        expect(row?.statusCode, `${label}: a refusal is an answer worth keeping`).toBe(200);
        expect(carriesSignature(JSON.stringify(row?.responseBody)), label).toBe(false);
      }
      expect(carriesSignature(await guestHeard(from)), label).toBe(false);
    };

    await ctx.db
      .update(signingKey)
      .set({ retiredAt: new Date() })
      .where(and(eq(signingKey.purpose, 'benefit_qr'), eq(signingKey.kid, PARK.kid)));
    await agent.syncCache();
    try {
      await run('no key on the box');
    } finally {
      await ctx.db
        .update(signingKey)
        .set({ retiredAt: null })
        .where(and(eq(signingKey.purpose, 'benefit_qr'), eq(signingKey.kid, PARK.kid)));
      await agent.syncCache();
    }

    const removed = await call(
      'PUT',
      `/benefits/profiles/${nokId}`,
      { benefitRole: null, override: null },
      {
        'idempotency-key': idem(),
      },
    );
    expect(removed.status).toBe(200);
    await agent.syncCache();
    try {
      await run('holder with no benefit today');
    } finally {
      await call(
        'PUT',
        `/benefits/profiles/${nokId}`,
        { benefitRole: 'staff', override: null },
        {
          'idempotency-key': idem(),
        },
      );
      await agent.syncCache();
    }
    const back = await call<ScanAnswer>('POST', `/stations/${tillId}/scan`, {
      code,
      source: 'camera',
    });
    expect(back.body.outcome).toBe('handled');
  });

  it('the scanner simulator, in both modes and with a code id, under a key: the QR is never kept', async () => {
    for (const body of [
      { code, mode: 'hid' },
      { code, mode: 'serial' },
      { code, mode: 'serial', codeId: ']Q1' },
      { code: `${code}X`, mode: 'hid' },
    ]) {
      const key = idem();
      const res = await call<ScanAnswer & { recognised: boolean }>(
        'POST',
        `/stations/${tillId}/scan/simulate`,
        body,
        { 'idempotency-key': key },
      );
      expect(res.status, JSON.stringify(body).slice(-40)).toBe(200);
      const row = await stored(key);
      expect(carriesSignature(JSON.stringify(row?.responseBody ?? null)), body.mode).toBe(false);
      if (res.body.outcome !== 'handled') expect(carriesSignature(res.raw)).toBe(false);
    }
  });
});

describe('REJECT 1’s other half: the cloud’s resolve refusals, under a key', () => {
  it('a live QR the cloud refuses — retired key, another park, a mangled read — is echoed short of its signature, and the store keeps no more', async () => {
    const asked: Array<{ what: string; status: number; raw: string; key: string }> = [];
    const ask = async (what: string, sent: string, cookie = admin) => {
      const key = idem();
      const res = await ctx.app.inject({
        method: 'POST',
        url: '/benefits/resolve',
        headers: { cookie, 'idempotency-key': key },
        payload: { code: sent },
      });
      asked.push({ what, status: res.statusCode, raw: res.body, key });
    };
    for (const shape of shapes(code).slice(2)) await ask(shape.what, shape.code);

    await ctx.db
      .update(signingKey)
      .set({ retiredAt: new Date() })
      .where(and(eq(signingKey.purpose, 'benefit_qr'), eq(signingKey.kid, PARK.kid)));
    try {
      await ask('the key retired', code);
    } finally {
      await ctx.db
        .update(signingKey)
        .set({ retiredAt: null })
        .where(and(eq(signingKey.purpose, 'benefit_qr'), eq(signingKey.kid, PARK.kid)));
    }

    const refused = asked.filter((a) => a.status !== 200);
    expect(refused.length).toBeGreaterThan(5);
    for (const a of asked) {
      expect(carriesSignature(a.raw), `${a.what}: ${a.raw.slice(0, 240)}`).toBe(false);
      const row = await stored(a.key);
      expect(carriesSignature(JSON.stringify(row?.responseBody ?? null)), a.what).toBe(false);
    }
    expect(refused.some((a) => a.raw.includes('No staff benefit found for \\"OTO-BEN:v1:'))).toBe(
      true,
    );
  });

  /**
   * NOT BLOCKING, recorded for round 3 (where the till's benefit dialog becomes
   * resolve's first caller). `benefitCodeShown` recognises a benefit QR only by
   * a header at the START, so a live QR read with anything in front of it —
   * `]Q1` from a keyboard-wedge scanner with Transmit Code ID on (the box's
   * serial reader strips it; a browser field does not), a zero-width space or
   * quotes from a pasted message, `QR:` — is echoed WHOLE in resolve's 404 and
   * kept under an Idempotency-Key. Probed in review: all four shapes, 404,
   * signature in the answer and in `core.idempotency_key.response_body`. The
   * box never routes such a read to the benefit handler (no echo there), and
   * the answer reaches only the caller who sent it. So too any other credential
   * typed into resolve — a signed band code, a booking QR — since anything
   * without the header is echoed as typed.
   */
  it.todo(
    'a live QR with anything in front of its header is echoed short of its signature by resolve, and the store keeps no more',
  );
});

describe('the Console’s Devices scanner simulator: a QR queued as a box command', () => {
  /**
   * NEW, BLOCKING. The Console's Devices drawer (`SimulatorPanel.tsx`, "Scan")
   * queues `scanner.scan` as an `edge.box_command`, and `queueCommand`
   * (`services/fleet.ts`) keeps the action whole in `box_command.payload` and in
   * the audit row's `after` (fleet.ts:2035 and :2047), and the command history
   * renders it. Only `badge.present`, `pin.enter` and `terminal.outcome` are
   * refused there (`SIMULATOR_ACTIONS_WITH_SECRETS`), for exactly this reason.
   * A live benefit QR pasted into that box — the obvious way to try one at a
   * till during the bench — is then in an append-only audit row for good.
   * Refused at the queue (the badge's `SIMULATOR_ACTION_CARRIES_SECRET`) or
   * kept out of the row some other way: either passes this.
   */
  it('no command row, audit row or command history holds the QR', async () => {
    for (const sent of [code, `  ${code}\r\n`]) {
      const res = await call(
        'POST',
        `/boxes/${boxId}/commands`,
        {
          kind: 'simulate',
          payload: {
            action: { action: 'scanner.scan', input: { code: sent, source: 'simulator' } },
          },
        },
        { 'idempotency-key': idem() },
      );
      expect([200, 409, 422]).toContain(res.status);
    }
    const commands = JSON.stringify(await ctx.db.select().from(boxCommand));
    const audits = JSON.stringify(await ctx.db.select().from(auditLog));
    const history = await call('GET', `/boxes/${boxId}/commands`);
    expect(history.status).toBe(200);
    expect(carriesSignature(commands), 'edge.box_command').toBe(false);
    expect(carriesSignature(audits), 'core.audit_log').toBe(false);
    expect(carriesSignature(history.raw), 'GET /boxes/:id/commands').toBe(false);
  });
});

describe('afterwards: the whole replay store, every log line', () => {
  it('no row of the replay store holds eight characters of the signature — the scan door included this time', async () => {
    const rows = await ctx.db.select().from(idempotencyKey);
    expect(rows.length).toBeGreaterThan(10);
    const leaking = rows.filter((r) => carriesSignature(JSON.stringify(r.responseBody ?? null)));
    expect(leaking.map((r) => r.key)).toEqual([]);
  });

  it('the scan door never raised the backstop’s ERROR line; it said so at debug instead; no log line holds the signature', async () => {
    for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setImmediate(r));
    const lines = logLines.join('').split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(50);
    const backstop = lines.filter((l) => l.includes('declare secretResponse on this route'));
    expect(backstop).toEqual([]);
    expect(
      lines.some((l) => l.includes('an answer carrying a scanned credential was not stored')),
    ).toBe(true);
    const leaking = lines.filter((l) => carriesSignature(l));
    expect(leaking.map((l) => l.slice(0, 200))).toEqual([]);
  });
});
