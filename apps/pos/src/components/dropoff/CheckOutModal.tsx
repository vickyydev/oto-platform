import { useEffect, useMemo, useRef, useState } from 'react';
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
  Loader2,
} from 'lucide-react';
import { BOX_CHECKIN_REFUSALS, type PickupView, type ReleaseView } from '@oto/shared';
import { type PrepaidFoodReconciliation } from '@/lib/dropoff';
import { FoodReconciliationSummary } from '@/components/shared/FoodReconciliationSummary';
import { CameraCapture } from '@/components/shared/CameraCapture';
import {
  pickupFromView,
  reconciliationFromWire,
  releaseApi,
  type ReleaseCollector,
  type ReleaseContext,
} from '@/api/release';

/**
 * The release modal (S2-13 round 3, plan docs/progress/plans/checkin/PLAN.md
 * §2.4). The prototype's four steps and their look are unchanged; what moved
 * is where the data lives. The pickup list, the stored sign-up photo and the
 * prepaid food come from the platform; the on-the-spot collector is added to
 * the platform's list with the photo stored; the live pickup photo is stored;
 * and "Confirm pickup" RELEASES the child on the platform, which enforces
 * R-92 itself and answers a refusal in the counter's words. Every stored
 * photo shown here is read through the access-logged path (R-94).
 *
 * PHOTOS SWITCHED OFF (gate r4, finding 2). On the box lane the context
 * carries the box's `photosEnabled`. While it is false the box refuses every
 * capture — "carry on without a photo" — and accepts a release, or an
 * on-the-spot collector, with none; so the camera steps are replaced by that
 * note in the box's own words and the confirm button does not wait for a
 * photo. The platform never answers `photosEnabled`, so online a photo is
 * required exactly as before.
 */

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
  /**
   * The child's wristband. Kept for the board's call; the remaining prepaid
   * balance is now the platform's (round 3), so it is not read here.
   */
  wristband?: Wristband;
  /** Configured policy for unused prepaid food — shown until the platform's answers. */
  prepaidFoodPolicy?: 'refund' | 'forfeit';
  /**
   * Called once the platform has RELEASED the child: the release is written
   * by this modal — R-92 checked, the pickup photo stored, the prepaid food
   * settled — and `release` carries what was recorded. The board refreshes;
   * it must not release a second time.
   */
  onConfirm: (
    pickupPhotoUrl: string,
    collectorInput: CollectorInput,
    reconciliation?: { unusedTHB: number; policy: 'refund' | 'forfeit' },
    release?: ReleaseView,
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
  prepaidFoodPolicy,
  onConfirm,
}: CheckOutModalProps) {
  const [step, setStep] = useState<Step>('select');
  const [pickups, setPickups] = useState<AuthorizedPickup[]>([]);
  const [selectedPickup, setSelectedPickup] = useState<AuthorizedPickup | null>(null);
  const [onSpotForm, setOnSpotForm] = useState<OnSpotForm>({ name: '', relationship: '', phone: '' });
  const [onSpotPhotoUrl, setOnSpotPhotoUrl] = useState<string | undefined>();
  const [pickupPhotoUrl, setPickupPhotoUrl] = useState<string | undefined>();
  // The platform's side of the same screen.
  const [context, setContext] = useState<ReleaseContext | null>(null);
  const [signUpPhotoUrl, setSignUpPhotoUrl] = useState<string | undefined>();
  const [onSpotFileId, setOnSpotFileId] = useState<string | null>(null);
  const [pickupFileId, setPickupFileId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One opening, one release id — a retried press is the same release.
  const releaseIdRef = useRef<string>(releaseApi.newId());
  // Each stored photo is read (and so access-logged) once per opening, not per render.
  const photoUrlsRef = useRef(new Map<string, string>());

  const photoUrlOf = async (fileId: string | null): Promise<string | undefined> => {
    if (!fileId) return undefined;
    const known = photoUrlsRef.current.get(fileId);
    if (known) return known;
    try {
      const url = await releaseApi.photoUrl(fileId);
      photoUrlsRef.current.set(fileId, url);
      return url;
    } catch {
      return undefined;
    }
  };

  const showPickups = async (views: PickupView[]) => {
    const list = await Promise.all(views.map(async (p) => pickupFromView(p, await photoUrlOf(p.photoFileId))));
    setPickups(list);
  };

  // Load the pickup list, the sign-up photo and the food from the platform when the modal opens.
  useEffect(() => {
    if (!open) return;
    let live = true;
    setStep('select');
    setPickups([]);
    setSelectedPickup(null);
    setOnSpotForm({ name: '', relationship: '', phone: '' });
    setOnSpotPhotoUrl(undefined);
    setPickupPhotoUrl(undefined);
    setOnSpotFileId(null);
    setPickupFileId(null);
    setContext(null);
    setSignUpPhotoUrl(undefined);
    setError(null);
    setBusy(false);
    releaseIdRef.current = releaseApi.newId();
    photoUrlsRef.current = new Map();
    void (async () => {
      try {
        const ctx = await releaseApi.context(checkIn.id);
        if (!live) return;
        setContext(ctx);
        const signUp = await photoUrlOf(ctx.signUpPhotoFileId);
        if (!live) return;
        setSignUpPhotoUrl(signUp);
        await showPickups(ctx.pickups);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : 'The pickup list could not be loaded.');
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- photoUrlOf and showPickups read refs and setters only; the stay is what reloads it
  }, [open, checkIn.id]);

  const reconciliation = useMemo<PrepaidFoodReconciliation | null>(
    () => (context?.reconciliation ? reconciliationFromWire(context.reconciliation) : null),
    [context?.reconciliation],
  );

  const hasFood = reconciliation !== null;
  // Required unless the box said photos are switched off; the platform never says so.
  const photosEnabled = context?.photosEnabled !== false;
  const policy = context?.prepaidPolicy ?? prepaidFoodPolicy ?? 'forfeit';
  const registrationId = context?.registrationId ?? checkIn.registrationId;
  const uploadPhoto = (dataUrl: string) => releaseApi.uploadPhoto(registrationId, dataUrl);

  const handleSelectPickup = (p: AuthorizedPickup) => {
    setSelectedPickup(p);
    setError(null);
    // Dropper-off: skip verify, go straight to capture.
    if (p.isDropperOff) {
      setStep('capture');
    } else {
      setStep('verify');
    }
  };

  const handleConfirmVerify = () => setStep('capture');

  const handleOnSpotProceed = async () => {
    if (!onSpotForm.name.trim()) return;
    // Persist the on-the-spot collector so they appear in the authorized list.
    // The platform refuses one without a name and a photo (R-92); the box
    // takes one without a photo only while photos are switched off there.
    const withPhoto = photosEnabled ? onSpotFileId : null;
    if (photosEnabled && (!onSpotPhotoUrl || !withPhoto)) return;
    setBusy(true);
    setError(null);
    try {
      const guardian = await releaseApi.addGuardian(registrationId, {
        id: releaseApi.newId(),
        name: onSpotForm.name.trim(),
        phone: onSpotForm.phone.trim() || null,
        relationship: onSpotForm.relationship.trim() || null,
        photoFileId: withPhoto,
        source: 'on_the_spot',
      });
      if (withPhoto && onSpotPhotoUrl) photoUrlsRef.current.set(withPhoto, onSpotPhotoUrl);
      const persisted = pickupFromView(guardian, withPhoto ? onSpotPhotoUrl : undefined);
      // Refresh the list so the new guardian shows if user navigates back.
      const fresh = await releaseApi.pickups(registrationId).catch(() => null);
      if (fresh) await showPickups(fresh.pickups);
      setSelectedPickup(persisted);
      setStep('capture');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The collector could not be added.');
    } finally {
      setBusy(false);
    }
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

  const handleConfirmCheckOut = async () => {
    // The live pickup photo, unless the box said photos are switched off.
    const photo = photosEnabled ? pickupFileId : null;
    if (photosEnabled && (!pickupPhotoUrl || !photo)) return;
    const collectorInput = buildCollectorInput();
    if (!collectorInput || !selectedPickup) return;
    const collector: ReleaseCollector = selectedPickup.isDropperOff
      ? { kind: 'dropper_off' }
      : { kind: 'guardian', guardianId: selectedPickup.id };
    setBusy(true);
    setError(null);
    try {
      const { release } = await releaseApi.release(checkIn.id, {
        id: releaseIdRef.current,
        collector,
        pickupPhotoFileId: photo,
      });
      const settled = release.settlement;
      const rec =
        settled && settled.unusedSatang > 0
          ? { unusedTHB: settled.unusedSatang / 100, policy: settled.policy }
          : undefined;
      onConfirm(photo ? (pickupPhotoUrl ?? '') : '', collectorInput, rec, release);
      onOpenChange(false);
    } catch (err) {
      // R-92's refusals arrive in the counter's words; show them as they came.
      setError(err instanceof Error ? err.message : 'The child could not be released.');
    } finally {
      setBusy(false);
    }
  };

  const TITLE: Record<Step, string> = {
    select: 'Who is collecting?',
    verify: 'Verify identity',
    on_spot: 'Add unlisted collector',
    capture: photosEnabled ? 'Capture pickup photo' : 'Confirm pickup',
  };

  const initial = checkIn.childName.charAt(0).toUpperCase();
  const signUpUrl = signUpPhotoUrl ?? checkIn.childPhotoUrl;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {step !== 'select' && (
              <button
                type="button"
                onClick={() => {
                  setError(null);
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

          {error && (
            <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 flex items-start gap-2 text-red-300 text-xs">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          {/* ── STEP: select ─────────────────────────────────────────── */}
          {step === 'select' && (
            <>
              <p className="text-xs text-muted-foreground">
                Select the person collecting this child. Only authorized persons may collect.
              </p>
              <div className="space-y-2">
                {!context && !error && (
                  <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Loading the pickup list…
                  </div>
                )}
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
                  disabled={!context}
                  onClick={() => {
                    setSelectedPickup(null);
                    setOnSpotForm({ name: '', relationship: '', phone: '' });
                    setOnSpotPhotoUrl(undefined);
                    setOnSpotFileId(null);
                    setError(null);
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
                {photosEnabled
                  ? 'This person is not on the authorized list. Collect their details and capture a photo before releasing the child.'
                  : 'This person is not on the authorized list. Collect their details before releasing the child.'}
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
                {photosEnabled ? (
                  <div>
                    <label className="block text-xs font-semibold text-muted-foreground mb-1.5">
                      Collector photo <span className="text-red-400">*</span>
                    </label>
                    <CameraCapture
                      value={onSpotPhotoUrl}
                      onCapture={setOnSpotPhotoUrl}
                      onClear={() => setOnSpotPhotoUrl(undefined)}
                      upload={uploadPhoto}
                      onUploaded={setOnSpotFileId}
                    />
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground italic">{BOX_CHECKIN_REFUSALS.photosOff.message}</p>
                )}
              </div>

              <Button
                className="w-full h-12 gap-2"
                disabled={!onSpotForm.name.trim() || (photosEnabled && (!onSpotPhotoUrl || !onSpotFileId)) || busy}
                onClick={() => void handleOnSpotProceed()}
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : photosEnabled ? <Camera className="w-4 h-4" /> : <Check className="w-4 h-4" />}
                {photosEnabled ? 'Proceed to pickup photo' : 'Proceed to confirm pickup'}
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

              {photosEnabled ? (
                <>
                  {/* Sign-up photo vs pickup photo */}
                  <div className="flex gap-3">
                    <div className="flex-1 space-y-1.5">
                      <p className="text-xs font-semibold text-muted-foreground">Sign-up photo</p>
                      <div className="aspect-square rounded-xl overflow-hidden bg-muted flex items-center justify-center">
                        {signUpUrl ? (
                          <img
                            src={signUpUrl}
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
                      upload={uploadPhoto}
                      onUploaded={setPickupFileId}
                    />
                  </div>
                </>
              ) : (
                // The box's own words: photos are switched off at this park, so no
                // pickup photo is taken or required — the collector is checked by eye.
                <div className="rounded-xl border border-border bg-muted/20 px-3 py-2.5 flex items-start gap-2 text-xs text-muted-foreground">
                  <ShieldCheck className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>{BOX_CHECKIN_REFUSALS.photosOff.message}</span>
                </div>
              )}

              {hasFood && (
                <FoodReconciliationSummary reconciliation={reconciliation!} policy={policy} />
              )}

              <Button
                variant="destructive"
                className="w-full h-14 text-lg gap-2"
                disabled={(photosEnabled && (!pickupPhotoUrl || !pickupFileId)) || busy}
                onClick={() => void handleConfirmCheckOut()}
              >
                {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <LogOut className="w-5 h-5" />}
                {!photosEnabled
                  ? 'Confirm pickup & check out'
                  : !pickupPhotoUrl
                    ? 'Capture a photo first'
                    : !pickupFileId
                      ? 'Saving photo…'
                      : 'Confirm pickup & check out'}
              </Button>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
