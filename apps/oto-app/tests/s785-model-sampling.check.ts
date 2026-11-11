// SCRUM-785 adversarial review. No provider calls: capture the SDK boundary.
// MEDIUM finding: the default model refuses sampling; omit it after model
// resolution, including explicit/default-fallback calls. Preserve fast calls.
//
// SCRUM-851: when the provider refuses, the helper still rejects with the
// provider's own error, and the SOP route is where it stops: the log takes
// the status, the kind and the request id, staff read one plain line. The
// real route against a refusing stand-in is tests/s851-sop-refusal.check.ts.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import { aiComplete, aiFailureForLog, DEFAULT_AI_MODEL, FAST_AI_MODEL, getAnthropic } from "../server/lib/anthropic";

process.env.ANTHROPIC_API_KEY = "ZZ TEST unused captured model key";
const client = getAnthropic();
const original = client.messages.create;
const calls: Record<string, unknown>[] = [];
let refusal: unknown = null;
client.messages.create = (async (body: Record<string, unknown>) => {
  calls.push(body);
  if (refusal) throw refusal;
  return { content: [{ type: "text", text: "first" }, { type: "thinking", thinking: "ignored" }, { type: "text", text: "second" }] };
}) as typeof client.messages.create;
let checks = 0, failed = 0;
async function check(name: string, action: () => Promise<void> | void) {
  checks++;
  try { await action(); console.log(`PASS ${name}`); }
  catch (error) { failed++; console.error(`FAIL ${name}`, error instanceof Error ? error.message : error); }
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
  const raw = { type: "error", error: { type: "invalid_request_error", message: "`temperature` is deprecated for this model." }, request_id: "req_ZZTEST851" };
  await check("SCRUM-851: a refusing provider still rejects the helper with its own error", async () => {
    refusal = Anthropic.APIError.generate(400, raw, undefined, new Headers({ "request-id": "req_ZZTEST851" }));
    const before = calls.length;
    await assert.rejects(aiComplete({ system: "ZZ TEST system", user: "ZZ TEST document", maxTokens: 2000 }), (error: any) => {
      assert.equal(error, refusal); assert.equal(calls.length, before + 1, "asked once, not again");
      // This is what staff used to read in the toast.
      assert.ok(error.message.includes('"request_id":"req_ZZTEST851"') && error.message.startsWith("400 {"));
      return true;
    });
  });
  await check("SCRUM-851: the log takes the status, the kind and the request id, and nothing else", () => {
    assert.deepEqual(aiFailureForLog(refusal), { status: 400, type: "invalid_request_error", providerRequestId: "req_ZZTEST851",
      detail: "`temperature` is deprecated for this model." });
    assert.deepEqual(aiFailureForLog(Anthropic.APIError.generate(529, { type: "error", error: { type: "overloaded_error", message: "Overloaded" } }, undefined, new Headers())),
      { status: 529, type: "overloaded_error", detail: "Overloaded" });
    assert.deepEqual(aiFailureForLog(new Anthropic.APIConnectionError({ message: "ZZ TEST connection reset" })), { detail: "ZZ TEST connection reset" });
    for (const odd of [null, undefined, "ZZ TEST text", 7, {}]) assert.deepEqual(aiFailureForLog(odd), { detail: "The model call failed" });
    assert.equal(aiFailureForLog(new Error("x".repeat(900))).detail.length, 300);
    // The provider's response headers, the key and what was sent never ride along.
    const keyed = Object.assign(Anthropic.APIError.generate(401, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }, undefined,
      new Headers({ "x-api-key": process.env.ANTHROPIC_API_KEY! })), { request: { system: "ZZ TEST system", user: "ZZ TEST document" } });
    const line = JSON.stringify(aiFailureForLog(keyed));
    for (const secret of [process.env.ANTHROPIC_API_KEY!, "ZZ TEST system", "ZZ TEST document", "headers"]) assert.equal(line.includes(secret), false);
  });
  await check("SCRUM-851: the SOP route stops a refusal there and answers one plain line", () => {
    const routes = readFileSync(new URL("../server/routes.ts", import.meta.url), "utf8");
    const start = routes.indexOf('app.post("/api/knowledge-files/:id/generate-sop"');
    const route = routes.slice(start, routes.indexOf('app.patch("/api/knowledge-files/:id"', start));
    const call = route.slice(route.indexOf("await aiComplete("), route.indexOf("// Parse the JSON response"));
    assert.ok(/maxTokens: 2000,\s*\}\)\.catch\(\(error: unknown\) => \{/.test(call), "the refusal is caught where the model is called");
    assert.ok(call.includes('console.error("[GenerateSOP] The AI provider did not answer:", aiFailureForLog(error));'));
    assert.ok(/return null;\s*\}\);\s*if \(aiResponse === null\) \{\s*return res\.status\(500\)\.json\(\{ message: "The steps could not be generated just now\. Please try again\." \}\);\s*\}/.test(call));
    assert.equal(/next\(|error\.message|String\(error\)/.test(call), false, "the provider's words can reach the answer");
    assert.equal((route.match(/await aiComplete\(/g) ?? []).length, 1);
  });
} finally { client.messages.create = original; refusal = null; }
console.log(`s785-model-sampling.check: ${checks - failed}/${checks} checks passed`);
if (failed) process.exitCode = 1;
