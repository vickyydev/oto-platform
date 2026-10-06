import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Monitor } from 'lucide-react';
import { DisplayPaymentSchema, DisplayTotalsSchema, readDisplayFnbCart, readDisplayMerchCart, type StationIntent } from '@oto/shared';
import { displayApi, DisplayError, newDisplayCredential, newerDisplaySession, readDisplayCredential, rememberDisplayCredential, type DisplaySession } from '@/api/display';
import { displayBridgeApi } from '@/api/bridge';
import { ApiError } from '@/api/client';

/**
 * OD-10 (offline plan Round 3): the display follows its BOX. Once it knows its
 * station it reads the document through the station bridge with its paired
 * credential, so it keeps working while the box works without the platform.
 * Pairing itself still needs the platform, and a display that cannot reach its
 * box shows its welcome screen rather than a total that may no longer be true.
 */
function asDisplayError(failure: unknown): unknown {
  if (failure instanceof DisplayError) return failure;
  if (failure instanceof ApiError) return new DisplayError(failure.status, failure.code, failure.message);
  if (failure instanceof DOMException && failure.name === 'AbortError') return failure;
  return new DisplayError(0, 'DISPLAY_UNAVAILABLE', 'Connection interrupted. Please retry when the connection returns.');
}

async function readThroughBox(stationId: string | null, bearer: string, signal: AbortSignal): Promise<DisplaySession> {
  if (!stationId) return displayApi.session(bearer, signal);
  try {
    return await displayBridgeApi.session(stationId, bearer, signal);
  } catch (failure) {
    throw asDisplayError(failure);
  }
}

/** The document with nothing on it for the visitor: the welcome screen, never a stale total. */
function welcomeOnly(session: DisplaySession): DisplaySession {
  return { ...session, document: { ...session.document, stage: 'welcome', step: null, cart: null,
    member: null, totals: null, payment: null, prompt: null } };
}
import { CustomerDisplay } from '@/components/till/CustomerDisplay';
import { Button } from '@/components/ui/button';
import { useLanguage } from '@/i18n/LanguageContext';
import type { ContactChannel } from '@/types';
import { readTicketDisplayView } from '@/lib/displaySession';
import { PublicSavedChildrenReview } from '@/components/shared/PublicSavedChildrenReview';
import { FnbCustomerDisplay, type FnbCustomerStage } from '@/components/fnb/FnbCustomerDisplay';
import { PublicMerchCustomerDisplay, type PublicMerchStage } from '@/components/merch/PublicMerchCustomerDisplay';
import { PublicConsentCapture } from '@/components/till/PublicConsentCapture';

/** Pairing and station polling deliberately live outside every staff provider. */
export default function Display() {
  const { lang } = useLanguage();
  const [session, setSession] = useState<DisplaySession | null>(null);
  const [pairing, setPairing] = useState<{ pairingCode: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [persistent, setPersistent] = useState(true);
  const [busy, setBusy] = useState(false);
  const [phone, setPhone] = useState('');
  const [nickname, setNickname] = useState('');
  const [contactChannel, setContactChannel] = useState<ContactChannel>('whatsapp');
  const [restart, setRestart] = useState(0);
  const [languageRetry, setLanguageRetry] = useState(0);
  const [pairingMode, setPairingMode] = useState<'active' | 'expiring' | 'expired' | 'expiry-error'>('active');
  const expiryOperation = useRef<symbol | null>(null);
  const pairingMint = useRef<symbol | null>(null);
  const bearerRef = useRef(readDisplayCredential() ?? newDisplayCredential());
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const pending = useRef<StationIntent | null>(null);
  const inFlight = useRef<symbol | null>(null);
  const generation = useRef(0);

  useEffect(() => () => { expiryOperation.current = null; }, []);

  useEffect(() => {
    generation.current += 1;
    inFlight.current = null;
    setBusy(false);
    if (pairingMode !== 'active') return;
    const startedGeneration = generation.current;
    const controller = new AbortController();
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let hasCode = false;
    let knownPaired = sessionRef.current !== null;
    const inactive = () => stopped || generation.current !== startedGeneration;
    const tick = async () => {
      try {
        const bearer = bearerRef.current;
        setPersistent(rememberDisplayCredential(bearer));
        // Once paired, the protected read is the authority. Revocation must
        // produce a real refused call before returning this browser to setup.
        const paired = knownPaired ? { status: 'paired' as const }
          : await displayApi.pairing(bearer, controller.signal);
        if (inactive()) return;
        if (paired.status === 'paired') {
          const stationId = sessionRef.current?.station.id ?? paired.station?.id ?? null;
          let current: DisplaySession;
          try {
            current = await readThroughBox(stationId, bearer, controller.signal);
          } catch (failure) {
            // Cannot reach the box: the welcome screen, not the last total (OD-10).
            if (!(failure instanceof DisplayError && failure.status === 401)) {
              setSession(previous => previous ? welcomeOnly(previous) : previous);
            }
            throw failure;
          }
          if (inactive()) return;
          knownPaired = true;
          setSession(previous => newerDisplaySession(previous, current));
          setPairing(null);
          const answer = current.document.prompt?.answer as { actionId?: string } | undefined;
          const gesture = pending.current;
          if (gesture && (answer?.actionId === gesture.actionId
            || (gesture.type === 'display.set_language' && current.document.language === gesture.payload.language))) {
            pending.current = null;
            setLanguageRetry(value => value + 1);
          }
          if (!pending.current) setError(null);
        } else {
          setSession(null);
          if (!hasCode || paired.status === 'expired') {
            const mint = Symbol();
            pairingMint.current = mint;
            setPairing(null);
            try {
              if (paired.status === 'expired') bearerRef.current = newDisplayCredential();
              setPersistent(rememberDisplayCredential(bearerRef.current));
              const code = await displayApi.start(bearerRef.current, controller.signal);
              if (inactive()) return;
              setPairing(code);
              hasCode = true;
            } finally {
              if (pairingMint.current === mint) pairingMint.current = null;
            }
          }
          setError(null);
        }
      } catch (failure) {
        if (inactive()) return;
        if (failure instanceof DisplayError && (failure.status === 401 || failure.code === 'DISPLAY_ALREADY_PAIRED')) {
          setSession(null);
          setPairing(null);
          pending.current = null;
          hasCode = false;
          knownPaired = false;
          if (failure.code !== 'DISPLAY_ALREADY_PAIRED') bearerRef.current = newDisplayCredential();
        } else setError(failure instanceof Error ? failure.message : 'The display could not connect.');
      } finally {
        if (!inactive()) timer = setTimeout(() => { void tick(); }, 2_000);
      }
    };
    void tick();
    return () => { stopped = true; generation.current += 1; controller.abort(); clearTimeout(timer); };
  }, [restart, pairingMode]);

  const expirePairing = async () => {
    if (sessionRef.current || expiryOperation.current || pairingMint.current) return;
    generation.current += 1;
    const operation = Symbol();
    expiryOperation.current = operation;
    const bearer = bearerRef.current;
    setPairingMode('expiring');
    setPairing(null);
    setError(null);
    try {
      await displayApi.expire(bearer);
      if (expiryOperation.current !== operation || bearerRef.current !== bearer) return;
      setPairingMode('expired');
    } catch (failure) {
      if (expiryOperation.current !== operation || bearerRef.current !== bearer) return;
      if (failure instanceof DisplayError && failure.code === 'DISPLAY_ALREADY_PAIRED') {
        setPairingMode('active');
      } else {
        setPairingMode('expiry-error');
        setError('Code expiry could not be confirmed. Retry to expire it.');
      }
    } finally {
      if (expiryOperation.current === operation) expiryOperation.current = null;
    }
  };

  const newPairing = () => {
    expiryOperation.current = null;
    bearerRef.current = newDisplayCredential();
    setPairing(null);
    setError(null);
    setPairingMode('active');
    setRestart(value => value + 1);
  };

  const requestId = typeof session?.document.prompt?.requestId === 'string' ? session.document.prompt.requestId : '';
  useEffect(() => {
    const prompt = sessionRef.current?.document.prompt;
    setPhone(typeof prompt?.phone === 'string' ? prompt.phone : '');
    setNickname(typeof prompt?.nickname === 'string' ? prompt.nickname : '');
    const channel = prompt?.contactChannel;
    setContactChannel(channel === 'line' || channel === 'telegram' ? channel : 'whatsapp');
    pending.current = null;
  }, [requestId]);

  const send = useCallback(async (type: string, payload: Record<string, unknown>) => {
    const current = sessionRef.current;
    if (!current || inFlight.current) return;
    if (pending.current && pending.current.type !== type) return;
    const operation = Symbol();
    inFlight.current = operation;
    const startedGeneration = generation.current;
    const bearer = bearerRef.current;
    const active = () => generation.current === startedGeneration && bearerRef.current === bearer;
    setBusy(true);
    const intent = pending.current ?? { type, payload, actionId: crypto.randomUUID(), lastSeenSequence: current.document.sequence };
    // A retry after an unreadable reply retains its action and input. A fresh
    // snapshot supplies the sequence, while the prompt id fences the visitor.
    pending.current = intent;
    try {
      const next = { ...intent, lastSeenSequence: current.document.sequence };
      const result = await displayBridgeApi.intent(current.station.id, bearer, next)
        .catch((failure: unknown) => { throw asDisplayError(failure); });
      if (!active()) return;
      setSession(previous => previous?.device.id === current.device.id ? newerDisplaySession(previous, { ...previous, document: result.document }) : previous);
      pending.current = null;
      setError(null);
    } catch (failure) {
      if (!active()) return;
      if (failure instanceof DisplayError && failure.status !== 0) pending.current = null;
      setError(failure instanceof Error ? failure.message : 'Please try again.');
      if (failure instanceof DisplayError && failure.status === 401) { setSession(null); setRestart(value => value + 1); }
    } finally {
      if (inFlight.current === operation) inFlight.current = null;
      if (active()) {
        setBusy(false);
        if (intent.type !== 'display.set_language') setLanguageRetry(value => value + 1);
      }
    }
  }, []);

  const pairedDeviceId = session?.device.id;
  useEffect(() => {
    if (pairedDeviceId && !pending.current && sessionRef.current?.document.language !== lang) void send('display.set_language', { language: lang });
  }, [lang, pairedDeviceId, session?.document.sequence, session?.document.language, languageRetry, send]);

  const document = session?.document;
  const isFnb = document?.cart?.kind === 'fnb';
  const fnbCart = document && isFnb ? readDisplayFnbCart(document.cart, document.stage) : null;
  const fnbTotals = fnbCart?.supported ? DisplayTotalsSchema.safeParse(document?.totals) : null;
  const fnbPayment = fnbCart?.supported ? DisplayPaymentSchema.safeParse(document?.payment) : null;
  const fnb = fnbCart?.supported && (fnbTotals?.success || document?.stage === 'welcome')
    && document?.member === null && document.prompt === null
    && (document.stage !== 'payment' || fnbPayment?.success)
    && (!fnbCart.completion || fnbTotals?.success && fnbCart.completion.total === fnbTotals.data.total)
    ? { cart: fnbCart, totals: fnbTotals?.success ? fnbTotals.data : undefined } : null;
  const isMerch = document?.cart?.kind === 'merch';
  const merchCart = document && isMerch ? readDisplayMerchCart(document.cart, document.stage) : null;
  const merchTotals = merchCart?.supported ? DisplayTotalsSchema.safeParse(document?.totals) : null;
  const merchPayment = merchCart?.supported ? DisplayPaymentSchema.safeParse(document?.payment) : null;
  const merch = merchCart?.supported && (merchTotals?.success || document?.stage === 'welcome')
    && document?.member === null && document.prompt === null
    && (document.stage !== 'payment' || merchPayment?.success)
    && (!merchCart.completion || merchTotals?.success && merchCart.completion.total === merchTotals.data.total)
    ? { cart: merchCart, totals: merchTotals?.success ? merchTotals.data : undefined } : null;
  const view = document && !isFnb && !isMerch ? readTicketDisplayView(document) : null;
  const answer = document?.prompt?.answer;
  // The public response deliberately omits the staff wizard step. Its validated
  // input prompt identifies the review without exposing that staff-only state.
  const childReview = view?.childReview ?? null;

  return <div className="dark h-[100dvh] w-full min-w-0 overflow-hidden bg-background text-foreground flex flex-col" data-testid="separate-display">
    {error && <div role="alert" className="shrink-0 bg-amber-100 px-4 py-3 text-sm text-amber-950 flex items-center justify-between gap-3">
      <span>{error}</span>
      <Button size="sm" onClick={() => { if (pairingMode === 'expiry-error') { void expirePairing(); return; } const intent = pending.current; if (intent) void send(intent.type, intent.payload); else setRestart(value => value + 1); }}>Retry</Button>
    </div>}
    {!persistent && <p className="shrink-0 px-4 py-2 text-sm">This browser cannot remember the display. Keep this page open or enable site storage.</p>}
    {!session ? <main className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-5">
      <Monitor className="h-14 w-14 text-primary" />
      <h1 className="text-3xl font-bold">Set up this display</h1>
      <p className="max-w-xl text-lg">In the Console, open Devices, choose Pair a display, and enter this code for the station.</p>
      {pairing ? <>
        <div className="font-mono text-6xl font-bold tracking-[0.2em]" aria-label="Pairing code" data-testid="display-pairing-code">{pairing.pairingCode}</div>
        <p className="text-sm text-muted-foreground">This code expires at {new Date(pairing.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.</p>
        <Button variant="outline" onClick={() => { void expirePairing(); }}>Expire code now</Button>
      </> : pairingMode === 'expired' ? <>
        <p role="status">This code has expired. Create a new code when you are ready to pair this display.</p>
        <Button variant="outline" onClick={newPairing}>New code</Button>
      </> : pairingMode === 'expiry-error' ? <p>Pairing is paused until code expiry is confirmed.</p>
        : <Loader2 className="h-8 w-8 animate-spin" aria-label={pairingMode === 'expiring' ? 'Expiring code' : 'Connecting'} />}
    </main> : fnb && document ? <>
      <div className="sr-only" data-testid="display-station">{session.station.name} · {session.device.name}</div>
      <div className="flex-1 min-h-0" data-testid="display-fnb">
        <FnbCustomerDisplay stage={document.stage as FnbCustomerStage} presentation={fnb}
          payment={fnbPayment?.success ? fnbPayment.data : undefined} />
      </div>
    </> : childReview ? <>
      <div className="sr-only" data-testid="display-station">{session.station.name} · {session.device.name}</div>
      <div className="flex-1 min-h-0" inert={busy || !!answer || !!pending.current}>
        <PublicSavedChildrenReview key={childReview.visitorId} prompt={childReview}
          busy={busy || !!answer || !!pending.current}
          onAction={action => { void send('display.child_review', action); }} />
      </div>
      {(busy || !!answer) && <p role="status" className="shrink-0 text-center py-3">
        {busy ? 'Sending…' : 'Please wait for the team to confirm this change.'}
      </p>}
    </> : view?.consent ? <>
      <div className="sr-only" data-testid="display-station">{session.station.name} · {session.device.name}</div>
      <div className="flex-1 min-h-0" inert={busy || !!answer || !!pending.current}>
        <PublicConsentCapture key={view.consent.visitorId} prompt={view.consent}
          busy={busy || !!answer || !!pending.current}
          onAction={action => { void send('display.consent', action); }} />
      </div>
      {(busy || !!answer) && <p role="status" className="shrink-0 text-center py-3">
        {busy ? 'Sending…' : 'Please wait for the team to confirm this change.'}
      </p>}
    </> : merch && document ? <>
      <div className="sr-only" data-testid="display-station">{session.station.name} · {session.device.name}</div>
      <div className="flex-1 min-h-0" data-testid="display-merch">
        <PublicMerchCustomerDisplay stage={document.stage as PublicMerchStage}
          cart={merch.cart} totals={merch.totals} payment={merchPayment?.success ? merchPayment.data : undefined} />
      </div>
    </> : view && document ? <>
      <div className="sr-only" data-testid="display-station">{session.station.name} · {session.device.name}</div>
      <div className="flex-1 min-h-0" inert={busy || !!answer || !!pending.current}>
        <CustomerDisplay stage={view.stage} sale={view.sale} phone={phone}
          nickname={view.stage === 'identify' || view.stage === 'input' ? nickname : view.nickname} member={view.member}
          totals={view.totals} payment={view.payment} lineBreakdowns={view.lineBreakdowns}
          voucherPrize={view.voucherPrize} nothingToPay={view.nothingToPay} showGrantQr={false}
          contactChannel={contactChannel} onPhoneChange={setPhone} onNicknameChange={setNickname} onContactChannelChange={setContactChannel}
          onIdentify={() => { void send('display.identify', { requestId, phone, nickname, contactChannel }); }}
          onSkipIdentify={() => { void send('display.skip_identify', { requestId }); }}
          onCustomerDone={() => { void send('display.contact_done', { requestId, phone, nickname, contactChannel }); }} />
      </div>
      {(busy || !!answer) && <p role="status" className="shrink-0 text-center py-3">{busy ? 'Sending…' : 'Thank you. Please wait for the team.'}</p>}
    </> : <main className="flex-1 flex flex-col items-center justify-center p-8 text-center gap-5">
      <Monitor className="h-14 w-14 text-primary" />
      <h1 className="text-3xl font-bold">Welcome to OTO Park</h1>
      <p className="text-xl">Please follow the staff screen.</p>
      <p className="text-sm text-muted-foreground">{session.station.name} · {session.device.name}</p>
    </main>}
  </div>;
}
