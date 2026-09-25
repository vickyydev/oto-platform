import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ChildDobPicker } from '@/components/shared/ChildDobPicker';
import { ScrollArea } from '@/components/ui/scroll-area';
import { CheckIn, DropOffServiceType } from '@/types';
import {
  getRegistrationsAwaitingCheckIn,
  addChildToRegistration,
  type RegistrationGroup,
} from '@/mockApi';
import { useOperator } from '@/auth/OperatorContext';
import { Baby, AlertTriangle, UserPlus, Phone, X, CheckCircle2, HandHeart, UserCheck } from 'lucide-react';

// What a freshly-added sibling should become. A drop-off child is always a named
// individual attaching a registered drop-off line (Drop-off or Nanny service);
// consent is booking-level. Anonymous normal-ticket kids/adults never come
// through here — they are added via the ticket grid ("Add ticket").
type AddKind = DropOffServiceType;

interface AddDropOffModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** checkIn ids already attached to the cart (shown as added / not re-attachable). */
  attachedCheckInIds: string[];
  /** Attach the chosen registered children to the sale as drop-off lines. The
   *  optional service forces Drop-off vs Nanny for a just-added sibling. */
  onAttach: (children: CheckIn[], service?: DropOffServiceType) => void;
}

/**
 * Direction-2 picker: registrations whose consent form is filled but who haven't
 * been checked in yet. Staff attach a booking's children to the current sale as
 * drop-off lines, and can add a sibling on the spot (consent is booking-level).
 * A child can't be attached without a registration on file.
 */
export function AddDropOffModal({
  open,
  onOpenChange,
  attachedCheckInIds,
  onAttach,
}: AddDropOffModalProps) {
  const { operator } = useOperator();
  const operatorName = operator?.name ?? 'Unknown';

  // Re-read the (mutable, in-memory) registration list each time the modal opens
  // and after adding a sibling, via a bump counter.
  const [bump, setBump] = useState(0);
  const groups = useMemo<RegistrationGroup[]>(
    () => (open ? getRegistrationsAwaitingCheckIn() : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bump re-reads the in-memory registration list after a sibling is added (see above)
    [open, bump],
  );

  // Inline add-sibling form, scoped to one registration at a time.
  const [addingFor, setAddingFor] = useState<string | null>(null);
  const [kind, setKind] = useState<AddKind>('drop_off');
  const [name, setName] = useState('');
  const [age, setAge] = useState('');
  const [dateOfBirth, setDateOfBirth] = useState<string | undefined>(undefined);
  const [details, setDetails] = useState('');

  const resetForm = () => {
    setKind('drop_off');
    setName('');
    setAge('');
    setDateOfBirth(undefined);
    setDetails('');
  };

  useEffect(() => {
    if (!open) {
      setAddingFor(null);
      resetForm();
    }
  }, [open]);

  const attached = new Set(attachedCheckInIds);

  const handleAddSibling = (registrationId: string) => {
    const trimmed = name.trim();
    // A drop-off child is a named individual — name + age are required so the
    // consent record is never missing details.
    if (!trimmed || !age.trim()) return;
    const created = addChildToRegistration(
      registrationId,
      { name: trimmed, age: Number(age) || 0, dateOfBirth, details },
      { operatorName },
    );
    if (!created) return;
    setAddingFor(null);
    resetForm();
    setBump((b) => b + 1);
    // Attach the new child straight away (with the chosen service) so it lands in
    // the sale.
    onAttach([created], kind);
  };

  const attachGroup = (group: RegistrationGroup) => {
    const fresh = group.children.filter((c) => !attached.has(c.id));
    if (fresh.length === 0) return;
    onAttach(fresh);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Baby className="w-5 h-5 text-primary" />
            Add drop-off child
          </DialogTitle>
          <DialogDescription>
            Bookings with a signed form, waiting to be checked in. Attach a booking's named children
            to this sale — they're checked into the park when you take payment. Anonymous play tickets
            are added with "Add ticket".
          </DialogDescription>
        </DialogHeader>

        {groups.length === 0 ? (
          <div className="py-12 text-center text-muted-foreground">
            <Baby className="w-12 h-12 mx-auto mb-3 opacity-20" />
            <p>No bookings are waiting to be checked in.</p>
          </div>
        ) : (
          <ScrollArea className="max-h-[60vh] -mx-2 px-2">
            <div className="space-y-3">
              {groups.map((group) => {
                const allAttached = group.children.every((c) => attached.has(c.id));
                return (
                  <Card key={group.registrationId} className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-bold truncate">
                          {group.parentName || 'Booking'}'s booking
                        </div>
                        {group.phone && (
                          <div className="text-xs text-muted-foreground flex items-center gap-1 mt-0.5">
                            <Phone className="w-3 h-3" />
                            {group.phone}
                          </div>
                        )}
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        disabled={allAttached}
                        onClick={() => attachGroup(group)}
                        className="shrink-0"
                      >
                        {allAttached ? 'Added' : 'Add to sale'}
                      </Button>
                    </div>

                    <div className="space-y-1.5">
                      {group.children.map((c) => {
                        const isAttached = attached.has(c.id);
                        return (
                          <div
                            key={c.id}
                            className="flex items-center justify-between gap-3 rounded-lg border bg-card/50 px-3 py-2"
                          >
                            <span className="flex items-center gap-2 min-w-0">
                              {isAttached ? (
                                <CheckCircle2 className="w-4 h-4 text-primary shrink-0" />
                              ) : (
                                <Baby className="w-4 h-4 text-muted-foreground shrink-0" />
                              )}
                              <span className="truncate">
                                {c.childName}
                                <span className="text-muted-foreground"> · {c.childAge}y</span>
                              </span>
                              {c.allergiesMedical && (
                                <span className="inline-flex items-center gap-1 text-xs text-amber-300 shrink-0">
                                  <AlertTriangle className="w-3 h-3" />
                                  {c.allergiesMedical}
                                </span>
                              )}
                            </span>
                            {isAttached && (
                              <span className="text-xs text-muted-foreground shrink-0">In sale</span>
                            )}
                          </div>
                        );
                      })}
                    </div>

                    {addingFor === group.registrationId ? (
                      <div className="space-y-3 rounded-lg border border-primary/40 p-3">
                        {/* A drop-off child is always a named individual; pick its
                            service (plain drop-off fee or nanny). Anonymous
                            normal-ticket kids/adults are added via the ticket grid. */}
                        <div className="grid grid-cols-2 gap-2">
                          {(
                            [
                              { k: 'drop_off' as AddKind, label: 'Drop-Off', icon: HandHeart },
                              { k: 'nanny' as AddKind, label: 'Nanny', icon: UserCheck },
                            ]
                          ).map(({ k, label, icon: Icon }) => (
                            <Button
                              key={k}
                              type="button"
                              size="sm"
                              variant={kind === k ? 'default' : 'outline'}
                              className="h-12 flex-col gap-0.5"
                              onClick={() => setKind(k)}
                            >
                              <Icon className="w-4 h-4" />
                              <span className="text-xs">{label}</span>
                            </Button>
                          ))}
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                          <Input
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            placeholder="Child name"
                            className="h-10 sm:col-span-2"
                          />
                          <ChildDobPicker
                            dateOfBirth={dateOfBirth}
                            age={age.trim() ? Number(age) : null}
                            childName={name}
                            onChange={({ dateOfBirth: dob, age: a }) => {
                              setDateOfBirth(dob);
                              setAge(String(a));
                            }}
                            size="sm"
                          />
                        </div>
                        <Input
                          value={details}
                          onChange={(e) => setDetails(e.target.value)}
                          placeholder="Allergies / medical (optional)"
                          className="h-10"
                        />

                        <div className="flex gap-2">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="gap-1.5"
                            onClick={() => {
                              setAddingFor(null);
                              resetForm();
                            }}
                          >
                            <X className="w-4 h-4" />
                            Cancel
                          </Button>
                          <Button
                            type="button"
                            size="sm"
                            disabled={!name.trim() || !age.trim()}
                            onClick={() => handleAddSibling(group.registrationId)}
                          >
                            Add &amp; attach
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="gap-1.5"
                        onClick={() => {
                          setAddingFor(group.registrationId);
                          resetForm();
                        }}
                      >
                        <UserPlus className="w-4 h-4" />
                        Add sibling
                      </Button>
                    )}
                  </Card>
                );
              })}
            </div>
          </ScrollArea>
        )}
      </DialogContent>
    </Dialog>
  );
}
