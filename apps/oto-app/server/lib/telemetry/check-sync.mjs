#!/usr/bin/env node
/**
 * Fail if the vendored redaction has drifted from the platform's.
 *
 * `redact.ts`, `scrub.ts` and `logger.ts` in this directory are byte-for-byte
 * copies of `packages/telemetry/src/` (see README.md for why a copy exists at
 * all). A copy nobody checks is a copy that diverges, and the divergence shows
 * up as a phone number in a log line months later, so the check is mechanical:
 * hash both, compare, say which file and in which direction.
 *
 * Inside the Docker image the platform sources are not in the build context.
 * That is reported and skipped rather than failed — the image has nothing to
 * compare against, and pretending otherwise would mean either a build that
 * always fails or a check nobody can trust.
 */
import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const upstream = resolve(here, "../../../../../packages/telemetry/src");
const FILES = ["redact.ts", "scrub.ts", "logger.ts"];

if (!existsSync(upstream)) {
  console.log(`[telemetry] platform source not in this tree (${upstream}) — drift check skipped`);
  process.exit(0);
}

const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const drifted = [];

for (const file of FILES) {
  const mine = join(here, file);
  const theirs = join(upstream, file);
  if (!existsSync(theirs)) {
    drifted.push(`${file}: no longer exists in packages/telemetry/src`);
    continue;
  }
  if (hash(mine) !== hash(theirs)) {
    drifted.push(`${file}: differs from packages/telemetry/src/${file}`);
  }
}

if (drifted.length) {
  console.error(
    "The vendored redaction has drifted from the platform's:\n  - " +
      drifted.join("\n  - ") +
      "\n\nThese files are copies and must stay byte-for-byte identical. Take the" +
      "\nupstream version:\n" +
      "\n  cp packages/telemetry/src/{redact,scrub,logger}.ts apps/oto-app/server/lib/telemetry/\n" +
      "\nIf the change belongs in both, make it in packages/telemetry/src first," +
      "\nthen copy it here — that package is the one the api, the POS and the" +
      "\nlauncher all read.\n",
  );
  process.exit(1);
}

console.log(`[telemetry] vendored redaction matches packages/telemetry/src (${FILES.length} files)`);
