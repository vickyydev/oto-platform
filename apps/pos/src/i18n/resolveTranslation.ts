import type { SupportedLang } from './types';

// A catalog entity that MAY carry translated display fields. Keep this
// intentionally narrow — only name/description are ever swapped for display;
// prices, ids, and every other field always come from the original record.
export interface Translatable {
  translations?: Partial<Record<SupportedLang, { name: string; description?: string }>>;
}

// Resolve the display name for a catalog item (MenuItem/TicketType/AddOn/
// MenuCategoryDef) in the given language, falling back to the item's
// original `name` when no translation exists for that language (or the
// language is English). This is a read-only display seam — it never mutates
// the catalog, so admin editing of `translations` is a follow-on (see
// types.ts note on the `translations` field).
export function resolveName<T extends Translatable & { name: string }>(
  item: T,
  lang: SupportedLang
): string {
  return item.translations?.[lang]?.name ?? item.name;
}

export function resolveDescription<T extends Translatable>(
  item: T,
  lang: SupportedLang
): string | undefined {
  return item.translations?.[lang]?.description;
}
