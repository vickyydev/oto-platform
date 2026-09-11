import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PrintTemplate } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { Field, TextInput } from '../discounts/fields';
import { PrintTemplatePreview } from './PrintTemplatePreview';
import {
  APPLICABLE_FIELDS,
  FIELD_META,
  TEMPLATE_TYPE_META,
  sampleDataFor,
} from './templateFields';

interface TemplateEditorProps {
  template: PrintTemplate;
  onClose: () => void;
}

// Edit one template's content config with a side-by-side live preview. Routing
// (which printer) is NOT here — that lives in Station Setup. Content only.
export function TemplateEditor({ template, onClose }: TemplateEditorProps) {
  const { mutators } = useCatalogStore();
  const [draft, setDraft] = useState<PrintTemplate>(template);

  const meta = TEMPLATE_TYPE_META[draft.type];
  const fieldKeys = APPLICABLE_FIELDS[draft.type];
  const nameError = draft.name.trim() ? '' : 'Name is required.';
  // Wristbands carry pre-printed OTO branding on the physical band, so the
  // logo / header controls don't apply to them.
  const isBand =
    draft.type === 'kids_wristband' || draft.type === 'adult_wristband';

  const setField = (key: keyof PrintTemplate['fields'], value: boolean) =>
    setDraft((d) => ({ ...d, fields: { ...d.fields, [key]: value } }));

  const save = () => {
    if (nameError) return;
    mutators.upsertPrintTemplate({ ...draft, name: draft.name.trim() });
    onClose();
  };

  return (
    <section className="rounded-3xl border border-primary/30 bg-primary/[0.06] p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-2xl bg-foreground/5 text-foreground/80">
          <meta.icon className="h-5 w-5" />
        </span>
        <div className="min-w-0">
          <h2 className="text-lg font-bold">{meta.label}</h2>
          <p className="truncate text-sm text-foreground/50">{meta.blurb}</p>
        </div>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-[1fr_300px]">
        {/* Form */}
        <div className="flex flex-col gap-4">
          <Field label="Template name" htmlFor="tpl-name" error={nameError}>
            <TextInput
              id="tpl-name"
              value={draft.name}
              invalid={!!nameError}
              placeholder="Standard receipt"
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </Field>

          {!isBand && (
            <>
              <ToggleRow
                label="Show logo"
                hint="Print the Oto mark at the top."
                checked={draft.showLogo}
                onChange={(v) => setDraft({ ...draft, showLogo: v })}
              />

              <Field label="Header text" htmlFor="tpl-header">
                <TextInput
                  id="tpl-header"
                  value={draft.headerText ?? ''}
                  placeholder="Oto Play Park"
                  onChange={(e) =>
                    setDraft({ ...draft, headerText: e.target.value || undefined })
                  }
                />
              </Field>
            </>
          )}

          <Field label="Footer text" htmlFor="tpl-footer">
            <TextInput
              id="tpl-footer"
              value={draft.footerText ?? ''}
              placeholder="Thank you · Tax ID…"
              onChange={(e) =>
                setDraft({ ...draft, footerText: e.target.value || undefined })
              }
            />
          </Field>

          <div className="border-t border-foreground/10 pt-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-foreground/50">
              Sections
            </div>
            <div className="flex flex-col gap-3">
              {fieldKeys.map((key) => (
                <ToggleRow
                  key={key}
                  label={FIELD_META[key].label}
                  hint={FIELD_META[key].hint}
                  checked={!!draft.fields[key]}
                  onChange={(v) => setField(key, v)}
                />
              ))}
            </div>
          </div>
        </div>

        {/* Live preview */}
        <div className="lg:sticky lg:top-4 lg:self-start">
          <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-foreground/40">
            Live preview
          </div>
          <PrintTemplatePreview template={draft} data={sampleDataFor(draft.type)} />
        </div>
      </div>

      <div className="mt-5 flex justify-end gap-2">
        <Button variant="outline" size="sm" onClick={onClose}>
          <X className="h-4 w-4" />
          Cancel
        </Button>
        <Button size="sm" onClick={save} disabled={!!nameError}>
          <Check className="h-4 w-4" />
          Save changes
        </Button>
      </div>
    </section>
  );
}

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onChange(!checked)}
      className="flex items-start justify-between gap-3 rounded-2xl border border-foreground/10 bg-black/20 px-4 py-3 text-left transition-colors hover:border-foreground/25"
    >
      <span className="min-w-0">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-foreground/45">{hint}</span>
      </span>
      <span
        className={`mt-0.5 inline-flex h-6 w-11 shrink-0 items-center rounded-full px-0.5 transition-colors ${
          checked ? 'bg-primary' : 'bg-foreground/15'
        }`}
        role="switch"
        aria-checked={checked}
      >
        <span
          className={`h-5 w-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-5' : 'translate-x-0'
          }`}
        />
      </span>
    </button>
  );
}
