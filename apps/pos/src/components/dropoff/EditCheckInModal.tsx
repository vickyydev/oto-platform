import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ChangeLogEntry, CheckIn } from '@/types';
import { boardApi, nannyChoicesFor, type ApiNanny, type CheckInEdits } from '@/api/checkin';
import { Pencil, History, Save, ArrowRight, Baby, AlertTriangle } from 'lucide-react';

interface EditCheckInModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checkIn: CheckIn;
  /** The park's roster with each nanny's live load (the board's, S2-13 round 2). */
  nannies: readonly ApiNanny[];
  /** The suggested ratio the warning is shown at — never a block. */
  softMax: number;
  /** Called with the edited values; the platform diffs + audits the changes. */
  onSave: (edits: CheckInEdits) => void;
}

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });

export function EditCheckInModal({
  open,
  onOpenChange,
  checkIn,
  nannies,
  softMax,
  onSave,
}: EditCheckInModalProps) {
  const [form, setForm] = useState<CheckInEdits>(() => toForm(checkIn));
  const roster = nannyChoicesFor(nannies, checkIn);
  const selectedNanny = roster.find((n) => n.id === form.assignedNannyId);
  // The change history is the platform's audit rows for this stay (OD-C5),
  // read each time the modal opens — there is no change log on the record.
  const [history, setHistory] = useState<ChangeLogEntry[]>([]);
  useEffect(() => {
    if (!open) return;
    // The mobile shell still runs on the prototype's in-memory records, which
    // carry their own log; a platform row never has one and reads its audit rows.
    if (checkIn.changeLog) {
      setHistory(checkIn.changeLog);
      return;
    }
    let live = true;
    boardApi
      .history(checkIn.id)
      .then((r) => {
        if (live) setHistory(r.entries.map((e) => ({ ...e, changedById: e.changedById ?? '' })));
      })
      .catch(() => {
        if (live) setHistory([]);
      });
    return () => {
      live = false;
    };
  }, [open, checkIn.id, checkIn.changeLog]);
  // Over the suggested ratio once SHE also covers this child (current load + 1).
  const overRatio = !!selectedNanny && selectedNanny.load + 1 > softMax;

  useEffect(() => {
    if (open) setForm(toForm(checkIn));
  }, [open, checkIn]);

  const set = <K extends keyof CheckInEdits>(key: K, value: CheckInEdits[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const handleSave = () => {
    onSave({
      ...form,
      childName: form.childName.trim(),
      parentName: form.parentName.trim(),
      phone: form.phone.trim(),
    });
    onOpenChange(false);
  };

  const log = [...history].reverse();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="w-5 h-5 text-primary" />
            Edit registration
          </DialogTitle>
          <DialogDescription className="flex items-center gap-1.5">
            <Baby className="w-4 h-4" />
            {checkIn.childName}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="flex-1 -mx-2 px-2">
          <div className="space-y-4 py-1">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Child name</Label>
                <Input
                  value={form.childName}
                  onChange={(e) => set('childName', e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Age</Label>
                <Input
                  type="number"
                  min={0}
                  value={form.childAge}
                  onChange={(e) => set('childAge', Number(e.target.value))}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Parent name</Label>
              <Input
                value={form.parentName}
                onChange={(e) => set('parentName', e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <PhoneInput
                value={form.phone}
                onChange={(v) => set('phone', v)}
                channel={form.contactMethod}
                onChannelChange={(c) => set('contactMethod', c)}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Service</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Button
                    type="button"
                    variant={form.serviceType === 'nanny' ? 'default' : 'outline'}
                    className="h-11"
                    onClick={() => set('serviceType', 'nanny')}
                  >
                    Nanny
                  </Button>
                  <Button
                    type="button"
                    variant={form.serviceType === 'drop_off' ? 'default' : 'outline'}
                    className="h-11"
                    onClick={() => set('serviceType', 'drop_off')}
                  >
                    Drop-Off
                  </Button>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Booked play time (min)</Label>
                <Input
                  type="number"
                  min={0}
                  step={15}
                  value={form.bookedDurationMinutes ?? ''}
                  onChange={(e) =>
                    set(
                      'bookedDurationMinutes',
                      e.target.value === '' ? undefined : Number(e.target.value),
                    )
                  }
                />
              </div>
            </div>

            <div className="flex items-center justify-between rounded-lg border border-border px-3 h-12">
              <Label className="cursor-pointer">May order food</Label>
              <Switch
                checked={form.mayOrderFood}
                onCheckedChange={(v) => set('mayOrderFood', v)}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Food restrictions</Label>
              <Input
                value={form.foodRestrictions ?? ''}
                onChange={(e) => set('foodRestrictions', e.target.value)}
                placeholder="e.g. Vegetarian"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Allergies / medical</Label>
              <Textarea
                value={form.allergiesMedical ?? ''}
                onChange={(e) => set('allergiesMedical', e.target.value)}
                placeholder="None"
                className="min-h-16"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Assigned nanny</Label>
              <div className="grid grid-cols-1 gap-2">
                <Button
                  type="button"
                  variant={!form.assignedNannyId ? 'default' : 'outline'}
                  className="h-11 justify-start"
                  onClick={() => set('assignedNannyId', undefined)}
                >
                  No nanny
                </Button>
                {roster.map((n) => {
                  const disabled = !n.available;
                  const selected = form.assignedNannyId === n.id;
                  // A nanny may cover several children — show her current load.
                  const status = !n.onShift
                    ? 'Off shift'
                    : n.load > 0
                      ? `${n.load} ${n.load === 1 ? 'kid' : 'kids'}`
                      : 'Available';
                  return (
                    <Button
                      key={n.id}
                      type="button"
                      disabled={disabled}
                      variant={selected ? 'default' : 'outline'}
                      className="h-12 justify-between"
                      onClick={() => set('assignedNannyId', n.id)}
                    >
                      <span>{n.name}</span>
                      <span
                        className={`text-xs font-semibold ${
                          disabled ? 'text-muted-foreground' : 'text-emerald-400'
                        }`}
                      >
                        {status}
                      </span>
                    </Button>
                  );
                })}
              </div>
              {overRatio && selectedNanny && (
                <div className="flex items-start gap-2 text-xs text-amber-300 bg-amber-300/10 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    {selectedNanny.name} would be looking after {selectedNanny.load + 1} children
                    (over the suggested {softMax}). Allowed — just double-check it's okay.
                  </span>
                </div>
              )}
            </div>

            {/* Change history (detail view) */}
            <div className="space-y-2 pt-2 border-t border-border">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-muted-foreground">
                <History className="w-4 h-4" />
                Change history
              </p>
              {log.length === 0 ? (
                <p className="text-xs text-muted-foreground">No changes recorded yet.</p>
              ) : (
                <ul className="space-y-2">
                  {log.map((e) => (
                    <li key={e.id} className="text-xs rounded-lg bg-muted/50 p-2.5">
                      <div className="font-semibold text-foreground">{e.field}</div>
                      <div className="flex items-center gap-1.5 text-muted-foreground mt-0.5 flex-wrap">
                        <span className="line-through">{e.oldValue}</span>
                        <ArrowRight className="w-3 h-3 shrink-0" />
                        <span className="text-foreground">{e.newValue}</span>
                      </div>
                      <div className="text-[11px] text-muted-foreground mt-1">
                        {e.changedBy} · {fmtWhen(e.changedAt)}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </ScrollArea>

        <div className="pt-3 shrink-0">
          <Button
            className="w-full h-14 text-lg gap-2"
            disabled={!form.childName.trim() || !form.parentName.trim()}
            onClick={handleSave}
          >
            <Save className="w-5 h-5" />
            Save changes
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function toForm(c: CheckIn): CheckInEdits {
  return {
    childName: c.childName,
    childAge: c.childAge,
    parentName: c.parentName,
    contactMethod: c.contactMethod,
    phone: c.phone,
    serviceType: c.serviceType,
    mayOrderFood: c.mayOrderFood,
    foodRestrictions: c.foodRestrictions,
    allergiesMedical: c.allergiesMedical,
    bookedDurationMinutes: c.bookedDurationMinutes,
    assignedNannyId: c.assignedNannyId,
  };
}
