import { useEffect, useMemo, useRef, useState } from 'react';
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
  Loader2,
} from 'lucide-react';
import { BOX_CHECKIN_REFUSALS, type PickupView, type ReleaseView } from '@oto/shared';
import { type PrepaidFoodReconciliation } from '@/lib/dropoff';
import { FoodReconciliationSummary } from '@/components/shared/FoodReconciliationSummary';
import {
  pickupFromView,
  reconciliationFromWire,
  releaseApi,
  type ReleaseCollector,
  type ReleaseContext,
} from '@/api/release';

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
  /** Configured policy for unused prepaid food — shown until the platform's answers. */
  prepaidFoodPolicy: 'refund' | 'forfeit';
  /**
   * Called once the platform has RELEASED the child: the release is written by
   * this view (`releaseApi.release` — R-92 checked, the pickup photo stored,
   * the prepaid food settled) and `release` carries what was recorded. The
   * board refreshes; it must not release a second time.
   */
  onConfirm: (pickupPhotoUrl: string, collectorInput: CollectorInput, release: ReleaseView) => void;
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
 *
 * The data is the platform's, through the same calls as the desktop release
 * modal (`releaseApi`): the pickup list, the stored sign-up photo and the
 * prepaid food come from `releaseApi.context`; an on-the-spot collector is
 * added to the platform's list with the photo stored; the live pickup photo is
 * stored; and "Confirm pickup" RELEASES the child on the platform, which
 * enforces R-92 itself and answers a refusal in the counter's words. Every
 * stored photo shown here is read through the access-logged path (R-94).
 * On the box lane the context carries `photosEnabled`; while it is false the
 * camera steps carry the box's own note and the confirm does not wait for a
 * photo. The platform never answers it, so online a photo is required.
 */
export function MobileCheckOutView({
  checkIn,
  prepaidFoodPolicy,
  onConfirm,
  onCancel,
}: MobileCheckOutViewProps) {
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

  // The pickup list, the sign-up photo and the food, from the platform.
  useEffect(() => {
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
  }, [checkIn.id]);

  const reconciliation = useMemo<PrepaidFoodReconciliation | null>(
    () => (context?.reconciliation ? reconciliationFromWire(context.reconciliation) : null),
    [context?.reconciliation],
  );
  // Required unless the box said photos are switched off; the platform never says so.
  const photosEnabled = context?.photosEnabled !== false;
  const policy = context?.prepaidPolicy ?? prepaidFoodPolicy;
  const registrationId = context?.registrationId ?? checkIn.registrationId;
  const uploadPhoto = (dataUrl: string) => releaseApi.uploadPhoto(registrationId, dataUrl);

  const handleSelectPickup = (p: AuthorizedPickup) => {
    setSelectedPickup(p);
    setError(null);
    if (p.isDropperOff) {
      setStep('capture');
    } else {
      setStep('verify');
    }
  };

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
      // Refresh the list so the new guardian shows if user navigates back to select.
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

  const handleConfirmCheckOut = async () => {
    // The live pickup photo, unless the box said photos are switched off.
    const photo = photosEnabled ? pickupFileId : null;
    if (photosEnabled && (!pickupPhotoUrl || !photo)) return;
    if (!selectedPickup) return;
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
      onConfirm(
        photo ? (pickupPhotoUrl ?? '') : '',
        {
          pickupId: selectedPickup.id,
          name: selectedPickup.name,
          relationship: selectedPickup.relationship,
          isDropperOff: selectedPickup.isDropperOff,
          source: selectedPickup.source,
        },
        release,
      );
    } catch (err) {
      // R-92's refusals arrive in the counter's words; show them as they came.
      setError(err instanceof Error ? err.message : 'The child could not be released.');
    } finally {
      setBusy(false);
    }
  };

  const goBack = () => {
    setError(null);
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
    capture: photosEnabled ? 'Capture pickup photo' : 'Confirm pickup',
  };

  const stepNum = { select: 1, verify: 2, on_spot: 2, capture: 3 }[step];
  const signUpUrl = signUpPhotoUrl ?? checkIn.childPhotoUrl;

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

        {error && (
          <div className="rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2.5 flex items-start gap-2 text-red-300 text-xs">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* ── STEP: select ─────────────────────────────────── */}
        {step === 'select' && (
          <>
            <p className="text-xs text-muted-foreground">
              Select the person collecting this child from the authorized list.
            </p>
            <div className="space-y-2">
              {!context && !error && (
                <div className="flex items-center justify-center gap-2 py-4 text-xs text-muted-foreground">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  Loading the pickup list…
                </div>
              )}
              {pickups.map((p) => (
                <PickupCard key={p.id} pickup={p} onClick={() => handleSelectPickup(p)} />
              ))}
            </div>
            <button
              type="button"
              disabled={!context}
              onClick={() => {
                setSelectedPickup(null);
                setOnSpotForm({ name: '', relationship: '', phone: '' });
                setOnSpotPhotoUrl(undefined);
                setOnSpotFileId(null);
                setError(null);
                setStep('on_spot');
              }}
              className="w-full flex items-center justify-center gap-2 rounded-2xl border border-dashed border-amber-500/40 text-amber-400 h-12 text-sm font-semibold hover:bg-amber-500/5 transition-colors disabled:opacity-50"
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

            {photosEnabled ? (
              <>
                {/* Sign-up photo + pickup capture side by side */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <p className="text-xs font-semibold text-muted-foreground mb-2 flex items-center gap-1">
                      <Baby className="w-3 h-3" /> Sign-up photo
                    </p>
                    <div className="aspect-square rounded-xl overflow-hidden bg-muted flex items-center justify-center">
                      {signUpUrl ? (
                        <img
                          src={signUpUrl}
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

            {/* Food reconciliation */}
            {reconciliation !== null && (
              <FoodReconciliationSummary
                reconciliation={reconciliation}
                policy={policy}
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
            disabled={!onSpotForm.name.trim() || (photosEnabled && (!onSpotPhotoUrl || !onSpotFileId)) || busy}
            onClick={() => void handleOnSpotProceed()}
          >
            {busy && <Loader2 className="w-5 h-5 animate-spin" />}
            {photosEnabled ? 'Proceed to pickup photo' : 'Proceed to confirm pickup'}
          </Button>
        )}

        {step === 'capture' && (
          <Button
            variant="destructive"
            size="lg"
            className="w-full h-14 text-lg gap-2 rounded-2xl"
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
        )}
      </div>
    </div>
  );
}
