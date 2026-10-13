/**
 * The api's own description, written where the front ends read it
 * (SCRUM-272).
 *
 * Every screen used to re-type by hand what a route answers, so a change on
 * the server type-checked green on both sides and failed only at the counter.
 * This builds the api exactly as `buildApp` does — no database, no network:
 * nothing is asked until a request arrives, and none does — takes the OpenAPI
 * document `@fastify/swagger` collects from the zod route schemas, and writes
 * two files into `packages/api-types`:
 *
 * - `openapi.json` — the document itself, which the seam walker
 *   (`packages/api-types/test/seam-walker.test.ts`, SCRUM-293) resolves every
 *   front-end call against;
 * - `src/openapi.ts` — the TypeScript `paths` / `operations` / `components`
 *   that `openapi-typescript` derives from it, which `@oto/api-types` exports.
 *
 * Usage, from the repository root:
 *
 *   pnpm api-types:generate   rewrite both files
 *   pnpm api-types:check      exit 1, naming what moved, if either file is not
 *                             what a fresh generation would write
 *
 * Before writing anything it checks the document against `routeRegistry`, the
 * list the permission plugin fills as each route registers: a route that is
 * registered but missing from the document would be a route the walker could
 * never see, so that refuses the generation rather than producing a partial
 * description that looks whole.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import openapiTS, { astToString } from 'openapi-typescript';
import type { Db } from '@oto/db';
import * as schema from '@oto/db/schema';
import { buildApp } from '../src/app';
import { loadEnv } from '../src/env';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../');
const outDir = join(repoRoot, 'packages/api-types');
const JSON_PATH = join(outDir, 'openapi.json');
const TS_PATH = join(outDir, 'src/openapi.ts');

/**
 * Registered on purpose with no place in the description: the document's own
 * route (declared `hide: true`) and Fastify's catch-all.
 */
const UNDESCRIBED = new Set(['GET /docs/json', 'HEAD /docs/json']);

const HEADER = `/**
 * GENERATED — do not edit. The api's OpenAPI description as TypeScript.
 *
 * Regenerate with \`pnpm api-types:generate\` after changing a route schema;
 * CI runs \`pnpm api-types:check\` and fails when this file is not what a fresh
 * generation writes. Source: apps/api/scripts/api-types.ts (SCRUM-272).
 */
/* eslint-disable */
`;

type OpenApiDoc = { paths: Record<string, Record<string, unknown>> };

async function describe(): Promise<{ json: string; ts: string }> {
  // A pool that is never asked anything: building the app connects to nothing.
  const unused = 'postgres://unused:unused@127.0.0.1:1/unused';
  const pool = new pg.Pool({ connectionString: unused });
  const env = loadEnv({ NODE_ENV: 'test', DATABASE_URL: unused });
  const app = await buildApp({ env, db: drizzle(pool, { schema }) as Db, fileStorage: null });
  try {
    await app.ready();
    const doc = app.swagger() as unknown as OpenApiDoc;

    const described = new Set<string>();
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const method of Object.keys(methods)) {
        described.add(`${method.toUpperCase()} ${toOpenApiPath(path)}`);
      }
    }
    const missing = app.routeRegistry
      .filter((r) => r.method !== 'HEAD' && r.url !== '/*')
      .map((r) => `${r.method} ${toOpenApiPath(r.url)}`)
      .filter((key) => !UNDESCRIBED.has(key) && !described.has(key));
    if (missing.length > 0) {
      throw new Error(
        `registered but not in the OpenAPI document — the walker could not see these:\n  ${missing.join('\n  ')}`,
      );
    }

    const json = `${JSON.stringify(doc, null, 2)}\n`;
    const ast = await openapiTS(JSON.parse(json) as Parameters<typeof openapiTS>[0]);
    const ts = `${HEADER}\n${astToString(ast)}`;
    return { json, ts };
  } finally {
    await app.close();
    await pool.end();
  }
}

/**
 * `/members/:id` as the document spells it, `/members/{id}`, with no trailing
 * slash: a prefix's own root registers as both `/me` and `/me/` and the
 * document keeps one of them.
 */
function toOpenApiPath(url: string): string {
  const path = url.length > 1 ? url.replace(/\/$/, '') : url;
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function readOrEmpty(path: string): string {
  try {
    // LF is what the generator writes and what .gitattributes commits; a
    // checkout that rewrote line endings is not drift.
    return readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    return '';
  }
}

/** Which operations a stale document has that a fresh one does not, and back. */
function operationDiff(stale: string, fresh: string): string[] {
  const ops = (text: string): Map<string, string> => {
    const out = new Map<string, string>();
    if (!text) return out;
    const doc = JSON.parse(text) as OpenApiDoc;
    for (const [path, methods] of Object.entries(doc.paths)) {
      for (const [method, op] of Object.entries(methods)) {
        out.set(`${method.toUpperCase()} ${path}`, JSON.stringify(op));
      }
    }
    return out;
  };
  const a = ops(stale);
  const b = ops(fresh);
  const lines: string[] = [];
  for (const key of b.keys()) if (!a.has(key)) lines.push(`  + ${key} (new route)`);
  for (const key of a.keys()) if (!b.has(key)) lines.push(`  - ${key} (route removed)`);
  for (const [key, op] of b)
    if (a.has(key) && a.get(key) !== op) lines.push(`  ~ ${key} (schema changed)`);
  return lines;
}

const check = process.argv.includes('--check');
const { json, ts } = await describe();

if (check) {
  const staleJson = readOrEmpty(JSON_PATH);
  const staleTs = readOrEmpty(TS_PATH);
  if (staleJson === json && staleTs === ts) {
    console.log('api-types: packages/api-types matches the api.');
  } else {
    const moved = operationDiff(staleJson, json);
    console.error(
      [
        'api-types: the committed description is not what the api declares now.',
        ...(moved.length > 0 ? moved : ['  (formatting or shared components only)']),
        'Run `pnpm api-types:generate` and commit packages/api-types.',
      ].join('\n'),
    );
    process.exitCode = 1;
  }
} else {
  writeFileSync(JSON_PATH, json);
  writeFileSync(TS_PATH, ts);
  console.log(
    `api-types: wrote ${relative(repoRoot, JSON_PATH)} and ${relative(repoRoot, TS_PATH)}.`,
  );
}
