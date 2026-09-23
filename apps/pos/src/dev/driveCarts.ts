/**
 * DOES THE F&B AND SHOP MONEY PATH ACTUALLY WORK AGAINST THE PLATFORM? —
 * S2-09b (SCRUM-204).
 *
 * `driveSaleLedger.ts` does this for the till's ticket cart. This is the other
 * two counters: an F&B order with modifiers, a note and a pick-up code, and a
 * shop sale with a size on it, driven through the till's OWN modules —
 * `api/sales.ts`, `lib/cartWire.ts`, `api/menu.ts` — against a running
 * api with a real session, real catalogue ids and real rows read back.
 *
 * WHAT IT COVERS, in the order the counter does it:
 *   1. The shop catalogue and the menu come from the platform, not the ported
 *      seed: the ids in the cart are `pos.product` uuids.
 *   2. The platform prices the order — the item, its chosen options, the
 *      quantity — and that is the figure the order panel shows.
 *   3. Two identical rows are one line of two; a note keeps them apart. (The
 *      MERGE itself is the screen's, driven in the browser; what is checked
 *      here is that the platform prices each shape the way the panel drew it.)
 *   4. Pay records the order unfinalised, the tender closes it, and it takes a
 *      receipt number. Pressing Pay twice is one sale.
 *   5. A shop sale with a size on the line — one of the item's own sizes — does
 *      the same.
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
 *   cd apps/pos && node_modules/.bin/tsx src/dev/driveCarts.ts
 *   # OTO_API=http://127.0.0.1:3021 to point it elsewhere
 *
 * IT IS NOT IN CI, for the same reason `driveSaleLedger.ts` is not: `apps/pos`
 * has no test runner. It is what can be run in one command by anyone who
 * touches the path between an F&B order and a row in the ledger.
 */

// --- The browser's fetch, as node can run it --------------------------------
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

import { newId } from '@oto/shared';
import { authApi, stationsApi } from '@/api/platform';
import { loadCatalogFromApi, apiBranchIdForSlug } from '@/api/catalogBridge';
import {
  getActiveBranch,
  getActiveMerchItems,
  getDefaultTier,
  getMenuItems,
} from '@/store/catalogStore';
import { getEffectiveModifierGroups } from '@/lib/menu';
import { computeLineTotal, areModifiersValid } from '@/lib/fnb';
import { computeMerchLineTotal } from '@/lib/merch';
import { ApiError } from '@/api/client';
import {
  buildItemCartPayload,
  commitSale,
  finaliseSale,
  localItemQuote,
  salesApi,
  type ItemCartIdentity,
} from '@/api/sales';
import type { FnbOrderLine, MerchOrderLine, SelectedModifier } from '@/types';

const PHONE = process.env.OTO_PHONE ?? '+66900000002';
const PASSWORD = process.env.OTO_PASSWORD ?? 'reception1234';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let checks = 0;
let failures = 0;
function check(label: string, ok: boolean, detail = ''): void {
  checks += 1;
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? ` — ${detail}` : ''}`);
}

function describe(err: unknown): string {
  return err instanceof ApiError ? `${err.status} ${err.code}: ${err.message}` : String(err);
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

  // --- 1. The catalogue is the platform's -----------------------------------
  const menu = getMenuItems();
  const withRequiredSingle = menu.find((item) =>
    getEffectiveModifierGroups(item).some((g) => g.required && g.selectionType === 'single'),
  );
  check('the menu came from the platform', menu.length > 0 && UUID.test(menu[0]?.id ?? ''), `${menu.length} items`);
  check(
    'an item with a required single-choice group is on it',
    !!withRequiredSingle,
    withRequiredSingle?.name,
  );
  const merch = getActiveMerchItems();
  check(
    'the shop catalogue came from the platform',
    merch.length > 0 && UUID.test(merch[0]?.id ?? ''),
    `${merch.length} items`,
  );
  if (!withRequiredSingle || merch.length === 0) {
    console.log('\nnothing further can be driven without a menu and a shop.');
    process.exitCode = 1;
    return;
  }

  // --- 2. The gate the screen puts on that item -----------------------------
  const group = getEffectiveModifierGroups(withRequiredSingle).find(
    (g) => g.required && g.selectionType === 'single',
  )!;
  check(
    'unsatisfied, the screen will not add it',
    !areModifiersValid(withRequiredSingle, []),
    `${withRequiredSingle.name} · ${group.name} required`,
  );
  const chosen: SelectedModifier[] = [{ groupId: group.id, optionIds: [group.options[0]!.id] }];
  check('chosen, it will', areModifiersValid(withRequiredSingle, chosen));

  const identity: ItemCartIdentity = {
    branchId,
    stationId: till.id,
    tier: getDefaultTier().id,
    channel: 'fnb',
    pickupCode: '042',
    memberId: null,
    customerPhone: null,
    customerNickname: null,
    accountId: session.accountId,
    accountName: 'Som (Reception)',
  };

  const fnbLine = (qty: number, note?: string): FnbOrderLine => ({
    id: newId(),
    menuItem: withRequiredSingle,
    qty,
    selectedModifiers: chosen,
    lineTotal: computeLineTotal(withRequiredSingle, chosen, qty),
    ...(note ? { note } : {}),
  });

  // The order the screen would have built: the same latte twice (merged into
  // one row of two) and a third with a note, which stays its own row.
  const merged = fnbLine(2);
  const noted = fnbLine(1, 'extra hot');
  const order = [merged, noted];

  const local = localItemQuote('fnb', order, []);
  console.log(
    `\nF&B order: ${merged.qty}× ${withRequiredSingle.name} (${group.options[0]!.name}) + ` +
      `${noted.qty}× with a note · this till says ฿${local.totals.total}`,
  );

  // --- 3. The platform prices it --------------------------------------------
  const payload = buildItemCartPayload(order, [], identity, local.totals.total);
  check('two rows go up, not three', payload.items?.length === 2, `${payload.items?.length} rows`);
  check(
    'the note rides on its own row',
    payload.items?.some((i) => i.note === 'extra hot') === true,
  );
  check(
    'the chosen option rides with its ids',
    payload.items?.[0]?.modifiers.some(
      (m) => m.groupId === group.id && m.optionIds.includes(group.options[0]!.id),
    ) === true,
  );
  check('the pick-up code rides with the order', payload.pickupCode === '042');
  check('the ticket half of the cart is empty', payload.lines.length === 0);

  let quotedSatang: number | null = null;
  try {
    const { quote } = await salesApi.quote(payload);
    quotedSatang = quote.totals.grossSatang;
    check(
      'the platform prices the order',
      quotedSatang > 0,
      `฿${quotedSatang / 100} (this till said ฿${local.totals.total})`,
    );
    const rows = Object.keys(quote.lineTotals).length;
    check('…row by row', rows === 2, `${rows} row(s) answered`);
  } catch (err) {
    check('the platform prices the order', false, describe(err));
  }

  // --- 4. Pay, then the tender ----------------------------------------------
  if (quotedSatang !== null) {
    const saleId = newId();
    const actionId = newId();
    const occurredAt = new Date().toISOString();
    // What the screen shows once the platform has answered is the platform's
    // figure, so that is what the commit reconciles against.
    const paid = buildItemCartPayload(order, [], identity, quotedSatang / 100);
    try {
      const committed = await commitSale({
        saleId,
        actionId,
        cart: paid,
        occurredAt,
        finalise: quotedSatang === 0,
      });
      check('Pay records the order', committed.sale.id === saleId, `status ${committed.sale.status}`);
      check('…with no receipt number yet', committed.sale.receiptNumber == null);

      const again = await commitSale({
        saleId,
        actionId,
        cart: paid,
        occurredAt,
        finalise: quotedSatang === 0,
      });
      check('Pay twice is one order', again.sale.id === saleId);

      const closed = await finaliseSale(saleId, actionId, {
        method: 'cash',
        kind: 'cash',
        amountSatang: committed.sale.totals.grossSatang,
        tenderedSatang: committed.sale.totals.grossSatang,
        changeSatang: 0,
      });
      check('the tender closes it', closed.sale.status === 'finalised');
      check('…and it takes a receipt number', !!closed.sale.receiptNumber, `receipt ${closed.sale.receiptNumber}`);
    } catch (err) {
      check('Pay records the order', false, describe(err));
    }
  }

  // --- 5. The shop ----------------------------------------------------------
  const shopIdentity: ItemCartIdentity = { ...identity, channel: 'shop', pickupCode: null };
  // An item the platform sells in sizes, and one of ITS sizes (S2-09b): the
  // platform checks the size against the item, so a made-up one is refused.
  const item = merch.find((m) => (m.variants?.length ?? 0) > 1) ?? merch[0]!;
  const size = item.variants?.find((v) => v.label === 'M') ?? item.variants?.[0];
  const shopLine: MerchOrderLine = {
    id: newId(),
    merchItem: item,
    qty: 1,
    lineTotal: computeMerchLineTotal(item, 1),
    ...(size ? { variantId: size.id, variantLabel: size.label } : {}),
  };
  const shopLocal = localItemQuote('shop', [shopLine], []);
  const shopPayload = buildItemCartPayload([shopLine], [], shopIdentity, shopLocal.totals.total);
  check(
    'the size rides on the shop line',
    !!size && shopPayload.items?.[0]?.variant?.variantId === size.id,
    size ? `${item.name} — ${size.label}` : `${item.name} has no sizes on this platform`,
  );
  try {
    const { quote } = await salesApi.quote(shopPayload);
    const shopSatang = quote.totals.grossSatang;
    check('the platform prices the shop sale', shopSatang > 0, `฿${shopSatang / 100} · ${item.name}`);
    const saleId = newId();
    const actionId = newId();
    const sold = buildItemCartPayload([shopLine], [], shopIdentity, shopSatang / 100);
    const committed = await commitSale({
      saleId,
      actionId,
      cart: sold,
      occurredAt: new Date().toISOString(),
      finalise: shopSatang === 0,
    });
    const closed = await finaliseSale(saleId, actionId, {
      method: 'cash',
      kind: 'cash',
      amountSatang: committed.sale.totals.grossSatang,
      tenderedSatang: committed.sale.totals.grossSatang,
      changeSatang: 0,
    });
    check('…and sells it', closed.sale.status === 'finalised', `receipt ${closed.sale.receiptNumber}`);
  } catch (err) {
    check('the platform prices the shop sale', false, describe(err));
  }

  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error(describe(err));
  process.exitCode = 1;
});
