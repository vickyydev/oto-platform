// seed: none — this file talks to nothing. Run it with `npx tsx
// tests/handoff-target.check.ts`; CI runs it beside the suite sign-in checks.
//
// SCRUM-591 prerequisite P1, this app's half: the launcher's hand-off may name
// a screen to land on. The rule is the platform's `safeTargetPath`
// (packages/shared/src/handoff-target.ts) copied into this tree, so these are
// the SAME vectors as packages/shared/test/handoff-target.test.ts — a vector
// added there is added here — and then the receiver itself: the fragment
// stripped first, the landing after a successful exchange only, home after a
// refused exchange or a refused target.
import assert from "node:assert/strict";
import {
  HANDOFF_TARGET_MAX,
  landingUrl,
  readHandoffTarget,
  safeTargetPath,
} from "../client/src/lib/handoff-target";
import {
  acceptHandoff,
  readHandoffToken,
  type HandoffArrivalPort,
  type HandoffProblem,
} from "../client/src/lib/platform-handoff";

// ─── safeTargetPath: what is a same-app path ──────────────────────────────────

for (const path of [
  "/health",
  "/employees/e-123?tab=time",
  "/?c=0192f0a0-1234-7abc-8def-0123456789ab",
  "/payroll/month-end?month=2026-09&tab=preview",
]) {
  assert.equal(safeTargetPath(path), path, `accepts a same-app path: ${path}`);
}

const atMax = `/${"a".repeat(HANDOFF_TARGET_MAX - 1)}`;
assert.equal(atMax.length, HANDOFF_TARGET_MAX);
assert.equal(safeTargetPath(atMax), atMax, "accepts a path of exactly HANDOFF_TARGET_MAX characters");

// Same-origin paths that only look odd: an encoded '#', a ':' or an '@' after
// the leading '/' resolve to this app (the URL probe holds); none is a route
// of ours, so each lands on this app's own not-found page.
for (const path of ["/health%23x", "/javascript:alert(1)", "/@evil.example/x"]) {
  assert.equal(safeTargetPath(path), path, `accepts a same-origin path that only looks odd: ${path}`);
}

const REFUSED: Array<[string, string]> = [
  ["empty", ""],
  ["absolute URL", "https://evil.example/health"],
  ["javascript scheme", "javascript:alert(1)"],
  ["bare host", "evil.example/health"],
  ["relative without a slash", "health"],
  ["protocol-relative", "//evil.example/health"],
  ["backslash host", "/\\evil.example"],
  ["backslash inside", "/health\\..\\admin"],
  ["dot-dot segment", "/health/../admin"],
  ["trailing dot-dot", "/health/.."],
  ["encoded dot-dot", "/health/%2e%2e/admin"],
  ["double-encoded dot-dot", "/%252e%252e/x"],
  ["encoded percent", "/x%25y"],
  ["encoded slash", "/health%2f..%2fadmin"],
  ["single dot segment", "/./health"],
  ["fragment", "/health#handoff=x"],
  ["ampersand in the path", "/x&handoff=z"],
  ["whitespace", "/health page"],
  ["control character", "/health\n"],
  ["encoded NUL", "/%00"],
  ["encoded control character", "/x%1Fy"],
  ["encoded DEL", "/x%7fy"],
  ["non-ASCII", "/héalth"],
  ["undecodable", "/health%zz"],
  ["one over HANDOFF_TARGET_MAX", `/${"a".repeat(HANDOFF_TARGET_MAX)}`],
];
for (const [name, raw] of REFUSED) {
  assert.equal(safeTargetPath(raw), null, `refuses ${name}: ${JSON.stringify(raw)}`);
}

for (const notAString of [undefined, null, 42]) {
  assert.equal(safeTargetPath(notAString), null, "refuses what is not a string");
}

// ─── readHandoffTarget: the fragment as the launcher writes it ────────────────

const TOKEN = "eyJ.abc.def";
for (const path of ["/health", "/employees/e-1?tab=time", "/?c=0192f0a0-1234-7abc-8def-0123456789ab&tab=team"]) {
  const hash = `#handoff=${TOKEN}&to=${encodeURIComponent(path)}`;
  assert.equal(readHandoffTarget(hash), path, `reads back the path the launcher wrote: ${path}`);
  assert.equal(readHandoffToken(hash), TOKEN, "the token beside it is untouched");
}

assert.equal(readHandoffTarget("#handoff=t"), null, "no target: nothing to land on");
assert.equal(readHandoffTarget("#handoff=t&to="), null, "an empty target");
assert.equal(readHandoffTarget("#handoff=t&to=%2F"), null, "home: nothing to do");
assert.equal(readHandoffTarget(`#handoff=t&to=${encodeURIComponent("https://evil.example/x")}`), null);
assert.equal(readHandoffTarget(`#handoff=t&to=${encodeURIComponent("//evil.example/x")}`), null);
assert.equal(readHandoffTarget(`#handoff=t&to=${encodeURIComponent("/a/../../etc")}`), null);
assert.equal(readHandoffTarget("#handoff=t&to=%E0%A4%A"), null, "undecodable");
assert.equal(readHandoffTarget("#handoff=t&to=/health"), "/health", "a raw path with nothing the fragment's syntax would cut still reads");

const whole = "/x?c=1&tab=team";
assert.equal(readHandoffTarget(`#handoff=t&to=${encodeURIComponent(whole)}`), whole, "percent-encoded, the whole path reads, query and all");
assert.equal(readHandoffTarget("#handoff=t&to=/x?c=1&tab=team"), null, "a raw query is refused whole rather than cut at the '&'");
assert.equal(readHandoffTarget("#handoff=t&to=/x?c=1"), null, "an unencoded '?' is not how the launcher writes it");

assert.equal(readHandoffToken("#handoff=a.b.c&to=%2Fhealth"), "a.b.c", "the token reads beside a target");

// ─── landingUrl ───────────────────────────────────────────────────────────────

assert.equal(landingUrl("/", "/health"), "/health");
assert.equal(landingUrl("/app/", "/health"), "/app/health");
assert.equal(landingUrl("", "/?c=x"), "/?c=x");

// ─── The receiver: strip, exchange, then land — or stay home ─────────────────

function port(hash: string, exchange: (token: string) => Promise<HandoffProblem | null>, base = "/") {
  const urls: string[] = [];
  const tokens: string[] = [];
  const p: HandoffArrivalPort = {
    hash,
    pathname: "/",
    search: "",
    base,
    replaceUrl: (url) => urls.push(url),
    exchange: (token) => {
      tokens.push(token);
      return exchange(token);
    },
  };
  return { p, urls, tokens };
}

const ok = () => Promise.resolve(null);
const refused = (): Promise<HandoffProblem | null> =>
  Promise.resolve({ reason: "expired", title: "That launcher sign-in did not work", detail: "expired" });

{
  const { p, urls } = port("#to=%2Fhealth", ok);
  assert.equal(acceptHandoff(p), null, "does nothing without a token");
  assert.deepEqual(urls, [], "and touches no address");
}

{
  const target = "/employees/e-123?tab=time";
  const { p, urls, tokens } = port(`#handoff=tok&to=${encodeURIComponent(target)}`, ok);
  assert.equal(await acceptHandoff(p), null, "a successful exchange answers no problem");
  assert.deepEqual(tokens, ["tok"], "the token was spent once");
  assert.deepEqual(urls, ["/", target], "the fragment is stripped first, then the target is landed on");
}

{
  const { p, urls } = port(`#handoff=tok&to=${encodeURIComponent("/core/rota")}`, ok, "/app/");
  await acceptHandoff(p);
  assert.equal(urls.at(-1), "/app/core/rota", "lands under the app's base path");
}

{
  const { p, urls } = port("#handoff=tok", ok);
  await acceptHandoff(p);
  assert.deepEqual(urls, ["/"], "opens at home when there is no target");
}

for (const target of ["https://evil.example/health", "//evil.example/health", "/health/../../admin", ""]) {
  const { p, urls } = port(`#handoff=tok&to=${encodeURIComponent(target)}`, ok);
  assert.equal(await acceptHandoff(p), null);
  assert.deepEqual(urls, ["/"], `ignores a refused target and opens at home: ${JSON.stringify(target)}`);
}

{
  const { p, urls } = port(`#handoff=tok&to=${encodeURIComponent("/core/rota")}`, refused);
  const problem = await acceptHandoff(p);
  assert.equal(problem?.reason, "expired", "a refused exchange answers the problem");
  assert.deepEqual(urls, ["/"], "and never lands");
}

await import("./platform-role-suite.check");
console.log("handoff-target: every check passed");
