import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { CheckIn, AuthorizedPickup, AuthorizedPickupSource, Wristband } from '@/types';
import {
  Camera,
  LogOut,
  ShieldCheck,
  Baby,
  Check,
  ArrowLeft,
  User,
  UserX,
  AlertTriangle,
} from 'lucide-react';
import { getAuthorizedPickups, addGuardianToRegistration } from '@/mockApi';
import { useOperator } from '@/auth/OperatorContext';
import {
  computePrepaidFoodReconciliation,
  type PrepaidFoodReconciliation,
} from '@/lib/dropoff';
import { FoodReconciliationSummary } from '@/components/shared/FoodReconciliationSummary';
import { CameraCapture } from '@/components/shared/CameraCapture';

type Step = 'select' | 'verify' | 'on_spot' | 'capture';

interface CollectorInput {
  pickupId: string;
  name: string;
  relationship?: string;
  isDropperOff: boolean;
  source: AuthorizedPickupSource;
}

interface OnSpotForm {
  name: string;
  relationship: string;
  phone: string;
}

interface CheckOutModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  checkIn: CheckIn;
  /** The child's wristband (used to read remaining prepaid balance). */
  wristband?: Wristband;
  /** Configured policy for unused prepaid food. */
  prepaidFoodPolicy?: 'refund' | 'forfeit';
  /** Called once collector is verified and pickup photo captured. */
  onConfirm: (
    pickupPhotoUrl: string,
    collectorInput: CollectorInput,
    reconciliation?: { unusedTHB: number; policy: 'refund' | 'forfeit' },
  ) => void;
}

const SOURCE_BADGE: Record<AuthorizedPickupSource, { label: string; cls: string }> = {
  dropper_off: { label: 'Parent / dropper-off', cls: 'text-primary bg-primary/10' },
  in_person: { label: 'Added in person', cls: 'text-emerald-400 bg-emerald-500/10' },
  from_chat: { label: 'Promoted from chat', cls: 'text-sky-400 bg-sky-500/10' },
  on_the_spot: { label: 'Added on the spot', cls: 'text-amber-400 bg-amber-500/10' },
};

function PickupCard({
  pickup,
  selected,
  onClick,
}: {
  pickup: AuthorizedPickup;
  selected?: boolean;
  onClick: () => void;
}) {
  const badge = SOURCE_BADGE[pickup.source] ?? SOURCE_BADGE.in_person;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center gap-3 rounded-xl border p-3 text-left transition-all ${
        selected
          ? 'border-primary bg-primary/5 ring-2 ring-primary/30'
          : 'border-border hover:border-primary/50 hover:bg-muted/40'
      }`}
    >
      <div className="w-12 h-12 rounded-xl overflow-hidden bg-muted shrink-0 flex items-center justify-center">
        {pickup.photoUrl ? (
          <img src={pickup.photoUrl} alt={pickup.name} className="w-full h-full object-cover" />
        ) : (
          <User className="w-5 h-5 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-bold text-sm truncate">{pickup.name}</div>
        {pickup.relationship && (
          <div className="text-xs text-muted-foreground">{pickup.relationship}</div>
        )}
        <span className={`text-[10px] font-bold rounded-full px-1.5 py-0.5 ${badge.cls}`}>
          {badge.label}
        </span>
      </div>
      {selected && <Check className="w-4 h-4 text-primary shrink-0" />}
    </button>
  );
}

export function CheckOutModal({
  open,
  onOpenChange,
  checkIn,
  wristband,
  prepaidFoodPolicy,
  onConfirm,
}: CheckOutModalProps) {
  const { operator } = useOperator();
  const [step, setStep] = useState<Step>('select');
  const [pickups, setPickups] = useState<AuthorizedPickup[]>([]);
  const [selectedPickup, setSelectedPickup] = useState<AuthorizedPickup | null>(null);
  const [onSpotForm, setOnSpotForm] = useState<OnSpotForm>({ name: '', relationship: '', phone: '' });
  const [onSpotPhotoUrl, setOnSpotPhotoUrl] = useState<string | undefined>();
  const [pickupPhotoUrl, setPickupPhotoUrl] = useState<string | undefined>();

  // Load authorized pickups when modal opens.
  useEffect(() => {
    if (open) {
      setStep('select');
      setPickups(getAuthorizedPickups(checkIn.registrationId));
      setSelectedPickup(null);
      setOnSpotForm({ name: '', relationship: '', phone: '' });
      setOnSpotPhotoUrl(undefined);
      setPickupPhotoUrl(undefined);
    }
  }, [open, checkIn.registrationId]);

  const reconciliation = useMemo<PrepaidFoodReconciliation | null>(() => {
    const fp = wristband?.foodProvision ?? checkIn.foodProvision;
    if (!fp || fp.mode === 'none') return null;
    const remaining = wristband?.creditBalanceTHB ?? 0;
    return computePrepaidFoodReconciliation(fp, remaining);
  }, [wristband?.foodProvision, wristband?.creditBalanceTHB, checkIn.foodProvision]);

  const hasFood = reconciliation !== null;
  const policy = prepaidFoodPolicy ?? 'forfeit';

  const handleSelectPickup = (p: AuthorizedPickup) => {
    setSelectedPickup(p);
    // Dropper-off: skip verify, go straight to capture.
    if (p.isDropperOff) {
      setStep('capture');
    } else {
      setStep('verify');
    }
  };

  const handleConfirmVerify = () => setStep('capture');

  const handleOnSpotProceed = () => {
    if (!onSpotForm.name.trim()) return;
    // Persist the on-the-spot collector so they appear in the authorized list.
    if (!onSpotPhotoUrl) return;
    const guardian = addGuardianToRegistration(
      checkIn.registrationId,
      {
        name: onSpotForm.name.trim(),
        phone: onSpotForm.phone.trim() || undefined,
        relationship: onSpotForm.relationship.trim() || undefined,
        photoUrl: onSpotPhotoUrl,
        source: 'on_the_spot',
      },
      { operatorName: operator?.name ?? 'Unknown', operatorId: operator?.id },
    );
    if (!guardian) return;
    const persisted: AuthorizedPickup = {
      id: guardian.id,
      registrationId: guardian.registrationId,
      name: guardian.name,
      relationship: guardian.relationship,
      phone: guardian.phone || undefined,
      isDropperOff: false,
      source: 'on_the_spot',
      addedAt: guardian.addedAt,
    };
    // Refresh the list so the new guardian shows if user navigates back.
    setPickups(getAuthorizedPickups(checkIn.registrationId));
    setSelectedPickup(persisted);
    setStep('capture');
  };

  const buildCollectorInput = (): CollectorInput | null => {
    if (!selectedPickup) return null;
    return {
      pickupId: selectedPickup.id,
      name: selectedPickup.name,
      relationship: selectedPickup.relationship,
      isDropperOff: selectedPickup.isDropperOff,
      source: selectedPickup.source,
    };
  };

  const handleConfirmCheckOut = () => {
    if (!pickupPhotoUrl) return;
    const collectorInput = buildCollectorInput();
    if (!collectorInput) return;
    const rec =
      reconciliation && reconciliation.totalUnusedTHB > 0
        ? { unusedTHB: reconciliation.totalUnusedTHB, policy }
        : undefined;
    onConfirm(pickupPhotoUrl, collectorInput, rec);
    onOpenChange(false);
  };

  const TITLE: Record<Step, string> = {
    select: 'Who is collecting?',
    verify: 'Verify identity',
    on_spot: 'Add unlisted collector',
    capture: 'Capture pickup photo',
  };

  const initial = checkIn.childName.charAt(0).toUpperCase();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step !== 'select' && (
              <button
                type="button"
                onClick={() => {
                  if (step === 'verify' || step === 'on_spot') setStep('select');
                  else if (step === 'capture') {
                    // on_the_spot guardians are already persisted — go back to select (they'll be in list).
                    setStep(selectedPickup?.isDropperOff || selectedPickup?.source === 'on_the_spot' ? 'select' : 'verify');
                  }
                }}
                className="w-7 h-7 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors mr-1"
              >
                <ArrowLeft className="w-4 h-4" />
              </button>
            )}
            <ShieldCheck className="w-5 h-5 text-primary shrink-0" />
            {TITLE[step]}
          </DialogTitle>
          <DialogDescription className="flex items-center gap-1.5">
            <Baby className="w-4 h-4 shrink-0" />
            {checkIn.childName} · {checkIn.childAge} yrs · {checkIn.parentName}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">

          {/* ── STEP: select ─────────────────────────────────────────── */}
          {step === 'select' && (
            <>
              <p className="text-xs text-muted-foreground">
                Select the person collecting this child. Only authorized persons may collect.
              </p>
              <div className="space-y-2">
                {pickups.map((p) => (
                  <PickupCard
                    key={p.id}
                    pickup={p}
                    onClick={() => handleSelectPickup(p)}
                  />
                ))}
              </div>
              <div className="pt-1 border-t border-border">
                <Button
                  variant="outline"
                  className="w-full h-11 gap-2 text-amber-400 border-amber-500/30 hover:text-amber-300"
                  onClick={() => {
                    setSelectedPickup(null);
                    setOnSpotForm({ name: '', relationship: '', phone: '' });
                    setStep('on_spot');
                  }}
                >
                  <UserX className="w-4 h-4" />
                  Person not on the list
                </Button>
              </div>
            </>
          )}

          {/* ── STEP: verify ─────────────────────────────────────────── */}
          {step === 'verify' && selectedPickup && (
            <>
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 px-3 py-2.5 flex items-start gap-2 text-amber-300 text-xs">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>
                  This is a different person from the dropper-off. Verify their identity against the
                  photo below before proceeding.
                </span>
              </div>

              {/* Photo prominently */}
              <div className="flex gap-4 items-start">
                <div className="w-28 h-28 rounded-2xl overflow-hidden bg-muted flex items-center justify-center shrink-0">
                  {selectedPickup.photoUrl ? (
                    <img
                      src={selectedPickup.photoUrl}
                      alt={selectedPickup.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <User className="w-8 h-8 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 pt-1 space-y-1">
                  <div className="font-bold text-base">{selectedPickup.name}</div>
                  {selectedPickup.relationship && (
                    <div className="text-sm text-muted-foreground">{selectedPickup.relationship}</div>
                  )}
                  {selectedPickup.phone && (
                    <div className="text-xs font-mono text-muted-foreground">{selectedPickup.phone}</div>
                  )}
                  <div className="mt-1">
                    <span className={`text-[10px] font-bold rounded-full px-1.5 py-0.5 ${SOURCE_BADGE[selectedPickup.source].cls}`}>
                      {SOURCE_BADGE[selectedPickup.source].label}
                    </span>
                  </div>
                  {!selectedPickup.photoUrl && (
                    <p className="text-xs text-muted-foreground italic">No photo on file — verify ID manually</p>
                  )}
                </div>
              </div>

              <Button
                className="w-full h-12 gap-2"
                onClick={handleConfirmVerify}
              >
                <Check className="w-4 h-4" />
                Identity confirmed — proceed to pickup photo
              </Button>
            </>
          )}

          {/* ── STEP: on_spot ─────────────────────────────────────────── */}
          {step === 'on_spot' && (
            <>
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 px-3 py-2.5 flex items-start gap-2 text-amber-300 text-xs">
                <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                This person is not on the authorized list. Collect their details and capture a photo before releasing the child.
              </div>

              <div className="space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
                    Full name <span className="text-red-400">*</span>
                  </label>
                  <Input
                    value={onSpotForm.name}
                    onChange={(e) => setOnSpotForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Khun Somchai"
                    className="h-11"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
                    Relationship (optional)
                  </label>
                  <Input
                    value={onSpotForm.relationship}
                    onChange={(e) => setOnSpotForm((f) => ({ ...f, relationship: e.target.value }))}
                    placeholder="e.g. grandfather, uncle, family friend"
                    className="h-11"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
                    Phone (optional)
                  </label>
                  <Input
                    value={onSpotForm.phone}
                    onChange={(e) => setOnSpotForm((f) => ({ ...f, phone: e.target.value }))}
                    placeholder="+66 8X XXX XXXX"
                    className="h-11"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
                    Collector photo <span className="text-red-400">*</span>
                  </label>
                  <CameraCapture
                    value={onSpotPhotoUrl}
                    onCapture={setOnSpotPhotoUrl}
                    onClear={() => setOnSpotPhotoUrl(undefined)}
                  />
                </div>
              </div>

              <Button
                className="w-full h-12 gap-2"
                disabled={!onSpotForm.name.trim() || !onSpotPhotoUrl}
                onClick={handleOnSpotProceed}
              >
                <Camera className="w-4 h-4" />
                Proceed to pickup photo
              </Button>
            </>
          )}

          {/* ── STEP: capture ─────────────────────────────────────────── */}
          {step === 'capture' && selectedPickup && (
            <>
              {/* Collector summary */}
              <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-3">
                <div className="w-11 h-11 rounded-xl overflow-hidden bg-muted shrink-0 flex items-center justify-center">
                  {selectedPickup.photoUrl ? (
                    <img
                      src={selectedPickup.photoUrl}
                      alt={selectedPickup.name}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <User className="w-5 h-5 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="font-bold text-sm">{selectedPickup.name}</div>
                  {selectedPickup.relationship && (
                    <div className="text-xs text-muted-foreground">{selectedPickup.relationship}</div>
                  )}
                </div>
                <span className={`text-[10px] font-bold rounded-full px-1.5 py-0.5 shrink-0 ${SOURCE_BADGE[selectedPickup.source].cls}`}>
                  {SOURCE_BADGE[selectedPickup.source].label}
                </span>
              </div>

              {/* Sign-up photo vs pickup photo */}
              <div className="flex gap-3">
                <div className="flex-1 space-y-1.5">
                  <p className="text-xs font-semibold text-muted-foreground">Sign-up photo</p>
                  <div className="aspect-square rounded-xl overflow-hidden bg-muted flex items-center justify-center">
                    {checkIn.childPhotoUrl ? (
                      <img
                        src={checkIn.childPhotoUrl}
                        alt={checkIn.childName}
                        className="w-full h-full object-cover"
                      />
                    ) : (
                      <Baby className="w-8 h-8 text-muted-foreground/40" />
                    )}
                  </div>
                </div>
                <div className="flex-1 space-y-1.5">
                  <p className="text-xs font-semibold text-muted-foreground">Pickup photo</p>
                  <div className="aspect-square rounded-xl overflow-hidden bg-muted flex items-center justify-center">
                    {pickupPhotoUrl ? (
                      <div className="flex flex-col items-center gap-1 text-emerald-400">
                        <Check className="w-8 h-8" />
                        <span className="text-[11px] font-semibold">Captured</span>
                      </div>
                    ) : (
                      <span className="text-3xl font-black text-muted-foreground">{initial}</span>
                    )}
                  </div>
                </div>
              </div>

              {/* Camera capture */}
              <div className="rounded-xl border border-border bg-muted/20 p-3">
                <p className="text-xs font-semibold text-muted-foreground mb-3">Capture pickup photo</p>
                <CameraCapture
                  value={pickupPhotoUrl}
                  onCapture={(url) => setPickupPhotoUrl(url)}
                  onClear={() => setPickupPhotoUrl(undefined)}
                />
              </div>

              {hasFood && (
                <FoodReconciliationSummary reconciliation={reconciliation!} policy={policy} />
              )}

              <Button
                variant="destructive"
                className="w-full h-14 text-lg gap-2"
                disabled={!pickupPhotoUrl}
                onClick={handleConfirmCheckOut}
              >
                <LogOut className="w-5 h-5" />
                {pickupPhotoUrl ? 'Confirm pickup & check out' : 'Capture a photo first'}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
