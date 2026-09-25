/**
 * DOES THE TILL'S MONEY PATH ACTUALLY WORK AGAINST THE PLATFORM? — S2-09a
 * (SCRUM-203).
 *
 * `checkCartPricing.ts` proves the arithmetic. This proves the SEAM: the till's
 * own modules — `api/sales.ts`, `lib/cartWire.ts`, the cart payload builder —
 * driven against a running api with a real session, real catalogue ids and real
 * rows read back. Five tickets on this project shipped a service with no
 * caller; the way that is not repeated is by driving the caller.
 *
 * WHAT IT COVERS, in the order the counter till does it:
 *   1. Pay records the sale, UNFINALISED — `tendering`, no receipt number.
 *   2. Pressing Pay again for the same cart is the same sale, not a second one.
 *   3. The tender closes it: `finalised`, with a receipt number.
 *   4. Closing twice takes no second number from the station's series.
 *   5. A CORRECTED cart under the old sale number is refused for ever
 *      (`IDEMPOTENCY_MISMATCH`) — which is why the till mints a new number when
 *      the cart changes, and does not when it has not. Both halves are driven.
 *   6. A ฿0 comp commits and finalises in the one call.
 *
 * HOW TO RUN IT:
 *
 *   # a database of its own, so nothing anybody else is using is written to
 *   docker exec oto-platform-postgres-1 psql -U oto -d postgres \
 *     -c "create database oto_drive owner oto;"
 *   DATABASE_URL=postgres://oto:oto@localhost:5433/oto_drive pnpm db:migrate
 *   DATABASE_URL=postgres://oto:oto@localhost:5433/oto_drive pnpm db:seed
 *   DATABASE_URL=postgres://oto:oto@localhost:5433/oto_drive API_PORT=3021 \
 *     pnpm --filter @oto/api start
 *
 *   cd apps/pos && node_modules/.bin/tsx src/dev/driveSaleLedger.ts
 *   # OTO_API=http://127.0.0.1:3021 to point it elsewhere
 *
 * IT IS NOT IN CI. `apps/pos` has a unit runner now (vitest, `apps/pos/test`,
 * SCRUM-408), and `test/sale-writer.test.ts` pins the writer's rules with the
 * platform's answers given by the test; this drive needs a running api on a
 * seeded database, so it stays what can be run in one command by anyone who
 * touches the path between Pay and a row in the ledger.
 */

// --- The browser's fetch, as node can run it --------------------------------
// The till calls `/api/...` and the Vite dev server proxies it. Here the same
// calls go straight to the api, and the session cookie is carried by hand
// because there is no browser to keep the jar.
const API = process.env.OTO_API ?? 'http://127.0.0.1:3021';
let cookie = '';
const realFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = typeof input === 'string' ? input : input.toString();
  const url = path.startsWith('/api') ? `${API}${path.slice(4)}` : path;
  const headers = new Headers(init?.headers);
  if (cookie) headers.set('cookie', cookie);
  const res = await realFetch(url, { ...init, headers });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0]!;
  return res;
}) as typeof fetch;

import { authApi, stationsApi } from '@/api/platform';
import { loadCatalogFromApi, apiBranchIdForSlug } from '@/api/catalogBridge';
import { getActiveBranch, getTicketTypes, getDefaultTier } from '@/store/catalogStore';
import { computeLineTotal } from '@/lib/pricing';
import { todayRateMode } from '@/lib/pricingMode';
import {
  buildCartPayload,
  commitSale,
  finaliseSale,
  localQuote,
  quotedPricing,
  salesApi,
  type CartIdentity,
  type SaleCartPayload,
} from '@/api/sales';
import { ApiError } from '@/api/client';
import { newId } from '@oto/shared';
import type { CartLine, ManualDiscount } from '@/types';

const PHONE = process.env.OTO_PHONE ?? '+66900000002';
const PASSWORD = process.env.OTO_PASSWORD ?? 'reception1234';

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function main(): Promise<void> {
  const session = await authApi.signIn(PHONE, PASSWORD);
  console.log(`signed in as ${PHONE} (account ${session.accountId})`);

  await loadCatalogFromApi();
  const branch = getActiveBranch();
  const branchId = apiBranchIdForSlug(branch.id);
  const { stations } = await stationsApi.mine();
  const till = stations.find((s) => s.kind === 'till') ?? stations[0];
  if (!branchId || !till) throw new Error('no branch or station for this account');
  console.log(`branch ${branch.name} (${branchId}) · station ${till.name} (${till.id})`);

  const tier = getDefaultTier().id;
  const tickets = getTicketTypes().filter((t) => (t.prices[tier]?.weekday ?? 0) > 0);
  const ticket = tickets[0];
  if (!ticket) throw new Error('no priced ticket package in the catalogue');

  const identity: CartIdentity = {
    branchId,
    stationId: till.id,
    tier,
    memberId: null,
    customerPhone: null,
    customerNickname: null,
    accountId: session.accountId,
    accountName: 'Som (Reception)',
  };

  // Which rows were already there, so a second run of this script counts its
  // own sales rather than the last run's.
  const before = new Set((await salesApi.list({ branchId, limit: 200 })).sales.map((s) => s.id));

  const rate = todayRateMode();
  const makeCart = (kids: number, adults: number, socks: number, manual: ManualDiscount[] = []) => {
    const base = { ticketType: ticket, tier, kids, adults, socks, addOns: [] };
    const line = { id: newId(), ...base, lineTotal: computeLineTotal(base) } as CartLine;
    const quote = localQuote([line], [], manual);
    if (!quote.satang) throw new Error('the engine would not price this cart');
    const payload = buildCartPayload([line], [], manual, identity, quote.satang, {
      mode: quote.pricingMode,
      modeReason: quote.pricingModeReason,
    });
    return { line, quote, payload, satang: quote.satang.total };
  };

  // --- 1. Pay records the sale, unfinalised ---------------------------------
  const cart = makeCart(2, 2, 2);
  console.log(
    `\ncart: ${ticket.name} · 2 kids + 2 adults + 2 socks · ${rate.mode} · ฿${cart.quote.totals.total} (${cart.satang} satang)`,
  );

  const saleId = newId();
  const actionId = newId();
  const occurredAt = new Date().toISOString();
  const pay = async (id: string, act: string, when: string, body: SaleCartPayload, zero: boolean) =>
    commitSale({ saleId: id, actionId: act, cart: body, occurredAt: when, finalise: zero });

  const committed = await pay(saleId, actionId, occurredAt, cart.payload, false);
  check('Pay records the sale', committed.sale.id === saleId, `id ${committed.sale.id}`);
  check('…in tendering', committed.sale.status === 'tendering', `status ${committed.sale.status}`);
  check('…with no receipt number', committed.sale.receiptNumber == null);
  check(
    '…at the quoted price',
    committed.sale.totals.grossSatang === cart.satang,
    `${committed.sale.totals.grossSatang} satang`,
  );

  // --- 2. The same press again is the same sale -----------------------------
  // The `replay` flag in the body says whether the SERVICE found the sale
  // already written. Through the idempotency store it does not get that far:
  // the first answer is returned verbatim, flag and all, and the proof of one
  // sale is the id — and the count read back at the end.
  const again = await pay(saleId, actionId, occurredAt, cart.payload, false);
  check('Pay twice is one sale', again.sale.id === saleId, `id ${again.sale.id}`);

  // --- 3. The tender closes it ----------------------------------------------
  const tender = {
    method: 'cash',
    kind: 'cash' as const,
    amountSatang: committed.sale.totals.grossSatang,
    tenderedSatang: committed.sale.totals.grossSatang,
    changeSatang: 0,
  };
  let receipt: string | null = null;
  try {
    const closed = await finaliseSale(saleId, actionId, tender);
    receipt = closed.sale.receiptNumber ?? null;
    check('the tender finalises it', closed.sale.status === 'finalised', `status ${closed.sale.status}`);
    check('…and it takes a receipt number', !!receipt, `receipt ${receipt}`);

    // --- 4. Closing twice takes no second number ----------------------------
    const twice = await finaliseSale(saleId, actionId, tender);
    check(
      'finalising twice keeps the one number',
      twice.sale.receiptNumber === receipt,
      `receipt ${twice.sale.receiptNumber}`,
    );
  } catch (err) {
    check(
      'the tender finalises it',
      false,
      err instanceof ApiError ? `${err.status} ${err.code}: ${err.message}` : String(err),
    );
  }

  // --- 5. A corrected cart cannot go under the old number -------------------
  const corrected = makeCart(3, 2, 2);
  let mismatched = false;
  try {
    await pay(saleId, actionId, occurredAt, corrected.payload, false);
  } catch (err) {
    mismatched = err instanceof ApiError && err.status === 409 && err.code === 'IDEMPOTENCY_MISMATCH';
    if (!mismatched) console.log(`  (corrected cart under the old number answered: ${String(err)})`);
  }
  check('a corrected cart under the old number is refused', mismatched);

  const reSaleId = newId();
  const reActionId = newId();
  const recommitted = await pay(reSaleId, reActionId, new Date().toISOString(), corrected.payload, false);
  check(
    '…and goes through under a new one',
    recommitted.sale.id === reSaleId && recommitted.sale.totals.grossSatang === corrected.satang,
    `฿${corrected.quote.totals.total} · ${recommitted.sale.status}`,
  );
  try {
    await finaliseSale(reSaleId, reActionId, {
      ...tender,
      amountSatang: recommitted.sale.totals.grossSatang,
      tenderedSatang: recommitted.sale.totals.grossSatang,
    });
  } catch {
    /* reported by the first finalise check; this one only tidies the row */
  }

  // --- 6. A ฿0 comp commits and finalises in one call -----------------------
  const compReason = 'Owner comp';
  const comped = makeCart(1, 1, 0, [
    {
      id: newId(),
      scope: 'order',
      type: 'comp',
      value: 0,
      amountTHB: 0,
      reason: compReason,
      appliedBy: 'Som (Reception)',
      appliedById: session.accountId,
      appliedAt: new Date().toISOString(),
    } as ManualDiscount,
  ]);
  const compId = newId();
  const comp = await pay(compId, newId(), new Date().toISOString(), comped.payload, comped.satang === 0);
  check('a ฿0 comp is quoted at ฿0', comped.satang === 0, `${comped.satang} satang`);
  check('…and finalises on Pay', comp.sale.status === 'finalised', `status ${comp.sale.status}`);
  check('…with a receipt number', !!comp.sale.receiptNumber, `receipt ${comp.sale.receiptNumber}`);

  // --- and the rows, read back ----------------------------------------------
  const { sale } = await salesApi.get(saleId);
  check('the sale reads back', sale.id === saleId, `${sale.status} · ${sale.receiptNumber ?? 'no number'}`);
  const carried = quotedPricing(cart.quote, sale);
  check(
    'the figures a receipt would print are the ledger’s',
    carried.total === sale.totals.grossSatang / 100,
    `฿${carried.total} from ${carried.source}`,
  );
  const { sales } = await salesApi.list({ branchId, limit: 200 });
  const mine = sales.filter((s) => !before.has(s.id));
  const atFirstCart = mine.filter((s) => s.totals.grossSatang === cart.satang).length;
  check('two presses left one row', atFirstCart === 1, `${atFirstCart} row(s) at ${cart.satang} satang`);
  console.log(
    `\n${mine.length} sale(s) written by this run: ` +
      mine.map((s) => `${s.receiptNumber ?? '—'} ${s.status} ฿${s.totals.grossSatang / 100}`).join(', '),
  );

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof ApiError ? `${err.status} ${err.code}: ${err.message}` : err);
  process.exitCode = 1;
});
