import { CheckIn } from '@/types';
import { CameraCapture } from '@/components/shared/CameraCapture';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import { useLanguage } from '@/i18n/LanguageContext';
import { Baby, ShieldCheck, UtensilsCrossed, Camera } from 'lucide-react';

interface MobileCheckInConsentProps {
  checkIn: CheckIn;
  photoUrl?: string;
  mayOrderFood: boolean;
  consentAck: boolean;
  onPhotoCapture: (url: string) => void;
  onPhotoClear: () => void;
  onMayOrderFoodChange: (v: boolean) => void;
  onConsentAckChange: (v: boolean) => void;
}

/**
 * Customer-facing (parent) content rendered inside HandToCustomer.
 * Shown once staff hands the phone to the parent for consent + photo capture.
 * Captures ONE photo of the child together with the parent / guardian so staff
 * can match the collector at pickup — graceful degradation preserved (a blocked
 * or absent camera never blocks the flow).
 *
 * NEVER surfaces allergies/medical info — those are staff-only and remain hidden
 * here; staff sees them on the detail card before handing over.
 */
export function MobileCheckInConsent({
  checkIn,
  photoUrl,
  mayOrderFood,
  consentAck,
  onPhotoCapture,
  onPhotoClear,
  onMayOrderFoodChange,
  onConsentAckChange,
}: MobileCheckInConsentProps) {
  const { t } = useLanguage();
  return (
    <div className="min-h-full flex flex-col bg-gradient-to-b from-sky-950 via-slate-950 to-slate-950 text-white relative">
      <div className="absolute top-4 right-4 z-40">
        <LanguageSwitcher variant="dark" />
      </div>
      {/* Header */}
      <div className="shrink-0 px-6 pt-8 pb-5 text-center">
        <div className="mb-3 inline-flex items-center gap-2 text-primary">
          <ShieldCheck className="h-6 w-6" />
          <span className="text-sm font-bold uppercase tracking-widest">{t('dropoff.consent.welcome')}</span>
        </div>
        <h2 className="text-3xl font-black leading-tight">
          {t('dropoff.consent.checkinFor', { name: checkIn.childName })}
        </h2>
        <div className="flex items-center justify-center gap-2 mt-2 text-white/60">
          <Baby className="w-4 h-4" />
          <span>{t('dropoff.consent.yearsOld', { age: checkIn.childAge })}</span>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 pb-8 space-y-5">
        {/* Photo capture — one shot with child AND parent / guardian in it */}
        <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
          <p className="text-base font-semibold text-white/70 mb-3 flex items-center gap-2">
            <Camera className="w-4 h-4" /> {t('dropoff.consent.photoTitle')}
          </p>
          <p className="text-sm text-white/50 mb-4">
            {t('dropoff.consent.photoInstructions')}
          </p>
          <CameraCapture
            value={photoUrl}
            onCapture={onPhotoCapture}
            onClear={onPhotoClear}
          />
        </div>

        {/* Food authorization */}
        <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
          <div className="flex items-start justify-between gap-4">
            <div className="flex items-start gap-3">
              <UtensilsCrossed className="w-5 h-5 mt-0.5 text-white/50 shrink-0" />
              <div>
                <p className="text-base font-semibold text-white/80 leading-snug">
                  {t('dropoff.consent.foodAuth')}
                </p>
                {checkIn.foodRestrictions && (
                  <p className="text-sm text-white/50 mt-1">
                    {t('dropoff.consent.dietaryNote', { note: checkIn.foodRestrictions })}
                  </p>
                )}
              </div>
            </div>
            <Switch
              checked={mayOrderFood}
              onCheckedChange={onMayOrderFoodChange}
              className="shrink-0 mt-0.5"
            />
          </div>
        </div>

        {/* Consent */}
        <div className="rounded-3xl border border-white/10 bg-white/5 p-5">
          <button
            type="button"
            onClick={() => onConsentAckChange(!consentAck)}
            className="flex w-full items-start gap-4 text-left"
          >
            <Checkbox
              checked={consentAck}
              onCheckedChange={(v) => onConsentAckChange(v === true)}
              className="mt-1 h-6 w-6 border-white/30 data-[state=checked]:bg-primary shrink-0"
            />
            <span className="text-base leading-snug text-white/80">
              {t('dropoff.consent.consentText')}
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}
