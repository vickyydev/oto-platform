// SCRUM-785 adversarial review. No provider calls: capture the SDK boundary.
// MEDIUM finding: the default model refuses sampling; omit it after model
// resolution, including explicit/default-fallback calls. Preserve fast calls.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aiComplete, DEFAULT_AI_MODEL, FAST_AI_MODEL, getAnthropic } from "../server/lib/anthropic";

process.env.ANTHROPIC_API_KEY = "ZZ TEST unused captured model key";
const client = getAnthropic();
const original = client.messages.create;
const calls: Record<string, unknown>[] = [];
client.messages.create = (async (body: Record<string, unknown>) => {
  calls.push(body);
  return { content: [{ type: "text", text: "first" }, { type: "thinking", thinking: "ignored" }, { type: "text", text: "second" }] };
}) as typeof client.messages.create;
let checks = 0, failed = 0;
async function check(name: string, action: () => Promise<void> | void) {
  checks++;
  try { await action(); console.log(`PASS ${name}`); }
  catch { failed++; console.error(`FAIL ${name}`); }
}
try {
  for (const [label, model] of [["omitted", undefined], ["null", null], ["blank", "  "], ["old stored model", "gpt-4o"], ["explicit default", DEFAULT_AI_MODEL], ["trimmed default", ` ${DEFAULT_AI_MODEL} `]] as const) {
    await check(`MEDIUM: ${label} uses the default without sampling`, async () => {
      const result = await aiComplete({ model, system: "ZZ TEST system", user: "ZZ TEST document", maxTokens: 123, temperature: 0.3 });
      const sent = calls.at(-1)!;
      assert.equal(sent.model, DEFAULT_AI_MODEL);
      for (const key of ["temperature", "top_p", "top_k"]) assert.equal(Object.hasOwn(sent, key), false);
      assert.equal(sent.max_tokens, 123); assert.equal(sent.system, "ZZ TEST system");
      assert.deepEqual(sent.messages, [{ role: "user", content: "ZZ TEST document" }]);
      assert.equal(result, "firstsecond");
    });
  }
  await check("PIN: a distinct fast model keeps its caller's supported sampling", async () => {
    await aiComplete({ model: FAST_AI_MODEL, system: "ZZ TEST", user: "ZZ TEST", maxTokens: 19, temperature: 0 });
    assert.equal(calls.at(-1)!.temperature, FAST_AI_MODEL === DEFAULT_AI_MODEL ? undefined : 0);
  });
  await check("PIN: an omitted sampling choice remains omitted for the fast model", async () => {
    await aiComplete({ model: FAST_AI_MODEL, system: "ZZ TEST", user: "ZZ TEST", maxTokens: 19 });
    assert.equal(Object.hasOwn(calls.at(-1)!, "temperature"), false);
  });
  await check("MEDIUM: SOP extraction does not request sampling", () => {
    const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    const start = routes.indexOf('app.post("/api/knowledge-files/:id/generate-sop"');
    assert.ok(start > 0);
    const route = routes.slice(start, routes.indexOf('app.patch("/api/knowledge-files/:id"', start));
    assert.ok(route.includes("await aiComplete("));
    assert.equal(/\b(?:temperature|top_p|top_k)\s*:/.test(route), false);
  });
} finally { client.messages.create = original; }
console.log(`s785-model-sampling.check: ${checks - failed}/${checks} checks passed`);
if (failed) process.exitCode = 1;
