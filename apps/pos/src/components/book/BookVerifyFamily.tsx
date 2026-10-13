import { useState } from 'react';
import { ArrowLeft, ArrowRight, MessageSquareLock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useLanguage } from '@/i18n/LanguageContext';
import { publicApi } from '@/api/platform';
import { publicChildToSavedChild } from '@/api/mappers';
import { storedPhoneHint } from '@/lib/phoneUtils';
import type { SavedChild } from '@/types';

interface BookVerifyFamilyProps {
  phone: string;
  branchCode: string;
  onVerified: (children: SavedChild[]) => void;
  onSkip: () => void;
  onBack: () => void;
}

/**
 * SCRUM-357 — a returning family proves it holds the phone before its saved
 * children are shown (UI addition: the prototype read them straight off the
 * phone number, which an open site cannot do). A six-digit code goes to the
 * phone; typed back, the platform answers the children the review step
 * pre-fills from. Skipping goes on to type the children's details as a new
 * family does.
 */
export function BookVerifyFamily({ phone, branchCode, onVerified, onSkip, onBack }: BookVerifyFamilyProps) {
  const { t } = useLanguage();
  const [sent, setSent] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    publicApi.savedChildrenCode(phone, branchCode).then(
      () => {
        setSent(true);
        setCode('');
        setBusy(false);
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : t('book.verify.failed'));
        setBusy(false);
      },
    );
  };

  const confirm = () => {
    if (busy || code.length !== 6) return;
    setBusy(true);
    setError(null);
    publicApi.savedChildrenVerify(phone, branchCode, code).then(
      (res) => {
        setBusy(false);
        onVerified(res.children.map(publicChildToSavedChild));
      },
      (err: unknown) => {
        setError(err instanceof Error ? err.message : t('book.verify.failed'));
        setBusy(false);
      },
    );
  };

  return (
    <div className="flex-1 flex flex-col px-5 py-6 animate-in fade-in slide-in-from-right-4 duration-300">
      <button type="button" onClick={onBack} className="inline-flex items-center gap-2 text-slate-500 mb-5">
        <ArrowLeft className="w-5 h-5" /> {t('common.back')}
      </button>

      <div className="inline-flex items-center gap-2 text-primary mb-3">
        <MessageSquareLock className="w-5 h-5" />
      </div>
      <h2 className="text-3xl font-black leading-tight">{t('book.verify.title')}</h2>
      <p className="text-slate-500 mt-2">
        {t('book.verify.subtitle', { phone: storedPhoneHint(phone) })}
      </p>

      {sent && (
        <div className="mt-6 space-y-2">
          <label className="text-sm text-slate-500 block">{t('book.verify.codeLabel')}</label>
          <Input
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            className="h-14 text-2xl tracking-[0.4em] font-bold bg-white border-slate-200"
          />
          <p className="text-xs text-slate-400">{t('book.verify.sent')}</p>
        </div>
      )}

      {error && <p className="mt-4 text-sm font-semibold text-red-600">{error}</p>}

      <div className="mt-auto pt-8 space-y-3">
        {sent ? (
          <Button
            size="lg"
            className="w-full h-16 text-lg font-bold gap-2"
            disabled={busy || code.length !== 6}
            onClick={confirm}
          >
            {t('book.verify.confirm')}
            <ArrowRight className="w-5 h-5" />
          </Button>
        ) : (
          <Button size="lg" className="w-full h-16 text-lg font-bold gap-2" disabled={busy} onClick={send}>
            {t('book.verify.sendCode')}
            <ArrowRight className="w-5 h-5" />
          </Button>
        )}
        {sent && (
          <Button variant="outline" className="w-full h-12" disabled={busy} onClick={send}>
            {t('book.verify.resend')}
          </Button>
        )}
        <Button variant="ghost" className="w-full h-12 text-slate-500" onClick={onSkip}>
          {t('book.verify.skip')}
        </Button>
      </div>
    </div>
  );
}
