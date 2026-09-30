import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { Pencil, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PrintTemplate, PrintTemplateType } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { useBranch } from '@/branch/BranchContext';
import { apiBranchIdForSlug } from '@/api/catalogBridge';
import { printApi, type ApiPrintTemplate } from '@/api/platform';
import { isMissingRoute } from '@/api/client';
import { TemplateEditor } from './TemplateEditor';
import { APPLICABLE_FIELDS, FIELD_META, TEMPLATE_TYPE_META } from './templateFields';

// Stable display order for the printout types.
const TYPE_ORDER: PrintTemplateType[] = [
  'receipt',
  'kids_wristband',
  'adult_wristband',
  'kitchen_ticket',
  'bar_ticket',
  'credit_voucher',
];

/**
 * S2-06 wired this panel to `pos.print_template`.
 *
 * The design is the prototype's and does not move. What changed is where the
 * rows come from and what saving does: the list is the branch's own templates
 * from the API, an edit is a `PATCH` that bumps the version, and that version
 * is what carries the change to a box — it is part of the config bundle's
 * hash, so the box pulls on its next heartbeat with nothing redeployed.
 *
 * The in-memory catalogue store is kept as the fallback for a deployment whose
 * API does not carry these routes yet. It is NOT a cache: a template edited
 * here is never written back to it, because two writable copies of the same
 * six rows is how a footer changed at a counter turns up missing on paper.
 */
export function TemplatesPanel() {
  const { printTemplates: mockTemplates } = useCatalogStore();
  const { branch } = useBranch();
  const branchId = apiBranchIdForSlug(branch.id);

  const [templates, setTemplates] = useState<PrintTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** True once the first read has answered, one way or the other. */
  const [settled, setSettled] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!branchId) {
      setTemplates(null);
      setSettled(true);
      return;
    }
    try {
      const { templates: rows } = await printApi.templates(branchId);
      setTemplates(rows.map(fromApi));
      setError(null);
    } catch (err) {
      setTemplates(null);
      setError(
        isMissingRoute(err)
          ? null
          : 'Could not read this branch’s print templates. Showing the built-in set.',
      );
    } finally {
      setSettled(true);
    }
  }, [branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Live rows where the API has them, the built-in set where it does not. */
  const rows = templates ?? mockTemplates;
  const live = templates !== null;
  const editing = rows.find((t) => t.id === editingId) ?? null;

  /**
   * The printout the address asks to open —
   * `/admin?panel=templates&template=receipt` (SCRUM-470) — named by type,
   * because a type means the same on every branch and deployment where a row
   * id does not. It waits for the first read to settle rather than opening the
   * built-in row of that type: a mock row's id is nobody's on the platform,
   * and the editor would close under the person the moment the live rows
   * arrived. Once only, so closing the editor does not reopen it; the address
   * is put back to the list at that point so a reload does not either.
   */
  const search = useSearch();
  const [, navigate] = useLocation();
  const askedType = new URLSearchParams(search).get('template');
  const openedFromAddress = useRef(false);
  useEffect(() => {
    if (!settled || !askedType || openedFromAddress.current) return;
    openedFromAddress.current = true;
    const match = rows.find((t) => t.type === askedType);
    if (match) setEditingId(match.id);
  }, [settled, askedType, rows]);

  const closeEditor = () => {
    setEditingId(null);
    // The panel id is Admin's (`adminSections`): with the editor closed, the
    // address says the list, and a reload shows the list.
    if (askedType) navigate('/admin?panel=templates', { replace: true });
  };

  const ordered = [...rows].sort(
    (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)
  );

  if (editing) {
    return (
      <TemplateEditor
        template={editing}
        live={live}
        onSaved={() => {
          void load();
        }}
        onClose={closeEditor}
      />
    );
  }

  return (
    <section className="rounded-3xl border border-foreground/10 bg-foreground/[0.02] p-5 sm:p-6">
      <div>
        <h2 className="text-lg font-bold">Print templates</h2>
        <p className="text-sm text-foreground/50">
          Control what each printout shows. Which physical printer each one routes
          to is set per iPad in Station Setup — templates change content only.
        </p>
      </div>

      {(error || !live) && (
        <div className="mt-4 flex items-start gap-2 rounded-2xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-sm text-amber-600 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {error ??
              'These are the built-in templates. This branch is not connected to the platform’s print settings yet, so edits here will not reach a printer.'}
          </span>
        </div>
      )}

      <div className="mt-5 flex flex-col gap-2">
        {ordered.map((t) => (
          <TemplateRow key={t.id} template={t} onEdit={() => setEditingId(t.id)} />
        ))}
      </div>
    </section>
  );
}

/**
 * The stored row as this panel's components want it.
 *
 * The API is explicit about absence (`null`) and the prototype's type is
 * explicit about omission (`undefined`); they mean the same thing here and the
 * conversion happens once, at the boundary, rather than in every reader.
 */
function fromApi(row: ApiPrintTemplate): PrintTemplate {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    showLogo: row.showLogo,
    headerText: row.headerText ?? undefined,
    footerText: row.footerText ?? undefined,
    fields: row.fields as PrintTemplate['fields'],
  };
}

function TemplateRow({
  template,
  onEdit,
}: {
  template: PrintTemplate;
  onEdit: () => void;
}) {
  const meta = TEMPLATE_TYPE_META[template.type];
  const enabled = APPLICABLE_FIELDS[template.type]
    .filter((key) => template.fields[key])
    .map((key) => FIELD_META[key].label);

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-foreground/10 bg-foreground/[0.02] px-4 py-3">
      <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-foreground/5 text-foreground/70">
        <meta.icon className="h-5 w-5" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-bold">{template.name}</span>
          <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] font-semibold text-foreground/60">
            {meta.label}
          </span>
        </div>
        <div className="mt-0.5 flex flex-wrap gap-1.5">
          {enabled.length === 0 ? (
            <span className="text-xs text-foreground/35">No sections enabled</span>
          ) : (
            enabled.map((label) => (
              <span
                key={label}
                className="rounded-full bg-sky-500/15 px-2 py-0.5 text-[11px] font-medium text-sky-600"
              >
                {label}
              </span>
            ))
          )}
        </div>
      </div>
      <Button variant="ghost" size="sm" onClick={onEdit} aria-label={`Edit ${template.name}`}>
        <Pencil className="h-4 w-4" />
        Edit
      </Button>
    </div>
  );
}
