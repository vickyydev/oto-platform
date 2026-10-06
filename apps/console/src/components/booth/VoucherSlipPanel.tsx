import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Receipt, RotateCcw } from 'lucide-react';
import { CONTROL } from '@/components/Filters';
import { Drawer } from '@/components/Drawer';
import { CheckRow, ChoiceRow, Field, TextInput } from '@/components/Form';
import { ErrorNote } from '@/components/Panel';
import { StatusChip } from '@/components/redesign/chips';
import { CardShell, Eyebrow, FactLine, FactList, RailNote } from '@/components/redesign/layout';
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
  slipSummary,
  SLIP_STANDING,
  slipStanding,
  type VoucherSlipEdit,
} from './voucherSlip';

/**
 * The booth's own voucher slip (SCRUM-471): what the paper a child takes to
 * reception shows, set per booth.
 *
 * On the approved sheet (SCRUM-474, Main.dc.html) the slip is a card in the
 * rail — the saved slip drawn small, what it prints in a line, and one button
 * — and the choices are made in a drawer, the way the booth's settings and its
 * prizes are: the rail is a third of the page, and a form with a 288-pixel
 * paper beside it does not fit in a third of anything. The form is the one
 * that sat on the page before, field for field, with the paper drawn beside
 * it as it is typed.
 *
 * Both draw the slip with the platform's `@oto/print` renderer — the one the
 * box prints with. Saving writes the booth's draft through the settings route
 * like every other booth setting, and the booth prints it only once a version
 * carrying it is published and its box has taken that version; the card says
 * so, and its chip says where the slip stands against the PUBLISHED wheel —
 * never that the booth is printing it, which only the box's own report (The
 * box card) can say.
 *
 * On the page's card language: what it prints is a fact line, as the same
 * summary is on the Publish review; the sentence about saving and publishing
 * is the rail's quiet foot note, as on The box.
 */
export function VoucherSlipPanel({
  draft,
  readOnly = false,
  onOpen,
  id,
  className,
}: {
  draft: BoothDraft;
  /** The caller may read this booth but not change it. */
  readOnly?: boolean;
  /** Opens the drawer (`VoucherSlipEditor`), which the page renders. */
  onOpen: () => void;
  id?: string;
  className?: string;
}) {
  const saved = useMemo(() => slipFromSettings(draft.settings), [draft.settings]);

  if (saved === null) {
    return (
      <CardShell id={id} className={className} icon={Receipt} title="Voucher slip">
        <p className="text-sm text-muted-foreground">
          This deployment does not have the booth’s own voucher slip yet. The booth prints the slip
          every booth prints: the logo, the prize, the code, the Staff row and the terms.
        </p>
      </CardShell>
    );
  }

  const standing = SLIP_STANDING[slipStanding(saved, draft)];
  const prints = slipSummary(draft.settings);

  return (
    <CardShell
      id={id}
      className={className}
      icon={Receipt}
      title="Voucher slip"
      badge={<StatusChip tone={standing.tone}>{standing.label}</StatusChip>}
    >
      <div className="flex items-center gap-4">
        <SlipPreview boothId={draft.booth.id} slip={slipInput(saved)} compact />
        <div className="flex min-w-0 flex-1 flex-col gap-3">
          {prints && (
            <FactList>
              <FactLine label="Prints">{prints}</FactLine>
            </FactList>
          )}
          <Button
            variant="outline"
            size="sm"
            className="self-start rounded-full border-primary px-4 font-bold text-primary-ink"
            onClick={onOpen}
          >
            {readOnly ? 'View slip' : 'Customise slip'}
          </Button>
        </div>
      </div>
      <RailNote>
        The logo, a header line, a footer line, the Staff row and the terms are this booth’s own;
        the prize’s words come from its voucher type. Saved to the booth’s draft, and printed
        after the next publish, once its box has taken that version.
      </RailNote>
    </CardShell>
  );
}

/**
 * The slip's choices, in the drawer the card's "Customise slip" opens.
 *
 * The same fields, checks and Save as when the form sat on the page. The
 * page closes the drawer once a save has been accepted and the booth read
 * again; a refused save keeps it open with the refusal at the top.
 */
export function VoucherSlipEditor({
  draft,
  readOnly = false,
  saving,
  error,
  onSave,
  onClose,
}: {
  draft: BoothDraft;
  /** The caller may read this booth but not change it. */
  readOnly?: boolean;
  saving: boolean;
  error: string | null;
  onSave: (slip: VoucherSlipInput) => void;
  onClose: () => void;
}) {
  const saved = useMemo(() => slipFromSettings(draft.settings), [draft.settings]);
  const [edit, setEdit] = useState<VoucherSlipEdit | null>(saved);

  /**
   * A fresh read of the booth replaces the form only when the SAVED SLIP
   * changed — a save here, or a colleague's. Every other write on the page
   * (a prize, a publish) re-reads the draft too, and an edit in progress in
   * this drawer must not vanish because somebody re-weighted a slice.
   */
  const savedKey = JSON.stringify(saved === null ? null : savedSlip(draft.settings));
  useEffect(() => {
    setEdit(slipFromSettings(draft.settings));
    // Keyed on the saved slip alone, for the reason above: `draft.settings`
    // is a new object on every read of the booth.
  }, [savedKey]);

  if (saved === null || edit === null) return null;

  const dirty = slipDirty(edit, draft.settings);
  const problems = slipProblems(edit);
  const standing = SLIP_STANDING[slipStanding(edit, draft)];
  const set = (next: Partial<VoucherSlipEdit>) => setEdit({ ...edit, ...next });
  const locked = readOnly || saving;

  return (
    <Drawer
      title="Voucher slip"
      subtitle={`${draft.booth.name} · What this booth’s printed voucher shows. The prize’s words come from its voucher type.`}
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center gap-2">
          {!readOnly && (
            <>
              <Button
                className="rounded-full px-4 font-bold"
                onClick={() => onSave(slipInput(edit))}
                disabled={!dirty || saving || problems.header !== undefined || problems.footer !== undefined}
              >
                {saving ? 'Saving…' : 'Save slip'}
              </Button>
              {dirty && (
                <Button
                  variant="outline"
                  className="rounded-full px-4"
                  onClick={() => setEdit(slipFromSettings(draft.settings))}
                  disabled={saving}
                >
                  <RotateCcw className="w-4 h-4" />
                  Discard
                </Button>
              )}
            </>
          )}
          <Button variant="outline" className="rounded-full px-4" onClick={onClose}>
            {readOnly ? 'Close' : 'Cancel'}
          </Button>
          <span className="text-xs text-muted-foreground">
            {readOnly ? (
              <>
                Changing it needs <code className="font-mono">admin:booth:manage</code>.
              </>
            ) : (
              'Saved to this booth’s draft; the booth prints it after the next publish, once its box has taken that version.'
            )}
          </span>
        </div>
      }
    >
      {error && <ErrorNote message={error} />}
      <div>
        <StatusChip tone={standing.tone}>{standing.label}</StatusChip>
      </div>

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
              <span className="text-status-down">{problems.header}</span>
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
              <span className="text-status-down">{problems.footer}</span>
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
      </div>

      <SlipPreview boothId={draft.booth.id} slip={slipInput(edit)} />
    </Drawer>
  );
}

/**
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

/** The card's thumbnail: the paper at the artboard's width, in screen pixels. */
const THUMBNAIL_PX = 124;

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
 * `compact` is the card's thumbnail of the SAVED slip: no zoom, no caption.
 *
 * The paper is a 1-bit PNG with its own white, so the surface under it is the
 * card's and never a colour of its own; the frame around it is the same faint
 * wash the drawer's preview and every striped row use.
 */
function SlipPreview({
  boothId,
  slip,
  compact = false,
}: {
  boothId: string;
  slip: VoucherSlipInput;
  compact?: boolean;
}) {
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

  if (compact) {
    return (
      <div className="shrink-0 rounded-[12px] border border-border bg-foreground/[0.025] p-1">
        {picture ? (
          <img
            src={picture.url}
            alt="A sample of this booth’s voucher slip"
            width={THUMBNAIL_PX}
            style={{ width: `${THUMBNAIL_PX}px`, maxWidth: 'none' }}
            className={cn('block bg-card shadow-sm', drawing && 'opacity-60')}
          />
        ) : (
          <div
            className="flex items-center justify-center px-2 text-center text-[11px] text-muted-foreground"
            style={{ width: `${THUMBNAIL_PX}px`, height: '160px' }}
          >
            {failed ?? 'Drawing the slip…'}
          </div>
        )}
      </div>
    );
  }

  const scale = ZOOMS.find((z) => z.id === zoom)?.scale ?? 0.5;
  const fitWidth = (picture?.dots ?? 576) * 0.5;

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <Eyebrow>Preview · 80 mm</Eyebrow>
        <ChoiceRow
          value={zoom}
          onChange={(v) => setZoom(v as Zoom)}
          options={ZOOMS.map((z) => ({ value: z.id, label: z.label }))}
        />
      </div>
      <div className="relative rounded-[14px] border border-border bg-foreground/[0.025] p-4 overflow-auto max-h-[640px]">
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
            className={cn('mx-auto block bg-card shadow-sm', drawing && 'opacity-60')}
          />
        ) : (
          <div
            className="mx-auto flex items-center justify-center bg-card/70 text-xs text-muted-foreground"
            style={{ width: `${fitWidth}px`, height: '420px', maxWidth: '100%' }}
          >
            {failed ? null : 'Drawing the slip…'}
          </div>
        )}
        {drawing && (
          <Loader2 className="absolute right-3 top-3 w-4 h-4 animate-spin text-muted-foreground" />
        )}
      </div>
      {failed && <p className="text-xs text-status-down">{failed}</p>}
      <RailNote>A sample: the prize, code, branch and staff are placeholders.</RailNote>
    </div>
  );
}
