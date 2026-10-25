import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const client = (path: string) => readFileSync(new URL(`../../oto-app/client/src/${path}`, import.meta.url), 'utf8');
const appText = client('App.tsx');
const app = ts.createSourceFile('App.tsx', appText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const oldAddresses = [
  ['/core/dashboard', '/core/today'],
  ['/core/troubleshoot', '/core/fix'],
  ['/studio/troubleshooting', '/studio'],
] as const;

function matches<T extends ts.Node>(tree: ts.Node, guard: (node: ts.Node) => node is T, predicate: (node: T) => boolean): T[] {
  const found: T[] = [];
  const walk = (node: ts.Node) => {
    if (guard(node) && predicate(node)) found.push(node);
    ts.forEachChild(node, walk);
  };
  walk(tree);
  return found;
}
function route(path: string) {
  const found = matches(app, ts.isJsxSelfClosingElement, node => node.tagName.getText(app) === 'ProtectedRoute'
    && node.attributes.properties.some(property => ts.isJsxAttribute(property) && property.name.getText(app) === 'path'
      && property.initializer && ts.isStringLiteral(property.initializer) && property.initializer.text === path));
  expect(found, `exactly one protected route for ${path}`).toHaveLength(1);
  return found[0]!;
}
function attribute(node: ts.JsxSelfClosingElement, name: string) {
  const found = node.attributes.properties.find(property => ts.isJsxAttribute(property) && property.name.getText(app) === name);
  return found && ts.isJsxAttribute(found) ? found.initializer : undefined;
}
function evaluate(text: string, globals: Record<string, unknown> = {}) {
  const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React } }).outputText;
  return runInNewContext(js, {
    React: { createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]) => ({
      type, props: { ...props, ...(children.length ? { children } : {}) },
    }) },
    Redirect: 'Redirect', Route: 'Route', AccessDenied: 'AccessDenied', Loader2: 'Loader2',
    ...Object.fromEntries(['CoreProtectedLayout', 'StudioProtectedLayout', 'HRProtectedLayout', 'CoreDashboardPage',
      'CoreTroubleshootPage', 'StudioTroubleshootingPage', 'CoreTodayPage', 'CoreFixPage', 'StudioIndexPage', 'DashboardPage'].map(name => [name, name])),
    ...globals,
  }, { timeout: 1000 }) as { type: string; props: Record<string, unknown> };
}
function component(node: ts.JsxSelfClosingElement) {
  const value = attribute(node, 'component');
  expect(value && ts.isJsxExpression(value) && value.expression && ts.isArrowFunction(value.expression), 'actual route component closure').toBe(true);
  return (value as ts.JsxExpression).expression!.getText(app);
}
function requiredRole(node: ts.JsxSelfClosingElement): string[] | undefined {
  const value = attribute(node, 'requiredRole');
  if (!value) return undefined;
  expect(ts.isJsxExpression(value) && value.expression && ts.isArrayLiteralExpression(value.expression)).toBe(true);
  return [...((value as ts.JsxExpression).expression as ts.ArrayLiteralExpression).elements].map(node => {
    expect(ts.isStringLiteral(node)).toBe(true);
    return (node as ts.StringLiteral).text;
  });
}

describe('SCRUM-633 unsupported navigation release review', () => {
  // The approved P3-5 choice removes these offers; no dashboard or flow API is introduced.
  it.each(oldAddresses)('FINDING medium: %s reaches %s without mounting the unsupported page; prescribed fix: protected history-replacing redirect', (from, to) => {
    const rendered = evaluate(`const render = ${component(route(from))}; render();`);
    expect(rendered.type).toBe('Redirect');
    expect(rendered.props).toEqual({ to, replace: true });
  });

  it('keeps the actual sign-in, password-change and original Studio role gates on the old addresses', () => {
    const guard = ['userHasAccess', 'ProtectedRoute'].map(name => {
      const found = matches(app, ts.isFunctionDeclaration, node => node.name?.text === name);
      expect(found).toHaveLength(1);
      return found[0]!.getText(app);
    }).join('\n');
    for (const [path] of oldAddresses) {
      const roles = requiredRole(route(path));
      expect(roles).toEqual(path.startsWith('/studio/') ? ['manager', 'admin'] : undefined);
      const renderGuard = (user: { role: string; mustChangePassword?: boolean } | null) => evaluate(`${guard}
        ProtectedRoute({path:${JSON.stringify(path)},requiredRole:${JSON.stringify(roles)},component:()=>null});`, {
        useAuth: () => ({ user, isLoading: false }), useLocation: () => [path], console: { log() {} },
      });
      const anonymous = renderGuard(null);
      expect(anonymous.props.children).toEqual([{ type: 'Redirect', props: { to: '/auth' } }]);
      const password = renderGuard({ role: 'admin', mustChangePassword: true });
      expect(password.props.children).toEqual([{ type: 'Redirect', props: { to: '/change-password' } }]);
      for (const role of ['manager', 'admin', 'operator_admin', 'global_admin']) expect(typeof renderGuard({ role }).props.component).toBe('function');
      const staff = renderGuard({ role: 'staff' });
      if (roles) expect(staff.props.children).toEqual([{ type: 'Redirect', props: { to: '/core' } }]);
      else expect(typeof staff.props.component).toBe('function');
    }
  });

  it('unmounts only the unsupported lazy pages and keeps the working HR Dashboard, Today, Fix and Studio pages', () => {
    for (const path of ['pages/core/dashboard', 'pages/core/troubleshoot', 'pages/studio/troubleshooting']) {
      expect(appText).not.toContain(`@/${path}`);
    }
    for (const [path, layout, page] of [
      ['/core/today', 'CoreProtectedLayout', 'CoreTodayPage'], ['/core/fix', 'CoreProtectedLayout', 'CoreFixPage'],
      ['/studio', 'StudioProtectedLayout', 'StudioIndexPage'], ['/dashboard', 'HRProtectedLayout', 'DashboardPage'],
    ]) {
      expect(evaluate(`const render = ${component(route(path!))}; render();`)).toEqual({ type: layout, props: { component: page } });
    }
    expect(requiredRole(route('/dashboard'))).toEqual(['manager', 'admin']);
    const dashboardImports = app.statements.filter(ts.isImportDeclaration).filter(node =>
      ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === '@/pages/dashboard-page');
    expect(dashboardImports).toHaveLength(1);
    expect(dashboardImports[0]!.importClause?.name?.text).toBe('DashboardPage');
  });

  it('FINDING medium: Setup retains every supported offer in order and removes only the unsupported Troubleshooting card; prescribed fix: remove that card', () => {
    const setup = ts.createSourceFile('setup.tsx', client('pages/setup/index.tsx'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const sections = matches(setup, ts.isVariableDeclaration, node => ts.isIdentifier(node.name) && node.name.text === 'setupSections');
    expect(sections).toHaveLength(1);
    const hrefs = matches(sections[0]!.initializer!, ts.isPropertyAssignment, node => node.name.getText(setup) === 'href').map(node => {
      expect(ts.isStringLiteral(node.initializer)).toBe(true);
      return (node.initializer as ts.StringLiteral).text;
    });
    expect(hrefs).toEqual(['/departments', '/roles', '/locations', '/branches', '/studio/form-builder', '/studio/tasks',
      '/studio/events', '/studio/children', '/studio/checklists', '/studio/quizzes', '/studio/kb',
      '/settings', '/settings/access', '/settings/permissions-debug']);
  });

  it('retains working native Core/Studio navigation without adding an offer to a retired screen', () => {
    const core = client('components/layout/core-layout.tsx');
    const studio = client('components/layout/studio-layout.tsx');
    const hub = client('pages/studio/index.tsx');
    for (const path of ['/core/today', '/core/fix']) expect(core).toContain(`url: "${path}"`);
    for (const path of ['/studio/tasks', '/studio/checklists', '/studio/sops']) {
      expect(studio).toContain(`url: "${path}"`);
      expect(hub).toContain(`href: "${path}"`);
    }
    for (const [path] of oldAddresses) for (const text of [core, studio, hub]) expect(text).not.toContain(path);
  });
});
