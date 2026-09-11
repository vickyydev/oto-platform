import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PrintTemplate, PrintTemplateType } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
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

export function TemplatesPanel() {
  const { printTemplates } = useCatalogStore();
  const [editingId, setEditingId] = useState<string | null>(null);

  const editing = printTemplates.find((t) => t.id === editingId) ?? null;

  const ordered = [...printTemplates].sort(
    (a, b) => TYPE_ORDER.indexOf(a.type) - TYPE_ORDER.indexOf(b.type)
  );

  if (editing) {
    return (
      <TemplateEditor template={editing} onClose={() => setEditingId(null)} />
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

      <div className="mt-5 flex flex-col gap-2">
        {ordered.map((t) => (
          <TemplateRow key={t.id} template={t} onEdit={() => setEditingId(t.id)} />
        ))}
      </div>
    </section>
  );
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
    <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-foreground/10 bg-black/20 px-4 py-3">
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
                className="rounded-full bg-sky-400/10 px-2 py-0.5 text-[11px] font-medium text-sky-300"
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
