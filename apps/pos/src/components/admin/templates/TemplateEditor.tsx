import { useState } from 'react';
import { Check, X, Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { PrintTemplate } from '@/types';
import { useCatalogStore } from '@/store/CatalogStoreContext';
import { useStation } from '@/station/StationContext';
import { printApi } from '@/api/platform';
import { ApiError } from '@/api/client';
import { NotSavedNotice } from '../NotSavedNotice';
import { Field, TextInput } from '../discounts/fields';
import { PrintTemplatePreview } from './PrintTemplatePreview';
import { APPLICABLE_FIELDS, FIELD_META, TEMPLATE_TYPE_META } from './templateFields';

interface TemplateEditorProps {
  template: PrintTemplate;
  /** True when this row came from the platform and can really be saved. */
  live?: boolean;
  onSaved?: () => void;
  onClose: () => void;
}

// Edit one template's content config with a side-by-side live preview. Routing
// (which printer) is NOT here — that lives in Station Setup. Content only.
export function TemplateEditor({
  template,
  live = false,
  onSaved,
  onClose,
}: TemplateEditorProps) {
  const { mutators } = useCatalogStore();
  const { station } = useStation();
  const [draft, setDraft] = useState<PrintTemplate>(template);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const meta = TEMPLATE_TYPE_META[draft.type];
  const fieldKeys = APPLICABLE_FIELDS[draft.type];
  const nameError = draft.name.trim() ? '' : 'Name is required.';
  // Wristbands carry pre-printed OTO branding on the physical band, so the
  // logo / header controls don't apply to them.
  const isBand =
    draft.type === 'kids_wristband' || draft.type === 'adult_wristband';

  const setField = (key: keyof PrintTemplate['fields'], value: boolean) =>
    setDraft((d) => ({ ...d, fields: { ...d.fields, [key]: value } }));

  const save = async () => {
    if (nameError || busy) return;
    if (!live) {
      // The built-in set, on a deployment whose API does not carry these rows.
      mutators.upsertPrintTemplate({ ...draft, name: draft.name.trim() });
      onClose();
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      await printApi.updateTemplate(draft.id, {
        name: draft.name.trim(),
        showLogo: draft.showLogo,
        headerText: draft.headerText ?? null,
        footerText: draft.footerText ?? null,
        fields: draft.fields,
      });
      onSaved?.();
      onClose();
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'The template could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  /**
   * Print this template's sample on a real printer.
   *
   * It goes through the platform and out to the box, where `@oto/print` turns
   * the template into dots. The preview on the right is a PNG the same package
   * rendered from the same fixture sample, so the two are one drawing path and
   * this button is a proof rather than a comparison of two drawings — which is
   * the only way it means anything. What can still differ is the paper: the
   * preview is laid out for the printer this test would route to, and a
   * template with no printer assigned falls back to the default width for its
   * kind.
   *
   * It prints what is SAVED. The job is queued and the answer is immediate: a
   * printer that is out of paper holds the job and prints it when the roll is
   * changed, and saying "queued" is the truth, not a hedge.
   */
  const testPrint = async () => {
    if (busy) return;
    if (!live) {
      setNotice('Connect this branch to the platform to print a test.');
      return;
    }
    setBusy(true);
    setNotice(null);
    try {
      const { printJob } = await printApi.testPrint(draft.id, {
        stationId: station?.stationId ?? null,
      });
      setNotice(
        printJob.status === 'skipped'
          ? `Not printed — ${printJob.errorMessage ?? 'no printer is assigned for this printout'}.`
          : `Sent to ${printJob.deviceLabel ?? 'the assigned printer'}. Unsaved changes on this screen are not in it.`,
      );
    } catch (err) {
      setNotice(err instanceof ApiError ? err.message : 'The test print could not be sent.');
    } finally {
      setBusy(false);
    }
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

      {/* A template row that did not come from the platform can only be edited
          in memory — the same editor, a different Save. Say which one this is
          before the person fills the form in. */}
      {!live && (
        <div className="mt-4">
          <NotSavedNotice
            mutators={['upsertPrintTemplate']}
            what="this built-in template, which the platform does not hold"
          />
        </div>
      )}

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
          <PrintTemplatePreview
            template={draft}
            live={live}
            stationId={station?.stationId ?? null}
          />
        </div>
      </div>

      {notice && (
        <div
          role="status"
          className="mt-4 rounded-2xl border border-foreground/10 bg-black/20 px-4 py-3 text-sm text-foreground/70"
        >
          {notice}
        </div>
      )}

      <div className="mt-5 flex flex-wrap justify-end gap-2">
        {/* UI addition (S2-06): the prototype had no way to put a template on
            paper. It sits beside Cancel rather than next to Save because it
            prints what is SAVED, not what is on this screen. */}
        <Button
          variant="outline"
          size="sm"
          className="mr-auto"
          onClick={() => void testPrint()}
          disabled={busy || !live}
          title={live ? 'Print the sample on this station’s printer' : 'Needs a connected branch'}
        >
          <Printer className="h-4 w-4" />
          Test print
        </Button>
        <Button variant="outline" size="sm" onClick={onClose} disabled={busy}>
          <X className="h-4 w-4" />
          Cancel
        </Button>
        <Button size="sm" onClick={() => void save()} disabled={!!nameError || busy}>
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
