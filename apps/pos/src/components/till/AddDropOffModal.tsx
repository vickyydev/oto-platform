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
import { useBranch } from '@/branch/BranchContext';
import { toast } from '@/hooks/use-toast';
import { apiCheckinToCheckIn, checkinApi, TILL_NOT_LINKED, type ApiRegistration } from '@/api/checkin';
import { apiBranchIdForSlug } from '@/api/catalogBridge';
import { CancelBookingDialog, cancelAloneLabel, cancelAloneOf, cancelBookingBlockedBy } from '@/components/dropoff/CancelBookingDialog';
import { Baby, AlertTriangle, Ban, UserPlus, Phone, X, CheckCircle2, HandHeart, UserCheck } from 'lucide-react';

/** One waiting registration as the picker lists it (prototype `RegistrationGroup`). */
export interface RegistrationGroup {
  registrationId: string;
  parentName: string;
  phone: string;
  children: CheckIn[];
  /**
   * SCRUM-862 — the names of children on this booking already checked in or
   * collected: the platform refuses a cancel while one is, so the till says so.
   */
  checkedIn?: readonly string[];
}

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

// SCRUM-886 — the rule and the confirm are shared with the Check-in board.
export { cancelBookingBlockedBy };

/**
 * One family on the picker: who they are, the button that adds them to the sale,
 * and each waiting child. SCRUM-730 — a child paid for online stays listed, so a
 * sibling can still join the family, and is never added to a sale. SCRUM-740 —
 * nor is a child a till sale already paid for: the board checks them in.
 * SCRUM-862 — "Cancel booking" takes a waiting, unpaid family off the list for
 * good, after one confirm with a reason (`onCancel`); hidden for a family every
 * child of which is paid, disabled (with the reason) while any child is paid or
 * a child is on this sale. SCRUM-909 — beside a press so refused over a paid
 * or checked-in sibling, "Cancel <child>'s booking" takes the unpaid children
 * off the list on their own (`cancelAloneOf`); the sibling stays.
 */
export function WaitingFamily({
  group,
  attached,
  onAddToSale,
  onCancel,
}: {
  group: RegistrationGroup;
  attached: ReadonlySet<string>;
  onAddToSale: (children: CheckIn[]) => void;
  onCancel?: (group: RegistrationGroup) => void;
}) {
  const chargeable = group.children.filter((c) => !c.paidOnline && !c.paidAtTill);
  const fresh = chargeable.filter((c) => !attached.has(c.id));
  const allPaid = group.children.length > 0 && chargeable.length === 0;
  const cancelBlock = onCancel && !allPaid ? cancelBookingBlockedBy(group, attached) : undefined;
  const alone = cancelBlock ? cancelAloneOf(group, attached) : null;
  const paidLabel = group.children.every((c) => c.paidOnline)
    ? 'Paid online'
    : group.children.every((c) => !c.paidOnline)
      ? 'Paid at till'
      : 'Paid';
  return (
    <>
      {/* SCRUM-888 — the buttons fit the card at every width. In a card wide
          enough (the counter till's window), the name keeps its row and takes
          the room it needs, and the buttons take the rest, never less than
          their narrowest layout: Cancel booking goes under Add to sale when
          both do not fit beside the name, and only a name too long for what
          is left is cut short. In a narrow card (the phone till), the buttons
          sit under the name, at the right. */}
      <div className="@container">
        <div className="grid grid-cols-1 @md:grid-cols-[minmax(0,max-content)_minmax(min-content,1fr)] items-start gap-3">
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
          <div className="flex flex-col items-end gap-1">
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                type="button"
                size="sm"
                disabled={fresh.length === 0}
                onClick={() => {
                  if (fresh.length > 0) onAddToSale(fresh);
                }}
                className="shrink-0"
              >
                {allPaid ? paidLabel : fresh.length === 0 ? 'Added' : 'Add to sale'}
              </Button>
              {cancelBlock !== undefined && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0 gap-1.5"
                  disabled={cancelBlock !== null}
                  onClick={() => onCancel?.(group)}
                >
                  <Ban className="w-4 h-4" />
                  Cancel booking
                </Button>
              )}
              {alone && (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0 gap-1.5"
                  onClick={() => onCancel?.(alone)}
                >
                  <Ban className="w-4 h-4" />
                  {cancelAloneLabel(alone)}
                </Button>
              )}
            </div>
            {cancelBlock && <p className="text-xs text-muted-foreground">{cancelBlock}</p>}
          </div>
        </div>
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
              {c.paidOnline ? (
                <span className="text-xs text-emerald-400 shrink-0">Paid online</span>
              ) : c.paidAtTill ? (
                <span className="text-xs text-emerald-400 shrink-0">
                  Paid at till{c.paidAtTill.receiptNumber ? ` · ${c.paidAtTill.receiptNumber}` : ''}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </>
  );
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
  const { branch } = useBranch();

  /**
   * S2-13 — the registrations waiting to be checked in are the platform's
   * (`GET /checkin/registrations`), re-read each time the modal opens and after
   * a sibling is added, via a bump counter — the prototype read its in-memory
   * list the same way.
   */
  const [bump, setBump] = useState(0);
  const [registrations, setRegistrations] = useState<ApiRegistration[]>([]);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (!open) return;
    // The park in the PLATFORM's id, never the catalogue slug (finding R1);
    // a till with no platform branch is told so, in plain words, once.
    const platformBranchId = apiBranchIdForSlug(branch.id);
    if (!platformBranchId) {
      setRegistrations([]);
      toast({
        title: "Couldn't load the waiting bookings",
        description: TILL_NOT_LINKED,
        variant: 'destructive',
      });
      return;
    }
    let live = true;
    checkinApi
      .awaiting(platformBranchId)
      .then((res) => {
        if (live) setRegistrations(res.registrations);
      })
      .catch((err: unknown) => {
        if (!live) return;
        setRegistrations([]);
        toast({
          title: "Couldn't load the waiting registrations",
          description: err instanceof Error ? err.message : 'Unknown error',
          variant: 'destructive',
        });
      });
    return () => {
      live = false;
    };
  }, [open, bump, branch.id]);
  const groups = useMemo<RegistrationGroup[]>(
    () =>
      registrations.map((reg) => ({
        registrationId: reg.id,
        parentName: reg.guardianName,
        phone: reg.guardianPhone ?? '',
        children: reg.children
          .filter((c) => c.status === 'registered')
          .map((c) => apiCheckinToCheckIn(c, reg))
          .sort((a, b) => a.childName.localeCompare(b.childName)),
        checkedIn: reg.children.filter((c) => c.status === 'in_park' || c.status === 'out').map((c) => c.childName),
      })),
    [registrations],
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
      setCancelling(null);
      resetForm();
    }
  }, [open]);

  const attached = new Set(attachedCheckInIds);

  // SCRUM-862 — "Cancel booking": one confirm with a reason, as the till's Void
  // asks (HeldSales); the dialog is shared with the board (SCRUM-886). After a
  // cancel the list is re-read, as after a sibling is added.
  const [cancelling, setCancelling] = useState<RegistrationGroup | null>(null);
  const askCancel = (group: RegistrationGroup) => setCancelling(group);

  const handleAddSibling = async (registrationId: string) => {
    const trimmed = name.trim();
    // A drop-off child is a named individual — name + age are required so the
    // consent record is never missing details.
    if (!trimmed || !age.trim() || saving) return;
    // The sibling is written to the registration on the platform (consent is
    // the registration's), under an id the till minted — the drop-off line
    // takes the same id, so the sale line names this stay.
    const checkinId = checkinApi.newId();
    setSaving(true);
    try {
      const reg = await checkinApi.addChildren(registrationId, [
        {
          checkinId,
          name: trimmed,
          ageYears: Math.max(0, Math.round(Number(age) || 0)),
          dateOfBirth: dateOfBirth ?? null,
          service: kind,
          allergies: details.trim() || null,
        },
      ]);
      const created = reg.children.find((c) => c.id === checkinId);
      if (!created) return;
      setAddingFor(null);
      resetForm();
      setBump((b) => b + 1);
      // Attach the new child straight away (with the chosen service) so it lands in
      // the sale.
      onAttach([apiCheckinToCheckIn(created, reg)], kind);
    } catch (err) {
      toast({
        title: "Couldn't add this child",
        description: err instanceof Error ? err.message : 'Unknown error',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
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
          // SCRUM-888 — Radix lays a scroll area's content out as a table, as
          // wide as its narrowest possible layout; a family card then grew past
          // the window and its right end, Cancel booking with it, was cut off.
          // As a block it is the window's width (the override StepConfirmation
          // and the F&B and shop carts use).
          <ScrollArea className="max-h-[60vh] -mx-2 px-2 [&_[data-radix-scroll-area-viewport]>div]:!block">
            <div className="space-y-3">
              {groups.map((group) => (
                <Card key={group.registrationId} className="p-4 space-y-3">
                  <WaitingFamily group={group} attached={attached} onAddToSale={onAttach} onCancel={askCancel} />

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
                          disabled={!name.trim() || !age.trim() || saving}
                          onClick={() => void handleAddSibling(group.registrationId)}
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
              ))}
            </div>
          </ScrollArea>
        )}

        <CancelBookingDialog
          booking={cancelling}
          onClose={() => setCancelling(null)}
          onCancelled={() => setBump((b) => b + 1)}
        />
      </DialogContent>
    </Dialog>
  );
}
