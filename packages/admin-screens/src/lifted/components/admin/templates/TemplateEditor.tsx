import { useAdminScreenRuntime } from '../../../runtime/AdminScreenRuntime';
import { useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import { ArrowDown, ArrowLeft, Check, ChevronDown, CircleCheck, Eye, EyeOff, FlaskConical, Printer, SlidersHorizontal, Undo2 } from "lucide-react";
import { Button } from "../../ui/button";
import { type PrintTemplate } from "../../../model/types";
import { useCatalogStore } from "../../../runtime/AdminScreenRuntime";
import { useStation } from "../../../runtime/AdminScreenRuntime";

import { isApiError } from "../../../api/client";
import { NotSavedNotice } from "../NotSavedNotice";
import { Field, TextInput } from "../discounts/fields";
import { PrintTemplatePreviewWithPorts } from "./PrintTemplatePreview";
import { CHROME_META, FIELD_META, TEMPLATE_TYPE_META, editorGroups, moreOptions, type EditorGroup, type EditorRow, type TemplateFieldKey } from "./templateFields";
import { fromApi, isDirty, saveBarView, saveBody, testPrintOutcome, type OutcomeTone } from "./templateDraft";
import { useUnsavedChangesPrompt } from "./useUnsavedChangesPrompt";
import { DEFAULT_PREVIEW_SAMPLE, PREVIEW_SAMPLES, type PreviewSampleId } from "./previewSamples";
import { type TestPrintTarget } from "./templatesApi";
import { useCareCapabilities, type TemplateEditorPorts } from '../../../runtime/care';

interface TemplateEditorProps {
  template: PrintTemplate;
  /** True when this row came from the platform and can really be saved. */
  live?: boolean;
  onSaved?: () => void | Promise<void>;
  onClose: () => void;
}

/** Where a test print would come out, as far as this screen knows. */
type Destination =
  | { state: 'loading' }
  | { state: 'known'; target: TestPrintTarget }
  | { state: 'unknown' };

/**
 * One template's content, redesigned around the preview (SCRUM-472).
 *
 * The controls are grouped the way the paper is laid out — Top, Body, Bottom,
 * or for a band Identity, Safety, Entry — and every section is an eye rather
 * than a switch: what it does is show or hide a part of the printout, and the
 * picture beside it changes the moment it is pressed. Nothing is stored until
 * Save, and the save bar appears only while there is something to save.
 *
 * Routing (which printer) is NOT here — that lives in Station Setup. The Test
 * print names the printer routing chose, so nobody walks to the wrong counter
 * for the paper, but it does not choose it.
 */
export function TemplateEditor(props: TemplateEditorProps) {
  const runtime = useAdminScreenRuntime();
  const printApi = runtime.api.platform.printApi;
  const templatesApi = runtime.api.platform.templatesApi;

  const { mutators } = useCatalogStore();
  const { station } = useStation();
  const stationId = station?.stationId ?? null;
  const owner = runtime.session?.operator;
  const branchId = runtime.branch?.branch?.apiId;
  const scope = useCareCapabilities(runtime.transport, owner?.id, props.live === true, owner, branchId);
  const api = useMemo(() => ({ ...printApi, ...templatesApi }), [printApi, templatesApi]);
  return <TemplateEditorWithPorts {...props} key={`${owner?.id ?? ''}:${branchId ?? ''}:${props.template.id}`} ports={{
    api, stationId, canEdit: scope.canEditTemplates, canTestPrint: scope.canTestPrint,
    authorityMessage: scope.authorityMessage, updateLocalTemplate: mutators.upsertPrintTemplate,
  }} />;
}

export function TemplateEditorWithPorts({ template, live = false, onSaved, onClose, ports }: TemplateEditorProps & { ports: TemplateEditorPorts }) {
  const printApi = ports.api;
  const templatesApi = ports.api;
  const stationId = ports.stationId;
  const canEdit = ports.canEdit !== false;
  const manageRef = useRef(canEdit);
  manageRef.current = canEdit;
  const canPrintRef = useRef(ports.canTestPrint === true);
  canPrintRef.current = ports.canTestPrint === true;
  const mounted = useRef(true);
  const busyRef = useRef(false);
  const printingRef = useRef(false);
  const draftEpoch = useRef(0);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  /** The template as last loaded or saved — what Discard goes back to. */
  const [loaded, setLoaded] = useState<PrintTemplate>(template);
  const [draft, setDraft] = useState<PrintTemplate>(template);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  /** Set when somebody tries to leave with unsaved changes: the bar asks them to choose. */
  const [nudge, setNudge] = useState(false);
  const [showMore, setShowMore] = useState(false);
  const [sample, setSample] = useState<PreviewSampleId>(DEFAULT_PREVIEW_SAMPLE);
  const [printing, setPrinting] = useState(false);
  const [outcome, setOutcome] = useState<{ tone: OutcomeTone; text: string } | null>(null);
  const [destination, setDestination] = useState<Destination>({ state: 'loading' });

  const meta = TEMPLATE_TYPE_META[draft.type];
  const groups = editorGroups(draft.type);
  const extras = moreOptions(draft.type);
  const dirty = isDirty(loaded, draft);
  const nameError = draft.name.trim() ? '' : 'Name is required.';
  const busy = saving || printing;
  const bar = saveBarView({ dirty, saving, saveError });

  // A reload or a closed tab asks first while there is something unsaved.
  useUnsavedChangesPrompt(dirty);

  // A name left empty is the one error on this screen, and it lives behind
  // "More options" — open it rather than leave the Save refused for no
  // visible reason.
  useEffect(() => {
    if (nameError) setShowMore(true);
  }, [nameError]);

  // Back to the saved template — by Discard, by a save, or by flipping the
  // change back by hand — and there is nothing left to nudge about or to have
  // failed at saving.
  useEffect(() => {
    if (dirty) return;
    setNudge(false);
    setSaveError(null);
  }, [dirty]);

  useEffect(() => {
    if (!justSaved) return;
    const t = setTimeout(() => setJustSaved(false), 4000);
    return () => clearTimeout(t);
  }, [justSaved]);

  // Where a test print from this station would come out — asked once, not on
  // every preview, because it does not depend on the draft.
  useEffect(() => {
    if (!live) {
      setDestination({ state: 'unknown' });
      return;
    }
    let cancelled = false;
    setDestination({ state: 'loading' });
    templatesApi
      .testPrintTarget(template.id, stationId)
      .then((target) => {
        if (!cancelled) setDestination({ state: 'known', target });
      })
      .catch(() => {
        // A deployment without the route, or a refusal: the button still
        // prints, it just cannot say where in advance.
        if (!cancelled) setDestination({ state: 'unknown' });
      });
    return () => {
      cancelled = true;
    };
  }, [live, template.id, stationId, templatesApi]);

  const editDraft = (update: (value: PrintTemplate) => PrintTemplate) => {
    if (!manageRef.current) return;
    draftEpoch.current++;
    setDraft(update);
  };
  const setField = (key: TemplateFieldKey, value: boolean) =>
    editDraft((d) => ({ ...d, fields: { ...d.fields, [key]: value } }));

  /** Store the draft. True when it was stored; the error is on the bar when not. */
  const persist = async (): Promise<boolean> => {
    if (!mounted.current || !manageRef.current || busyRef.current) return false;
    if (nameError) {
      setShowMore(true);
      setSaveError(nameError);
      return false;
    }
    const sent = draft;
    busyRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      let next: PrintTemplate;
      if (live) {
        const { template: saved } = await printApi.updateTemplate(draft.id, saveBody(draft));
        next = fromApi(saved);
      } else {
        // The built-in set, on a deployment whose API does not carry these rows.
        next = { ...draft, name: draft.name.trim() };
        ports.updateLocalTemplate?.(next);
      }
      if (!mounted.current || !manageRef.current) return false;
      setLoaded(next);
      // Anything typed while the save was in flight stays on screen, unsaved.
      setDraft((current) => (isDirty(sent, current) ? current : next));
      setJustSaved(true);
      // A confirmed template write is not repeated because its list refresh failed.
      try {
        const refresh = onSaved?.();
        if (refresh) void refresh.catch(() => {
          if (mounted.current) setSaveError('The template was saved, but the list could not be refreshed.');
        });
      } catch {
        setSaveError('The template was saved, but the list could not be refreshed.');
      }
      return true;
    } catch (err) {
      if (mounted.current) setSaveError(isApiError(err) ? err.message : 'The template could not be saved.');
      return false;
    } finally {
      busyRef.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const discard = () => {
    setDraft(loaded);
    setSaveError(null);
    setNudge(false);
  };

  const leave = () => {
    if (dirty) {
      setNudge(true);
      return;
    }
    onClose();
  };

  const known = destination.state === 'known' ? destination.target : null;
  const destinationLabel = known?.printer?.label ?? null;
  /** The platform said, before anyone pressed anything, that nothing would print. */
  const noPrinter = !!known && !known.printer;
  const destinationText = !live
    ? 'Needs a connected branch'
    : destination.state === 'loading'
      ? 'Finding this station’s printer…'
      : known
        ? known.printer
          ? `to ${known.printer.label}`
          : (known.note ?? 'No printer is assigned for this printout')
        : 'to this station’s printer';

  /**
   * Print this template's sample on a real printer.
   *
   * It goes through the platform and out to the box, where `@oto/print` turns
   * the template into dots. The preview is a PNG the same package rendered from
   * the same fixture sample, so the two are one drawing path and this button
   * is a proof rather than a comparison of two drawings.
   *
   * It prints what is SAVED, so with changes on the screen it saves them first
   * — the button says so. The box prints from the templates it cached at its
   * last config pull, so the platform queues a pull ahead of the print whenever
   * the box has not confirmed the configuration it would be handed now, and
   * the box's command poll hands the two out in that order (`requestTestPrint`
   * and `pollCommands` on the API). That is what makes the paper the draft the
   * person is looking at rather than the template before the save. It prints
   * the Test print's own sample whichever scenario the preview shows. The job
   * is queued and the answer is immediate: a printer that is out of paper
   * holds the job and prints it when the roll is changed.
   */
  const testPrint = async () => {
    if (busy || busyRef.current || printingRef.current || !live || !mounted.current || !canPrintRef.current || dirty && !manageRef.current) return;
    const epoch = draftEpoch.current;
    printingRef.current = true;
    setOutcome(null);
    try {
      if (dirty && !(await persist())) return;
      if (!mounted.current || !canPrintRef.current || draftEpoch.current !== epoch) return;
      setPrinting(true);
      const { printJob } = await printApi.testPrint(draft.id, { stationId });
      if (mounted.current && canPrintRef.current) setOutcome(testPrintOutcome(printJob, destinationLabel));
    } catch (err) {
      if (mounted.current) setOutcome({
        tone: 'error',
        text: isApiError(err) ? err.message : 'The test print could not be sent.',
      });
    } finally {
      printingRef.current = false;
      if (mounted.current) setPrinting(false);
    }
  };

  const testPrintBar = (
    <div className="flex flex-col gap-1.5 px-1 pb-0.5">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          className="bg-white"
          onClick={() => void testPrint()}
          disabled={busy || !live || noPrinter || !ports.canTestPrint || dirty && !canEdit}
          title={
            !live || noPrinter ? destinationText : 'Print the Test print sample on this station’s printer'
          }
        >
          <Printer className="h-4 w-4" />
          {printing ? 'Sending…' : dirty ? 'Save & print test' : 'Print test'}
        </Button>
        <span
          title={destinationText}
          className={`min-w-0 flex-1 truncate text-[11px] ${
            noPrinter ? 'text-amber-700' : 'text-stone-500'
          }`}
        >
          {destinationText}
        </span>
      </div>
      {ports.authorityMessage && <p className="mt-3 text-sm text-foreground/60">{ports.authorityMessage}</p>}
      {outcome && (
        <div
          role="status"
          className={`text-[11px] leading-snug ${
            outcome.tone === 'ok'
              ? 'text-emerald-700'
              : outcome.tone === 'warn'
                ? 'text-amber-700'
                : 'text-destructive'
          }`}
        >
          {outcome.text}
        </div>
      )}
    </div>
  );

  return (
    <section className="rounded-3xl border border-primary/30 bg-primary/[0.06] p-5 sm:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" onClick={leave} aria-label="Back to all templates">
          <ArrowLeft className="h-4 w-4" />
          All templates
        </Button>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-2xl bg-foreground/5 text-foreground/80">
          <meta.icon className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-lg font-bold">{loaded.name || meta.label}</h2>
            <span className="rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] font-semibold text-foreground/60">
              {meta.label}
            </span>
            {justSaved && !dirty && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700">
                <CircleCheck className="h-3.5 w-3.5" />
                Saved
              </span>
            )}
          </div>
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

      {/* The preview column takes half the width, never under the 300px it
          had nor over 460px (SCRUM-470). Below lg the halves stack, controls
          first, with a link down to the preview. */}
      <div className="mt-5 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_clamp(300px,50%,460px)]">
        <fieldset className="flex flex-col gap-4" disabled={!canEdit}>
          <a
            href="#template-preview"
            className="inline-flex items-center gap-1.5 self-start text-xs font-semibold text-primary lg:hidden"
          >
            <ArrowDown className="h-3.5 w-3.5" />
            Jump to the preview
          </a>

          {groups.map((group) => (
            <GroupCard key={group.id} group={group} draft={draft}>
              {group.rows.map((row) => (
                <RowControl
                  key={rowKey(row)}
                  row={row}
                  draft={draft}
                  onLogo={(v) => editDraft((d) => ({ ...d, showLogo: v }))}
                  onText={(which, v) => editDraft((d) => ({ ...d, [which]: v || undefined }))}
                  onField={setField}
                />
              ))}
            </GroupCard>
          ))}

          {/* ONE disclosure: what is rarely touched folds here rather than
              sitting in the way of what is. */}
          <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02]">
            <button
              type="button"
              aria-expanded={showMore}
              aria-controls="tpl-more"
              onClick={() => setShowMore((v) => !v)}
              className="flex w-full items-center gap-3 px-4 py-3 text-left"
            >
              <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-foreground/5 text-foreground/60">
                <SlidersHorizontal className="h-4 w-4" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-semibold">More options</span>
                <span className="block text-xs text-foreground/45">
                  {extras.includes('footerText') ? 'Template name, footer text' : 'Template name'}
                </span>
              </span>
              <ChevronDown
                className={`h-4 w-4 text-foreground/40 transition-transform ${showMore ? 'rotate-180' : ''}`}
              />
            </button>
            {showMore && (
              <div id="tpl-more" className="flex flex-col gap-4 border-t border-foreground/10 px-4 py-4">
                <Field
                  label="Template name"
                  htmlFor="tpl-name"
                  error={nameError}
                  hint="How this template is listed here. It is not printed."
                >
                  <TextInput
                    id="tpl-name"
                    value={draft.name}
                    invalid={!!nameError}
                    placeholder="Standard receipt"
                    onChange={(e) => editDraft((d) => ({ ...d, name: e.target.value }))}
                  />
                </Field>
                {extras.includes('footerText') && (
                  <Field
                    label="Footer text"
                    htmlFor="tpl-footer"
                    hint="Kept with the template. The band layout does not print a footer."
                  >
                    <TextInput
                      id="tpl-footer"
                      value={draft.footerText ?? ''}
                      placeholder="Thank you · Tax ID…"
                      onChange={(e) =>
                        editDraft((d) => ({ ...d, footerText: e.target.value || undefined }))
                      }
                    />
                  </Field>
                )}
              </div>
            )}
          </div>
        </fieldset>

        {/* Live preview */}
        <div id="template-preview" className="scroll-mt-20 lg:sticky lg:top-20 lg:self-start">
          <div className="mb-2 flex items-center justify-between gap-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-foreground/40">
              Live preview
            </span>
            {/* The scenario the platform fills the preview with (SCRUM-472).
                Names only — the samples are the renderer's. */}
            <label className="inline-flex min-w-0 items-center gap-1.5 text-xs text-foreground/50">
              <FlaskConical className="h-3.5 w-3.5 shrink-0" />
              <span className="sr-only">Sample</span>
              <select
                value={sample}
                disabled={!live}
                onChange={(e) => setSample(e.target.value as PreviewSampleId)}
                title={PREVIEW_SAMPLES.find((s) => s.id === sample)?.hint}
                className="h-8 min-w-0 rounded-full border border-foreground/10 bg-foreground/[0.02] px-3 text-xs font-semibold text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 disabled:opacity-50"
              >
                {PREVIEW_SAMPLES.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <PrintTemplatePreviewWithPorts
            ports={ports.api}
            template={draft}
            live={live}
            stationId={stationId}
            sample={sample}
            footer={testPrintBar}
          />
          {sample !== DEFAULT_PREVIEW_SAMPLE && (
            <p className="mt-2 text-center text-[11px] text-foreground/40">
              A test print uses the Test print sample, whichever scenario is shown here.
            </p>
          )}
        </div>
      </div>

      {/* The save bar: only while there is something to save (SCRUM-472). It
          replaces the always-there Save and Cancel, so an untouched template
          shows nothing to press. A touched one is held on "All templates"
          (the bar is nudged) and on a reload or a closed tab (the browser
          asks); switching Admin panel is not seen from here. */}
      {bar.shown && (
        <div className="sticky bottom-4 z-20 mt-5">
          <div
            role="region"
            aria-label="Unsaved changes"
            className={`flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl border bg-background/95 px-4 py-3 shadow-xl shadow-black/10 backdrop-blur ${
              nudge ? 'border-primary ring-2 ring-primary/40' : 'border-foreground/10'
            }`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full bg-amber-500" aria-hidden />
            <span className="text-sm font-semibold">Unsaved changes</span>
            {bar.error ? (
              <span className="text-xs font-medium text-destructive">{bar.error}</span>
            ) : nudge ? (
              <span className="text-xs text-foreground/60">Save or discard them to leave.</span>
            ) : null}
            <div className="ml-auto flex gap-2">
              <Button variant="ghost" size="sm" onClick={discard} disabled={busy}>
                <Undo2 className="h-4 w-4" />
                Discard
              </Button>
              <Button size="sm" onClick={() => void persist()} disabled={!!nameError || busy || !canEdit}>
                <Check className="h-4 w-4" />
                {saving ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function rowKey(row: EditorRow): string {
  return row.kind === 'field' ? row.key : row.kind === 'text' ? row.which : 'logo';
}

/** Is this row's part of the paper printed? Text rows count when not empty. */
function rowShown(row: EditorRow, draft: PrintTemplate): boolean | null {
  if (row.kind === 'logo') return draft.showLogo;
  if (row.kind === 'field') return !!draft.fields[row.key];
  return null;
}

function GroupCard({
  group,
  draft,
  children,
}: {
  group: EditorGroup;
  draft: PrintTemplate;
  children: ReactNode;
}) {
  const toggles = group.rows
    .map((row) => rowShown(row, draft))
    .filter((v): v is boolean => v !== null);
  const shown = toggles.filter(Boolean).length;
  return (
    <div className="rounded-2xl border border-foreground/10 bg-foreground/[0.02]">
      <div className="flex items-center gap-3 px-4 pb-2 pt-3">
        <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-primary/10 text-primary">
          <group.icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold">{group.title}</div>
          <div className="text-xs text-foreground/45">{group.caption}</div>
        </div>
        {toggles.length > 1 && (
          <span className="shrink-0 rounded-full bg-foreground/5 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-foreground/55">
            {shown} of {toggles.length} shown
          </span>
        )}
      </div>
      <div className="divide-y divide-foreground/[0.06] border-t border-foreground/10">{children}</div>
    </div>
  );
}

function RowControl({
  row,
  draft,
  onLogo,
  onText,
  onField,
}: {
  row: EditorRow;
  draft: PrintTemplate;
  onLogo: (v: boolean) => void;
  onText: (which: 'headerText' | 'footerText', v: string) => void;
  onField: (key: TemplateFieldKey, v: boolean) => void;
}) {
  if (row.kind === 'logo') {
    const m = CHROME_META.logo;
    return (
      <EyeRow
        icon={m.icon}
        label={m.label}
        hint={m.hint}
        visible={draft.showLogo}
        onToggle={() => onLogo(!draft.showLogo)}
      />
    );
  }
  if (row.kind === 'field') {
    const m = FIELD_META[row.key];
    const visible = !!draft.fields[row.key];
    return (
      <EyeRow
        icon={m.icon}
        label={m.label}
        hint={m.hint}
        visible={visible}
        onToggle={() => onField(row.key, !visible)}
      />
    );
  }
  const m = CHROME_META[row.which];
  const id = row.which === 'headerText' ? 'tpl-header' : 'tpl-footer';
  const Icon = m.icon;
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-foreground/5 text-foreground/60">
        <Icon className="h-4 w-4" />
      </span>
      <div className="min-w-0 flex-1">
        <label htmlFor={id} className="block text-sm font-medium text-foreground">
          {m.label}
        </label>
        <span className="block text-xs text-foreground/45">{m.hint}</span>
        <TextInput
          id={id}
          className="mt-2"
          value={draft[row.which] ?? ''}
          placeholder={row.which === 'headerText' ? 'Oto Play Park' : 'Thank you · Tax ID…'}
          onChange={(e) => onText(row.which, e.target.value)}
        />
      </div>
    </div>
  );
}

/**
 * A part of the paper, with an eye: open, it prints; closed, it does not, and
 * the row dims. The whole row is the control — a large target on an iPad —
 * and the preview beside it redraws the moment it is pressed.
 */
function EyeRow({
  icon: Icon,
  label,
  hint,
  visible,
  onToggle,
}: {
  icon: ComponentType<{ className?: string }>;
  label: string;
  hint: string;
  visible: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={visible}
      aria-label={`${label} on the printout`}
      title={visible ? 'Shown — press to hide it from the printout' : 'Hidden — press to print it'}
      onClick={onToggle}
      className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-foreground/[0.03] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/50"
    >
      <span
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-foreground/5 transition-colors ${
          visible ? 'text-foreground/70' : 'text-foreground/25'
        }`}
      >
        <Icon className="h-4 w-4" />
      </span>
      <span className={`min-w-0 flex-1 transition-opacity ${visible ? '' : 'opacity-45'}`}>
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-foreground/50">{hint}</span>
      </span>
      <span
        aria-hidden
        className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full transition-colors ${
          visible ? 'bg-primary/10 text-primary' : 'bg-foreground/5 text-foreground/35'
        }`}
      >
        {visible ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
      </span>
    </button>
  );
}
