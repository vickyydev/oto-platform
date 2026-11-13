import {
  PARTY_PLAN_LINE_QTY_MAX,
  newId,
  type PartyKitchenChange,
  type PartyKitchenPlan,
  type PartyMenuOrigin,
} from '@oto/shared';
import { partyCakeOf } from './partyKitchen';

/**
 * SCRUM-907 — THE PARTY EDIT FORM'S KITCHEN SECTION, FROM THE PLAN THE TILL
 * READS (SCRUM-906), AND WHAT A MANAGER CHANGED IN IT.
 *
 * The form keeps a draft of the plan's lines; Save sends only what differs
 * from the plan it opened with, each change naming the BEO line by its own id
 * (`PartyKitchenChange`). What the till may change, as the owner's decision 7
 * and the BEO allow it:
 *
 *   - a line's count and its note, on a line the BEO holds (one with an id);
 *   - an EXTRA removed (a set-menu dish comes back from the template, so it is
 *     not removed from the till);
 *   - a line added, picked from the till's menu (its name and code) or typed;
 *   - a set-menu choice within its group: on the line that holds it, or on an
 *     open group no line holds yet;
 *   - the cake's time and note.
 *
 * Never a price: where an EXTRA's price is entered is the owner's open
 * question (SCRUM-949).
 */

export type KitchenDraftList = 'food' | 'bar';

export interface KitchenDraftLine {
  /** The row's own key: the BEO line's id, or one the form made. */
  key: string;
  list: KitchenDraftList;
  /** The BEO line's id; null for a set-menu dish no BEO line holds yet, and for a line added here. */
  lineId: string | null;
  name: string;
  productCode: string | null;
  /** Null when the plan prints no count (a choice split over several dishes). */
  qty: number | null;
  note: string;
  origin: PartyMenuOrigin | null;
  choiceGroup: string | null;
  chosenOption: string | null;
  /** Whether a live till product carries its code (the plan's "not on the till menu"). */
  onTillMenu: boolean | null;
  /** The adults' marks the plan carries, shown beside the line as the party page shows them. */
  audience: 'kids' | 'adults' | null;
  /** A line added on this form: the id it is sent under. */
  added: string | null;
  removed: boolean;
}

export interface KitchenDraft {
  lines: KitchenDraftLine[];
  /** The cake's time and note as the form holds them; null when the BEO says no cake. */
  cake: { time: string; note: string } | null;
}

const lineKey = (list: KitchenDraftList, lineId: string | null | undefined, at: number) =>
  lineId ? `${list}:${lineId}` : `${list}:place-${at}`;

/** The plan as the form's draft. */
export function kitchenDraftOf(plan: Pick<PartyKitchenPlan, 'setMenu' | 'barItems' | 'cake'>): KitchenDraft {
  return {
    lines: [
      ...plan.setMenu.map((m, i): KitchenDraftLine => ({
        key: lineKey('food', m.lineId, i),
        list: 'food',
        lineId: m.lineId ?? null,
        name: m.name,
        productCode: m.productCode,
        qty: m.qty,
        note: m.note ?? '',
        origin: m.origin ?? null,
        choiceGroup: m.choiceGroup,
        chosenOption: m.chosenOption,
        onTillMenu: m.onTillMenu ?? null,
        audience: m.audience ?? null,
        added: null,
        removed: false,
      })),
      ...plan.barItems.map((b, i): KitchenDraftLine => ({
        key: lineKey('bar', b.lineId, i),
        list: 'bar',
        lineId: b.lineId ?? null,
        name: b.name,
        productCode: b.productCode,
        qty: b.qty,
        note: b.note ?? '',
        origin: b.origin ?? null,
        choiceGroup: null,
        chosenOption: null,
        onTillMenu: b.onTillMenu ?? null,
        audience: null,
        added: null,
        removed: false,
      })),
    ],
    cake: plan.cake ? { time: plan.cake.time ?? '', note: plan.cake.note ?? '' } : null,
  };
}

/** A line the till may change the count and note of: one the BEO holds by its id. */
export const kitchenLineEditable = (l: KitchenDraftLine): boolean => !!l.lineId || !!l.added;

/** A line the till may remove: an EXTRA (or one made for the party alone) the BEO holds, or one added here. */
export const kitchenLineRemovable = (l: KitchenDraftLine): boolean =>
  !!l.added || (!!l.lineId && l.origin !== null && l.origin !== 'set_menu');

/** A set-menu choice the till may change: a group's line, or an open group no line holds. */
export const kitchenLineChoosable = (l: KitchenDraftLine): boolean => !!l.choiceGroup && !l.added;

/**
 * Whether the plan gives the kitchen anything to make: a food line or a cake. The party page's own
 * reading of the plan (SCRUM-906, `withPartyKitchen`); the BEO's "kitchen required" switch itself is
 * not in the plan the till reads.
 */
export const kitchenServiceNeeded = (plan: Pick<PartyKitchenPlan, 'setMenu' | 'cake'>): boolean =>
  plan.setMenu.length > 0 || partyCakeOf(plan).type !== 'none';

/**
 * A choice group's options as the form's picker offers them: the template's, and first the dish the
 * BEO saved when the template no longer lists it, shown but not picked again (`saved`).
 */
export function kitchenChoiceOptions(options: readonly string[], chosen: string | null): Array<{ value: string; saved: boolean }> {
  const listed = options.map((value) => ({ value, saved: false }));
  return chosen && !options.includes(chosen) ? [{ value: chosen, saved: true }, ...listed] : listed;
}

/** A new line for the draft: a till item (its name and code) or a typed name. */
export function addedKitchenLine(list: KitchenDraftList, item: { name: string; code: string | null } = { name: '', code: null }): KitchenDraftLine {
  const id = newId();
  return {
    key: `${list}:new-${id}`,
    list,
    lineId: null,
    name: item.name,
    productCode: item.code,
    qty: 1,
    note: '',
    origin: 'extra',
    choiceGroup: null,
    chosenOption: null,
    onTillMenu: item.code ? true : false,
    audience: null,
    added: id,
    removed: false,
  };
}

const clampQty = (q: number) => Math.min(PARTY_PLAN_LINE_QTY_MAX, Math.max(1, Math.round(q)));
const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim() === (b ?? '').trim();

/**
 * What Save sends: only what differs from the plan the form opened with, in
 * the plan's order — the changes to the lines it holds, then the lines added,
 * then the cake. An added line with no name is not sent.
 */
export function kitchenChangesOf(
  plan: Pick<PartyKitchenPlan, 'setMenu' | 'barItems' | 'cake'>,
  draft: KitchenDraft,
): PartyKitchenChange[] {
  const before = kitchenDraftOf(plan);
  const byKey = new Map(draft.lines.map((l) => [l.key, l]));
  const changes: PartyKitchenChange[] = [];
  for (const was of before.lines) {
    const now = byKey.get(was.key);
    if (!now) continue;
    if (now.removed) {
      if (kitchenLineRemovable(was)) changes.push({ op: 'remove', lineId: was.lineId! });
      continue;
    }
    if (was.choiceGroup && now.chosenOption && !same(now.chosenOption, was.chosenOption)) {
      changes.push({ op: 'choose', choiceGroup: was.choiceGroup, lineId: was.lineId, option: now.chosenOption.trim() });
    }
    if (!was.lineId) continue;
    const qtyChanged = now.qty !== null && was.qty !== null && clampQty(now.qty) !== was.qty;
    const noteChanged = !same(now.note, was.note);
    if (qtyChanged || noteChanged) {
      changes.push({
        op: 'set',
        lineId: was.lineId,
        ...(qtyChanged ? { qty: clampQty(now.qty!) } : {}),
        ...(noteChanged ? { note: now.note.trim() || null } : {}),
      });
    }
  }
  for (const l of draft.lines) {
    if (!l.added || l.removed || !l.name.trim()) continue;
    changes.push({
      op: 'add',
      id: l.added,
      list: l.list,
      name: l.name.trim(),
      productCode: l.productCode?.trim() || null,
      qty: clampQty(l.qty ?? 1),
      ...(l.note.trim() ? { note: l.note.trim() } : {}),
    });
  }
  if (before.cake && draft.cake) {
    const timeChanged = !same(draft.cake.time, before.cake.time);
    const noteChanged = !same(draft.cake.note, before.cake.note);
    if (timeChanged || noteChanged) {
      changes.push({
        op: 'cake',
        ...(timeChanged ? { time: draft.cake.time.trim() || null } : {}),
        ...(noteChanged ? { note: draft.cake.note.trim() || null } : {}),
      });
    }
  }
  return changes;
}

/** A till menu item the picker offers: its name and code. */
export interface KitchenMenuPick {
  name: string;
  code: string;
}

/** The till's items a search finds, by name or code, the closest first; at most `limit`. */
export function kitchenMenuMatches<T extends KitchenMenuPick>(items: readonly T[], search: string, limit = 6): T[] {
  const q = search.trim().toLowerCase();
  if (!q) return [];
  const score = (it: T) => {
    const name = it.name.toLowerCase();
    const code = it.code.toLowerCase();
    if (name === q || code === q) return 4;
    if (name.startsWith(q) || code.startsWith(q)) return 3;
    if (name.split(/\s+/).some((w) => w.startsWith(q))) return 2;
    return name.includes(q) || code.includes(q) ? 1 : 0;
  };
  return items
    .map((it, at) => ({ it, at, s: score(it) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || a.at - b.at)
    .slice(0, limit)
    .map((r) => r.it);
}

/** SCRUM-967 — the one thing to do when the BEO moved under the Edit form. */
export const KITCHEN_READ_AGAIN_ASK = 'Close this form and open it again to see the latest plan.';

/**
 * SCRUM-967 — THE OTO APP'S REFUSAL WHEN THE BEO MOVED UNDER THE FORM, IN THE
 * TILL'S WORDS. The app names the line it no longer finds by its internal id
 * ("… since the till read it (menu_17…). Read the party again and make the
 * change once more.", `line_not_found`), and the till added an instruction of
 * its own. The till's copy of the plan knows that line: it says the dish, and
 * one thing to do. A line it does not know is said as a line of the kitchen
 * plan, never by its id. Any other such refusal (a choice made in the BEO) keeps
 * the app's own first sentence, with the same one thing to do.
 */
export function kitchenReadAgainSaid(
  refusal: { code?: string; message: string },
  plan: Pick<PartyKitchenPlan, 'setMenu' | 'barItems'> | null,
): string {
  if (refusal.code === 'OTOAPP_LINE_NOT_FOUND') {
    const lines: Array<{ lineId?: string | null; name: string }> = [...(plan?.setMenu ?? []), ...(plan?.barItems ?? [])];
    const known = lines.find((l) => !!l.lineId && refusal.message.includes(`(${l.lineId})`));
    const what = known?.name.trim() ? known.name.trim() : 'A line of the kitchen plan';
    return `${what} was changed in the BEO since this form opened. ${KITCHEN_READ_AGAIN_ASK}`;
  }
  const first = refusal.message.split(/(?<=\.)\s+/)[0]?.trim() || refusal.message;
  return `${first} ${KITCHEN_READ_AGAIN_ASK}`;
}
