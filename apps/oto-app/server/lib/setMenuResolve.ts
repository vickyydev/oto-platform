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
