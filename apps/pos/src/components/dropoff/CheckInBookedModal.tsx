import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { CameraCapture } from '@/components/shared/CameraCapture';
import { CheckIn } from '@/types';
import { getNannyRoster, getDropOffPricing } from '@/mockApi';
import {
  UserCheck,
  Baby,
  AlertTriangle,
  LogIn,
  Camera,
  ShieldCheck,
  UtensilsCrossed,
} from 'lucide-react';

// One child's resolved check-in input — built locally and handed up on confirm.
export interface BookedCheckInItem {
  checkInId: string;
  nannyId?: string;
  childPhotoUrl?: string;
  confirmationsAccepted?: boolean;
}

interface CheckInBookedModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The booked (registered + scheduledFor) children of ONE registration.
  family: CheckIn[];
  onConfirm: (items: BookedCheckInItem[]) => void;
}

// Plain-language summary of a child's prepaid food provision (read-only — staff
// just confirm it's loaded onto the band, there is no charge to take).
function foodSummary(child: CheckIn): string {
  const fp = child.foodProvision;
  if (!fp || fp.mode === 'none') return 'No prepaid food';
  if (fp.mode === 'prepaid_credit') return `Prepaid credit ฿${fp.creditAmountTHB ?? fp.paidTHB}`;
  const names = (fp.items ?? []).map((i) => `${i.menuItemName}${i.qty > 1 ? ` ×${i.qty}` : ''}`);
  return names.length > 0 ? `Prepaid: ${names.join(', ')} (฿${fp.paidTHB})` : `Prepaid food ฿${fp.paidTHB}`;
}

/**
 * Payment-free check-in for a BOOKED (already-paid) drop-off / nanny registration.
 * Runs ONLY the in-park check-in process: pick the nanny (nanny children),
 * capture consent + the sign-up photo (one shot of the child together with the
 * parent / guardian) if it wasn't on file, confirm prepaid food, then hand the
 * resolved per-child inputs up. NEVER takes payment or opens the till.
 */
export function CheckInBookedModal({
  open,
  onOpenChange,
  family,
  onConfirm,
}: CheckInBookedModalProps) {
  const rep = family[0];
  const nannyChildren = useMemo(() => family.filter((c) => c.serviceType === 'nanny'), [family]);
  const needsNanny = nannyChildren.length > 0;

  // One shared nanny for the whole family (the park assigns a single nanny per
  // family — mirrors the online "one nanny per family" model).
  const [nannyId, setNannyId] = useState<string | null>(null);
  // Captured consent + photos for any child missing them (the edge case).
  const [photos, setPhotos] = useState<Record<string, string>>({});
  const [consentAck, setConsentAck] = useState(false);

  const nannies = useMemo(() => getNannyRoster(), [open]);
  const softMax = useMemo(() => getDropOffPricing().nannyRatioSoftMax, []);

  useEffect(() => {
    if (open) {
      setNannyId(nannyChildren.find((c) => c.assignedNannyId)?.assignedNannyId ?? null);
      setPhotos({});
      setConsentAck(false);
    }
  }, [open, family]);

  // Children whose consent / photo isn't on file → must be captured before check-in.
  const childrenMissingConsent = family.filter((c) => !c.confirmationsAccepted);
  const childrenMissingPhoto = family.filter((c) => !c.childPhotoUrl && !photos[c.id]);
  const consentNeeded = childrenMissingConsent.length > 0;
  const selectedNanny = nannies.find((n) => n.id === nannyId);
  const overRatio = !!selectedNanny && selectedNanny.load + 1 > softMax;

  const canConfirm =
    (!needsNanny || !!nannyId) &&
    childrenMissingPhoto.length === 0 &&
    (!consentNeeded || consentAck);

  const handleConfirm = () => {
    if (!canConfirm) return;
    const items: BookedCheckInItem[] = family.map((c) => ({
      checkInId: c.id,
      nannyId: c.serviceType === 'nanny' ? (nannyId ?? c.assignedNannyId ?? undefined) : undefined,
      childPhotoUrl: photos[c.id],
      confirmationsAccepted: !c.confirmationsAccepted ? consentAck : undefined,
    }));
    onConfirm(items);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <LogIn className="w-5 h-5 text-primary" />
            Check in {family.length > 1 ? 'children' : 'child'}
          </DialogTitle>
          <DialogDescription>
            {rep.parentName} · already booked &amp; paid — no payment needed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Per-child summary: name, age, service, allergy, prepaid food. */}
          <div className="space-y-2">
            {family.map((c) => (
              <div key={c.id} className="rounded-xl border border-border bg-card/50 p-3">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-bold text-sm">{c.childName}</span>
                  <span className="text-[10px] font-bold rounded-full px-1.5 py-0.5 bg-muted text-muted-foreground">
                    {c.childAge} yrs
                  </span>
                  <Badge
                    variant="secondary"
                    className={`gap-1 px-2 py-0.5 text-xs ${
                      c.serviceType === 'nanny' ? 'text-sky-400' : ''
                    }`}
                  >
                    {c.serviceType === 'nanny' ? <UserCheck className="w-3 h-3" /> : null}
                    {c.serviceType === 'nanny' ? 'Nanny' : 'Drop-Off'}
                  </Badge>
                </div>
                {c.allergiesMedical && (
                  <div className="flex items-start gap-1 text-amber-400 font-medium text-xs mt-1">
                    <AlertTriangle className="w-3 h-3 mt-0.5 shrink-0" />
                    {c.allergiesMedical}
                  </div>
                )}
                <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-1">
                  <UtensilsCrossed className="w-3 h-3" />
                  {foodSummary(c)}
                </div>
              </div>
            ))}
          </div>

          {/* Nanny picker — only when a nanny child is present. */}
          {needsNanny && (
            <div className="space-y-2">
              <p className="text-sm font-medium text-muted-foreground">
                Assign a nanny <span className="text-destructive">*</span>
              </p>
              <div className="grid grid-cols-1 gap-2">
                {nannies.map((n) => {
                  const disabled = !n.available;
                  const selected = nannyId === n.id;
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
                      className="h-14 justify-between text-base px-4"
                      onClick={() => setNannyId(n.id)}
                    >
                      <span className="flex items-center gap-3">
                        <span className="w-8 h-8 rounded-full bg-primary/15 text-primary flex items-center justify-center font-bold shrink-0">
                          {n.name.charAt(0).toUpperCase()}
                        </span>
                        {n.name}
                      </span>
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
                <div className="flex items-start gap-2 text-sm text-amber-300 bg-amber-300/10 rounded-lg px-3 py-2">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    {selectedNanny.name} would be looking after {selectedNanny.load + 1} children
                    (over the suggested {softMax}). Allowed — just double-check it's okay.
                  </span>
                </div>
              )}
            </div>
          )}

          {/* Consent + photo capture — ONLY for children missing them on file. */}
          {(childrenMissingPhoto.length > 0 || consentNeeded) && (
            <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-300">
                <Camera className="w-4 h-4" />
                Consent &amp; photo needed before check-in
              </p>
              {family
                .filter((c) => !c.childPhotoUrl)
                .map((c) => (
                  <div key={c.id}>
                    <label className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
                      <Baby className="w-3.5 h-3.5" /> {c.childName}'s photo (with parent / guardian in the shot)
                    </label>
                    <CameraCapture
                      value={photos[c.id]}
                      onCapture={(dataUrl) => setPhotos((p) => ({ ...p, [c.id]: dataUrl }))}
                      onClear={() =>
                        setPhotos((p) => {
                          const next = { ...p };
                          delete next[c.id];
                          return next;
                        })
                      }
                    />
                  </div>
                ))}
              {consentNeeded && (
                <button
                  type="button"
                  onClick={() => setConsentAck((v) => !v)}
                  className="flex w-full items-start gap-3 rounded-lg border border-border bg-card p-3 text-left"
                >
                  <Checkbox checked={consentAck} onCheckedChange={(v) => setConsentAck(v === true)} className="mt-0.5" />
                  <span className="text-sm leading-snug text-foreground/80">
                    Parent / guardian authorizes Oto Play Park staff to supervise their child and
                    consents to a photo of the child and parent / guardian together being taken
                    for safe check-in and pickup verification.
                  </span>
                </button>
              )}
            </div>
          )}

          <Button className="w-full h-14 text-lg gap-2" disabled={!canConfirm} onClick={handleConfirm}>
            <ShieldCheck className="w-5 h-5" />
            Check in &amp; issue band{family.length > 1 ? 's' : ''}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
