import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocation, useSearch } from 'wouter';
import { Pencil, AlertTriangle } from 'lucide-react';
import type { PrintTemplate, PrintTemplateType } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { useBranch } from '@/branch/BranchContext';
import { useStation } from '@/station/StationContext';
import { apiBranchIdForSlug } from '@/api/catalogBridge';
import { printApi } from '@/api/platform';
import { isMissingRoute } from '@/api/client';
import { TemplateEditor } from './TemplateEditor';
import { PrintTemplateThumbnail } from './PrintTemplatePreview';
import { APPLICABLE_FIELDS, TEMPLATE_TYPE_META } from './templateFields';
import { fromApi, paperLabel } from './templateDraft';

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
 * What changed is where the rows come from and what saving does: the list is
 * the branch's own templates from the API, an edit is a `PATCH` that bumps the
 * version, and that version is what carries the change to a box — it is part
 * of the config bundle's hash, so the box pulls on its next heartbeat with
 * nothing redeployed. SCRUM-472 turned the list into cards, each with a live
 * thumbnail of the saved template and the paper it prints on.
 *
 * The in-memory catalogue store is kept as the fallback for a deployment whose
 * API does not carry these routes yet. It is NOT a cache: a template edited
 * here is never written back to it, because two writable copies of the same
 * six rows is how a footer changed at a counter turns up missing on paper.
 */
export function TemplatesPanel() {
  const { printTemplates: mockTemplates } = useCatalogStore();
  const { branch } = useBranch();
  const { station } = useStation();
  const stationId = station?.stationId ?? null;
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
        // A different template is a different editor: nothing of one draft may
        // carry into the next.
        key={editing.id}
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

      {/* As many columns as keep an 80 mm thumbnail whole at Fit (288px plus
          the card's padding): a thumbnail cut at both edges reads as broken. */}
      <div className="mt-5 grid grid-cols-[repeat(auto-fill,minmax(min(100%,312px),1fr))] gap-3">
        {ordered.map((t) => (
          <TemplateCard
            key={t.id}
            template={t}
            live={live}
            stationId={stationId}
            onEdit={() => setEditingId(t.id)}
          />
        ))}
      </div>
    </section>
  );
}

/**
 * One printout, as a card: the saved template drawn small at the top — the
 * same renderer and the same sample as the editor's preview — then what it is
 * and the paper it prints on. The whole card opens the editor.
 */
function TemplateCard({
  template,
  live,
  stationId,
  onEdit,
}: {
  template: PrintTemplate;
  live: boolean;
  stationId: string | null;
  onEdit: () => void;
}) {
  const meta = TEMPLATE_TYPE_META[template.type];
  const [dots, setDots] = useState<number | null>(null);
  const applicable = APPLICABLE_FIELDS[template.type];
  const shown = applicable.filter((key) => template.fields[key]).length;

  return (
    <div className="group relative flex flex-col rounded-2xl border border-foreground/10 bg-foreground/[0.02] p-2 transition-colors focus-within:ring-2 focus-within:ring-primary/50 hover:border-foreground/25">
      <PrintTemplateThumbnail
        template={template}
        live={live}
        stationId={stationId}
        onDots={setDots}
      />
      <div className="flex items-start gap-3 px-2 pt-3">
        <span className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-foreground/5 text-foreground/70">
          <meta.icon className="h-[18px] w-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-bold">{template.name}</div>
          <div className="truncate text-xs text-foreground/50">{meta.label}</div>
        </div>
        <Pencil className="mt-1 h-4 w-4 shrink-0 text-foreground/30 transition-colors group-hover:text-foreground/60" />
      </div>
      <div className="flex flex-wrap gap-1.5 px-2 pb-1.5 pt-2.5">
        {dots !== null && (
          <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-foreground/60">
            {paperLabel(template.type, dots)}
          </span>
        )}
        <span
          className={`rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
            shown === 0 ? 'bg-foreground/5 text-foreground/40' : 'bg-sky-500/15 text-sky-600'
          }`}
        >
          {shown === 0 ? 'No sections shown' : `${shown} of ${applicable.length} sections shown`}
        </span>
      </div>
      {/* The whole card opens the editor: one button laid over it, rather than
          the card being a button, because a button may not hold the
          block-level thumbnail inside it. */}
      <button
        type="button"
        onClick={onEdit}
        aria-label={`Edit ${template.name}`}
        className="absolute inset-0 rounded-2xl focus-visible:outline-none"
      />
    </div>
  );
}
