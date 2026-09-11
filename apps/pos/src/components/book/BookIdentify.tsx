import { useState } from 'react';
import { Sparkles, ArrowRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PhoneInput } from '@/components/shared/PhoneInput';
import { useLanguage } from '@/i18n/LanguageContext';
import type { ContactChannel } from '@/types';
import { getMemberByPhone } from '@/mockApi';

interface BookIdentifyProps {
  onContinue: (phone: string, nickname: string, channel: ContactChannel) => void;
}

export function BookIdentify({ onContinue }: BookIdentifyProps) {
  const { t } = useLanguage();
  const [phone, setPhone] = useState('');
  const [nickname, setNickname] = useState('');
  const [channel, setChannel] = useState<ContactChannel>('whatsapp');

  const handlePhoneChange = (v: string) => {
    setPhone(v);
    // Pre-select a returning member's saved channel preference as soon as the
    // phone matches — the same phone→member lookup used at booking time.
    const found = v.trim() ? getMemberByPhone(v, nickname) : null;
    if (found?.preferredChannel) setChannel(found.preferredChannel);
  };

  return (
    <div className="flex-1 flex flex-col px-6 py-10 relative animate-in fade-in slide-in-from-bottom-4 duration-300">
      <div className="flex items-center gap-3 mb-10">
        <div className="w-12 h-12 rounded-2xl bg-primary flex items-center justify-center text-primary-foreground font-black text-2xl">
          O
        </div>
        <span className="text-xl font-bold tracking-tight">{t('common.brand')}</span>
      </div>

      <div className="mb-8">
        <div className="inline-flex items-center gap-2 text-primary mb-3">
          <Sparkles className="w-5 h-5" />
          <span className="uppercase tracking-widest text-xs font-bold">{t('book.identify.bookOnline')}</span>
        </div>
        <h1 className="text-4xl font-black leading-tight">{t('book.identify.title')}</h1>
        <p className="text-slate-500 text-lg mt-3">{t('book.identify.subtitle')}</p>
      </div>

      <div className="space-y-5">
        <div>
          <label className="text-sm text-slate-500 mb-2 block">{t('book.identify.mobileNumber')}</label>
          <PhoneInput
            value={phone}
            onChange={handlePhoneChange}
            label=""
            inputClassName="h-14 text-lg bg-white border-slate-200"
            channel={channel}
            onChannelChange={setChannel}
            translate
          />
        </div>
        <div>
          <label className="text-sm text-slate-500 mb-2 block">
            {t('book.identify.yourName')} <span className="text-slate-400">({t('book.identify.optional')})</span>
          </label>
          <Input
            value={nickname}
            onChange={(e) => setNickname(e.target.value)}
            placeholder={t('book.identify.namePlaceholder')}
            className="h-14 text-lg bg-white border-slate-200"
          />
        </div>
      </div>

      <p className="text-xs text-slate-400 mt-4">{t('book.identify.recognised')}</p>

      <div className="mt-auto pt-8 space-y-3">
        <Button
          size="lg"
          className="w-full h-16 text-lg font-bold gap-2"
          disabled={!phone.trim()}
          onClick={() => onContinue(phone, nickname, channel)}
        >
          {t('book.identify.continue')}
          <ArrowRight className="w-5 h-5" />
        </Button>
        <Button
          variant="ghost"
          className="w-full h-12 text-slate-500"
          onClick={() => onContinue('', nickname, channel)}
        >
          {t('book.identify.continueAsGuest')}
        </Button>
      </div>
    </div>
  );
}
