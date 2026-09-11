import { useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { QuantityStepper } from '@/components/shared/QuantityStepper';
import { ChildDobPicker } from '@/components/shared/ChildDobPicker';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { PartyBooking, PartyLineItem, PartyStatus } from '@/types';
import { PARTY_STATUS_LABELS } from '@/lib/party';
import {
  Sparkles,
  Phone,
  ReceiptText,
  UtensilsCrossed,
  GlassWater,
  Clock,
  Cake,
  Plus,
  Trash2,
  ChevronUp,
  ChevronDown,
  X,
  Save,
} from 'lucide-react';

// The patch this form emits — every editable field of a PartyBooking (the POS
// may now edit a party in-place). Protected fields (`id`/`branch`, and the
// POS-owned ledgers) are never part of the patch and stay fixed in `updateParty`.
export type PartyEditPatch = Omit<
  PartyBooking,
  'id' | 'branchId' | 'partyExtraCharges' | 'partyPayments' | 'lastEditedBy' | 'lastEditedById' | 'lastEditedAt'
>;

interface PartyEditFormProps {
  party: PartyBooking;
  onSave: (patch: PartyEditPatch) => void;
  onCancel: () => void;
}

const newId = (prefix: string) => `${prefix}-${Math.random().toString(36).substring(2, 9)}`;

function Section({ icon: Icon, title, children }: { icon: typeof Sparkles; title: string; children: ReactNode }) {
  return (
    <Card className="p-5 bg-card/50">
      <div className="flex items-center gap-2 mb-4 font-bold">
        <Icon className="w-5 h-5 text-primary" />
        {title}
      </div>
      <div className="space-y-3">{children}</div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function Grid2({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-2 gap-3">{children}</div>;
}

// An editable list of free-text strings (e.g. kids/adults menu items).
function StringListEditor({
  label,
  values,
  onChange,
  placeholder,
}: {
  label: string;
  values: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
}) {
  return (
    <div>
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="mt-1 space-y-2">
        {values.map((v, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={v}
              placeholder={placeholder}
              onChange={(e) => onChange(values.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 text-destructive"
              onClick={() => onChange(values.filter((_, j) => j !== i))}
              aria-label={`Remove ${label} item`}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        ))}
        <Button variant="outline" size="sm" className="gap-1.5 border-dashed" onClick={() => onChange([...values, ''])}>
          <Plus className="w-4 h-4" /> Add item
        </Button>
      </div>
    </div>
  );
}

// An editable list of named items with a quantity (kitchen food / bar items).
function QtyItemListEditor({
  label,
  items,
  onChange,
}: {
  label: string;
  items: { id: string; name: string; qty: number }[];
  onChange: (next: { id: string; name: string; qty: number }[]) => void;
}) {
  return (
    <div>
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="mt-1 space-y-2">
        {items.map((it) => (
          <div key={it.id} className="flex items-center gap-2">
            <Input
              value={it.name}
              placeholder="Item name"
              onChange={(e) => onChange(items.map((x) => (x.id === it.id ? { ...x, name: e.target.value } : x)))}
            />
            <QuantityStepper
              size="sm"
              value={it.qty}
              min={1}
              onChange={(q) => onChange(items.map((x) => (x.id === it.id ? { ...x, qty: q } : x)))}
              ariaLabel={`${label} quantity`}
            />
            <Button
              variant="ghost"
              size="icon"
              className="shrink-0 text-destructive"
              onClick={() => onChange(items.filter((x) => x.id !== it.id))}
              aria-label={`Remove ${label} item`}
            >
              <Trash2 className="w-4 h-4" />
            </Button>
          </div>
        ))}
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 border-dashed"
          onClick={() => onChange([...items, { id: newId('it'), name: '', qty: 1 }])}
        >
          <Plus className="w-4 h-4" /> Add item
        </Button>
      </div>
    </div>
  );
}

export function PartyEditForm({ party, onSave, onCancel }: PartyEditFormProps) {
  // A deep-ish working draft. Edits are immutable on nested objects so Cancel
  // (which simply discards this component's state) never leaks into the party.
  const [draft, setDraft] = useState<PartyBooking>(() => ({
    ...party,
    lineItems: party.lineItems.map((li) => ({ ...li })),
    kitchen: {
      ...party.kitchen,
      kidsMenu: [...party.kitchen.kidsMenu],
      adultsMenu: [...party.kitchen.adultsMenu],
      foodItems: party.kitchen.foodItems.map((f) => ({ ...f })),
      cake: { ...party.kitchen.cake },
    },
    bar: party.bar
      ? { ...party.bar, items: party.bar.items ? party.bar.items.map((b) => ({ ...b })) : undefined }
      : undefined,
    timeline: party.timeline.map((t) => ({ ...t })),
  }));

  const set = <K extends keyof PartyBooking>(key: K, value: PartyBooking[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));

  const setKitchen = (patch: Partial<PartyBooking['kitchen']>) =>
    setDraft((d) => ({ ...d, kitchen: { ...d.kitchen, ...patch } }));

  const setCake = (patch: Partial<PartyBooking['kitchen']['cake']>) =>
    setDraft((d) => ({ ...d, kitchen: { ...d.kitchen, cake: { ...d.kitchen.cake, ...patch } } }));

  const setBar = (patch: Partial<NonNullable<PartyBooking['bar']>>) =>
    setDraft((d) => ({ ...d, bar: { ...(d.bar ?? {}), ...patch } }));

  // --- Bill line items ---
  const setLineItem = (id: string, patch: Partial<PartyLineItem>) =>
    setDraft((d) => ({ ...d, lineItems: d.lineItems.map((li) => (li.id === id ? { ...li, ...patch } : li)) }));
  const addLineItem = () =>
    setDraft((d) => ({ ...d, lineItems: [...d.lineItems, { id: newId('li'), name: '', qty: 1, price: 0 }] }));
  const removeLineItem = (id: string) =>
    setDraft((d) => ({ ...d, lineItems: d.lineItems.filter((li) => li.id !== id) }));

  // --- Timeline (with reorder) ---
  const setTimeline = (next: PartyBooking['timeline']) => set('timeline', next);
  const moveTimeline = (i: number, dir: -1 | 1) => {
    const j = i + dir;
    if (j < 0 || j >= draft.timeline.length) return;
    const next = [...draft.timeline];
    [next[i], next[j]] = [next[j], next[i]];
    setTimeline(next);
  };

  const handleSave = () => {
    const {
      id: _id,
      branchId: _branchId,
      partyExtraCharges: _pec,
      partyPayments: _ppy,
      lastEditedBy: _leb,
      lastEditedById: _lebi,
      lastEditedAt: _lea,
      ...patch
    } = draft;
    onSave(patch);
  };

  return (
    <div className="h-full flex flex-col min-h-0">
      {/* Header */}
      <div className="shrink-0 mb-4 flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-2xl font-black tracking-tight">Edit party</h2>
          <p className="text-muted-foreground mt-1 text-sm">
            Editing all booking details. Changes save to the party tab and are stamped with you.
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <Button variant="outline" size="lg" className="gap-2 h-12" onClick={onCancel}>
            <X className="w-5 h-5" />
            Cancel
          </Button>
          <Button size="lg" className="gap-2 h-12" onClick={handleSave}>
            <Save className="w-5 h-5" />
            Save changes
          </Button>
        </div>
      </div>

      <ScrollArea className="flex-1 -mx-1 px-1">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 pb-2">
          <div className="space-y-4">
            {/* Event info */}
            <Section icon={Sparkles} title="Event info">
              <Field label="Party title">
                <Input value={draft.title} onChange={(e) => set('title', e.target.value)} />
              </Field>
              <Grid2>
                <Field label="Child name">
                  <Input value={draft.childName} onChange={(e) => set('childName', e.target.value)} />
                </Field>
                <Field label="Child age">
                  <ChildDobPicker
                    dateOfBirth={draft.kidDob}
                    age={draft.kidAge ?? null}
                    childName={draft.childName}
                    onChange={({ dateOfBirth, age }) =>
                      setDraft((d) => ({ ...d, kidDob: dateOfBirth, kidAge: age }))
                    }
                  />
                </Field>
              </Grid2>
              <Field label="Status">
                <Select value={draft.status} onValueChange={(v) => set('status', v as PartyStatus)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(Object.keys(PARTY_STATUS_LABELS) as PartyStatus[]).map((s) => (
                      <SelectItem key={s} value={s}>
                        {PARTY_STATUS_LABELS[s]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field label="Date">
                <Input type="date" value={draft.date} onChange={(e) => set('date', e.target.value)} />
              </Field>
              <Grid2>
                <Field label="Start time">
                  <Input type="time" value={draft.startTime} onChange={(e) => set('startTime', e.target.value)} />
                </Field>
                <Field label="End time">
                  <Input type="time" value={draft.endTime} onChange={(e) => set('endTime', e.target.value)} />
                </Field>
              </Grid2>
              <Field label="Room / area">
                <Input value={draft.location} onChange={(e) => set('location', e.target.value)} />
              </Field>
              <Grid2>
                <Field label="Expected kids">
                  <Input
                    type="number"
                    value={draft.expectedKids}
                    onChange={(e) => set('expectedKids', Number(e.target.value) || 0)}
                  />
                </Field>
                <Field label="Expected adults">
                  <Input
                    type="number"
                    value={draft.expectedAdults}
                    onChange={(e) => set('expectedAdults', Number(e.target.value) || 0)}
                  />
                </Field>
              </Grid2>
              <Field label="Decoration">
                <Input value={draft.decoration ?? ''} onChange={(e) => set('decoration', e.target.value || undefined)} />
              </Field>
              <Field label="Activities">
                <Input value={draft.activities ?? ''} onChange={(e) => set('activities', e.target.value || undefined)} />
              </Field>
              <Grid2>
                <Field label="Party host">
                  <Input value={draft.partyHost ?? ''} onChange={(e) => set('partyHost', e.target.value || undefined)} />
                </Field>
                <Field label="Entertainment host">
                  <Input
                    value={draft.entertainmentHost ?? ''}
                    onChange={(e) => set('entertainmentHost', e.target.value || undefined)}
                  />
                </Field>
              </Grid2>
            </Section>

            {/* Parent contact */}
            <Section icon={Phone} title="Parent contact">
              <Field label="Parent name">
                <Input value={draft.parentName} onChange={(e) => set('parentName', e.target.value)} />
              </Field>
              <Field label="WhatsApp">
                <PhoneInput
                  value={draft.whatsapp ?? ''}
                  onChange={(v) => set('whatsapp', v || undefined)}
                  label=""
                />
              </Field>
              <Field label="POS notes">
                <Textarea
                  value={draft.posNotes ?? ''}
                  onChange={(e) => set('posNotes', e.target.value || undefined)}
                  rows={2}
                />
              </Field>
              <Field label="Staff note (final message)">
                <Textarea
                  value={draft.finalMessage ?? ''}
                  onChange={(e) => set('finalMessage', e.target.value || undefined)}
                  rows={2}
                />
              </Field>
            </Section>
          </div>

          <div className="space-y-4">
            {/* Bill */}
            <Section icon={ReceiptText} title="Party bill">
              <Grid2>
                <Field label="Package name">
                  <Input
                    value={draft.packageName ?? ''}
                    onChange={(e) => set('packageName', e.target.value || undefined)}
                  />
                </Field>
                <Field label="Base price (฿)">
                  <Input
                    type="number"
                    value={draft.basePrice}
                    onChange={(e) => set('basePrice', Number(e.target.value) || 0)}
                  />
                </Field>
              </Grid2>
              <Grid2>
                <Field label="Deposit paid (฿)">
                  <Input
                    type="number"
                    value={draft.deposit}
                    onChange={(e) => set('deposit', Number(e.target.value) || 0)}
                  />
                </Field>
                <Field label="Deposit date">
                  <Input
                    type="date"
                    value={draft.depositDate ?? ''}
                    onChange={(e) => set('depositDate', e.target.value || undefined)}
                  />
                </Field>
              </Grid2>
              <div>
                <span className="text-sm text-muted-foreground">Add-on line items</span>
                <div className="mt-1 space-y-2">
                  {draft.lineItems.map((li) => (
                    <div key={li.id} className="flex items-center gap-2">
                      <Input
                        className="flex-1"
                        value={li.name}
                        placeholder="Line item"
                        onChange={(e) => setLineItem(li.id, { name: e.target.value })}
                      />
                      <QuantityStepper
                        size="sm"
                        value={li.qty}
                        min={1}
                        onChange={(q) => setLineItem(li.id, { qty: q })}
                        ariaLabel="Line item quantity"
                      />
                      <Input
                        type="number"
                        className="w-24"
                        value={li.price}
                        placeholder="฿"
                        onChange={(e) => setLineItem(li.id, { price: Number(e.target.value) || 0 })}
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        className="shrink-0 text-destructive"
                        onClick={() => removeLineItem(li.id)}
                        aria-label="Remove line item"
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  ))}
                  <Button variant="outline" size="sm" className="gap-1.5 border-dashed" onClick={addLineItem}>
                    <Plus className="w-4 h-4" /> Add line item
                  </Button>
                </div>
              </div>
            </Section>

            {/* Kitchen */}
            <Section icon={UtensilsCrossed} title="Kitchen plan">
              <div className="flex items-center justify-between">
                <span className="text-sm">Kitchen service needed</span>
                <Switch checked={draft.kitchen.needed} onCheckedChange={(v) => setKitchen({ needed: v })} />
              </div>
              {draft.kitchen.needed && (
                <>
                  <Grid2>
                    <Field label="Food service time">
                      <Input
                        type="time"
                        value={draft.kitchen.serviceTime ?? ''}
                        onChange={(e) => setKitchen({ serviceTime: e.target.value || undefined })}
                      />
                    </Field>
                    <div className="flex items-center justify-between self-end pb-2">
                      <span className="text-sm">Set menu</span>
                      <Switch
                        checked={!!draft.kitchen.setMenu}
                        onCheckedChange={(v) => setKitchen({ setMenu: v })}
                      />
                    </div>
                  </Grid2>
                  <StringListEditor
                    label="Kids menu"
                    values={draft.kitchen.kidsMenu}
                    onChange={(next) => setKitchen({ kidsMenu: next })}
                    placeholder="e.g. Mini burgers"
                  />
                  <StringListEditor
                    label="Adults menu"
                    values={draft.kitchen.adultsMenu}
                    onChange={(next) => setKitchen({ adultsMenu: next })}
                    placeholder="e.g. Thai set"
                  />
                  <QtyItemListEditor
                    label="Food items"
                    items={draft.kitchen.foodItems}
                    onChange={(next) => setKitchen({ foodItems: next })}
                  />
                  <div className="rounded-lg bg-primary/10 p-3 space-y-3">
                    <div className="flex items-center gap-2 font-semibold text-sm">
                      <Cake className="w-4 h-4 text-primary" /> Cake
                    </div>
                    <Grid2>
                      <Field label="Cake type">
                        <Select
                          value={draft.kitchen.cake.type}
                          onValueChange={(v) => setCake({ type: v as 'none' | 'our' | 'own' })}
                        >
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
                          value={draft.kitchen.cake.time ?? ''}
                          onChange={(e) => setCake({ time: e.target.value || undefined })}
                        />
                      </Field>
                    </Grid2>
                    {draft.kitchen.cake.type === 'our' && (
                      <Field label="Cake quantity">
                        <QuantityStepper
                          size="sm"
                          value={draft.kitchen.cake.qty ?? 1}
                          min={1}
                          onChange={(q) => setCake({ qty: q })}
                          ariaLabel="Cake quantity"
                        />
                      </Field>
                    )}
                    <Field label="Cake note">
                      <Input
                        value={draft.kitchen.cake.note ?? ''}
                        onChange={(e) => setCake({ note: e.target.value || undefined })}
                      />
                    </Field>
                  </div>
                </>
              )}
            </Section>

            {/* Bar */}
            <Section icon={GlassWater} title="Bar plan">
              <Field label="Bar service time">
                <Input
                  type="time"
                  value={draft.bar?.serviceTime ?? ''}
                  onChange={(e) => setBar({ serviceTime: e.target.value || undefined })}
                />
              </Field>
              <QtyItemListEditor
                label="Bar items"
                items={draft.bar?.items ?? []}
                onChange={(next) => setBar({ items: next })}
              />
            </Section>

            {/* Timeline */}
            <Section icon={Clock} title="Run of show">
              <div className="space-y-2">
                {draft.timeline.map((t, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      type="time"
                      className="w-28 shrink-0"
                      value={t.time}
                      onChange={(e) => setTimeline(draft.timeline.map((x, j) => (j === i ? { ...x, time: e.target.value } : x)))}
                    />
                    <Input
                      className="flex-1"
                      value={t.label}
                      placeholder="What happens"
                      onChange={(e) => setTimeline(draft.timeline.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
                    />
                    <div className="flex flex-col shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-7"
                        disabled={i === 0}
                        onClick={() => moveTimeline(i, -1)}
                        aria-label="Move earlier"
                      >
                        <ChevronUp className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-5 w-7"
                        disabled={i === draft.timeline.length - 1}
                        onClick={() => moveTimeline(i, 1)}
                        aria-label="Move later"
                      >
                        <ChevronDown className="w-4 h-4" />
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 text-destructive"
                      onClick={() => setTimeline(draft.timeline.filter((_, j) => j !== i))}
                      aria-label="Remove timeline entry"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                ))}
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5 border-dashed"
                  onClick={() => setTimeline([...draft.timeline, { time: '', label: '' }])}
                >
                  <Plus className="w-4 h-4" /> Add timeline entry
                </Button>
              </div>
            </Section>
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
