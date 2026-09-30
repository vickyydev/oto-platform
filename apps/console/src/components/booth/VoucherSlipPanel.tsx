import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RotateCcw } from 'lucide-react';
import { CONTROL } from '@/components/Filters';
import { CheckRow, ChoiceRow, Field, TextInput } from '@/components/Form';
import { ErrorNote, Panel } from '@/components/Panel';
import { StatusPill } from '@/components/Status';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ApiError, boothApi, isMissingRoute, type BoothDraft, type VoucherSlipInput } from './boothApi';
import {
  BOOTH_VOUCHER_FOOTER_MAX_CHARS,
  BOOTH_VOUCHER_HEADER_MAX_CHARS,
  savedSlip,
  slipDirty,
  slipFromSettings,
  slipInput,
  slipProblems,
  SLIP_STANDING,
  slipStanding,
  type VoucherSlipEdit,
} from './voucherSlip';

/**
 * The booth's own voucher slip (SCRUM-471): what the paper a child takes to
 * reception shows, set per booth.
 *
 * The choices on the left, the slip on the right, drawn by the platform's
 * `@oto/print` renderer — the one the box prints with — from the choices as
 * they are on screen, saved or not. Saving writes the booth's draft through
 * the settings route like every other booth setting, and the booth prints it
 * only once a version carrying it is published and its box has taken that
 * version; the card says so in one line and its chip says where the slip
 * stands against the PUBLISHED wheel — never that the booth is printing it,
 * which only the box's own report ("What this booth is running") can say.
 *
 * The preview follows the till's template editor (`PrintTemplatePreview.tsx`
 * in `apps/pos`): it asks once typing stops, aborts a drawing an edit has
 * overtaken, keeps the last picture on screen while the next is drawn, and
 * shows the paper at a whole-number scale of its dots so a one-dot rule is
 * never dropped between two screen pixels.
 */
const DEBOUNCE_MS = 350;

type Zoom = 'fit' | 'full';
const ZOOMS: ReadonlyArray<{ id: Zoom; label: string; scale: number }> = [
  { id: 'fit', label: 'Fit', scale: 0.5 },
  { id: 'full', label: '100%', scale: 1 },
];

export function VoucherSlipPanel({
  draft,
  readOnly = false,
  saving,
  error,
  onSave,
}: {
  draft: BoothDraft;
  /** The caller may read this booth but not change it. */
  readOnly?: boolean;
  saving: boolean;
  error: string | null;
  onSave: (slip: VoucherSlipInput) => void;
}) {
  const saved = useMemo(() => slipFromSettings(draft.settings), [draft.settings]);
  const [edit, setEdit] = useState<VoucherSlipEdit | null>(saved);

  /**
   * A fresh read of the booth replaces the form only when the SAVED SLIP
   * changed — a save here, or a colleague's. Every other write on the page
   * (a prize, a publish) re-reads the draft too, and an edit in progress on
   * this card must not vanish because somebody re-weighted a slice.
   */
  const savedKey = JSON.stringify(saved === null ? null : savedSlip(draft.settings));
  useEffect(() => {
    setEdit(slipFromSettings(draft.settings));
    // Keyed on the saved slip alone, for the reason above: `draft.settings`
    // is a new object on every read of the booth.
  }, [savedKey]);

  if (saved === null || edit === null) {
    return (
      <Panel title="Voucher slip" description="What this booth’s printed voucher shows.">
        <p className="text-sm text-muted-foreground">
          This deployment does not have the booth’s own voucher slip yet. The booth prints the slip
          every booth prints: the logo, the prize, the code, the Staff row and the terms.
        </p>
      </Panel>
    );
  }

  const dirty = slipDirty(edit, draft.settings);
  const problems = slipProblems(edit);
  const standing = SLIP_STANDING[slipStanding(edit, draft)];
  const set = (next: Partial<VoucherSlipEdit>) => setEdit({ ...edit, ...next });
  const locked = readOnly || saving;

  return (
    <Panel
      title="Voucher slip"
      description="What this booth’s printed voucher shows. The prize’s words come from its voucher type."
      actions={<StatusPill tone={standing.tone}>{standing.label}</StatusPill>}
    >
      {error && <ErrorNote message={error} />}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_auto]">
        <div className="flex flex-col gap-4 min-w-0">
          <div className="flex flex-col">
            <CheckRow
              checked={edit.showLogo}
              disabled={locked}
              onChange={(showLogo) => set({ showLogo })}
              label="Print the logo"
              detail="The park’s mark at the top. Leave it off on paper that comes pre-printed with it."
            />
            <CheckRow
              checked={edit.showStaff}
              disabled={locked}
              onChange={(showStaff) => set({ showStaff })}
              label="Print the Staff row"
              detail="Who was signed in when the prize was won — “unattributed” when nobody was."
            />
            <CheckRow
              checked={edit.showTerms}
              disabled={locked}
              onChange={(showTerms) => set({ showTerms })}
              label="Print the terms"
              detail="The voucher type’s terms at the foot. “Single use” always prints."
            />
          </div>

          <Field
            label="Header line"
            hint={
              problems.header ? (
                <span style={{ color: 'hsl(var(--status-down))' }}>{problems.header}</span>
              ) : (
                `A line of its own under the park’s name, which always prints. ${edit.headerText.trim().length}/${BOOTH_VOUCHER_HEADER_MAX_CHARS}.`
              )
            }
          >
            <TextInput
              value={edit.headerText}
              disabled={locked}
              placeholder="No header line"
              onChange={(headerText) => set({ headerText })}
            />
          </Field>

          <Field
            label="Footer line"
            hint={
              problems.footer ? (
                <span style={{ color: 'hsl(var(--status-down))' }}>{problems.footer}</span>
              ) : (
                `The last line on the slip. ${edit.footerText.trim().length}/${BOOTH_VOUCHER_FOOTER_MAX_CHARS}.`
              )
            }
          >
            <textarea
              value={edit.footerText}
              disabled={locked}
              rows={3}
              placeholder="No footer line"
              onChange={(e) => set({ footerText: e.target.value })}
              className={cn(CONTROL, 'h-auto py-2 leading-snug resize-y disabled:opacity-60')}
            />
          </Field>

          {!readOnly && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => onSave(slipInput(edit))}
                disabled={!dirty || saving || problems.header !== undefined || problems.footer !== undefined}
              >
                {saving ? 'Saving…' : 'Save slip'}
              </Button>
              {dirty && (
                <Button variant="outline" onClick={() => setEdit(slipFromSettings(draft.settings))} disabled={saving}>
                  <RotateCcw className="w-4 h-4" />
                  Discard
                </Button>
              )}
            </div>
          )}
          <p className="text-xs text-muted-foreground">
            Saved to this booth’s draft; the booth prints it after the next publish, once its box has
            taken that version — “What this booth is running” shows which version that is.
            {readOnly && (
              <>
                {' '}
                Changing it needs <code className="font-mono">admin:booth:manage</code>.
              </>
            )}
          </p>
        </div>

        <SlipPreview boothId={draft.booth.id} slip={slipInput(edit)} />
      </div>
    </Panel>
  );
}

/** A drawn slip and its width in dots, which is its width in pixels. */
interface Picture {
  url: string;
  dots: number;
}

/**
 * The sample slip, drawn by the platform from the choices on screen.
 *
 * The prize, the code, the branch and the member of staff on it are
 * placeholders the API supplies; only the booth's five choices come from here.
 */
function SlipPreview({ boothId, slip }: { boothId: string; slip: VoucherSlipInput }) {
  const request = JSON.stringify(slip);
  const [picture, setPicture] = useState<Picture | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [zoom, setZoom] = useState<Zoom>('fit');
  /** The object URL on screen, released when it is replaced. */
  const held = useRef<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setDrawing(true);
      void (async () => {
        try {
          const drawn = await boothApi.voucherPreview(
            boothId,
            JSON.parse(request) as VoucherSlipInput,
            controller.signal,
          );
          if (controller.signal.aborted) return;
          const url = URL.createObjectURL(drawn.blob);
          if (held.current) URL.revokeObjectURL(held.current);
          held.current = url;
          setPicture({ url, dots: drawn.widthDots });
          setFailed(null);
        } catch (err) {
          if (controller.signal.aborted) return;
          setFailed(
            isMissingRoute(err)
              ? 'This deployment cannot draw the slip yet.'
              : err instanceof ApiError
                ? err.message
                : 'The preview could not be drawn.',
          );
        } finally {
          if (!controller.signal.aborted) setDrawing(false);
        }
      })();
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [boothId, request]);

  // Release the last picture when the card goes.
  useEffect(
    () => () => {
      if (held.current) URL.revokeObjectURL(held.current);
    },
    [],
  );

  const scale = ZOOMS.find((z) => z.id === zoom)?.scale ?? 0.5;
  const fitWidth = (picture?.dots ?? 576) * 0.5;

  return (
    <div className="flex flex-col gap-2 min-w-0 lg:w-[calc(288px+2rem)]">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-foreground/45">
          Preview · 80 mm
        </span>
        <ChoiceRow
          value={zoom}
          onChange={(v) => setZoom(v as Zoom)}
          options={ZOOMS.map((z) => ({ value: z.id, label: z.label }))}
        />
      </div>
      <div className="relative rounded-xl border bg-muted/30 p-4 overflow-auto max-h-[640px]">
        {picture ? (
          <img
            src={picture.url}
            alt="A sample of this booth’s voucher slip"
            width={Math.round(picture.dots * scale)}
            style={{
              width: `${picture.dots * scale}px`,
              maxWidth: 'none',
              imageRendering: scale >= 1 ? 'pixelated' : 'auto',
            }}
            className={cn('mx-auto block bg-white shadow-sm', drawing && 'opacity-60')}
          />
        ) : (
          <div
            className="mx-auto flex items-center justify-center bg-white/70 text-xs text-muted-foreground"
            style={{ width: `${fitWidth}px`, height: '420px', maxWidth: '100%' }}
          >
            {failed ? null : 'Drawing the slip…'}
          </div>
        )}
        {drawing && (
          <Loader2 className="absolute right-3 top-3 w-4 h-4 animate-spin text-muted-foreground" />
        )}
      </div>
      {failed && <p className="text-xs" style={{ color: 'hsl(var(--status-down))' }}>{failed}</p>}
      <p className="text-xs text-muted-foreground">
        A sample: the prize, code, branch and staff are placeholders.
      </p>
    </div>
  );
}
