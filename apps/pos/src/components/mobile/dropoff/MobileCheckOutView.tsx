import { useEffect, useState } from 'react';
import { CheckIn, AuthorizedPickup, AuthorizedPickupSource } from '@/types';
import { CameraCapture } from '@/components/shared/CameraCapture';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  ShieldCheck,
  LogOut,
  Baby,
  ArrowLeft,
  Check,
  User,
  UserX,
  AlertTriangle,
} from 'lucide-react';
import { getAuthorizedPickups, addGuardianToRegistration } from '@/mockApi';
import { useOperator } from '@/auth/OperatorContext';
import { type PrepaidFoodReconciliation } from '@/lib/dropoff';
import { FoodReconciliationSummary } from '@/components/shared/FoodReconciliationSummary';

type Step = 'select' | 'verify' | 'on_spot' | 'capture';

export interface CollectorInput {
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

interface MobileCheckOutViewProps {
  checkIn: CheckIn;
  /** Pre-computed food reconciliation — null when no food provision or mode=none. */
  reconciliation: PrepaidFoodReconciliation | null;
  /** Configured policy for unused prepaid food. */
  prepaidFoodPolicy: 'refund' | 'forfeit';
  onConfirm: (pickupPhotoUrl: string, collectorInput: CollectorInput) => void;
  onCancel: () => void;
}

const SOURCE_BADGE: Record<AuthorizedPickupSource, { label: string; cls: string }> = {
  dropper_off: { label: 'Parent / dropper-off', cls: 'text-primary bg-primary/10' },
  in_person: { label: 'Added in person', cls: 'text-emerald-400 bg-emerald-500/10' },
  from_chat: { label: 'Promoted from chat', cls: 'text-sky-400 bg-sky-500/10' },
  on_the_spot: { label: 'Added on the spot', cls: 'text-amber-400 bg-amber-500/10' },
};

function PickupCard({
  pickup,
  onClick,
}: {
  pickup: AuthorizedPickup;
  onClick: () => void;
}) {
  const badge = SOURCE_BADGE[pickup.source] ?? SOURCE_BADGE.in_person;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full flex items-center gap-3 rounded-2xl border border-border bg-card/50 hover:border-primary/50 hover:bg-muted/30 p-3 text-left transition-all"
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
    </button>
  );
}

/**
 * Full-screen in-app check-out view for mobile with a multi-step flow:
 *  1. Select who is collecting (authorized list + "not on list" escape).
 *  2. Verify a different authorized person against their photo.
 *  3. Add an unlisted person on the spot (name / relationship / phone).
 *  4. Capture a pickup photo before releasing the child.
 */
export function MobileCheckOutView({
  checkIn,
  reconciliation,
  prepaidFoodPolicy,
  onConfirm,
  onCancel,
}: MobileCheckOutViewProps) {
  const { operator } = useOperator();
  const [step, setStep] = useState<Step>('select');
  const [pickups, setPickups] = useState<AuthorizedPickup[]>([]);
  const [selectedPickup, setSelectedPickup] = useState<AuthorizedPickup | null>(null);
  const [onSpotForm, setOnSpotForm] = useState<OnSpotForm>({ name: '', relationship: '', phone: '' });
  const [onSpotPhotoUrl, setOnSpotPhotoUrl] = useState<string | undefined>();
  const [pickupPhotoUrl, setPickupPhotoUrl] = useState<string | undefined>();

  useEffect(() => {
    setStep('select');
    setPickups(getAuthorizedPickups(checkIn.registrationId));
    setSelectedPickup(null);
    setOnSpotForm({ name: '', relationship: '', phone: '' });
    setOnSpotPhotoUrl(undefined);
    setPickupPhotoUrl(undefined);
  }, [checkIn.id, checkIn.registrationId]);

  const handleSelectPickup = (p: AuthorizedPickup) => {
    setSelectedPickup(p);
    if (p.isDropperOff) {
      setStep('capture');
    } else {
      setStep('verify');
    }
  };

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
    // Refresh the list so the new guardian shows if user navigates back to select.
    setPickups(getAuthorizedPickups(checkIn.registrationId));
    setSelectedPickup(persisted);
    setStep('capture');
  };

  const handleConfirmCheckOut = () => {
    if (!pickupPhotoUrl || !selectedPickup) return;
    onConfirm(pickupPhotoUrl, {
      pickupId: selectedPickup.id,
      name: selectedPickup.name,
      relationship: selectedPickup.relationship,
      isDropperOff: selectedPickup.isDropperOff,
      source: selectedPickup.source,
    });
  };

  const goBack = () => {
    if (step === 'verify' || step === 'on_spot') setStep('select');
    else if (step === 'capture') {
      // on_the_spot guardians are already persisted — go back to select (they'll be in list).
      setStep(selectedPickup?.isDropperOff || selectedPickup?.source === 'on_the_spot' ? 'select' : 'verify');
    } else {
      onCancel();
    }
  };

  const TITLE: Record<Step, string> = {
    select: 'Who is collecting?',
    verify: 'Verify identity',
    on_spot: 'Add unlisted collector',
    capture: 'Capture pickup photo',
  };

  const stepNum = { select: 1, verify: 2, on_spot: 2, capture: 3 }[step];

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background text-foreground animate-in fade-in duration-200">
      {/* Header */}
      <div className="shrink-0 flex items-center gap-3 px-4 h-14 border-b bg-card/30">
        <button
          type="button"
          onClick={goBack}
          className="w-9 h-9 flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground transition-colors"
        >
          <ArrowLeft className="w-5 h-5" />
        </button>
        <ShieldCheck className="w-5 h-5 text-primary" />
        <span className="font-bold flex-1">{TITLE[step]}</span>
        <span className="text-xs text-muted-foreground font-semibold">Step {stepNum}/3</span>
      </div>

      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4">
        {/* Child info strip */}
        <div className="flex items-center gap-3 rounded-xl bg-muted/50 border border-border p-3">
          <Baby className="w-4 h-4 text-muted-foreground shrink-0" />
          <span className="font-semibold truncate">{checkIn.childName}</span>
          <span className="text-sm text-muted-foreground shrink-0">{checkIn.childAge} yrs</span>
          <span className="text-sm text-muted-foreground shrink-0 truncate">· {checkIn.parentName}</span>
        </div>

        {/* ── STEP: select ─────────────────────────────────── */}
        {step === 'select' && (
          <>
            <p className="text-xs text-muted-foreground">
              Select the person collecting this child from the authorized list.
            </p>
            <div className="space-y-2">
              {pickups.map((p) => (
                <PickupCard key={p.id} pickup={p} onClick={() => handleSelectPickup(p)} />
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                setSelectedPickup(null);
                setOnSpotForm({ name: '', relationship: '', phone: '' });
                setStep('on_spot');
              }}
              className="w-full flex items-center justify-center gap-2 rounded-2xl border border-dashed border-amber-500/40 text-amber-400 h-12 text-sm font-semibold hover:bg-amber-500/5 transition-colors"
            >
              <UserX className="w-4 h-4" />
              Person not on the list
            </button>
          </>
        )}

        {/* ── STEP: verify ─────────────────────────────────── */}
        {step === 'verify' && selectedPickup && (
          <>
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 px-3 py-2.5 flex items-start gap-2 text-amber-300 text-xs">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              Different from dropper-off. Verify their identity against the photo below.
            </div>

            <div className="rounded-2xl border border-border bg-card/50 p-4 flex gap-4 items-start">
              <div className="w-24 h-24 rounded-2xl overflow-hidden bg-muted shrink-0 flex items-center justify-center">
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
              <div className="min-w-0 flex-1 pt-1 space-y-1">
                <div className="font-bold text-base">{selectedPickup.name}</div>
                {selectedPickup.relationship && (
                  <div className="text-sm text-muted-foreground">{selectedPickup.relationship}</div>
                )}
                {selectedPickup.phone && (
                  <div className="text-xs font-mono text-muted-foreground">{selectedPickup.phone}</div>
                )}
                {!selectedPickup.photoUrl && (
                  <p className="text-xs text-muted-foreground italic">No photo — verify ID manually</p>
                )}
              </div>
            </div>
          </>
        )}

        {/* ── STEP: on_spot ─────────────────────────────────── */}
        {step === 'on_spot' && (
          <>
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/8 px-3 py-2.5 flex items-start gap-2 text-amber-300 text-xs">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              Not on the authorized list. Collect their details before releasing the child.
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
                  className="h-12"
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
                  className="h-12"
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
                  className="h-12"
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
          </>
        )}

        {/* ── STEP: capture ─────────────────────────────────── */}
        {step === 'capture' && selectedPickup && (
          <>
            {/* Collector summary */}
            <div className="flex items-center gap-3 rounded-xl border border-border bg-muted/30 p-3">
              <div className="w-10 h-10 rounded-xl overflow-hidden bg-muted shrink-0 flex items-center justify-center">
                {selectedPickup.photoUrl ? (
                  <img src={selectedPickup.photoUrl} alt={selectedPickup.name} className="w-full h-full object-cover" />
                ) : (
                  <User className="w-4 h-4 text-muted-foreground" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="font-bold text-sm truncate">{selectedPickup.name}</div>
                {selectedPickup.relationship && (
                  <div className="text-xs text-muted-foreground">{selectedPickup.relationship}</div>
                )}
              </div>
              <span className={`text-[10px] font-bold rounded-full px-1.5 py-0.5 shrink-0 ${SOURCE_BADGE[selectedPickup.source].cls}`}>
                {SOURCE_BADGE[selectedPickup.source].label}
              </span>
            </div>

            {/* Sign-up photo + pickup capture side by side */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
                  <Baby className="w-3 h-3" /> Sign-up photo
                </p>
                <div className="aspect-square rounded-xl overflow-hidden bg-muted flex items-center justify-center">
                  {checkIn.childPhotoUrl ? (
                    <img
                      src={checkIn.childPhotoUrl}
                      alt={checkIn.childName}
                      className="w-full h-full object-cover"
                    />
                  ) : (
                    <span className="text-3xl font-black text-muted-foreground">
                      {checkIn.childName.charAt(0).toUpperCase()}
                    </span>
                  )}
                </div>
              </div>
              <div>
                <p className="text-xs font-semibold text-muted-foreground mb-2">Pickup photo</p>
                <div className="aspect-square rounded-xl overflow-hidden bg-muted flex items-center justify-center">
                  {pickupPhotoUrl ? (
                    <div className="flex flex-col items-center gap-1.5 text-emerald-400">
                      <Check className="w-8 h-8" />
                      <span className="text-xs font-semibold">Captured</span>
                    </div>
                  ) : (
                    <span className="text-3xl font-black text-muted-foreground">?</span>
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

            {/* Food reconciliation */}
            {reconciliation !== null && (
              <FoodReconciliationSummary
                reconciliation={reconciliation}
                policy={prepaidFoodPolicy}
              />
            )}
          </>
        )}
      </div>

      {/* Footer actions */}
      <div className="shrink-0 p-4 border-t bg-card/30 space-y-3">
        {step === 'select' && (
          <Button
            variant="ghost"
            size="lg"
            className="w-full h-12 text-muted-foreground"
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}

        {step === 'verify' && (
          <Button
            size="lg"
            className="w-full h-14 text-base gap-2 rounded-2xl"
            onClick={() => setStep('capture')}
          >
            <Check className="w-5 h-5" />
            Identity confirmed — take pickup photo
          </Button>
        )}

        {step === 'on_spot' && (
          <Button
            size="lg"
            className="w-full h-14 text-base gap-2 rounded-2xl"
            disabled={!onSpotForm.name.trim() || !onSpotPhotoUrl}
            onClick={handleOnSpotProceed}
          >
            Proceed to pickup photo
          </Button>
        )}

        {step === 'capture' && (
          <Button
            variant="destructive"
            size="lg"
            className="w-full h-14 text-lg gap-2 rounded-2xl"
            disabled={!pickupPhotoUrl}
            onClick={handleConfirmCheckOut}
          >
            <LogOut className="w-5 h-5" />
            {pickupPhotoUrl ? 'Confirm pickup & check out' : 'Capture a photo first'}
          </Button>
        )}
      </div>
    </div>
  );
}
