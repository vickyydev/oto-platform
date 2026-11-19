/**
 * SCRUM-1029: what the party's package includes, in the words the Staff BEO's header prints
 * (server/pdf.ts, the package box: "Included: 10 kids + 4 adults, <the package's summary>"),
 * read from the same stored source, the party's package snapshot (beo_package_snapshots). The
 * BEO editor's Event Info shows it beside the package's name. Empty when the snapshot says
 * neither an allowance nor a summary: nothing is made up.
 */
export interface BeoPackageIncludedSource {
  kidsIncluded?: number | null;
  adultsIncluded?: number | null;
  includedSummary?: string | null;
}

/** The guest counts the package includes: "10 kids + 4 adults"; empty when it stores none. */
export function beoPackageAllowanceOf(pkg: BeoPackageIncludedSource | null | undefined): string {
  return [
    pkg?.kidsIncluded != null ? `${pkg.kidsIncluded} kids` : "",
    pkg?.adultsIncluded != null ? `${pkg.adultsIncluded} adults` : "",
  ].filter(Boolean).join(" + ");
}

/** The allowance and the package's own summary: "10 kids + 4 adults, play, basic program, cake". */
export function beoPackageIncludedOf(pkg: BeoPackageIncludedSource | null | undefined): string {
  return [beoPackageAllowanceOf(pkg), pkg?.includedSummary?.trim() ?? ""].filter(Boolean).join(", ");
}
