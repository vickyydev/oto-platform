import { useEffect, useRef, useState } from 'react';
import type { StationSessionDocument, StationSessionStage } from '@oto/shared';
import { api, ApiError } from '@/api/client';
import type { ContactChannel, Member } from '@/types';

export interface DisplayAnswer {
  type: 'identify' | 'skip_identify' | 'contact_done';
  actionId: string;
  phone?: string;
  nickname?: string;
  contactChannel?: ContactChannel;
}
export interface TicketDisplayState {
  stage: StationSessionStage;
  step: number;
  sessionKey: string;
  tier: string;
  phone: string;
  nickname: string;
  contactChannel: ContactChannel;
  member: Member | null;
}

/** The first display slice shares identification/contact only, never child or staff records. */
export function ticketDisplayPresentation(state: TicketDisplayState, requestId: string) {
  const supported = ['identify', 'welcome', 'input'].includes(state.stage) && state.step !== 7 && state.step !== 8;
  return {
    stage: state.stage,
    step: state.step,
    cart: { supported, sale: { tier: state.tier } },
    member: state.member ? { id: state.member.id, nickname: state.member.nickname, tier: state.tier } : null,
    totals: null,
    payment: null,
    prompt: supported && (state.stage === 'identify' || state.stage === 'input') ? {
      kind: state.stage === 'identify' ? 'identify' : 'contact', requestId,
      phone: state.phone, nickname: state.nickname, contactChannel: state.contactChannel,
    } : null,
  };
}

export function readDisplayAnswer(document: StationSessionDocument, requestId: string): DisplayAnswer | null {
  if (document.prompt?.requestId !== requestId) return null;
  const answer = document.prompt.answer as Partial<DisplayAnswer> | undefined;
  if (!answer || typeof answer.actionId !== 'string') return null;
  if (answer.type === 'skip_identify' && document.stage === 'identify') return answer as DisplayAnswer;
  if (answer.type === 'identify' && document.stage === 'identify' && typeof answer.phone === 'string') return answer as DisplayAnswer;
  if (answer.type === 'contact_done' && document.stage === 'input' && typeof answer.phone === 'string'
    && typeof answer.nickname === 'string' && ['whatsapp','telegram','line'].includes(answer.contactChannel ?? '')) return answer as DisplayAnswer;
  return null;
}

interface ConnectedDisplay { id: string; name: string; connected: boolean }
const POLL_MS = 1_500;
// The browser document keeps its publisher identity through a paused or
// remounted till. A different tab cannot silently take a live display lease.
const holders = new Map<string,string>();
function holderFor(stationId: string): string {
  let holder = holders.get(stationId);
  if (!holder) { holder = crypto.randomUUID(); holders.set(stationId,holder); }
  return holder;
}

interface DisplayPublisher {
  stationId: string;
  holder: string;
  leaseId: string | null;
  renewedAt: number;
  lastPublished: string;
  promptKey: string;
  requestId: string;
  handled: Set<string>;
}

/** A lock pauses this publisher without discarding the current visitor's prompt. */
export function useTicketDisplay(stationId: string | null, state: TicketDisplayState, onAnswer: (answer: DisplayAnswer) => void, active = true) {
  const current = useRef({ state, onAnswer, active });
  current.current = { state, onAnswer, active };
  const publisher = useRef<DisplayPublisher | null>(null);
  const [connected, setConnected] = useState<ConnectedDisplay[]>([]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setConnected([]);
    setError(null);
    if (!stationId) return;
    const channel: DisplayPublisher = {
      stationId, holder: holderFor(stationId), leaseId: null, renewedAt: 0,
      lastPublished: '', promptKey: '', requestId: '', handled: new Set(),
    };
    publisher.current = channel;
    return () => {
      if (publisher.current === channel) publisher.current = null;
      if (channel.leaseId) void api.post(`/stations/${stationId}/lease/release`, { leaseId: channel.leaseId }).catch(() => undefined);
    };
  }, [stationId]);

  useEffect(() => {
    const channel = publisher.current;
    if (!stationId || !active || !channel || channel.stationId !== stationId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const base = `/stations/${stationId}`;
    const paused = () => stopped || !current.current.active || publisher.current !== channel;
    const tick = async () => {
      if (paused()) return;
      try {
        const list = await api.get<{ displays: ConnectedDisplay[] }>(`${base}/displays`);
        if (paused()) return;
        const online = list.displays.filter(display => display.connected);
        setConnected(online);
        if (!online.length) return;
        let document: StationSessionDocument;
        if (!channel.leaseId) {
          const claimed = await api.post<{ document: StationSessionDocument; lease: { leaseId: string } }>(`${base}/lease`, { holder: channel.holder });
          if (paused()) return;
          channel.leaseId = claimed.lease.leaseId;
          channel.renewedAt = Date.now();
          document = claimed.document;
          channel.lastPublished = '';
        } else if (Date.now() - channel.renewedAt >= 15_000) {
          const renewed = await api.post<{ document: StationSessionDocument }>(`${base}/lease/renew`, { leaseId: channel.leaseId });
          if (paused()) return;
          document = renewed.document;
          channel.renewedAt = Date.now();
        } else {
          document = (await api.get<{ document: StationSessionDocument }>(`${base}/session`)).document;
          if (paused()) return;
        }
        const latest = current.current;
        const key = `${latest.state.sessionKey}:${latest.state.stage}:${latest.state.step}`;
        if (key !== channel.promptKey) {
          channel.promptKey = key;
          channel.requestId = crypto.randomUUID();
        }
        const answer = readDisplayAnswer(document, channel.requestId);
        if (answer && !channel.handled.has(answer.actionId)) {
          channel.handled.add(answer.actionId);
          latest.onAnswer(answer);
          // React applies the resulting stage/contact state before the next publish.
          return;
        }
        const payload = ticketDisplayPresentation(latest.state, channel.requestId);
        const signature = JSON.stringify(payload);
        if (signature !== channel.lastPublished) {
          await api.post(`${base}/intents`, { type: 'session.publish_display', leaseId: channel.leaseId,
            lastSeenSequence: document.sequence, actionId: crypto.randomUUID(), payload });
          if (paused()) return;
          channel.lastPublished = signature;
        }
        setError(null);
      } catch (failure) {
        if (paused()) return;
        if (failure instanceof ApiError && ['STATION_STALE','STATION_NO_LEASE'].includes(failure.code)) {
          channel.leaseId = null;
          channel.lastPublished = '';
        }
        setConnected([]);
        setError(failure instanceof Error ? failure.message : 'The display could not connect.');
      } finally {
        if (!paused()) timer = setTimeout(() => { void tick(); }, POLL_MS);
      }
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [stationId, active]);
  return { connected, error, supported: ticketDisplayPresentation(state, '').cart.supported };
}
