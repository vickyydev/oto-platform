import { AlertTriangle, StickyNote, ShieldAlert, Wallet } from 'lucide-react';
import type { PrintTemplate } from '@/types';
import { Barcode } from '@/components/till/Barcode';
import { QrCode } from '@/components/till/QrCode';
import { roundTHB } from '@/lib/tax';
import { APPLICABLE_FIELDS, type TemplatePreviewData } from './templateFields';

interface PrintTemplatePreviewProps {
  template: PrintTemplate;
  data: TemplatePreviewData;
}

const Divider = () => <div className="my-2 border-t border-dashed border-black/30" />;

/**
 * A faux printout that renders exactly the sections the active template
 * enables. Used in the Admin editor with sample data so staff can see the
 * effect of every toggle. Pure presentational — drives off `template.fields`.
 *
 * Wristbands render as a thin watch-band-width strip (not a receipt): the OTO
 * mark/branding is pre-printed on the physical band, codes are 1D barcodes, and
 * everything prints in black ink only.
 */
export function PrintTemplatePreview({ template, data }: PrintTemplatePreviewProps) {
  const f = template.fields;
  // A field only renders if it's both applicable to this type AND toggled on.
  const applicable = new Set(APPLICABLE_FIELDS[template.type]);
  const on = (key: keyof PrintTemplate['fields']) =>
    applicable.has(key) && !!f[key];

  const isWristband =
    template.type === 'kids_wristband' || template.type === 'adult_wristband';

  if (isWristband) {
    const timeBits = [
      on('startEndTime') && data.startEndTime,
      on('durationTime') && data.duration,
    ].filter(Boolean) as string[];
    const metaBits = [
      on('partyName') && data.partyName,
      on('dietaryRequirement') && data.dietaryRequirement,
    ].filter(Boolean) as string[];

    return (
      <div className="mx-auto w-full max-w-[300px]">
        {/* A thin wristband. OTO name + logo are pre-printed on the band, so
            they're never rendered here. Black ink only. */}
        <div className="relative flex items-center gap-2.5 rounded-2xl bg-stone-50 px-3 py-2.5 font-mono text-stone-900 shadow-xl shadow-black/40 ring-1 ring-black/10">
          {/* Fastening end (physical band feature, not printed content) */}
          <div className="flex shrink-0 flex-col items-center justify-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-stone-300 ring-1 ring-stone-400/60" />
            <span className="h-1.5 w-1.5 rounded-full bg-stone-300 ring-1 ring-stone-400/60" />
          </div>

          {/* Printed content */}
          <div className="min-w-0 flex-1 space-y-1 text-[11px] leading-tight">
            {on('holderName') && data.holderName && (
              <div className="truncate text-[13px] font-bold">{data.holderName}</div>
            )}

            {on('supervisionBadge') && data.supervisionMode && (
              <div className="inline-flex items-center gap-1 rounded bg-stone-900 px-1.5 py-0.5 text-[10px] font-black tracking-widest text-stone-50">
                <ShieldAlert className="h-3 w-3 shrink-0" />
                {data.supervisionMode}
              </div>
            )}

            {timeBits.length > 0 && (
              <div className="font-semibold">{timeBits.join(' · ')}</div>
            )}

            {metaBits.length > 0 && (
              <div className="text-stone-700">{metaBits.join(' · ')}</div>
            )}

            {on('assignedNannyName') && data.assignedNannyName && (
              <div className="text-stone-700">Nanny: {data.assignedNannyName}</div>
            )}

            {on('allergyLine') && data.allergy && (
              <div className="inline-flex items-start gap-1 rounded border border-stone-900 px-1.5 py-0.5 text-[10px] font-bold">
                <AlertTriangle className="mt-px h-3 w-3 shrink-0" />
                ALLERGY: {data.allergy}
              </div>
            )}
          </div>

          {/* Barcode (fits a thin band far better than a square QR) */}
          {on('qr') && (
            <div className="flex shrink-0 flex-col items-center gap-0.5">
              <Barcode seed={data.qrSeed} className="h-11 w-14" />
              <span className="text-[8px] tracking-[0.25em] text-stone-600">SCAN</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  // ── Credit voucher ───────────────────────────────────────────────────────
  if (template.type === 'credit_voucher') {
    const creditAmt = 150; // sample amount for preview
    return (
      <div className="mx-auto w-[280px] max-w-full rounded-lg bg-stone-50 px-5 py-4 font-mono text-[12px] leading-snug text-stone-900 shadow-xl shadow-black/40 ring-1 ring-black/10">
        <div className="text-center">
          {template.showLogo && (
            <div className="mx-auto mb-1.5 flex h-9 w-9 items-center justify-center rounded-full bg-stone-900 text-[11px] font-black text-stone-50">
              oto
            </div>
          )}
          {template.headerText && (
            <div className="text-sm font-bold tracking-wide">{template.headerText}</div>
          )}
          <div className="text-[11px] uppercase tracking-widest text-stone-500">Credit Voucher</div>
        </div>

        {on('creditVoucherBalance') && (
          <>
            <Divider />
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1 text-stone-500">
                <Wallet className="h-3 w-3" />
                Credit loaded
              </span>
              <span className="font-black tabular-nums text-sm">฿{creditAmt}</span>
            </div>
            <div className="mt-0.5 text-[10px] text-stone-500">Scan wristband or QR at the F&B counter to spend.</div>
          </>
        )}

        {on('creditVoucherQr') && (
          <>
            <Divider />
            <div className="flex flex-col items-center gap-1">
              <QrCode seed="QR-wb-sample-1" />
              <div className="text-[10px] text-stone-500">QR-wb-sample-1</div>
            </div>
          </>
        )}

        {template.footerText && (
          <>
            <Divider />
            <div className="text-center text-[11px] text-stone-600">{template.footerText}</div>
          </>
        )}
      </div>
    );
  }

  const isReceipt = template.type === 'receipt';
  const isPrep =
    template.type === 'kitchen_ticket' || template.type === 'bar_ticket';

  return (
    <div className="mx-auto w-[280px] max-w-full rounded-lg bg-stone-50 px-5 py-4 font-mono text-[12px] leading-snug text-stone-900 shadow-xl shadow-black/40 ring-1 ring-black/10">
      {/* Header / logo */}
      <div className="text-center">
        {template.showLogo && (
          <div className="mx-auto mb-1.5 flex h-9 w-9 items-center justify-center rounded-full bg-stone-900 text-[11px] font-black text-stone-50">
            oto
          </div>
        )}
        {template.headerText && (
          <div className="text-sm font-bold tracking-wide">{template.headerText}</div>
        )}
        <div className="text-[11px] uppercase tracking-widest text-stone-500">
          {data.title}
        </div>
      </div>

      {/* Order ref + time (prep tickets) */}
      {isPrep && on('orderRefTime') && (
        <>
          <Divider />
          <div className="flex items-center justify-between font-bold">
            <span>#{data.orderRef}</span>
            <span>{data.time}</span>
          </div>
        </>
      )}

      {/* Holder name */}
      {on('holderName') && data.holderName && (
        <div className="mt-1">
          <span className="text-stone-500">For </span>
          <span className="font-bold">{data.holderName}</span>
        </div>
      )}

      {/* Allergy alert */}
      {on('allergyLine') && data.allergy && (
        <div className="mt-2 flex items-start gap-1 rounded border border-black/40 bg-stone-200 px-2 py-1 text-[11px] font-bold">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          <span>ALLERGY: {data.allergy}</span>
        </div>
      )}

      {/* Itemized lines */}
      {on('itemizedLines') && data.lines.length > 0 && (
        <>
          <Divider />
          <div className="space-y-1">
            {data.lines.map((l) => (
              <div key={l.id}>
                <div className="flex items-baseline justify-between gap-2">
                  <span className="min-w-0">
                    <span className="font-bold">{l.qty}×</span> {l.name}
                  </span>
                  {isReceipt && typeof l.price === 'number' && (
                    <span className="tabular-nums">฿{l.price}</span>
                  )}
                </div>
                {/* Item notes ride with the lines, gated by orderNotes (prep). */}
                {l.note && (isReceipt || on('orderNotes')) && (
                  <div className="flex items-start gap-1 pl-3 text-[11px] text-stone-600">
                    <StickyNote className="mt-0.5 h-3 w-3 shrink-0" />
                    {l.note}
                  </div>
                )}
              </div>
            ))}
          </div>
        </>
      )}

      {/* Tax / service breakdown (receipt) */}
      {on('taxServiceBreakdown') && (
        <>
          <Divider />
          <div className="space-y-0.5">
            <MoneyRow label="Subtotal" value={data.subtotal} />
            {data.service > 0 && <MoneyRow label="Service" value={data.service} />}
            {data.tax > 0 && <MoneyRow label="VAT (incl.)" value={data.tax} />}
            <div className="mt-1 flex items-center justify-between border-t border-black/30 pt-1 text-sm font-black">
              <span>TOTAL</span>
              <span className="tabular-nums">฿{data.total}</span>
            </div>
          </div>
        </>
      )}

      {/* Credit grant info (receipt) */}
      {on('voucherInfo') && data.creditGrants.length > 0 && (
        <>
          <Divider />
          <div className="text-[11px]">
            <div className="font-bold uppercase tracking-wide text-stone-500">
              Credit issued
            </div>
            <ul className="mt-0.5 space-y-0.5">
              {data.creditGrants.map((v, i) => (
                <li key={i}>• {v}</li>
              ))}
            </ul>
          </div>
        </>
      )}

      {/* Order note (prep) */}
      {isPrep && on('orderNotes') && data.orderNote && (
        <>
          <Divider />
          <div className="flex items-start gap-1 text-[11px]">
            <StickyNote className="mt-0.5 h-3 w-3 shrink-0" />
            <span>{data.orderNote}</span>
          </div>
        </>
      )}

      {/* Footer */}
      {template.footerText && (
        <>
          <Divider />
          <div className="text-center text-[11px] text-stone-600">
            {template.footerText}
          </div>
        </>
      )}
    </div>
  );
}

function MoneyRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-stone-600">{label}</span>
      <span className="tabular-nums">฿{roundTHB(value)}</span>
    </div>
  );
}
