/**
 * CAN A DISCOUNTED WALK-IN BE SOLD AT ALL? — SCRUM-310 (the phone till's half
 * of SCRUM-307).
 *
 * The counter till learned to record reception's document check as a CLAIM
 * before anything is priced (`api/sales.ts:claimVerifiedTier`). The phone till
 * did not: `MobileTill` built its cart identity with no `tierClaimActionId` and
 * its `handleVerified` recorded nothing, so the platform priced the cart at the
 * operator's default while the screen showed the Expat rate, and Pay came back
 * `SALE_LINE_PRICE_MISMATCH`. No Expat or Thai walk-in could be completed on a
 * handheld.
 *
 * WHAT THIS DRIVES, in the order a member of staff does it:
 *   1. WITHOUT a claim, an Expat cart is refused — the defect, planted, so the
 *      thing this ticket fixes stays visible after the fix.
 *   2. Recording the document check answers with a claim id.
 *   3. WITH that id on the cart, the same lines commit, and the sale the
 *      platform holds says `customerTier: expat`.
 *   4. A claim made for one sale does not price another cart — naming somebody
 *      else's action id resolves to nothing and the cart is priced at the
 *      default, which is the refusal in step 1 again.
 *
 * It exercises `api/sales.ts`, the module `MobileTill` calls. What it cannot
 * exercise is the React state around it — that the claim id reaches the cart
 * and is cleared on Cancel — which is why this ticket was also driven in a
 * browser at a phone viewport; see the Jira evidence.
 *
 * HOW TO RUN IT:
 *
 *   # a database of its own, so nothing anybody else is using is written to
 *   docker exec oto-platform-postgres-1 psql -U oto -d postgres \
 *     -c "create database oto_s310 owner oto;"
 *   DATABASE_URL=postgres://oto:oto@localhost:5433/oto_s310 pnpm db:migrate
 *   DATABASE_URL=postgres://oto:oto@localhost:5433/oto_s310 pnpm db:seed
 *   DATABASE_URL=postgres://oto:oto@localhost:5433/oto_s310 API_PORT=3047 \
 *     pnpm --filter @oto/api start
 *
 *   cd apps/pos && node_modules/.bin/tsx src/dev/driveTierClaim.ts
 *   # OTO_API=http://127.0.0.1:3047 to point it elsewhere
 *
 * IT IS NOT IN CI. `apps/pos` has no test runner — giving it one is its own
 * ticket — so this is what can be run in one command by anyone who touches the
 * path between a checked passport and the price a visitor pays.
 */

// --- The browser's fetch, as node can run it --------------------------------
// The till calls `/api/...` and the Vite dev server proxies it. Here the same
// calls go straight to the api, and the session cookie is carried by hand
// because there is no browser to keep the jar. (Same preamble as
// `driveSaleLedger.ts`, and for the same reason.)
const API = process.env.OTO_API ?? 'http://127.0.0.1:3047';
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
import { getActiveBranch, getTicketTypes } from '@/store/catalogStore';
import { computeLineTotal } from '@/lib/pricing';
import {
  buildCartPayload,
  claimVerifiedTier,
  commitSale,
  localQuote,
  salesApi,
  type CartIdentity,
} from '@/api/sales';
import { ApiError } from '@/api/client';
import { newId } from '@oto/shared';
import type { CartLine, CustomerTier } from '@/types';

const PHONE = process.env.OTO_PHONE ?? '+66900000002';
const PASSWORD = process.env.OTO_PASSWORD ?? 'reception1234';
/** The tier the phone till could not sell. Any non-default tier shows it. */
const TIER = (process.env.OTO_TIER ?? 'expat') as CustomerTier;

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

/** The refusal the phone till hit on every discounted walk-in. */
function priceMismatch(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'SALE_LINE_PRICE_MISMATCH';
}

/** `YYYY-MM-DD`, a year out — a document that has not expired. */
function nextYear(): string {
  const at = new Date();
  at.setUTCFullYear(at.getUTCFullYear() + 1);
  return at.toISOString().slice(0, 10);
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

  const ticket = getTicketTypes().find(
    (t) => (t.prices[TIER]?.weekday ?? 0) > 0 && (t.prices[TIER]?.weekday ?? 0) !== (t.prices.tourist?.weekday ?? 0),
  );
  if (!ticket) throw new Error(`no package priced differently at the ${TIER} rate`);
  console.log(
    `ticket ${ticket.name} · ${TIER} ฿${ticket.prices[TIER]?.weekday} vs tourist ฿${ticket.prices.tourist?.weekday}`,
  );

  // One walk-in: a kid and an adult on the discounted rate, exactly the cart
  // the phone till builds after a passport is checked.
  const makeCart = (claimActionId: string | null) => {
    const base = { ticketType: ticket, tier: TIER, kids: 1, adults: 1, socks: 0, addOns: [] };
    const line = { id: newId(), ...base, lineTotal: computeLineTotal(base) } as CartLine;
    const quote = localQuote([line], [], []);
    if (!quote.satang) throw new Error('the engine would not price this cart');
    const identity: CartIdentity = {
      branchId,
      stationId: till.id,
      tier: TIER,
      tierClaimActionId: claimActionId,
      memberId: null,
      customerPhone: null,
      customerNickname: null,
      accountId: session.accountId,
      accountName: 'Som (Reception)',
    };
    return {
      payload: buildCartPayload([line], [], [], identity, quote.satang, {
        mode: quote.pricingMode,
        modeReason: quote.pricingModeReason,
      }),
      satang: quote.satang.total,
    };
  };

  // --- 1. The defect, planted: no claim, no sale ----------------------------
  const unclaimed = makeCart(null);
  let refused: unknown = null;
  try {
    await commitSale({
      saleId: newId(),
      actionId: newId(),
      cart: unclaimed.payload,
      occurredAt: new Date().toISOString(),
      finalise: false,
    });
  } catch (err) {
    refused = err;
  }
  check(
    `a ${TIER} walk-in with no claim is refused`,
    priceMismatch(refused),
    refused instanceof ApiError ? `${refused.status} ${refused.code}` : String(refused),
  );

  // --- 2. The document check, recorded ---------------------------------------
  const claimActionId = await claimVerifiedTier({
    branchId,
    tier: TIER,
    proofType: 'Passport',
    expiresAt: nextYear(),
  });
  check('the document check records a claim', !!claimActionId, `action ${claimActionId}`);

  // --- 3. The same cart, naming it, goes through ----------------------------
  const claimed = makeCart(claimActionId);
  const saleId = newId();
  const committed = await commitSale({
    saleId,
    actionId: newId(),
    cart: claimed.payload,
    occurredAt: new Date().toISOString(),
    finalise: false,
  });
  check('…and goes through when the cart names it', committed.sale.id === saleId);
  check(
    `…priced at the ${TIER} rate`,
    committed.sale.customerTier === TIER,
    `customerTier ${committed.sale.customerTier}`,
  );
  check(
    '…for the money the screen showed',
    committed.sale.totals.grossSatang === claimed.satang,
    `${committed.sale.totals.grossSatang} vs ${claimed.satang} satang`,
  );

  const { sale } = await salesApi.get(saleId);
  check(
    'the row the platform holds says the same',
    sale.customerTier === TIER,
    `${sale.status} · customerTier ${sale.customerTier}`,
  );

  // --- 4. A claim id nobody made prices nothing ------------------------------
  // The till clears its claim on Cancel; this is the other half of that rule —
  // an id the platform never wrote resolves to no claim at all, so the cart
  // falls back to the default rate and is refused exactly as in step 1.
  const invented = makeCart(newId());
  let inventedRefused: unknown = null;
  try {
    await commitSale({
      saleId: newId(),
      actionId: newId(),
      cart: invented.payload,
      occurredAt: new Date().toISOString(),
      finalise: false,
    });
  } catch (err) {
    inventedRefused = err;
  }
  check(
    'an action id nobody claimed prices nothing',
    priceMismatch(inventedRefused),
    inventedRefused instanceof ApiError
      ? `${inventedRefused.status} ${inventedRefused.code}`
      : String(inventedRefused),
  );

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(err instanceof ApiError ? `${err.status} ${err.code}: ${err.message}` : err);
  process.exitCode = 1;
});
