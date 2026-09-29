import { useEffect, useRef, useState } from 'react';
import type { ConsentAction, ConsentPrompt } from '@oto/shared';
import { ShieldCheck, ClipboardCheck, Baby } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import { useLanguage } from '@/i18n/LanguageContext';

/** The public part of ConsentCapture; private child records remain on the staff screen. */
export function PublicConsentCapture({ prompt, busy, onAction }: {
  prompt: ConsentPrompt; busy: boolean; onAction: (action: ConsentAction) => void;
}) {
  const { t } = useLanguage();
  const [name, setName] = useState(prompt.guardianName);
  const [acknowledged, setAcknowledged] = useState(prompt.consentAcknowledged);
  const [confirmations, setConfirmations] = useState(() => prompt.confirmations.filter(item => item.acknowledged).map(item => item.id));
  const lastRequest = useRef(prompt.requestId);
  useEffect(() => {
    if (lastRequest.current === prompt.requestId) return;
    lastRequest.current = prompt.requestId;
    setName(prompt.guardianName);
    setAcknowledged(prompt.consentAcknowledged);
    setConfirmations(prompt.confirmations.filter(item => item.acknowledged).map(item => item.id));
  }, [prompt]);
  const fence = { requestId: prompt.requestId, visitorId: prompt.visitorId };
  const locked = busy || prompt.completed;
  const saved = name.trim() === prompt.guardianName && acknowledged === prompt.consentAcknowledged
    && prompt.confirmations.every(item => item.acknowledged === confirmations.includes(item.id));
  return <div className="relative flex h-full w-full min-h-0 flex-col bg-[image:var(--cd-gradient)] text-foreground" data-testid="display-consent">
    <div className="absolute top-4 right-4 z-40"><LanguageSwitcher variant="dark" /></div>
    <div className="shrink-0 px-8 pt-8 pb-4 text-center">
      <div className="mb-2 inline-flex items-center gap-2 text-primary"><ShieldCheck className="h-6 w-6" />
        <span className="text-sm font-bold uppercase tracking-widest">{t('superviseConsent.playingToday')}</span></div>
      <h2 className="text-4xl font-black">{t(prompt.slots.length === 1 ? 'superviseConsent.titleOne' : 'superviseConsent.titleMany')}</h2>
      <p className="mt-1 text-lg text-foreground/60">{t('superviseConsent.subtitle')}</p>
    </div>
    <div className="flex-1 min-h-0 space-y-5 overflow-y-auto px-8 pb-6">
      {prompt.slots.map(slot => <div key={slot.id} className="rounded-3xl border border-foreground/10 bg-foreground/5 p-6">
        <div className="flex items-center gap-2 text-lg"><Baby className="h-5 w-5" />{slot.name} · {slot.ageYears}</div>
        <p className="mt-3 text-base">{t(slot.requirement === 'nanny' ? 'superviseConsent.reqNanny'
          : slot.requirement === 'drop_off' ? 'superviseConsent.reqDropOff' : 'superviseConsent.reqNone')}</p>
      </div>)}
      {prompt.consentRequired && <div className="rounded-3xl border border-foreground/10 bg-foreground/5 p-6 space-y-5">
        <div><label htmlFor="public-consent-guardian" className="text-lg text-foreground/70">{t('superviseConsent.parentGuardianName')}</label>
          <Input id="public-consent-guardian" value={name} maxLength={100} disabled={locked} onChange={event => setName(event.target.value)}
            placeholder={t('superviseConsent.yourFullName')} className="mt-2 h-14 border-foreground/10 bg-foreground/5 px-4 text-2xl" /></div>
        <label className="flex w-full items-start gap-4 rounded-2xl border border-foreground/10 bg-foreground/5 p-4 text-left">
          <Checkbox checked={acknowledged} disabled={locked} onCheckedChange={value => setAcknowledged(value === true)}
            className="mt-1 h-6 w-6 border-foreground/30 data-[state=checked]:bg-primary" />
          <span className="text-lg leading-snug text-foreground/80">{t('superviseConsent.consentText')}</span></label>
      </div>}
      {prompt.confirmations.length > 0 && <div className="rounded-3xl border border-foreground/10 bg-foreground/5 p-6 space-y-3">
        <div className="flex items-center gap-2 text-lg font-semibold text-foreground/80"><ClipboardCheck className="h-5 w-5" />{t('superviseConsent.pleaseConfirm')}</div>
        {prompt.confirmations.map(item => <label key={item.id} className="flex w-full items-start gap-4 rounded-2xl border border-foreground/10 bg-foreground/5 p-4 text-left">
          <Checkbox checked={confirmations.includes(item.id)} disabled={locked} onCheckedChange={value => setConfirmations(previous =>
            value === true ? [...previous.filter(id => id !== item.id), item.id] : previous.filter(id => id !== item.id))}
            className="mt-1 h-6 w-6 border-foreground/30 data-[state=checked]:bg-primary" />
          <span className="text-lg leading-snug text-foreground/80">{item.text}{!item.required && <span className="ml-2 text-sm text-foreground/40">({t('superviseConsent.optional')})</span>}</span>
        </label>)}
      </div>}
    </div>
    <div className="shrink-0 border-t border-foreground/10 px-8 py-4 flex flex-wrap items-center justify-end gap-3">
      {prompt.completed ? <p role="status">{t('superviseConsent.waitForTeam')}</p> : <>
        <Button variant="outline" disabled={busy} onClick={() => onAction({ ...fence, action: 'staff_help' })}>{t('superviseConsent.askTeam')}</Button>
        <Button disabled={locked || saved || prompt.consentRequired && !name.trim()} onClick={() => onAction({ ...fence,
          action: 'acknowledge', guardianName: name, consentAcknowledged: acknowledged, acknowledgedConfirmationIds: confirmations })}>{t('common.continue')}</Button>
        <Button disabled={locked || !saved || !prompt.canContinue} onClick={() => onAction({ ...fence, action: 'done' })}>{t('common.done')}</Button>
      </>}
    </div>
  </div>;
}
