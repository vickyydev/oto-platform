import { and, asc, eq, isNotNull, isNull, or } from 'drizzle-orm';
import { branch, product, productCategory, type Db } from '@oto/db';
import type { PartyMenuCatalogueAnswer, PartyMenuCatalogueItem } from '@oto/shared';
import { errors } from '../lib/errors';
import { effectivePrepStation, type CategoryRow } from './menu';

/**
 * SCRUM-905 — THE TILL'S FOOD AND DRINK, for the BEO's kitchen and bar plan.
 *
 * The OTO App's server asks with its provisioning key (`GET
 * /otoapp/party-menu/catalogue?branchId=`, `routes/otoapp-party-menu.ts`), so
 * the operator is the key's and the branch must be one of that operator's live
 * branches; another operator's branch is not found. It answers what a BEO line
 * can be matched to: the branch's own items and the operator-wide ones (an
 * item's `branch_id` null, the menu read's own scope, `readMenu`) that are
 *
 *   - menu items (`kind` menu: never merch or a ticket add-on);
 *   - not archived and on sale (`active`): an item withdrawn from the till is
 *     not offered to a party, and a line still carrying its code is the one
 *     the BEO marks "No longer on the till";
 *   - coded: a BEO line is matched to the till by its code (the party's plan,
 *     its slips and its settlement find the product by it), so an item with no
 *     code could be named but never found;
 *   - made at the kitchen or the bar, by the same walk the till's own prep
 *     slips take (`effectivePrepStation`: the item's station, else its
 *     category's, else the parent's, else the kitchen).
 *
 * The BEO-only items the BEO made for a party (SCRUM-828) are included,
 * flagged, as the Console's menu read includes them on request. Read only:
 * nothing is written and nothing is audited.
 */
export async function readPartyMenuCatalogue(
  db: Db,
  input: { operatorId: string; branchId: string },
): Promise<PartyMenuCatalogueAnswer> {
  const [br] = await db
    .select({ id: branch.id })
    .from(branch)
    .where(and(eq(branch.id, input.branchId), eq(branch.operatorId, input.operatorId), isNull(branch.archivedAt)))
    .limit(1);
  if (!br) throw errors.notFound('Branch not found');

  // Every category of the operator, archived ones too: an item's station walks
  // its category and that category's parent, whatever became of them.
  const categories: CategoryRow[] = await db
    .select()
    .from(productCategory)
    .where(eq(productCategory.operatorId, input.operatorId));
  const items = await db
    .select()
    .from(product)
    .where(
      and(
        eq(product.operatorId, input.operatorId),
        or(eq(product.branchId, input.branchId), isNull(product.branchId)),
        eq(product.kind, 'menu'),
        isNull(product.archivedAt),
        eq(product.active, true),
        isNotNull(product.code),
      ),
    )
    .orderBy(asc(product.sortOrder), asc(product.name));

  const byId = new Map(categories.map((c) => [c.id, c]));
  /** A category's place in the menu: its parent's order first, then its own. */
  const placeOf = (categoryId: string | null): [number, number] => {
    const own = categoryId ? byId.get(categoryId) : undefined;
    if (!own) return [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER];
    const parent = own.parentId ? byId.get(own.parentId) : undefined;
    return parent ? [parent.sortOrder, own.sortOrder] : [own.sortOrder, -1];
  };

  const answered: Array<PartyMenuCatalogueItem & { place: [number, number]; sortOrder: number }> = [];
  for (const item of items) {
    const code = item.code?.trim();
    if (!code) continue;
    const station = effectivePrepStation(item, categories);
    if (station !== 'kitchen' && station !== 'bar') continue;
    const own = item.categoryId ? byId.get(item.categoryId) : undefined;
    const parent = own?.parentId ? byId.get(own.parentId) : undefined;
    answered.push({
      code,
      name: item.name,
      category: own?.name ?? null,
      parentCategory: parent?.name ?? null,
      station,
      priceSatang: item.priceSatang,
      priceWeekendSatang: item.priceWeekendSatang ?? item.priceSatang,
      beoOnly: item.beoOnly,
      place: placeOf(item.categoryId),
      sortOrder: item.sortOrder,
    });
  }
  answered.sort(
    (a, b) =>
      a.place[0] - b.place[0] ||
      a.place[1] - b.place[1] ||
      a.sortOrder - b.sortOrder ||
      a.name.localeCompare(b.name),
  );
  return {
    branchId: br.id,
    items: answered.map(({ place: _place, sortOrder: _sortOrder, ...item }) => item),
  };
}
