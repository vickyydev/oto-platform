import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const client = (path: string) => readFileSync(new URL(`../../oto-app/client/src/${path}`, import.meta.url), 'utf8');

// The runtime history suite covers own/foreign park, branch, replay and rollback.
// These release pins cover the active navigation into that same editor.
describe('SOP editor navigation release review', () => {
  it('FINDING 2 high, fixed: the active Studio route reaches revision controls; prescribed fix: register the existing editor in App', () => {
    const app = client('App.tsx');
    expect(app).toContain('const StudioSopsPage = lazy(() => import("@/pages/studio/sops"))');
    expect(app).toContain('<ProtectedRoute path="/studio/sops" component={() => <StudioProtectedLayout component={StudioSopsPage} />} requiredRole={["manager", "admin"]} />');
    const editor = client('pages/studio/sops.tsx');
    expect(editor).toContain('data-testid="button-sop-history"');
    expect(editor).toContain('<SopHistory article={editingSop}');
    expect(editor).toContain('<SelectItem value="archived">Archived</SelectItem>');
  });

  it('both active Studio navigation surfaces link to the registered editor', () => {
    const layout = client('components/layout/studio-layout.tsx');
    expect(layout).toContain('{ title: "SOPs", url: "/studio/sops", icon: FileText }');
    expect(layout).toContain('studioNavItems.map(');
    expect(layout).toContain('href={item.url}');
    const index = client('pages/studio/index.tsx');
    expect(index).toContain('href: "/studio/sops"');
    expect(index).toContain('studioSections.map(');
    expect(index).toContain('href={section.href}');
  });

  it('the editor retains administrator changes and the existing knowledge destination', () => {
    const editor = client('pages/studio/sops.tsx');
    expect(editor).toContain('["admin", "global_admin", "operator_admin"].includes(user?.role || "")');
    expect(editor).toContain('{isAdmin ? (');
    expect(editor).toContain('View Only');
    expect(client('App.tsx')).toContain('path="/studio/kb"');
    expect(client('components/layout/studio-layout.tsx')).toContain('{ title: "ASK OTO", url: "/studio/kb", icon: MessageCircleQuestion }');
  });
});
