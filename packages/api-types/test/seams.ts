/**
 * The seam walker's reading of the front ends (SCRUM-293): every place a
 * screen asks the platform api for something, as a path, a method and what it
 * sends, resolved against the routes the api describes in `openapi.json`.
 *
 * Kept apart from the test so the reading can be inspected on its own
 * (`collectCalls`, `resolveCall`) and the assertions stay short.
 *
 * WHAT COUNTS AS A CALL. apps/pos, apps/console, apps/launcher and apps/inbox reach the
 * platform through one wrapper each, `api.get / post / put / patch / delete`
 * (and the till's `getBlob` / `postBlob`) in their `src/api/client.ts`, which
 * prefixes `/api`. A call is any of those with the path as its first
 * argument; a `fetch`, an `EventSource` or an `apiUrl(...)` whose path is
 * written starting `/api`; an arrow function or a JSX attribute that is such
 * a path (a download link); and a call through one of the `WRAPPERS` below —
 * the display's, the kiosk's and the station bridge's transports in the till,
 * and apps/booth's `call`, which reaches the platform's `/booth/*` when the
 * television is served from the staging site.
 *
 * HOW A PATH IS READ. From the source text, with the TypeScript parser: a
 * string, a template (each `${…}` becomes a hole), `+` of those, a `const`
 * in the same file holding one, or a call to an arrow function in the same
 * file returning one (`at(id)` in the Console's booth module). A query string
 * is cut off and its literal parameter names kept; a hole that ends the path
 * glued to a word (`/members${q ? … : ''}`) is a query string being added and
 * is dropped. Anything else is DYNAMIC — a path the walker cannot read — and
 * has to be named in the test's allowlist, so "the walker could not see it"
 * is a line in a diff rather than a silent gap.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { STATION_BRIDGE_BASE } from '@oto/shared';
import ts from 'typescript';

export const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

/** The front ends that call the platform api, walked whole. */
export const FRONT_ENDS = [
  'apps/pos/src',
  'apps/console/src',
  'apps/launcher/src',
  'apps/booth/src',
  // The Inbox shell (S2-19 I3a, SCRUM-587): its reads go through its own
  // `api` wrapper in src/api/client.ts, read like the Console's.
  'apps/inbox/src',
  // Lifted admin panels use the host's authenticated AdminApi transport.
  'packages/admin-screens/src',
];

/** Generated or vendored: never authored call sites. */
const SKIP = new Set(['node_modules', 'dist', 'build', 'coverage']);

export interface SourceFile {
  /** Repository-relative, forward slashes. */
  path: string;
  text: string;
}

export function readFrontEnds(): SourceFile[] {
  const out: SourceFile[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir).sort()) {
      if (SKIP.has(entry) || entry.startsWith('.')) continue;
      const full = `${dir}${entry}`;
      if (statSync(full).isDirectory()) walk(`${full}/`, `${prefix}${entry}/`);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.d\.ts$/.test(entry)) {
        out.push({ path: `${prefix}${entry}`, text: readFileSync(full, 'utf8') });
      }
    }
  };
  for (const root of FRONT_ENDS) walk(`${repoRoot}${root}/`, `${root}/`);
  return out;
}

// --- The api's description ---------------------------------------------------

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface JsonSchema {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  additionalProperties?: boolean | JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  allOf?: JsonSchema[];
  $ref?: string;
}

interface OpenApiOperation {
  parameters?: Array<{ in: string; name: string }>;
  requestBody?: { content?: Record<string, { schema?: JsonSchema }> };
  responses?: Record<string, { content?: Record<string, unknown> }>;
}

export interface Route {
  /** As the document spells it, `{param}`, trailing slash removed. */
  path: string;
  /** The document's own key, which `ApiResponse<'…'>` names. */
  docPath: string;
  method: Method;
  segments: string[];
  query: Set<string>;
  /** The JSON body's schema, when the route reads one. */
  body: JsonSchema | null;
  /** Whether the success answer has a described body. */
  describedResponse: boolean;
}

export const routeKey = (r: { method: string; path: string }) => `${r.method} ${r.path}`;

export function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/$/, '') : path;
}

export function readRoutes(): Route[] {
  const doc = JSON.parse(readFileSync(`${repoRoot}packages/api-types/openapi.json`, 'utf8')) as {
    paths: Record<string, Record<string, OpenApiOperation>>;
  };
  const routes: Route[] = [];
  for (const [docPath, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const path = trimSlash(docPath);
      const ok = Object.entries(op.responses ?? {}).find(([status]) => status.startsWith('2'));
      routes.push({
        path,
        docPath,
        method: method.toUpperCase() as Method,
        segments: path.split('/').slice(1),
        query: new Set((op.parameters ?? []).filter((p) => p.in === 'query').map((p) => p.name)),
        body: op.requestBody?.content?.['application/json']?.schema ?? null,
        describedResponse: Boolean(ok?.[1].content),
      });
    }
  }
  return routes;
}

/**
 * The property names a body schema reads, or null when it reads any (no
 * declared properties, or extra properties allowed). A union reads what any
 * of its branches reads.
 */
export function bodyKeys(schema: JsonSchema): Set<string> | null {
  const branches = [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])];
  if (branches.length > 0) {
    const keys = new Set<string>();
    for (const branch of branches) {
      // `{ not: {} }` is how an optional body says "or no body at all".
      if ('not' in branch) continue;
      const inner = bodyKeys(branch);
      if (inner === null) return null;
      for (const k of inner) keys.add(k);
    }
    return keys;
  }
  if (schema.$ref || !schema.properties) return null;
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false)
    return null;
  return new Set(Object.keys(schema.properties));
}

// --- Reading a call site -----------------------------------------------------

/** A `${…}` in a path. Never appears in a real path. */
export const HOLE = '\u0000';

export interface Call {
  file: string;
  line: number;
  method: Method;
  /** The path as read, holes as `${}`; null when it could not be read. */
  shown: string;
  /** Path without query, holes as HOLE; null when DYNAMIC. */
  path: string | null;
  /** Literal query parameter names written in the path. */
  query: string[];
  /** Explicit keys of an object-literal body; null when the body is not one. */
  bodyKeys: string[] | null;
  /** `ApiResponse<'/x', 'get'>` (or ApiBody/ApiQuery/ApiParams) named at the site. */
  generated: Array<{ path: string; method: string; helper: string }>;
  /** Whether the site's response type argument is written by hand. */
  handTyped: boolean;
}

const VERBS: Record<string, Method> = {
  get: 'GET',
  getBlob: 'GET',
  getFile: 'GET',
  href: 'GET',
  post: 'POST',
  postBlob: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
  deleteWithBody: 'DELETE',
};

/**
 * The transports that are not `api`, each declared in one file and called
 * only there: the customer display's and the kiosk's bearer requests, the
 * till's station bridge (the box's `/box/v1/station/:id/*`, or the platform's
 * copy of it), and the booth television's `call`. A call through one is read
 * like an `api` call — method, path and body by position, the method from a
 * `fetch`-style init where the wrapper takes one — and the `fetch` inside
 * the wrapper is its plumbing, not a call.
 */
interface Wrapper {
  /** Prepended to the path argument; HOLE stands for a value. */
  prefix: string;
  method: number | { init: number };
  path: number;
  body: number;
}

const WRAPPERS: Record<string, Wrapper> = {
  'apps/pos/src/api/display.ts#displayRequest': { prefix: '/display', method: 1, path: 2, body: 3 },
  'apps/pos/src/api/kiosk.ts#kioskRequest': { prefix: '', method: 1, path: 2, body: 4 },
  'apps/pos/src/api/bridge.ts#request': {
    prefix: `${STATION_BRIDGE_BASE}/${HOLE}/`,
    method: 0,
    path: 2,
    body: 3,
  },
  'apps/booth/src/booth/client.ts#call': {
    prefix: '/booth',
    method: { init: 1 },
    path: 0,
    body: -1,
  },
};

/**
 * Constants a path is built from that are imported rather than declared in
 * the calling file, read from where they are defined so the walker cannot
 * hold a stale copy.
 */
const IMPORTED: Record<string, string> = { STATION_BRIDGE_BASE };

/** The name of the function declaration enclosing a node, if any. */
function enclosingFunction(node: ts.Node): string | null {
  for (let at: ts.Node | undefined = node.parent; at; at = at.parent) {
    if (ts.isFunctionDeclaration(at) && at.name) return at.name.text;
  }
  return null;
}

const GENERATED_HELPERS = new Set(['ApiResponse', 'ApiBody', 'ApiQuery', 'ApiParams']);

/** Arrow-function parameters bound to what the call passed: text, or null for a hole. */
type Bindings = Map<string, string | null>;

/** Resolves an expression to path text with holes, or null when it cannot. */
function pathText(node: ts.Expression, depth = 0, bound: Bindings = new Map()): string | null {
  if (depth > 4) return null;
  if (ts.isParenthesizedExpression(node)) return pathText(node.expression, depth, bound);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isIdentifier(node) && bound.has(node.text)) return bound.get(node.text) ?? null;
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      // A parameter the helper was called with, an imported base or a local
      // path helper (`${branchPath(id)}/end-of-day`) is read through; anything
      // else — an id, an encoded value, a query string — is a hole.
      const e = span.expression;
      const inner =
        ts.isIdentifier(e) && bound.has(e.text)
          ? bound.get(e.text)!
          : ts.isIdentifier(e) && IMPORTED[e.text] !== undefined
            ? IMPORTED[e.text]!
            : pathHelper(e, depth + 1, bound);
      out += (inner ?? HOLE) + span.literal.text;
    }
    return out;
  }
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = pathText(node.left, depth + 1, bound);
    const right = pathText(node.right, depth + 1, bound);
    return left === null ? null : left + (right ?? HOLE);
  }
  return pathHelper(node, depth + 1, bound);
}

/**
 * A `const` holding a path, or a call to a `const` arrow function returning
 * one, declared in the same file in a scope that encloses the use. Only text
 * that starts with `/` counts, so a helper that encodes a value
 * (`const path = (s) => encodeURIComponent(s)`) stays a hole.
 */
function pathHelper(node: ts.Expression, depth: number, bound: Bindings): string | null {
  let text: string | null = null;
  if (ts.isIdentifier(node)) {
    const found = localConst(node.text, node);
    if (found && !ts.isArrowFunction(found)) text = pathText(found, depth, bound);
  } else if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
    const found = localConst(node.expression.text, node);
    if (found && ts.isArrowFunction(found) && !ts.isBlock(found.body)) {
      const params: Bindings = new Map();
      found.parameters.forEach((param, i) => {
        if (!ts.isIdentifier(param.name)) return;
        const arg = node.arguments[i];
        params.set(param.name.text, arg ? pathText(arg, depth + 1, bound) : null);
      });
      text = pathText(found.body, depth, params);
    }
  }
  return text !== null && text.startsWith('/') ? text : null;
}

/** The initializer of the nearest `const name = …` in a scope enclosing `at`. */
function localConst(name: string, at: ts.Node): ts.Expression | null {
  for (let scope: ts.Node | undefined = at; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      for (const decl of statement.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.name.text === name && decl.initializer) {
          return decl.initializer;
        }
      }
    }
  }
  return null;
}

/** Splits read text into the path part and the literal query names. */
function splitQuery(text: string): { path: string; query: string[] } {
  const q = text.indexOf('?');
  if (q === -1) return { path: text, query: [] };
  const query = [...text.slice(q + 1).matchAll(/(?:^|[&?])([A-Za-z0-9_]+)=/g)].map((m) => m[1]!);
  return { path: text.slice(0, q), query };
}

function normalisePath(raw: string): string | null {
  let path = raw;
  // A hole glued to the end of a word adds a query string or nothing.
  while (path.endsWith(HOLE) && !path.endsWith(`/${HOLE}`)) path = path.slice(0, -1);
  if (!path.startsWith('/')) return null;
  return trimSlash(path);
}

function typeArgs(call: ts.CallExpression): Call['generated'] {
  const found: Call['generated'] = [];
  const visit = (node: ts.Node) => {
    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      GENERATED_HELPERS.has(node.typeName.text)
    ) {
      const [p, m] = node.typeArguments ?? [];
      if (
        p &&
        m &&
        ts.isLiteralTypeNode(p) &&
        ts.isStringLiteral(p.literal) &&
        ts.isLiteralTypeNode(m) &&
        ts.isStringLiteral(m.literal)
      ) {
        found.push({ path: p.literal.text, method: m.literal.text, helper: node.typeName.text });
      }
    }
    ts.forEachChild(node, visit);
  };
  for (const arg of call.typeArguments ?? []) visit(arg);
  return found;
}

function objectKeys(node: ts.Expression | undefined): string[] | null {
  if (!node || !ts.isObjectLiteralExpression(node)) return null;
  const keys: string[] = [];
  for (const prop of node.properties) {
    if (ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop)) {
      if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) keys.push(prop.name.text);
    }
  }
  return keys;
}

/** `{ method: 'POST' }` in a fetch's init, else GET. */
function fetchMethod(init: ts.Expression | undefined): Method {
  if (init && ts.isObjectLiteralExpression(init)) {
    for (const prop of init.properties) {
      if (
        ts.isPropertyAssignment(prop) &&
        ts.isIdentifier(prop.name) &&
        prop.name.text === 'method' &&
        ts.isStringLiteral(prop.initializer)
      ) {
        return prop.initializer.text.toUpperCase() as Method;
      }
    }
  }
  return 'GET';
}

/** `body: JSON.stringify(x)` in a fetch-style init: x. */
function initBody(init: ts.Expression | undefined): ts.Expression | undefined {
  if (!init || !ts.isObjectLiteralExpression(init)) return undefined;
  for (const prop of init.properties) {
    if (!ts.isPropertyAssignment(prop) || !ts.isIdentifier(prop.name) || prop.name.text !== 'body')
      continue;
    const value = prop.initializer;
    if (
      ts.isCallExpression(value) &&
      ts.isPropertyAccessExpression(value.expression) &&
      value.expression.getText() === 'JSON.stringify'
    ) {
      return value.arguments[0];
    }
  }
  return undefined;
}

export function collectCalls(source: SourceFile): Call[] {
  const file = ts.createSourceFile(
    source.path,
    source.text,
    ts.ScriptTarget.Latest,
    true,
    source.path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const calls: Call[] = [];
  const record = (
    node: ts.Expression,
    method: Method,
    pathArg: ts.Expression,
    body: ts.Expression | undefined,
    prefix = '',
    strip = '',
  ) => {
    const read = pathText(pathArg);
    const text = read === null ? null : prefix + read;
    const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1;
    const generated = ts.isCallExpression(node) ? typeArgs(node) : [];
    const handTyped =
      ts.isCallExpression(node) && (node.typeArguments?.length ?? 0) > 0 && generated.length === 0;
    const readable = text !== null && text.startsWith(strip);
    const { path, query } = readable
      ? splitQuery(text.slice(strip.length))
      : { path: '', query: [] };
    calls.push({
      file: source.path,
      line,
      method,
      shown: readable ? text.replaceAll(HOLE, '${}') : pathArg.getText(file),
      path: readable ? normalisePath(path) : null,
      query,
      bodyKeys: objectKeys(body),
      generated,
      handTyped,
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      // api.get('/x'), api.post('/x', body, …)
      if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'api' &&
        VERBS[callee.name.text] &&
        node.arguments[0]
      ) {
        const method = VERBS[callee.name.text]!;
        // The console's delete takes (path, opts): an object there is not a body.
        const body = callee.name.text === 'deleteWithBody'
          ? node.arguments[1]
          : method === 'GET' || method === 'DELETE' ? undefined : node.arguments[1];
        record(node, method, node.arguments[0], body);
      }
      // A file's own transport: displayRequest(bearer, 'GET', '/session'), …
      const wrapper = ts.isIdentifier(callee)
        ? WRAPPERS[`${source.path}#${callee.text}`]
        : undefined;
      const pathArg = wrapper ? node.arguments[wrapper.path] : undefined;
      if (wrapper && pathArg) {
        let method: Method | null = null;
        let body: ts.Expression | undefined;
        if (typeof wrapper.method === 'number') {
          const arg = node.arguments[wrapper.method];
          if (arg && ts.isStringLiteral(arg)) method = arg.text.toUpperCase() as Method;
          body = node.arguments[wrapper.body];
        } else {
          const init = node.arguments[wrapper.method.init];
          method = fetchMethod(init);
          body = initBody(init);
        }
        if (method)
          record(node, method, pathArg, method === 'GET' ? undefined : body, wrapper.prefix);
      }
      // fetch('/api/x', { method }) and fetch(apiUrl('/x'), { method }),
      // except the fetch a transport above makes with whatever it was given.
      const transport = enclosingFunction(node);
      if (
        ts.isIdentifier(callee) &&
        callee.text === 'fetch' &&
        node.arguments[0] &&
        !(transport && WRAPPERS[`${source.path}#${transport}`])
      ) {
        const target = node.arguments[0];
        const method = fetchMethod(node.arguments[1]);
        const body = initBody(node.arguments[1]);
        if (
          ts.isCallExpression(target) &&
          ts.isIdentifier(target.expression) &&
          target.expression.text === 'apiUrl' &&
          target.arguments[0]
        ) {
          record(node, method, target.arguments[0], body);
        } else if (pathText(target)?.startsWith('/api/')) {
          record(node, method, target, body, '', '/api');
        }
      }
      // apiUrl('/x') outside a fetch: an <img src>, a download link — a GET.
      if (
        ts.isIdentifier(callee) &&
        callee.text === 'apiUrl' &&
        node.arguments[0] &&
        !(
          ts.isCallExpression(node.parent) &&
          ts.isIdentifier(node.parent.expression) &&
          node.parent.expression.text === 'fetch'
        )
      ) {
        record(node, 'GET', node.arguments[0], undefined);
      }
    }
    // new EventSource('/api/x') — a GET that stays open.
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'EventSource' &&
      node.arguments?.[0] &&
      pathText(node.arguments[0])?.startsWith('/api/')
    ) {
      record(node, 'GET', node.arguments[0], undefined, '', '/api');
    }
    // A link the browser follows: an arrow function returning an `/api/…`
    // path, or a JSX attribute holding one.
    if (
      (ts.isStringLiteral(node) ||
        ts.isNoSubstitutionTemplateLiteral(node) ||
        ts.isTemplateExpression(node)) &&
      (ts.isArrowFunction(node.parent) ||
        ts.isJsxExpression(node.parent) ||
        ts.isJsxAttribute(node.parent)) &&
      pathText(node)?.startsWith('/api/')
    ) {
      record(node, 'GET', node, undefined, '', '/api');
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return calls;
}

// --- Resolving a call against the routes -----------------------------------

function segmentMatches(route: string, call: string): 'param' | 'static' | false {
  const isParam = /^\{[^}]+\}$/.test(route);
  if (call === HOLE) return isParam ? 'param' : 'static';
  if (!call.includes(HOLE)) {
    if (isParam) return call.length > 0 ? 'param' : false;
    return route === call ? 'static' : false;
  }
  // A segment with a hole inside it: `x-${id}`.
  if (isParam) return 'param';
  const pattern = new RegExp(
    `^${call
      .split(HOLE)
      .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
      .join('.+')}$`,
  );
  return pattern.test(route) ? 'static' : false;
}

/**
 * The routes a read path can reach, as Fastify would choose among them: a
 * literal segment beats a parameter, and a hole is read as a parameter when a
 * route has one there. Every method on the reached path is returned; the
 * caller checks its own.
 */
export function resolvePath(path: string, routes: Route[]): Route[] {
  const segments = path.split('/').slice(1);
  const candidates = routes.filter((r) => r.segments.length === segments.length);
  let best: Route[] = [];
  let bestScore = -1;
  for (const route of candidates) {
    let score = 0;
    let ok = true;
    for (let i = 0; i < segments.length; i++) {
      const m = segmentMatches(route.segments[i]!, segments[i]!);
      if (!m) {
        ok = false;
        break;
      }
      // A literal written in the call matching a literal route segment is the
      // strongest evidence; a hole read as a parameter next.
      const literal = !segments[i]!.includes(HOLE);
      score = score * 4 + (m === 'static' ? (literal ? 3 : 1) : 2);
    }
    if (!ok) continue;
    if (score > bestScore) {
      bestScore = score;
      best = [route];
    } else if (score === bestScore) {
      best.push(route);
    }
  }
  return best;
}
