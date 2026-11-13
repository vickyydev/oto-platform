import { useMemo, useState } from 'react';
import { PARTY_KITCHEN_READ_ONLY, PARTY_NOT_ON_TILL_MENU, type PartyKitchenChoicesAnswer, type PartyKitchenPlan } from '@oto/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { QuantityStepper } from '@/components/shared/QuantityStepper';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Cake, GlassWater, Plus, Trash2, UtensilsCrossed } from 'lucide-react';
import {
  addedKitchenLine,
  kitchenChoiceOptions,
  kitchenLineChoosable,
  kitchenLineEditable,
  kitchenLineRemovable,
  kitchenMenuMatches,
  kitchenServiceNeeded,
  type KitchenDraft,
  type KitchenDraftLine,
  type KitchenDraftList,
  type KitchenMenuPick,
} from '@/lib/partyKitchenEdit';
import { Field, Grid2, Section } from './partyEditParts';

/**
 * SCRUM-907 — THE PARTY EDIT FORM'S KITCHEN AND BAR SECTIONS, FROM THE BEO.
 *
 * The prototype's two sections (its "Kitchen plan" card with the cake, its
 * "Bar plan" card), filled from the kitchen plan the till reads (SCRUM-906)
 * instead of the prototype's own lists, in the same cards, fields, steppers
 * and dashed "Add item" buttons. A manager or an admin changes a line's count
 * and note, adds a line (picked from the till's menu with its code, or typed),
 * removes an EXTRA, changes a set-menu choice within its group and the cake's
 * time and note; Save writes them to the BEO. Everyone else sees the same
 * sections read-only, with one line saying a manager changes them. What the
 * till does not change here (the food and bar times, the set menu itself, the
 * cake's kind and count) is shown as the BEO has it, read-only.
 */

interface Props {
  plan: Pick<PartyKitchenPlan, 'setMenu' | 'barItems' | 'cake' | 'kitchen'>;
  draft: KitchenDraft;
  onChange: (next: KitchenDraft) => void;
  readOnly: boolean;
  /** The set menu's choice groups from the OTO App; null while asked, or when the form may not change them. */
  choices: PartyKitchenChoicesAnswer | null;
  /** The till's own menu, by name and code, for the picker. */
  menu: readonly KitchenMenuPick[];
}

/** A read-only line's name box: the dish and its chosen option, as the party page names them. */
function lineLabel(l: KitchenDraftLine): string {
  return [l.name, l.chosenOption].filter((x): x is string => !!x).join(' · ');
}

/**
 * SCRUM-967 — the slip's marks for a read-only line, said whole on a line of
 * their own under its name box, in the box's hint style: a one-line box cut a
 * long dish's "adults" or "not on the till menu" off at its edge.
 */
function lineMarks(l: KitchenDraftLine): string | null {
  const marks = [
    l.audience === 'kids' ? 'kids only' : l.audience === 'adults' ? 'adults' : null,
    l.onTillMenu === false && !(l.choiceGroup && !l.chosenOption) ? PARTY_NOT_ON_TILL_MENU : null,
  ].filter((x): x is string => !!x);
  return marks.length > 0 ? marks.join(' · ') : null;
}

/** The name box of a line added here: typed, or picked from the till's menu (its name and code). */
function MenuPickInput({
  line,
  menu,
  onPick,
}: {
  line: KitchenDraftLine;
  menu: readonly KitchenMenuPick[];
  onPick: (patch: Pick<KitchenDraftLine, 'name' | 'productCode' | 'onTillMenu'>) => void;
}) {
  const [open, setOpen] = useState(false);
  const matches = useMemo(() => (open && !line.productCode ? kitchenMenuMatches(menu, line.name) : []), [open, line.name, line.productCode, menu]);
  return (
    <div className="relative flex-1 min-w-0">
      <Input
        value={line.name}
        placeholder="Item name"
        aria-label={line.list === 'bar' ? 'New bar item' : 'New food item'}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => onPick({ name: e.target.value, productCode: null, onTillMenu: false })}
      />
      {matches.length > 0 && (
        <div className="absolute z-20 left-0 right-0 mt-1 rounded-lg border bg-background shadow-lg overflow-hidden">
          {matches.map((m) => (
            <button
              key={m.code}
              type="button"
              className="w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                onPick({ name: m.name, productCode: m.code, onTillMenu: true });
                setOpen(false);
              }}
            >
              <span className="truncate">{m.name}</span>
              <span className="text-xs text-muted-foreground shrink-0">{m.code}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LineRows({
  list,
  label,
  draft,
  onChange,
  readOnly,
  choices,
  menu,
}: Omit<Props, 'plan'> & { list: KitchenDraftList; label: string }) {
  const lines = draft.lines.filter((l) => l.list === list && !l.removed);
  const update = (key: string, patch: Partial<KitchenDraftLine>) =>
    onChange({ ...draft, lines: draft.lines.map((l) => (l.key === key ? { ...l, ...patch } : l)) });
  const groupOf = (l: KitchenDraftLine) =>
    choices?.status === 'ok' ? choices.groups.find((g) => g.label.toLowerCase() === (l.choiceGroup ?? '').toLowerCase()) : undefined;
  return (
    <div>
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="mt-1 space-y-2">
        {lines.map((l) => {
          const group = !readOnly && kitchenLineChoosable(l) ? groupOf(l) : undefined;
          const editable = !readOnly && kitchenLineEditable(l);
          const marks = !group && !(l.added && !readOnly) ? lineMarks(l) : null;
          return (
            <div key={l.key} className="space-y-1">
              <div className="flex items-center gap-2">
                {group ? (
                  <Select value={l.chosenOption ?? undefined} onValueChange={(v) => update(l.key, { chosenOption: v })}>
                    <SelectTrigger aria-label={`${l.choiceGroup} choice`} className="flex-1 min-w-0">
                      <SelectValue placeholder={`${l.choiceGroup}: choose`} />
                    </SelectTrigger>
                    <SelectContent>
                      {/* A dish the BEO saved that the template no longer lists still shows, and is not picked again. */}
                      {kitchenChoiceOptions(group.options, l.chosenOption).map((o) => (
                        <SelectItem key={o.value} value={o.value} disabled={o.saved}>
                          {`${group.label}: ${o.value}`}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                ) : l.added && !readOnly ? (
                  <MenuPickInput line={l} menu={menu} onPick={(patch) => update(l.key, patch)} />
                ) : (
                  <div role="textbox" aria-readonly="true" aria-label={`${label} item`} className="flex-1 min-w-0 min-h-10 rounded-md border border-input bg-background px-3 py-2 text-sm whitespace-normal break-words">{lineLabel(l)}</div>
                )}
                {l.qty !== null &&
                  (editable ? (
                    <QuantityStepper
                      size="sm"
                      value={l.qty}
                      min={1}
                      max={Math.max(999, l.qty)}
                      onChange={(q) => update(l.key, { qty: q })}
                      ariaLabel={`${l.name || label} quantity`}
                    />
                  ) : (
                    <span className="shrink-0 w-14 text-right font-medium tabular-nums">×{l.qty}</span>
                  ))}
                {!readOnly && kitchenLineRemovable(l) && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="shrink-0 text-destructive"
                    onClick={() => update(l.key, { removed: true })}
                    aria-label={`Remove ${l.name || label} item`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                )}
              </div>
              {marks && <div className="text-xs text-muted-foreground" data-testid="kitchen-line-marks">{marks}</div>}
              {l.added && !readOnly && (
                <div className="text-xs text-muted-foreground">{l.productCode ? `Till item ${l.productCode}` : PARTY_NOT_ON_TILL_MENU}</div>
              )}
              {(editable || l.note) && (
                <Input
                  value={l.note}
                  placeholder="Note"
                  aria-label={`${l.name || label} note`}
                  readOnly={!editable}
                  disabled={!editable}
                  onChange={(e) => update(l.key, { note: e.target.value })}
                  className="h-8 text-sm"
                />
              )}
            </div>
          );
        })}
        {!readOnly && (
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 border-dashed"
            onClick={() => onChange({ ...draft, lines: [...draft.lines, addedKitchenLine(list)] })}
          >
            <Plus className="w-4 h-4" /> Add item
          </Button>
        )}
      </div>
    </div>
  );
}

/** The "Kitchen plan" card, from the BEO. */
export function PartyKitchenPlanSection({ plan, draft, onChange, readOnly, choices, menu }: Props) {
  const cake = plan.cake ?? null;
  const setMenu = plan.setMenu.some((m) => m.origin === 'set_menu' || !!m.choiceGroup);
  return (
    <Section icon={UtensilsCrossed} title="Kitchen plan">
      {readOnly && <p className="text-sm text-muted-foreground">{PARTY_KITCHEN_READ_ONLY}</p>}
      <div className="flex items-center justify-between">
        <span className="text-sm">Kitchen service needed</span>
        <Switch checked={kitchenServiceNeeded(plan)} disabled aria-label="Kitchen service needed" />
      </div>
      <Grid2>
        <Field label="Food service time">
          <Input type="time" value={plan.kitchen?.kidsFoodTime ?? ''} readOnly disabled />
        </Field>
        <div className="flex items-center justify-between self-end pb-2">
          <span className="text-sm">Set menu</span>
          <Switch checked={setMenu} disabled aria-label="Set menu" />
        </div>
      </Grid2>
      <LineRows list="food" label="Food items" draft={draft} onChange={onChange} readOnly={readOnly} choices={choices} menu={menu} />
      {!readOnly && choices?.status === 'unavailable' && choices.message && (
        <p className="text-xs text-muted-foreground">{choices.message}</p>
      )}
      <div className="rounded-lg bg-primary/10 p-3 space-y-3">
        <div className="flex items-center gap-2 font-semibold text-sm">
          <Cake className="w-4 h-4 text-primary" /> Cake
        </div>
        <Grid2>
          <Field label="Cake type">
            <Select value={cake?.type ?? 'none'} disabled>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">No cake</SelectItem>
                <SelectItem value="our">Our cake</SelectItem>
                <SelectItem value="own">Customer brings own</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Cake time">
            <Input
              type="time"
              value={draft.cake?.time ?? ''}
              readOnly={readOnly || !draft.cake}
              disabled={readOnly || !draft.cake}
              onChange={(e) => draft.cake && onChange({ ...draft, cake: { ...draft.cake, time: e.target.value } })}
            />
          </Field>
        </Grid2>
        {cake?.type === 'our' && (
          <Field label="Cake quantity">
            <span className="block font-medium tabular-nums">×{cake.qty}</span>
          </Field>
        )}
        <Field label="Cake note">
          <Input
            value={draft.cake?.note ?? ''}
            readOnly={readOnly || !draft.cake}
            disabled={readOnly || !draft.cake}
            onChange={(e) => draft.cake && onChange({ ...draft, cake: { ...draft.cake, note: e.target.value } })}
          />
        </Field>
      </div>
    </Section>
  );
}

/** The "Bar plan" card, from the BEO. */
export function PartyBarPlanSection({ plan, draft, onChange, readOnly, choices, menu }: Props) {
  return (
    <Section icon={GlassWater} title="Bar plan">
      {readOnly && <p className="text-sm text-muted-foreground">{PARTY_KITCHEN_READ_ONLY}</p>}
      <Field label="Bar service time">
        <Input type="time" value={plan.kitchen?.barServiceTime ?? ''} readOnly disabled />
      </Field>
      <LineRows list="bar" label="Bar items" draft={draft} onChange={onChange} readOnly={readOnly} choices={choices} menu={menu} />
    </Section>
  );
}
