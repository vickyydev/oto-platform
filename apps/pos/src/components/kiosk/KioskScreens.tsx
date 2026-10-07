import type { ReactNode } from 'react';
import {
  Baby,
  CreditCard,
  Info,
  Loader2,
  MapPin,
  Printer,
  QrCode,
  ScanLine,
  Sparkles,
  Ticket,
  User,
  Users,
  Wallet,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import type { KioskRedeemAnswer } from '@oto/shared';
import { Button } from '@/components/ui/button';
import { LanguageSwitcher } from '@/components/shared/LanguageSwitcher';
import {
  RedeemBandCodes,
  RedeemCallout,
  RedeemCountRow,
  RedeemOutcomeHeader,
  type RedeemTone,
} from '@/components/till/redeemParts';
import { useLanguage, type TFunction } from '@/i18n/LanguageContext';
import type { KioskScreen } from '@/lib/kiosk';

/**
 * S2-20 K2 (SCRUM-217) — THE SELF-SERVICE KIOSK'S SCREENS.
 *
 * Guest-facing and full screen, so no admin chrome: the customer display's
 * own language (its gradient, the round brand mark, the big type and the
 * language pill top right) and the redeem dialog's own parts
 * (`components/till/redeemParts.tsx`) at kiosk scale. Every screen reads only
 * what the kiosk's strict answer carries — a reference, counts, band codes,
 * credit, when and where — so there is nothing private to draw (R-58).
 */

/** The customer display's shell: its background, and the language pill top right. */
export function KioskShell({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="h-full w-full bg-[image:var(--cd-gradient)] text-foreground flex flex-col relative">
      <div className="absolute top-4 right-4 z-40">
        <LanguageSwitcher variant="dark" />
      </div>
      <div className="flex-1 min-h-0 flex flex-col">{children}</div>
      {footer}
    </div>
  );
}

/** The round "O" the customer display opens with. */
function BrandMark() {
  return (
    <div className="w-28 h-28 rounded-[2rem] bg-primary flex items-center justify-center text-primary-foreground font-black text-6xl shadow-2xl shadow-primary/30">
      O
    </div>
  );
}

/** Centred when it fits, scrolled from the top when it does not (a long Thai line on a small screen). */
function Center({ children }: { children: ReactNode }) {
  return (
    <div className="flex-1 min-h-0 overflow-y-auto flex flex-col px-10 py-8">
      <div className="my-auto flex flex-col items-center text-center gap-6 animate-in fade-in zoom-in-95 duration-500">
        {children}
      </div>
    </div>
  );
}

function BigButton({ children, onClick, variant = 'primary' }: { children: ReactNode; onClick: () => void; variant?: 'primary' | 'ghost' }) {
  return variant === 'primary' ? (
    <Button size="lg" className="w-full max-w-xl h-20 text-2xl font-bold rounded-2xl" onClick={onClick}>
      {children}
    </Button>
  ) : (
    <Button
      variant="ghost"
      size="lg"
      className="w-full max-w-xl h-14 text-lg text-foreground/60 hover:text-foreground hover:bg-foreground/5 rounded-2xl"
      onClick={onClick}
    >
      {children}
    </Button>
  );
}

// --- Attract ---------------------------------------------------------------------------

export function KioskAttract({ resting, onStart }: { resting: boolean; onStart: () => void }) {
  const { t } = useLanguage();
  if (resting) {
    return (
      <Center>
        <BrandMark />
        <h1 className="text-5xl font-black tracking-tight" data-testid="kiosk-resting">
          {t('kiosk.attract.restingTitle')}
        </h1>
        <p className="text-2xl text-foreground/70 max-w-2xl">{t('kiosk.attract.restingSubtitle')}</p>
      </Center>
    );
  }
  return (
    <button
      type="button"
      onClick={onStart}
      className="flex-1 flex flex-col items-center justify-center text-center px-10 gap-6 cursor-pointer animate-in fade-in zoom-in-95 duration-500"
      data-testid="kiosk-attract"
    >
      <BrandMark />
      <div className="inline-flex items-center gap-2 text-primary mt-2">
        <Ticket className="w-6 h-6" />
        <span className="uppercase tracking-widest text-sm font-bold">{t('kiosk.attract.eyebrow')}</span>
      </div>
      <h1 className="text-6xl font-black tracking-tight">{t('kiosk.attract.title')}</h1>
      <p className="text-2xl text-foreground/70 max-w-2xl">{t('kiosk.attract.subtitle')}</p>
      <span className="mt-6 inline-flex items-center justify-center gap-3 w-full max-w-xl h-20 rounded-2xl bg-primary text-primary-foreground text-2xl font-bold shadow-2xl shadow-primary/30 animate-pulse">
        <QrCode className="w-7 h-7" />
        {t('kiosk.attract.start')}
      </span>
      <span className="flex items-center gap-2 mt-4 text-foreground/50 text-lg">
        <Sparkles className="w-5 h-5" />
        {t('kiosk.attract.help')}
      </span>
    </button>
  );
}

// --- Scan and working --------------------------------------------------------------------

export function KioskScan({ onStartOver }: { onStartOver: () => void }) {
  const { t } = useLanguage();
  return (
    <>
      <Center>
        <div className="relative w-64 h-64 rounded-[2.5rem] border-4 border-dashed border-primary/50 flex items-center justify-center bg-foreground/5">
          <QrCode className="w-32 h-32 text-primary" />
          <ScanLine className="absolute w-56 h-56 text-primary/40 animate-pulse" />
        </div>
        <h2 className="text-5xl font-black tracking-tight">{t('kiosk.scan.title')}</h2>
        <p className="text-2xl text-foreground/70 max-w-2xl">{t('kiosk.scan.subtitle')}</p>
      </Center>
      <div className="p-8 border-t border-foreground/10 flex justify-center">
        <BigButton variant="ghost" onClick={onStartOver}>
          {t('kiosk.scan.startOver')}
        </BigButton>
      </div>
    </>
  );
}

export function KioskWorking() {
  const { t } = useLanguage();
  return (
    <Center>
      <div className="w-28 h-28 rounded-full bg-primary/15 flex items-center justify-center text-primary">
        <Loader2 className="w-14 h-14 animate-spin" />
      </div>
      <h2 className="text-5xl font-black tracking-tight" data-testid="kiosk-working">
        {t('kiosk.working.title')}
      </h2>
      <p className="text-2xl text-foreground/70">{t('kiosk.working.subtitle')}</p>
    </Center>
  );
}

// --- Results ---------------------------------------------------------------------------

function counts(t: TFunction, answer: KioskRedeemAnswer | null) {
  if (!answer?.booking) return null;
  const { kids, adults } = answer.booking;
  return (
    <div className="flex flex-wrap justify-center gap-x-10 gap-y-3">
      {kids > 0 && (
        <RedeemCountRow size="kiosk" icon={Ticket}>
          {kids === 1 ? t('kiosk.count.kidsOne') : t('kiosk.count.kidsMany', { count: kids })}
        </RedeemCountRow>
      )}
      {adults > 0 && (
        <RedeemCountRow size="kiosk" icon={Users}>
          {adults === 1 ? t('kiosk.count.adultsOne') : t('kiosk.count.adultsMany', { count: adults })}
        </RedeemCountRow>
      )}
    </div>
  );
}

/** The thank-you cards of the customer display: bands by kind, and the credit loaded. */
function IssuedCards({ answer }: { answer: KioskRedeemAnswer }) {
  const { t } = useLanguage();
  const kids = answer.bands.filter((b) => b.kind === 'kid').length;
  const adults = answer.bands.filter((b) => b.kind === 'adult').length;
  return (
    <div className="w-full max-w-xl space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="bg-foreground/5 rounded-3xl p-6 border border-foreground/10 text-center">
          <Baby className="w-8 h-8 mx-auto text-primary mb-2" />
          <div className="text-4xl font-black">{kids}</div>
          <div className="text-foreground/60">
            {t(kids !== 1 ? 'till.thankyou.childBracelets' : 'till.thankyou.childBracelet')}
          </div>
        </div>
        <div className="bg-foreground/5 rounded-3xl p-6 border border-foreground/10 text-center">
          <User className="w-8 h-8 mx-auto text-(--cd-sky) mb-2" />
          <div className="text-4xl font-black">{adults}</div>
          <div className="text-foreground/60">
            {t(adults !== 1 ? 'till.thankyou.adultBracelets' : 'till.thankyou.adultBracelet')}
          </div>
        </div>
      </div>
      {answer.walletCreditSatang > 0 && (
        <div className="flex items-center gap-4 bg-foreground/5 rounded-2xl p-4 border border-foreground/10">
          <Wallet className="w-8 h-8 text-primary shrink-0" />
          <div className="text-2xl font-bold text-left" data-testid="kiosk-credit">
            {t('kiosk.done.credit', { amount: (answer.walletCreditSatang / 100).toLocaleString() })}
          </div>
        </div>
      )}
      {answer.bands.length > 0 && (
        <div className="space-y-1 text-center">
          <p className="text-foreground/50 text-lg">{t('kiosk.done.codes')}</p>
          <RedeemBandCodes
            size="kiosk"
            noCode="—"
            bands={answer.bands.map((b, i) => ({
              key: `${i}:${b.shortCode ?? ''}`,
              shortCode: b.shortCode,
              label: t(b.kind === 'kid' ? 'kiosk.done.kid' : 'kiosk.done.adult'),
            }))}
          />
        </div>
      )}
    </div>
  );
}

interface ProblemCopy {
  tone: RedeemTone;
  icon: LucideIcon;
  title: string;
  lines: string[];
  /** A second try makes sense: a code that could not be read. */
  retry?: boolean;
}

function whenWhere(t: TFunction, lang: string, answer: KioskRedeemAnswer | null): string | null {
  const redeemed = answer?.alreadyRedeemed;
  if (!redeemed) return null;
  const at = new Date(redeemed.at);
  const when = Number.isNaN(at.getTime())
    ? redeemed.at
    : at.toLocaleString(lang, { dateStyle: 'medium', timeStyle: 'short' });
  const place =
    redeemed.branchName && redeemed.stationName
      ? `${redeemed.branchName} (${redeemed.stationName})`
      : (redeemed.branchName ?? redeemed.stationName);
  return place ? t('kiosk.already.whenWhere', { when, place }) : t('kiosk.already.when', { when });
}

function problemCopy(t: TFunction, lang: string, screen: KioskScreen): ProblemCopy {
  switch (screen.kind) {
    case 'desk_supervised':
      return { tone: 'ok', icon: Baby, title: t('kiosk.deskSupervised.title'), lines: [t('kiosk.deskSupervised.subtitle')] };
    case 'printer':
      return {
        tone: 'warn',
        icon: Printer,
        title: t('kiosk.printer.title'),
        lines: [t(screen.paperOut ? 'kiosk.printer.paperOut' : 'kiosk.printer.fault'), t('kiosk.printer.subtitle')],
      };
    case 'offline':
      return { tone: 'warn', icon: WifiOff, title: t('kiosk.offline.title'), lines: [t('kiosk.offline.subtitle')] };
    case 'already': {
      const said = whenWhere(t, lang, screen.answer);
      return {
        tone: 'warn',
        icon: Ticket,
        title: t('kiosk.already.title'),
        lines: [...(said ? [said] : []), t('kiosk.already.subtitle')],
      };
    }
    case 'not_paid':
      return { tone: 'warn', icon: CreditCard, title: t('kiosk.notPaid.title'), lines: [t('kiosk.notPaid.subtitle')] };
    case 'unrecognised':
      return {
        tone: 'warn',
        icon: QrCode,
        title: t('kiosk.unrecognised.title'),
        lines: [t('kiosk.unrecognised.subtitle')],
        retry: true,
      };
    case 'other_branch':
      return { tone: 'warn', icon: MapPin, title: t('kiosk.otherBranch.title'), lines: [t('kiosk.otherBranch.subtitle')] };
    default:
      return { tone: 'warn', icon: Info, title: t('kiosk.desk.title'), lines: [t('kiosk.desk.subtitle')] };
  }
}

/** One guest-readable screen per ending: done, done with the desk, and each failure. */
export function KioskResult({
  screen,
  onDone,
  onScanAgain,
}: {
  screen: KioskScreen;
  onDone: () => void;
  onScanAgain: () => void;
}) {
  const { t, lang } = useLanguage();
  const answer = screen.answer;
  const reference = answer?.booking?.reference ?? null;

  if ((screen.kind === 'done' || screen.kind === 'done_desk') && answer) {
    const supervised = answer.desk.supervisedChildren;
    return (
      <>
        <div className="flex-1 min-h-0 overflow-y-auto flex flex-col p-8" data-testid={`kiosk-result-${screen.kind}`}>
          <div className="my-auto flex flex-col items-center gap-4 animate-in fade-in zoom-in-95 duration-500">
            <RedeemOutcomeHeader size="kiosk" tone="ok" title={t('kiosk.done.title')} reference={reference}>
              <p className="text-2xl text-foreground/70 mt-3">{t('kiosk.done.subtitle')}</p>
            </RedeemOutcomeHeader>
            <IssuedCards answer={answer} />
            {screen.kind === 'done_desk' && (
              <div className="w-full max-w-xl">
                <RedeemCallout size="kiosk" tone="amber" icon={Baby}>
                  {supervised === 1
                    ? t('kiosk.doneDesk.noteOne')
                    : t('kiosk.doneDesk.noteMany', { count: supervised })}
                </RedeemCallout>
              </div>
            )}
          </div>
        </div>
        <div className="p-8 border-t border-foreground/10 flex justify-center">
          <BigButton onClick={onDone}>{t('common.done')}</BigButton>
        </div>
      </>
    );
  }

  const copy = problemCopy(t, lang, screen);
  return (
    <>
      <div className="flex-1 min-h-0 overflow-y-auto flex flex-col p-8" data-testid={`kiosk-result-${screen.kind}`}>
        <div className="my-auto flex flex-col items-center gap-4 animate-in fade-in zoom-in-95 duration-500">
          <RedeemOutcomeHeader size="kiosk" tone={copy.tone} icon={copy.icon} title={copy.title} reference={reference} />
          <div className="max-w-2xl space-y-3 text-center">
            {copy.lines.map((line) => (
              <p key={line} className="text-2xl text-foreground/70">
                {line}
              </p>
            ))}
          </div>
          {counts(t, answer)}
        </div>
      </div>
      <div className="p-8 border-t border-foreground/10 flex flex-col items-center gap-3">
        {copy.retry && <BigButton onClick={onScanAgain}>{t('kiosk.scanAgain')}</BigButton>}
        <BigButton variant={copy.retry ? 'ghost' : 'primary'} onClick={onDone}>
          {t('common.done')}
        </BigButton>
      </div>
    </>
  );
}

// --- Setup (staff-facing, English like the display's) ----------------------------------------

export function KioskSetup({
  code,
  expiresAt,
  state,
  persistent,
  error,
  onExpire,
  onNewCode,
}: {
  code: string | null;
  expiresAt: string | null;
  state: 'connecting' | 'code' | 'expired';
  persistent: boolean;
  error: string | null;
  onExpire: () => void;
  onNewCode: () => void;
}) {
  return (
    <main className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-5">
      <ScanLine className="h-14 w-14 text-primary" />
      <h1 className="text-3xl font-bold">Set up this kiosk</h1>
      <p className="max-w-xl text-lg">
        In the Console, open Devices, choose Pair a kiosk, and enter this code for the kiosk station.
      </p>
      {error && (
        <p role="alert" className="rounded-lg bg-amber-100 px-4 py-2 text-sm text-amber-950">
          {error}
        </p>
      )}
      {!persistent && <p className="text-sm">This browser cannot remember the kiosk. Keep this page open or enable site storage.</p>}
      {state === 'code' && code ? (
        <>
          <div className="font-mono text-6xl font-bold tracking-[0.2em]" aria-label="Pairing code" data-testid="kiosk-pairing-code">
            {code}
          </div>
          {expiresAt && (
            <p className="text-sm text-muted-foreground">
              This code expires at {new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
            </p>
          )}
          <Button variant="outline" onClick={onExpire}>
            Expire code now
          </Button>
        </>
      ) : state === 'expired' ? (
        <>
          <p role="status">This code has expired. Create a new code when you are ready to pair this kiosk.</p>
          <Button variant="outline" onClick={onNewCode}>
            New code
          </Button>
        </>
      ) : (
        <Loader2 className="h-8 w-8 animate-spin" aria-label="Connecting" />
      )}
    </main>
  );
}
