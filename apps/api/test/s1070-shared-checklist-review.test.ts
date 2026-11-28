import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const routes = readFileSync(fileURLToPath(new URL("../../oto-app/server/routes.ts", import.meta.url)), "utf8");
function routeBetween(start: string, end: string): string {
  const startIndex = routes.indexOf(start);
  const endIndex = routes.indexOf(end, startIndex + start.length);
  if (startIndex < 0 || endIndex < 0) throw new Error(`Missing checklist route boundary: ${start} or ${end}`);
  return routes.slice(startIndex, endIndex);
}

const itemRoute = routeBetween('app.patch("/api/checklist-run-items/:itemId"', 'app.patch("/api/checklist-runs/:id"');

describe("shared HR checklist completion", () => {
  it("locks the run before saving an item and checks readiness inside the same transaction", () => {
    const milestones = ["db.transaction(", '.for("update")', "tx.update(checklistRunItems)",
      "await operationalReadiness(tx, run.id)", "tx.update(checklistRuns)", "return { updatedItem, currentRun: run, completed }"];
    const offsets = milestones.map(text => itemRoute.indexOf(text));
    expect(offsets.every(offset => offset >= 0)).toBe(true);
    expect(offsets).toEqual([...offsets].sort((a, b) => a - b));
    expect(itemRoute).toContain('template?.type === "operational"');
  });

  it("uses the same eligibility check for a manual close and preserves the first closer on retries", () => {
    const manual = routeBetween('app.patch("/api/checklist-runs/:id"', "// Manager/Admin override");
    expect(manual).toContain("await operationalReadiness(tx, id)");
    expect(manual).toContain('if (run.status === "completed") return { status: run.status }');
    expect(manual).toContain("if (ready.missing) return { error: ready.missing }");
  });
});
