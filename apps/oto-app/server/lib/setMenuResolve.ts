/**
 * A set menu's choices as the kitchen plan's lines: the parent link's submit
 * (`POST /api/beo/set-menu-selections/public/:token/submit`) and the BEO AI
 * Fill's approval (SCRUM-815) write the same lines from the same template and
 * choices, so the kitchen plan reads one way whoever chose.
 */

export interface SetMenuChoice {
  groupId: string;
  chosenOptions: string[];
}

export type ResolvedSetMenuLine = {
  id: string;
  itemName: string;
  quantity: number;
  notes: string;
  included: true;
  price: 0;
  source: "set_menu";
  groupId: string;
};

/**
 * Every item the template always includes, and each choice group's chosen
 * options. A set menu that names its portions (SCRUM-803: "French Fries x3")
 * gives the kitchen plan that quantity; one that names none stays at 1.
 */
export function resolveSetMenuLines(templateItems: unknown[], selections: SetMenuChoice[]): ResolvedSetMenuLine[] {
  const portionsOf = (item: { qty?: unknown }): number =>
    typeof item.qty === "number" && Number.isInteger(item.qty) && item.qty > 0 ? item.qty : 1;
  const resolved: ResolvedSetMenuLine[] = [];
  for (const raw of templateItems) {
    const item = raw as { id: string; type?: string; label: string; qty?: unknown };
    if (item.type === "always_included") {
      resolved.push({
        id: `set_${item.id}`,
        itemName: item.label,
        quantity: portionsOf(item),
        notes: "",
        included: true,
        price: 0,
        source: "set_menu",
        groupId: item.id,
      });
    } else if (item.type === "choice_group") {
      const chosen = selections.find((s) => s.groupId === item.id)?.chosenOptions ?? [];
      for (const opt of chosen) {
        resolved.push({
          id: `set_${item.id}_${opt.replace(/\s+/g, "_")}`,
          itemName: opt,
          // The group's portions go to its one choice; several choices split
          // them in a way the menu does not say, so each stays at 1.
          quantity: chosen.length === 1 ? portionsOf(item) : 1,
          notes: `(${item.label})`,
          included: true,
          price: 0,
          source: "set_menu",
          groupId: item.id,
        });
      }
    }
  }
  return resolved;
}

/**
 * SCRUM-906 — THE SET MENU'S CHOICES AS THE KITCHEN PLAN NOW HOLDS THEM: the
 * BEO's one record of a choice (the owner's decision 3, "Every record should
 * get updated in this POS and BEO entries accordingly": the latest change
 * wins). The parent's submit, an AI fill's approval and a staff edit in the
 * BEO's set-menu block all write the kitchen plan's set-menu lines, and the
 * till's plan view (app migration 0050) reads the choice from them; the
 * parent's own link reads it from the same lines here, so a choice staff
 * change after the parent submitted is what the parent sees too.
 *
 * Matched as the BEO's set-menu block matches them (beo-event-editor.tsx,
 * SetMenuChoiceGroups): the set-menu lines of the kids' list when it holds
 * one, else the adults'; a line of a group by its groupId, or — saved before
 * groupId — by the note "(<group>)". Null when the kitchen plan holds no
 * set-menu line at all (none written yet): the caller keeps what it had.
 */
export function setMenuChoicesOfKitchenPlan(templateItems: unknown[], menus: unknown): SetMenuChoice[] | null {
  const m = menus && typeof menus === "object" && !Array.isArray(menus) ? (menus as Record<string, unknown>) : {};
  type Line = { itemName?: unknown; notes?: unknown; source?: unknown; groupId?: unknown };
  const setMenuLines = (list: unknown): Line[] =>
    Array.isArray(list)
      ? (list.filter((l) => l && typeof l === "object" && !Array.isArray(l) && (l as Line).source === "set_menu") as Line[])
      : [];
  const kids = setMenuLines(m.kids);
  const lines = kids.length > 0 ? kids : setMenuLines(m.adults);
  if (lines.length === 0) return null;
  const choices: SetMenuChoice[] = [];
  for (const raw of templateItems) {
    const group = raw as { id?: unknown; type?: unknown; label?: unknown };
    if (group.type !== "choice_group" || typeof group.id !== "string") continue;
    const label = typeof group.label === "string" ? group.label : "";
    const chosen = lines
      .filter((line) => {
        const groupId = typeof line.groupId === "string" ? line.groupId.trim() : "";
        if (groupId) return groupId === group.id;
        return typeof line.notes === "string" && line.notes.trim() === `(${label})`;
      })
      .map((line) => (typeof line.itemName === "string" ? line.itemName.trim() : ""))
      .filter((name) => name.length > 0);
    if (chosen.length > 0) choices.push({ groupId: group.id, chosenOptions: chosen });
  }
  return choices;
}
