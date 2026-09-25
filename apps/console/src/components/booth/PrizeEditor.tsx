import { useState } from 'react';
import { Link } from 'wouter';
import { formatTHB } from '@oto/shared';
import { Drawer } from '@/components/Drawer';
import { Button } from '@/components/ui/button';
import { CheckRow, Field, NumberInput, Select, TextInput } from '@/components/Form';
import { ErrorNote, RouteUnavailable } from '@/components/Panel';
import { StatusPill } from '@/components/Status';
import type { BoothPrizeDraft, VoucherDefinitionRow } from './boothApi';
import {
  formatBp,
  formatGap,
  hundredthsToText,
  parseBahtToSatang,
  parsePercentToBp,
  weightVerdict,
} from './odds';
import { notSetUp, worthOf } from './voucherTypes';

/**
 * One slice, open for editing.
 *
 * Two things this form does that a plain set of inputs would not:
 *
 *   - **It takes a percentage and stores basis points.** Nobody is asked to
 *     multiply by a hundred. The integer that will be stored is shown beside
 *     the field, so the conversion is visible rather than magic, and the text
 *     is parsed digit by digit (`parsePercentToBp`) so "0.07" is 7 basis
 *     points and not 7.000000000000001.
 *   - **It says what the change does to the whole wheel, while it is being
 *     typed.** A weight is not a property of one prize — it is a share of
 *     10,000 — so a form that only validates the field in front of somebody is
 *     letting them make the one mistake this page exists to prevent.
 *
 * What it does NOT do is decide whether the change is allowed. Saving a draft
 * is deliberately permissive: a half-made prize with no voucher behind it can
 * be saved and come back to. It is PUBLISHING that is refused, by the publish
 * panel and then, authoritatively, by the API.
 */
export function PrizeEditor({
  prize,
  siblings,
  voucherDefinitions,
  saving,
  saveUnavailable,
  readOnly = false,
  error,
  onSave,
  onArchive,
  onClose,
}: {
  /** The prize being edited. A new prize arrives with an empty id. */
  prize: BoothPrizeDraft;
  /** Every other prize on this booth, for the live weight total. */
  siblings: readonly BoothPrizeDraft[];
  voucherDefinitions: readonly VoucherDefinitionRow[];
  saving: boolean;
  /**
   * The API half has not shipped here; the form is shown and cannot save.
   * A permission must never be passed here — "not deployed" is a claim about
   * the server, and somebody who simply may not edit this booth would be told
   * something untrue about it. That is `readOnly`.
   */
  saveUnavailable: boolean;
  /** The caller may read this booth but not change it. */
  readOnly?: boolean;
  error: string | null;
  onSave: (next: BoothPrizeDraft) => void;
  onArchive: (prize: BoothPrizeDraft) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState<BoothPrizeDraft>(prize);
  const [weightText, setWeightText] = useState(() => hundredthsToText(prize.weightBp));
  const [costText, setCostText] = useState(() => hundredthsToText(prize.costSatang));
  const [confirmArchive, setConfirmArchive] = useState(false);

  const weightBp = parsePercentToBp(weightText);
  const costSatang = parseBahtToSatang(costText);
  const isNew = prize.id === '';
  const chosenDefinition = voucherDefinitions.find((d) => d.id === draft.voucherDefinitionId);

  // The wheel as it would be with this edit applied — the number that actually
  // matters while somebody is typing a weight.
  const after = weightVerdict([
    ...siblings,
    { ...draft, weightBp: weightBp ?? 0, costSatang: costSatang ?? 0 },
  ]);

  const nameGiven = draft.nameEn.trim().length > 0;
  const canSave =
    !saving && !saveUnavailable && !readOnly && nameGiven && weightBp !== null && costSatang !== null;

  const save = () => {
    if (!canSave || weightBp === null || costSatang === null) return;
    onSave({ ...draft, nameEn: draft.nameEn.trim(), weightBp, costSatang });
  };

  return (
    <Drawer
      title={isNew ? 'New prize' : draft.nameEn || 'Prize'}
      subtitle={
        isNew
          ? 'It joins the wheel when the next version is published, not when it is saved.'
          : 'Saved changes reach the booth only when a new version is published.'
      }
      onClose={onClose}
      footer={
        <div className="flex flex-wrap items-center gap-2 justify-between">
          {!isNew ? (
            confirmArchive ? (
              <div className="flex items-center gap-2">
                <span className="text-sm">Take it off the wheel?</span>
                <Button variant="destructive" size="sm" onClick={() => onArchive(draft)} disabled={saving}>
                  Archive
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setConfirmArchive(false)}>
                  Keep
                </Button>
              </div>
            ) : (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setConfirmArchive(true)}
                disabled={saving || saveUnavailable || readOnly}
              >
                Archive prize
              </Button>
            )
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={save} disabled={!canSave}>
              {saving ? 'Saving…' : isNew ? 'Add prize' : 'Save'}
            </Button>
          </div>
        </div>
      }
    >
      <div className="flex flex-col gap-4">
        {saveUnavailable && (
          <RouteUnavailable
            what="Saving a prize"
            detail="The prize editor is built and the API route it writes to is not deployed here yet — SCRUM-200. Everything below reads and calculates; the Save button stays closed until that route lands."
          />
        )}
        {error && <ErrorNote message={error} />}

        <Field label="Name (English)" hint="What the voucher and every report call it.">
          <TextInput
            value={draft.nameEn}
            onChange={(nameEn) => setDraft({ ...draft, nameEn })}
            maxLength={120}
            placeholder="100 baht voucher"
          />
        </Field>

        <Field label="Name (Thai)" hint="Printed beside the English on the voucher.">
          <TextInput
            value={draft.nameTh ?? ''}
            onChange={(v) => setDraft({ ...draft, nameTh: v.trim() === '' ? null : v })}
            maxLength={120}
          />
        </Field>

        <Field
          label="Slice label"
          hint="The short text on the wedge itself — “100 ฿”. Left empty, the wedge shows the English name, which may not fit."
        >
          <TextInput
            value={draft.wheelLabel ?? ''}
            onChange={(v) => setDraft({ ...draft, wheelLabel: v.trim() === '' ? null : v })}
            maxLength={40}
          />
        </Field>

        <Field
          label="Chance"
          hint={
            weightBp === null ? (
              <span style={{ color: 'hsl(var(--status-down))' }}>
                A percentage between 0 and 100, with at most two decimals.
              </span>
            ) : (
              <>Stored as {weightBp.toLocaleString()} basis points.</>
            )
          }
        >
          <div className="flex items-center gap-2">
            <TextInput value={weightText} onChange={setWeightText} placeholder="23.5" />
            <span className="text-sm text-muted-foreground shrink-0">%</span>
          </div>
        </Field>

        {/*
          The consequence, on the screen, while it is being typed. A weight is
          a share of 10,000 and no field-level validation can see that.
        */}
        <div className="rounded-xl border px-3.5 py-3 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <span className="text-sm font-medium">With this change the wheel adds to</span>
          {after.balanced ? (
            <StatusPill tone="ok">100% — publishable</StatusPill>
          ) : (
            <>
              <StatusPill tone="down">{formatBp(after.totalBp)}</StatusPill>
              <span className="text-xs text-muted-foreground">{formatGap(after.differenceBp)}</span>
            </>
          )}
          <span className="text-xs text-muted-foreground w-full">
            Across {after.activeCount} active prize{after.activeCount === 1 ? '' : 's'}. A draft that
            does not add to 100% can be saved; it cannot be published.
          </span>
        </div>

        <CheckRow
          checked={draft.active}
          onChange={(active) => setDraft({ ...draft, active })}
          label="On the wheel"
          detail="Switched off, it is not drawn and not shown. Re-balance the others to 100% before publishing: a wheel is published only when the prizes switched on add up to exactly 100%."
        />

        <Field
          label="Voucher"
          hint={
            <>
              {chosenDefinition ? (
                <>
                  {worthOf(chosenDefinition)}.
                  {notSetUp(chosenDefinition) && (
                    <span style={{ color: 'hsl(var(--status-warn))' }}> {notSetUp(chosenDefinition)}</span>
                  )}{' '}
                </>
              ) : (
                'What winning it produces at the park. A prize with none cannot be published. '
              )}
              {/* Voucher types are the operator's, set up on their own page (SCRUM-400). */}
              <Link href="/voucher-types" className="underline underline-offset-4">
                Set up voucher types
              </Link>
            </>
          }
        >
          <Select
            value={draft.voucherDefinitionId ?? ''}
            onChange={(v) => setDraft({ ...draft, voucherDefinitionId: v === '' ? null : v })}
            placeholder="— none chosen —"
            // Live types to choose from, and the one this prize points at even if
            // it has since been archived, named as such rather than hidden.
            options={voucherDefinitions
              .filter((d) => !d.archivedAt || d.id === draft.voucherDefinitionId)
              .map((d) => ({
                value: d.id,
                label: d.archivedAt
                  ? `${d.nameEn} (${d.code}) — archived`
                  : d.active
                    ? `${d.nameEn} (${d.code})`
                    : `${d.nameEn} (${d.code}) — switched off`,
              }))}
          />
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            label="Cost to the park"
            hint={
              costSatang === null ? (
                <span style={{ color: 'hsl(var(--status-down))' }}>Baht, at most two decimals.</span>
              ) : costSatang === 0 ? (
                'Zero reads as “not costed yet” on this page, not as free.'
              ) : (
                <>{formatTHB(costSatang)} each time it is won.</>
              )
            }
          >
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground shrink-0">฿</span>
              <TextInput value={costText} onChange={setCostText} placeholder="100" />
            </div>
          </Field>

          <Field label="Wheel order" hint="Low numbers first, clockwise from the top.">
            <NumberInput
              value={draft.sortOrder}
              min={0}
              onChange={(v) => setDraft({ ...draft, sortOrder: v ?? 0 })}
            />
          </Field>

          <Field
            label="Daily cap"
            hint="Left empty it is uncapped. At its cap the prize leaves the draw for the rest of the trading day and the others renormalise — the wheel keeps spinning."
          >
            <NumberInput
              value={draft.dailyCap}
              min={1}
              placeholder="no cap"
              onChange={(dailyCap) => setDraft({ ...draft, dailyCap })}
            />
          </Field>

          <Field
            label="Expires after"
            hint={
              draft.expiryDays !== null ? (
                'Days after the day it is won. The slip prints the last day, and the voucher is good to the end of that day in the park’s time zone.'
              ) : chosenDefinition?.expiryDays != null ? (
                <>Left empty, it takes the voucher’s own {chosenDefinition.expiryDays} days.</>
              ) : chosenDefinition ? (
                'That voucher never expires, and neither will this prize unless a number is set here.'
              ) : (
                'Days. Left empty it takes the voucher definition’s own expiry.'
              )
            }
          >
            <NumberInput
              value={draft.expiryDays}
              min={1}
              placeholder={
                chosenDefinition?.expiryDays != null
                  ? `${chosenDefinition.expiryDays} from the voucher`
                  : chosenDefinition
                    ? 'never, from the voucher'
                    : 'from the voucher'
              }
              onChange={(expiryDays) => setDraft({ ...draft, expiryDays })}
            />
          </Field>

          <Field label="Slice colour" hint="Left empty it takes the layout's palette for this position.">
            <TextInput
              value={draft.sliceColor ?? ''}
              onChange={(v) => setDraft({ ...draft, sliceColor: v.trim() === '' ? null : v.trim() })}
              placeholder="#E23B3B"
              maxLength={32}
            />
          </Field>

          <Field label="Label colour" hint="The text on the wedge.">
            <TextInput
              value={draft.textColor ?? ''}
              onChange={(v) => setDraft({ ...draft, textColor: v.trim() === '' ? null : v.trim() })}
              placeholder="#111111"
              maxLength={32}
            />
          </Field>
        </div>

        <p className="text-xs text-muted-foreground">
          Archiving a prize takes it off the wheel and keeps it: every spin that ever won it still
          points at this row, so last month’s report can still name what somebody won.
        </p>
      </div>
    </Drawer>
  );
}
