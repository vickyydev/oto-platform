import type { CatalogReaders } from '../../../model/ports';

/** Original domain rules, bound to this host's explicit data ports. */
export function createMemberLabelsHelpers(deps: { catalog: CatalogReaders }) {
const { getTiers } = deps.catalog;


// The tiers that require verification (the default tier is the absence of an
// entry). Driven by each tier's `requiresVerification` flag.
const verifiedTiers = (): string[] =>
  getTiers()
    .filter((t) => t.requiresVerification)
    .map((t) => t.id);
return { verifiedTiers };
}
export type MemberLabelsHelpers = ReturnType<typeof createMemberLabelsHelpers>;
