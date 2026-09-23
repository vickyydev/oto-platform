#!/usr/bin/env node
/**
 * Fail if a POS screen reads the prototype's fixture members (S2-09b,
 * SCRUM-204).
 *
 * `apps/pos/src/mockApi.ts` still holds the prototype's in-memory member list:
 * four families that exist only in the browser tab. A screen that asks it for
 * a member finds somebody the platform has never heard of, or misses somebody
 * it has, and a sale that names that member names an id the platform cannot
 * place. The screens ask the platform instead — `lookupMember` in
 * `apps/pos/src/api/members.ts`, `membersApi`, or on the booking site, which
 * has no session, `publicApi.memberTier` — and this check keeps it that way:
 * a file under `apps/pos/src` other than `mockApi.ts` that imports one of the
 * functions below from `mockApi` fails, with its file and line.
 *
 * Read with the TypeScript parser rather than a pattern, so an import split
 * over lines, an alias, a re-export or a namespace import is read as what it
 * is, and a comment that mentions a name is not. The list itself is checked
 * against `mockApi.ts` on every run: a guarded name it no longer exports, or
 * a new export that touches the fixture members and is not listed, fails the
 * run too, so the list cannot go quietly out of date.
 *
 *   node scripts/check-no-mock-members.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'apps', 'pos', 'src');
const MOCK_FILE = join(SRC, 'mockApi.ts');
const MOCK_MODULE = join(SRC, 'mockApi');

/**
 * The member section of `mockApi.ts` (from `--- Members` to `getProofTypes`),
 * plus the two History views that hand back one of its members.
 */
const GUARDED = new Map([
  // Readers: each hands the caller a fixture member, or a fixture member's
  // saved children.
  ['getMembers', 'the fixture member list'],
  ['getMemberByPhone', 'a fixture member by phone'],
  ['getMemberById', 'a fixture member by id'],
  ['getSavedChildren', 'the saved children of a fixture member'],
  ['getTransactionsByMember', 'the History phone view, with the fixture member it matched'],
  ['getTransactionsByWristband', 'the History band view, with the fixture member on the band'],
  // Writers: each changes the fixture list, which only a screen holding one of
  // its members has any reason to do.
  ['createMember', 'adds a fixture member'],
  ['updateMember', 'edits a fixture member'],
  ['verifyMemberTier', 'writes the verified tier of a fixture member'],
  ['deleteMember', 'removes a fixture member'],
  ['addSavedChild', 'adds a saved child to a fixture member'],
  ['updateSavedChild', 'edits the saved child of a fixture member'],
  ['removeSavedChild', 'removes the saved child of a fixture member'],
]);

/**
 * Exports that reach the fixture members and are deliberately NOT guarded.
 * `countTierUsage` is the admin tier panel's delete check: how many prices,
 * fixture members and fixture sales name a tier. It returns a number, and the
 * members it counts never leave `mockApi.ts`.
 */
const EXEMPT = new Map([
  ['countTierUsage', 'the reference count of a tier, for the admin delete check'],
]);

const parse = (file) =>
  ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
const rel = (file) => relative(ROOT, file).split(sep).join('/');
const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

/**
 * Every exported name in mockApi.ts that reads or writes `mockMembers`,
 * directly or through another name that does.
 */
function fixtureMemberSurface() {
  const sf = parse(MOCK_FILE);
  const decls = new Map();
  for (const st of sf.statements) {
    const exported = !!ts.getModifiers(st)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) decls.set(d.name.text, { node: d.initializer, exported });
      }
    } else if (ts.isFunctionDeclaration(st) && st.name) {
      decls.set(st.name.text, { node: st.body, exported });
    }
  }
  const refs = new Map();
  for (const [name, { node }] of decls) {
    const seen = new Set();
    const walk = (n) => {
      if (ts.isIdentifier(n)) seen.add(n.text);
      ts.forEachChild(n, walk);
    };
    if (node) walk(node);
    refs.set(name, seen);
  }
  const touching = new Set(['mockMembers']);
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, seen] of refs) {
      if (!touching.has(name) && [...touching].some((t) => seen.has(t))) {
        touching.add(name);
        grew = true;
      }
    }
  }
  const exported = new Set([...decls].filter(([, d]) => d.exported).map(([n]) => n));
  return { exported, touching: [...touching].filter((n) => exported.has(n)) };
}

function isMockApi(spec, fromFile) {
  let target;
  if (spec.startsWith('@/')) target = join(SRC, spec.slice(2));
  else if (spec.startsWith('.')) target = resolve(dirname(fromFile), spec);
  else return false;
  return target.replace(/\.(tsx?|m?js)$/, '') === MOCK_MODULE;
}

function sourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (/\.tsx?$/.test(e.name) && p !== MOCK_FILE) out.push(p);
  }
  return out;
}

/** `file:line  name — what it reads`, for every guarded name this file takes from mockApi. */
function violationsIn(file) {
  const sf = parse(file);
  const found = [];
  const hit = (node, name, what = GUARDED.get(name)) =>
    found.push(`${rel(file)}:${lineOf(sf, node)}  ${name} — ${what}`);
  const namespaces = new Set();

  for (const st of sf.statements) {
    const spec = st.moduleSpecifier;
    if (!spec || !ts.isStringLiteral(spec) || !isMockApi(spec.text, file)) continue;
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      if (!clause || clause.isTypeOnly) continue; // a type reads nothing at run time
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) namespaces.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          const name = (el.propertyName ?? el.name).text;
          if (!el.isTypeOnly && GUARDED.has(name)) hit(el, name);
        }
      }
    } else if (ts.isExportDeclaration(st) && !st.isTypeOnly) {
      if (!st.exportClause || ts.isNamespaceExport(st.exportClause)) {
        hit(st, 'export *', 're-exports every fixture member function');
      } else if (ts.isNamedExports(st.exportClause)) {
        for (const el of st.exportClause.elements) {
          const name = (el.propertyName ?? el.name).text;
          if (!el.isTypeOnly && GUARDED.has(name)) hit(el, name);
        }
      }
    }
  }

  const walk = (n) => {
    // `mock.getMemberByPhone` or `mock['getMemberByPhone']` through `import * as mock`.
    if (
      ts.isPropertyAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      namespaces.has(n.expression.text)
    ) {
      if (GUARDED.has(n.name.text)) hit(n, n.name.text);
    } else if (
      ts.isElementAccessExpression(n) &&
      ts.isIdentifier(n.expression) &&
      namespaces.has(n.expression.text) &&
      ts.isStringLiteral(n.argumentExpression) &&
      GUARDED.has(n.argumentExpression.text)
    ) {
      hit(n, n.argumentExpression.text);
    } else if (
      ts.isCallExpression(n) &&
      (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(n.expression) && n.expression.text === 'require')) &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0]) &&
      isMockApi(n.arguments[0].text, file)
    ) {
      hit(
        n,
        'import()',
        'a runtime import of mockApi cannot be checked; import the names statically',
      );
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return found;
}

const problems = [];
const surface = fixtureMemberSurface();
for (const name of [...GUARDED.keys(), ...EXEMPT.keys()]) {
  if (!surface.exported.has(name)) {
    problems.push(
      `${name} is on this script's list but mockApi.ts no longer exports it — update the list`,
    );
  }
}
for (const name of surface.touching) {
  if (!GUARDED.has(name) && !EXEMPT.has(name)) {
    problems.push(
      `mockApi.ts exports ${name}, which reads or writes the fixture members — add it to GUARDED, or to EXEMPT with the reason`,
    );
  }
}

const files = sourceFiles(SRC);
const violations = files.flatMap(violationsIn);

if (problems.length || violations.length) {
  if (violations.length) {
    console.error(
      'These files read the prototype fixture members in apps/pos/src/mockApi.ts:\n  ' +
        violations.join('\n  ') +
        '\n\nAsk the platform instead: lookupMember (apps/pos/src/api/members.ts) or' +
        '\nmembersApi on a screen with a staff session, publicApi.memberTier on the' +
        '\nbooking site. One member record exists, and it is the platform one.\n',
    );
  }
  if (problems.length) {
    console.error(
      'The guarded list is out of step with mockApi.ts:\n  ' + problems.join('\n  ') + '\n',
    );
  }
  process.exit(1);
}

console.log(
  `[mock-members] no file under apps/pos/src outside mockApi.ts imports a fixture member function ` +
    `(${files.length} files, ${GUARDED.size} functions guarded)`,
);
