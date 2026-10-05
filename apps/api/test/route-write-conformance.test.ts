import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/app';
import { loadEnv } from '../src/env';
import {
  matchDelimiter,
  readFunctions,
  readRoutes,
  readSourceFiles,
  reachesText,
  splitArgs,
  type SourceRoute,
} from './route-source';

/**
 * SCRUM-291 (static half) — a mutating route writes in one transaction,
 * records what it did with that transaction, and takes an idempotency key.
 *
 * `test/transactions.test.ts` hand-drives three routes out of a hundred and
 * twelve. Every drift in this class sits in the hundred and nine nobody wrote
 * a test for: nine Sprint-1 write paths that write a change and its audit row
 * as separate statements, and one audit row
 * written on the POOL from inside its own transaction — which survives the
 * rollback and describes a child that does not exist, while `withTx` also
 * writes the failure row beside it. Two rows, both wrong, indistinguishable
 * from real ones ever after.
 *
 * This is the half that can be settled by reading. The other half — driving
 * each route with a seeded body, crashing it mid-write, and asserting that
 * nothing but the failure row survives — needs a database and a body fixture
 * per route, and is a later ticket.
 *
 * **What this cannot see.** It follows calls by name, three hops at most, and
 * a transaction opened further away than that reads as absent. That direction
 * is the safe one: it names a route for a person to look at, rather than
 * quietly passing one. Every list below is exact in both directions, so a
 * fixed entry fails too and has to be deleted.
 */

const API_SRC = fileURLToPath(new URL('../src', import.meta.url));

let app: App;
let routes: SourceRoute[];
let configs: Map<string, App['routeRegistry'][number]['config']>;
let functions: ReturnType<typeof readFunctions>;

beforeAll(async () => {
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: 'postgres://oto:oto@localhost:1/unused' });
  app = await buildApp({ env, db: {} as never, fileStorage: null });
  configs = new Map(app.routeRegistry.map((r) => [`${r.method} ${r.url}`, r.config]));
  routes = readRoutes();
  functions = readFunctions();
});

afterAll(async () => {
  await app.close();
});

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function expectKnownFailures(actual: string[], known: string[], label: string, ticket: string): void {
  const seen = new Set(actual);
  const expected = new Set(known);
  expect(
    actual.filter((v) => !expected.has(v)).sort(),
    `NEW ${label}. Fix it, or add it to the list in this file with the ticket that will.`,
  ).toEqual([]);
  expect(
    known.filter((v) => !seen.has(v)).sort(),
    `FIXED ${label} — ${ticket} landed for these. Delete them from the list in this file.`,
  ).toEqual([]);
}

// --- 1 · The audit row commits with the change, or not at all ---------------

/**
 * Every `audit.record(…)` that sits lexically inside a `withTx(…)` call, with
 * the first argument it was given.
 *
 * `services/tx.ts` states the rule this looks for: the SUCCESS row is written
 * inside the transaction with the `tx` handle, so it cannot survive a
 * rollback; the FAILURE row is written after the rollback on a separate
 * connection, because it has to outlive the transaction that failed. An
 * `app.db` inside the callback is the first rule broken with the second rule's
 * mechanism.
 */
function auditCallsInsideTransactions(): Array<{ where: string; exec: string }> {
  const found: Array<{ where: string; exec: string }> = [];
  {
    /**
     * `readSourceFiles` walks SUBDIRECTORIES, which this scan did not until
     * S2-10a. `services/payments/` — the attempt ledger, the cash drawer and
     * the QR gateway — was outside it, and between them those are every write
     * that moves money. The walk failed safe in the other check (a route whose
     * transaction it cannot see is NAMED, not passed), but this one would have
     * read a pool-handle audit row in there as absent.
     */
    for (const { file, src } of readSourceFiles()) {
      let at = 0;
      while ((at = src.indexOf('withTx(', at)) >= 0) {
        const open = at + 'withTx'.length;
        let end: number;
        try {
          end = matchDelimiter(src, open);
        } catch {
          at = open + 1;
          continue;
        }
        const span = src.slice(open, end);
        let inner = 0;
        while ((inner = span.indexOf('audit.record(', inner)) >= 0) {
          const auditOpen = inner + 'audit.record'.length;
          let args: string[];
          try {
            args = splitArgs(span, auditOpen);
          } catch {
            inner = auditOpen + 1;
            continue;
          }
          const line = src.slice(0, open + inner).split('\n').length;
          found.push({ where: `${file}:${line}`, exec: (args[0] ?? '').trim() });
          inner = auditOpen + 1;
        }
        at = end;
      }
    }
  }
  return found;
}

/** The handle a transaction hands its callback. Anything else is the pool. */
const IS_TRANSACTION = /^(tx|trx|sp)$/;

describe('the audit row commits with the change (SCRUM-291)', () => {
  it('no audit.record inside a transaction is written on the pool', () => {
    const calls = auditCallsInsideTransactions();
    // The walk has to be finding them, or the assertion under it is empty.
    expect(calls.length).toBeGreaterThan(50);
    const onThePool = calls
      .filter((c) => !IS_TRANSACTION.test(c.exec))
      .map((c) => `${c.where}  audit.record(${c.exec}, …)`);
    expectKnownFailures(
      onThePool,
      // Empty, and that is the point of keeping the list: SCRUM-283 was one
      // character — `app.db` for `tx` in `child.create` — and it was live long
      // enough to reach staging. The next one fails here on the day it is
      // written.
      [],
      'audit row written on the pool from inside its own transaction',
      'SCRUM-283',
    );
  });

  /**
   * The scan, run against the call it was written for.
   *
   * `routes/members.ts` at `91f5d8b`, inside the `child.create` transaction.
   * It is fixed, so the live scan can no longer demonstrate that this works —
   * which is exactly when a check quietly stops meaning anything.
   */
  it('catches the child.create call as it stood before SCRUM-283', () => {
    const before = `
      await withTx(app.db, opCtx(req), 'child.create', async (tx) => {
        const [created] = await tx.insert(child).values({ id, name: req.body.name }).returning();
        await audit.record(app.db, {
          actorAccountId: auth.accountId,
          action: 'child.create',
          entityType: 'child',
          entityId: id,
        });
      });`;
    const open = before.indexOf('withTx(') + 'withTx'.length;
    const span = before.slice(open, matchDelimiter(before, open));
    const auditOpen = span.indexOf('audit.record(') + 'audit.record'.length;
    const exec = splitArgs(span, auditOpen)[0]!.trim();
    expect(exec).toBe('app.db');
    expect(IS_TRANSACTION.test(exec), 'app.db must not read as a transaction handle').toBe(false);
  });

  it('accepts the same call with the transaction handle', () => {
    const after = `
      await withTx(app.db, opCtx(req), 'child.create', async (tx) => {
        await audit.record(tx, { action: 'child.create', entityId: id });
      });`;
    const open = after.indexOf('withTx(') + 'withTx'.length;
    const span = after.slice(open, matchDelimiter(after, open));
    const auditOpen = span.indexOf('audit.record(') + 'audit.record'.length;
    expect(IS_TRANSACTION.test(splitArgs(span, auditOpen)[0]!.trim())).toBe(true);
  });
});

// --- 2 · One operation, one transaction --------------------------------------

/**
 * Mutating routes that reach no database write of their own.
 *
 * Measured, not asserted: the assertion below re-derives it, so a route cannot
 * be parked here to excuse a write. What it means precisely is that neither
 * the handler nor anything within three calls of it contains a Drizzle
 * `insert`, `update` or `delete`. Two different reasons for that:
 *
 *   - it computes an answer and keeps nothing — a cart quote, a rendered
 *     preview;
 *   - the write belongs to the BOX. A spin, a lease, a scan, an intent and a
 *     booth sign-in all cross into the agent, and what happens on that side is
 *     the box's own machinery. This says nothing about whether that side is
 *     transactional; it says the route does not write here.
 */
const NO_DIRECT_WRITE = [
  'POST /auth/badge',
  'POST /booth/print',
  'POST /booth/reprint',
  'POST /booth/spin',
  'POST /booth/staff/sign-in',
  'POST /booth/staff/sign-out',
  // SCRUM-232: the import's first step parses, validates and diffs a workbook
  // and writes nothing at all — that is the whole point of a preview. The
  // second step, `POST /branches/:branchId/menu/import`, does the writing and
  // is transacted.
  'POST /branches/:branchId/menu/import/preview',
  'POST /print-templates/:id/preview.png',
  // SCRUM-471: the booth voucher slip's live preview draws a sample and saves nothing.
  'POST /booths/:id/voucher-preview.png',
  /**
   * S2-12 (SCRUM-209) — THE INVARIANT OF ARRIVAL ROUND 1, measured.
   *
   * The payment gateway's hosted page sends the guest's browser back here with
   * a signed `paymentResponse`. It is verified and read as a display hint, and
   * the browser is redirected to the booking site's waiting page — and that is
   * all: a booking is paid only by the backend notification plus an inquiry,
   * or by the poller. A write reached from this handler fails the re-measure
   * below, which is the point of listing it.
   */
  'POST /public/bookings/return',
  /**
   * S2-10a — what a SIMULATED card terminal will do with the next tender.
   *
   * It writes nothing on purpose. The state belongs to the simulator inside
   * the agent in this process, and the value it carries can be the approval
   * code that terminal will print — which is precisely why it may not ride the
   * command queue, whose payload is a stored jsonb column the Console renders
   * (`SIMULATOR_ACTIONS_WITH_SECRETS`). Same shape, same reason, as the badge
   * and scan-simulate routes above it.
   */
  'POST /payments/terminal-simulator',
  /**
   * Offline plan Round 3 — the station bridge's virtual-box mount. Every one of
   * these crosses into the box: a lease and an intent are the box's session
   * manager, a member, child or visit record is a fact sealed into the box's
   * own outbox with its overlay row in ONE store transaction
   * (`@oto/box-agent` `station-bridge.ts`, `produce`), and ending a box
   * session forgets a hash held in memory. The unlock beside them does write
   * here — the platform session's lock and its audit row — and does it in
   * `withTx`, so it is not on this list.
   */
  'POST /box/v1/station/:stationId/intents',
  'POST /box/v1/station/:stationId/lease',
  'POST /box/v1/station/:stationId/lease/release',
  'POST /box/v1/station/:stationId/lease/renew',
  'POST /box/v1/station/:stationId/lock',
  'POST /sales/quote',
  /**
   * SCRUM-494: POST /files already records the file and audit together. This
   * signed-in PUT sends only its photo bytes to private object storage; it
   * does not change a database row or its audit trail.
   */
  'PUT /files/:id/content',
  'POST /stations/:id/button',
  'POST /stations/:id/intents',
  'POST /stations/:id/lease',
  'POST /stations/:id/lease/release',
  'POST /stations/:id/lease/renew',
  'POST /stations/:id/scan',
  'POST /stations/:id/scan/simulate',
];

/**
 * Known failures — SCRUM-287 for the pending-lookup pair, and the two routes
 * that send a verification code.
 *
 * Each writes a row and a second statement that belongs with it as unrelated
 * statements. The code-issuing pair mints the code and clears the guess budget
 * that goes with it; stopping between them leaves a fresh code carrying the
 * previous one's spent attempts.
 *
 * SCRUM-296 took the five that were here before: the two code-CONSUMING routes
 * and the password change, where a crash between spending a single-use code
 * and setting the password left an invited member of staff locked out holding
 * a code that had been burnt; the hand-off exchange, whose claim is now one
 * transaction with the record of it; and `POST /files`. None of those was a
 * plain wrap — see the ticket, and the comments at each.
 */
const UNTRANSACTED = [
  'POST /auth/password-reset/request',
  'POST /auth/setup/start',
];

const opensTransaction = (route: SourceRoute): boolean =>
  reachesText(route.handlerText, (body) => /\bwithTx\s*\(/.test(body), functions, 3);

const writesToTheDatabase = (route: SourceRoute): boolean =>
  reachesText(route.handlerText, (body) => /\.(insert|update|delete)\s*\(/.test(body), functions, 3);

/**
 * The box surface is out of scope here, and pinned in `routes-guarded.test.ts`
 * rather than restated: its principal is a machine, and a batch of facts from
 * a box goes through the sync ledger — cursors, epochs, quarantine — which is
 * its own transaction discipline and its own ticket.
 */
const mutatingCloudRoutes = (): SourceRoute[] =>
  routes.filter(
    (r) => MUTATING.has(r.method) && !configs.get(`${r.method} ${r.path}`)?.credential,
  );

describe('one operation, one transaction (SCRUM-291)', () => {
  it('the source walk found every route the app registered', () => {
    const live = new Set(
      app.routeRegistry
        .filter(
          (r) =>
            r.method !== 'HEAD' &&
            r.method !== 'OPTIONS' &&
            r.url !== '/docs/json' &&
            r.url !== '/*',
        )
        .map((r) => `${r.method} ${r.url}`),
    );
    const parsed = new Set(routes.map((r) => `${r.method} ${r.path}`));
    expect([...live].filter((k) => !parsed.has(k)).sort()).toEqual([]);
    expect([...parsed].filter((k) => !live.has(k)).sort()).toEqual([]);
  });

  it('every mutating route opens a transaction, or writes nothing of its own', () => {
    const considered = mutatingCloudRoutes();
    expect(considered.length).toBeGreaterThan(95);
    const untransacted = considered
      .filter((r) => !opensTransaction(r))
      .filter((r) => !NO_DIRECT_WRITE.includes(`${r.method} ${r.path}`))
      .map((r) => `${r.method} ${r.path}`);
    expectKnownFailures(
      untransacted,
      UNTRANSACTED,
      'mutating route whose write is not inside a transaction',
      'SCRUM-284',
    );
  });

  it('nothing on the no-write list actually writes', () => {
    // The list is a measurement, so it is re-measured. Without this it would
    // be a place to put a route that had become inconvenient.
    const writing = routes
      .filter((r) => NO_DIRECT_WRITE.includes(`${r.method} ${r.path}`))
      .filter((r) => writesToTheDatabase(r))
      .map((r) => `${r.method} ${r.path}`);
    expect(
      writing.sort(),
      'listed as writing nothing, but it reaches an insert, update or delete',
    ).toEqual([]);
  });

  it('every route on either list is still registered', () => {
    const live = new Set(routes.map((r) => `${r.method} ${r.path}`));
    expect(
      [...NO_DIRECT_WRITE, ...UNTRANSACTED].filter((key) => !live.has(key)).sort(),
      'named in this file but no longer a route — delete the line',
    ).toEqual([]);
  });

  it('every route on the known-failure list does write, so the debt is real', () => {
    const notWriting = routes
      .filter((r) => UNTRANSACTED.includes(`${r.method} ${r.path}`))
      .filter((r) => !writesToTheDatabase(r))
      .map((r) => `${r.method} ${r.path}`);
    expect(
      notWriting.sort(),
      'listed as an untransacted write but it reaches no write — it belongs on the other list',
    ).toEqual([]);
  });
});

// --- 3 · The idempotency key -------------------------------------------------

/**
 * The mutating routes whose answer never enters the replay store.
 *
 * The store keeps a response body verbatim for a day and hands it back to
 * anybody holding the key, so a route that mints a credential must be
 * incapable of entering it — `secretResponse` says the answer IS a credential,
 * and `credential` says the principal is a machine with its own replay
 * protection. Every other mutating route WITH A SESSION takes a key, because
 * the plugin is a global preHandler and not a decoration each route
 * remembers — but the plugin returns before the store when there is no
 * session (`plugins/idempotency.ts`, `if (!req.auth) return`), so the
 * sessionless mutating routes never enter it: the `/auth/*` paths, the
 * booth's `/booth/*` paths and `POST /public/bookings`. Those are pinned
 * below in `OPEN_WITHOUT_A_KEY`, each with the thing that protects it instead
 * (SCRUM-298); a comment that said "every other" without that qualification
 * was found by review to be papering over a live gap.
 *
 * Pinned, because these two declarations are the only way out of the
 * safeguard for a route that has a session: a thirteenth route quietly
 * acquiring one is a route that stopped being idempotent, and this is where
 * that becomes a line in a diff.
 */
const OUTSIDE_THE_REPLAY_STORE = [
  'POST /accounts/:id/temp-password [secretResponse]',
  'POST /auth/handoff [secretResponse]',
  /**
   * SCRUM-255(c) / SCRUM-327 — the three fleet routes that mint a one-time
   * code, which reached this list late.
   *
   * They were minting credentials all along and declaring nothing. What kept
   * the code out of the store was that each service returns a code-free value
   * from inside `withTx`, which stores THAT and marks the key stored — right,
   * but right by a convention held in three services rather than by anything
   * this list could see. The plugin's `carriesSecret` backstop never fired on
   * them and could not: `onSend` returns before the check once the claim is
   * marked stored.
   *
   * What makes a retry safe on each is different and is written at the route:
   * the register is refused by `box_slot_unique`, the re-issue overwrites the
   * box's claim-code hash, and the station pairing leaves a second credential
   * row that is visible and revocable.
   */
  'POST /boxes/:id/claim-code [secretResponse]',
  'POST /branches/:branchId/boxes [secretResponse]',
  /**
   * SCRUM-244 — the booth's television surface and its pairing pair.
   *
   * The four `/booth/*` writes moved here from `OPEN_WITHOUT_A_KEY` the day
   * they stopped being open: their principal is now a paired screen with a
   * credential, and the replay protection that matters for a press is the
   * BOX's — the television mints a key per press and the box refuses the
   * second bump of the same one (`packages/box-agent/src/booth.ts`).
   *
   * The two that mint something are here because their answers ARE
   * credentials: six digits somebody types at a booth, and the 256-bit secret
   * those digits buy. Neither may sit in a store that replays a body for a day
   * to anyone holding a key. What makes a repeated press of "Pair a screen"
   * safe instead is that minting revokes the booth's previous unredeemed code.
   */
  'POST /booth/pair [secretResponse]',
  'POST /booth/print [credential:booth]',
  'POST /booth/reprint [credential:booth]',
  'POST /booth/spin [credential:booth]',
  'POST /booth/staff/sign-in [credential:booth]',
  'POST /booth/staff/sign-out [credential:booth]',
  'POST /booths/:id/pairing-codes [secretResponse]',
  /**
   * SCRUM-223 — a booth box forwards a phone and password typed at its booth.
   * `secretResponse` for the REQUEST: its body is a password, and nothing may
   * keep a hash of it. A retry is a second attempt and counts as one, exactly
   * as a second `POST /auth/sign-in` does.
   */
  'POST /box/v1/booth/staff/verify [secretResponse,credential:box]',
  'POST /box/v1/commands/:commandId/result [credential:box]',
  'POST /box/v1/commands/poll [credential:box]',
  'POST /box/v1/heartbeat [credential:box]',
  /**
   * S2-13 round 4 — a box's photo upload. A machine's own replay protection,
   * as the print-job result: the photo id IS the file's id, so asking for an
   * upload URL again is the same file, and linking again is a replay that
   * writes nothing (`linkBoxPhoto`).
   */
  'POST /box/v1/photos/:id/link [credential:box]',
  'POST /box/v1/photos/:id/upload-url [credential:box]',
  'POST /box/v1/print-jobs/:id/result [credential:box]',
  'POST /box/v1/register [secretResponse,credential:box-claim]',
  'POST /box/v1/sync/key [credential:box]',
  'POST /box/v1/sync/push [credential:box]',
  /**
   * Offline plan Round 3 — the station bridge. The unlock's answer IS a
   * credential (the box session), and a retried unlock is a second attempt
   * that counts as one, exactly as a second `POST /auth/unlock` does. A
   * display's intent through the bridge is the display's own credential and
   * fencing, as `POST /display/intents` is.
   */
  'POST /box/v1/station/:stationId/display/intents [credential:display]',
  'POST /box/v1/station/:stationId/unlock [secretResponse]',
  // Independent display credentials have no staff account replay key. Minting
  // rotates the pending single-use hash and must never store its secret reply;
  // expiry is idempotent. Typed answers keep their action/request id and use
  // box sequence fencing with first-answer-wins (fleet and station tests).
  'POST /display/pairing [secretResponse,credential:display-pairing]',
  'POST /display/pairing/expire [credential:display-pairing]',
  'POST /display/intents [credential:display]',
  'POST /me/staff-token [secretResponse]',
  /**
   * S2-10a — what the card terminal did, reported by the box that drove it.
   *
   * On this list for the same reason `POST /box/v1/print-jobs/:id/result` is:
   * the principal is a machine with its own replay protection, and the replay
   * store cannot hold a key for a caller with no account. What makes a retry
   * safe here is stronger than a stored body — the service refuses to move an
   * attempt that has already reached a state nothing can move it out of, so a
   * second `approved` for one tender writes nothing and is answered as a
   * replay. `payments-terminal.test.ts` plants exactly that.
   */
  'POST /payments/attempts/:id/result [credential:box]',
  'POST /stations/:id/credentials [secretResponse]',
  'PUT /booths/:id/staff/:accountId/pin [secretResponse]',
  'PUT /me/session/station [secretResponse]',
];

/**
 * The mutating routes that can be called with no session at all, and what
 * stands in for the replay store on each (SCRUM-298).
 *
 * A row in that store is owned by an account — `core.idempotency_key` has a
 * not-null `account_id` referencing `core.account` — so a caller without a
 * session cannot hold one, and the plugin returns before claiming anything.
 * That is not a judgement about these routes; it is the store's shape. Each of
 * them therefore has to say what makes a retry safe, and the three answers are
 * genuinely different:
 *
 *   - **self-idempotent by construction** — `/auth/*`. A second identical
 *     sign-in IS a second attempt and has to count as one; a second
 *     `setup/complete` with the same code has to find that code spent; a
 *     second `sign-out` has nothing left to end. Replaying a stored answer
 *     here would be the defect, not the safeguard. `setup/start` and
 *     `password-reset/request` send a second SMS on purpose and are bounded by
 *     `rl:setup:<phone>` and `rl:reset:<phone>` instead;
 *   - **single-use by construction** — `POST /booth/pair` (SCRUM-244). The six
 *     digits are spent by the UPDATE that redeems them, conditional on the
 *     hash still being on the row, so a second send of the same code updates
 *     nothing and is refused. Replaying a stored answer here would be the
 *     defect: it would hand the same device secret to a second screen;
 *   - **a client-minted id** — `POST /public/bookings`. The site mints the
 *     booking id, the primary key is the unique constraint, and the second
 *     submit is answered with the first one's row. `public.test.ts` pins it.
 *
 * Pinned as a list because the gap is invisible from a route declaration: a
 * new open mutating route inherits none of this and looks exactly like the
 * guarded ones above.
 */
const OPEN_WITHOUT_A_KEY = [
  'POST /auth/handoff/exchange',
  'POST /auth/password-reset/complete',
  'POST /auth/password-reset/request',
  'POST /auth/setup/complete',
  'POST /auth/setup/start',
  'POST /auth/sign-in',
  'POST /auth/sign-out',
  'POST /booth/pair',
  'POST /public/bookings',
  /**
   *   - **one attempt per booking** — `POST /public/bookings/:id/checkout`
   *     (S2-12). The booking's row is locked and it links to ONE gateway
   *     attempt, so a second press finds that attempt and is answered with
   *     the same page; a new invoice is never minted for a booking that
   *     already has one.
   *   - **it writes nothing** — `POST /public/bookings/return`, the hosted
   *     page's browser return (on the no-write list above).
   *   - **the notification's own key** — `POST /webhooks/2c2p/hosted/:attemptId`,
   *     the simulated page's press: it moves the simulator's in-memory record
   *     and sends a signed notification through the webhook below, whose
   *     unique indexes make a second press of the same payment a duplicate.
   */
  'POST /public/bookings/:id/checkout',
  'POST /public/bookings/return',
  'POST /webhooks/2c2p/hosted/:attemptId',
  /**
   *   - **the delivery is its own unique key** — `POST /webhooks/2c2p/payment`
   *     (S2-10a). The caller is 2C2P's server and has no account, so the
   *     replay store cannot hold a key for it; what makes a redelivery safe is
   *     `pos.payment_notification`, whose two partial unique indexes are
   *     `(invoice_no, tran_ref)` and `(invoice_no, payment_id)` — the key the
   *     gateway document names. A second delivery of one payment loses the
   *     insert and answers 200 having done nothing, and a delivery carrying
   *     neither reference is refused before the insert rather than written as
   *     often as it arrives. Redelivery is expected here rather than
   *     exceptional: 2C2P publishes no retry schedule.
   */
  'POST /webhooks/2c2p/payment',
];

describe('the idempotency key (SCRUM-291)', () => {
  it('only these mutating routes are outside the replay store', () => {
    const outside = app.routeRegistry
      .filter((r) => MUTATING.has(r.method))
      .filter((r) => r.config.secretResponse || r.config.credential)
      .map((r) => {
        const why = [
          r.config.secretResponse ? 'secretResponse' : '',
          r.config.credential ? `credential:${r.config.credential}` : '',
        ].filter(Boolean);
        return `${r.method} ${r.url} [${why.join(',')}]`;
      })
      .sort();
    expect(
      outside,
      'a mutating route declared secretResponse or credential — it no longer takes an Idempotency-Key, so say so here on purpose',
    ).toEqual(OUTSIDE_THE_REPLAY_STORE.slice().sort());
  });

  it('only these mutating routes can be called without a session (SCRUM-298)', () => {
    const open = app.routeRegistry
      .filter((r) => MUTATING.has(r.method))
      .filter((r) => r.config.public)
      .map((r) => `${r.method} ${r.url}`)
      .sort();
    expect(
      open,
      'a mutating route became open — the replay store cannot hold a key for it, so say in OPEN_WITHOUT_A_KEY what makes a retry safe',
    ).toEqual(OPEN_WITHOUT_A_KEY.slice().sort());
  });

  it('the plugin still claims a key on all four mutating verbs', () => {
    // Every route above depends on this: the plugin decides by METHOD, so a
    // verb dropped from its set silently un-protects every route using it,
    // and no route declaration anywhere would change.
    const plugin = readFileSync(join(API_SRC, 'plugins', 'idempotency.ts'), 'utf8');
    for (const verb of MUTATING) {
      expect(plugin, `plugins/idempotency.ts no longer claims a key on ${verb}`).toContain(
        `'${verb}'`,
      );
    }
  });

  it('every other mutating route that has a session is therefore covered', () => {
    const outside = new Set(
      OUTSIDE_THE_REPLAY_STORE.map((entry) => entry.slice(0, entry.indexOf(' ['))),
    );
    const covered = app.routeRegistry
      .filter((r) => MUTATING.has(r.method))
      .filter((r) => !outside.has(`${r.method} ${r.url}`));
    expect(covered.length).toBeGreaterThan(95);
    // Nothing in `covered` can opt out: the two declarations that would are
    // what put a route on the other list.
    expect(
      covered.filter((r) => r.config.secretResponse || r.config.credential).map((r) => r.url),
    ).toEqual([]);
  });
});
