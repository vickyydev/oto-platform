export type Diagnostics = { errors: number; counts: Record<string, number> };
export type Baseline = Diagnostics & { version: number };
export function parseDiagnostics(output: string): Diagnostics;
export function compareDiagnostics(
  actual: Diagnostics,
  baseline: Baseline,
): {
  ok: boolean;
  increased: { key: string; before: number; after: number }[];
  reduced: { key: string; before: number; after: number }[];
};
export function runTypecheck(): Diagnostics & ReturnType<typeof compareDiagnostics>;
