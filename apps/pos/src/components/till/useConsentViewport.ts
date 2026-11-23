import { useEffect, useRef, useState, type RefObject, type SyntheticEvent } from 'react';
import type { ConsentFormStep, ConsentPrompt } from '@oto/shared';

type View = NonNullable<ConsentPrompt['familyView']>;
const selector = '[data-consent-field]';
const thousandths = (ratio: number) => Math.round(Math.max(-1, Math.min(1, ratio)) * 1000);

// Only bounded positions cross the station channel. Each screen lays out the same
// fields at its own width, even when the guest has an on-screen keyboard open.
export function useConsentViewport({ scroller, step, prompt, mirror, canSend, onView }: {
  scroller: RefObject<HTMLDivElement | null>; step: ConsentFormStep; prompt: ConsentPrompt;
  mirror: boolean; canSend: boolean; onView: (view: View) => void;
}) {
  const [local, setLocal] = useState<View | null>(null);
  const active = useRef<Element | null>(null);
  const sent = useRef('');
  const publish = useRef(onView);
  publish.current = onView;
  const enabled = !mirror && prompt.familyView !== undefined;
  const localView = enabled && local?.step === step ? local : null;
  const sample = (event: SyntheticEvent<HTMLDivElement>) => {
    const box = scroller.current;
    if (!enabled || !box || !box.clientHeight) return;
    const fields = Array.from(box.querySelectorAll<HTMLElement>(selector));
    if (event.type !== 'scroll' && event.target instanceof Element) {
      active.current = event.target.closest(selector);
    }
    const top = box.getBoundingClientRect().top;
    const visible = fields.filter(field => {
      const rect = field.getBoundingClientRect();
      return rect.height > 0 && rect.bottom > top && rect.top < top + box.clientHeight;
    });
    const focused = fields.indexOf(active.current as HTMLElement);
    const anchor = visible.find(field => field === active.current) ?? visible[0];
    const next: View = {
      step, anchor: anchor ? fields.indexOf(anchor) : null,
      offset: anchor ? thousandths((anchor.getBoundingClientRect().top - top) / box.clientHeight) : 0,
      progress: thousandths(box.scrollTop / Math.max(1, box.scrollHeight - box.clientHeight)),
      active: focused >= 0 ? focused : null,
    };
    setLocal(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  };
  useEffect(() => {
    active.current = null;
    setLocal(null);
    sent.current = '';
  }, [step, prompt.visitorId]);
  const acknowledged = JSON.stringify(prompt.familyView);
  useEffect(() => {
    if (!canSend || !localView || JSON.stringify(localView) === acknowledged) return;
    const key = JSON.stringify([prompt.requestId, localView]);
    if (sent.current === key) return;
    const timer = setTimeout(() => {
      sent.current = key;
      publish.current(localView);
    }, 180);
    return () => clearTimeout(timer);
  }, [canSend, localView, acknowledged, prompt.requestId]);

  const remote = mirror ? prompt.familyView : null;
  useEffect(() => {
    const box = scroller.current;
    if (!box || !remote || remote.step !== step) return;
    const fields = box.querySelectorAll<HTMLElement>(selector);
    const marked = remote.active === null ? undefined : fields[remote.active];
    marked?.setAttribute('data-guest-active', '');
    const follow = () => {
      const anchor = remote.anchor === null ? undefined : fields[remote.anchor];
      if (anchor && anchor.getBoundingClientRect().height > 0) {
        box.scrollTop += anchor.getBoundingClientRect().top - box.getBoundingClientRect().top
          - box.clientHeight * remote.offset / 1000;
      } else {
        box.scrollTop = (box.scrollHeight - box.clientHeight) * remote.progress / 1000;
      }
    };
    follow();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(follow);
    observer?.observe(box);
    return () => { observer?.disconnect(); marked?.removeAttribute('data-guest-active'); };
  }, [remote, scroller, step]);
  return { localView, events: enabled ? { onScroll: sample, onFocusCapture: sample, onPointerDownCapture: sample } : {} };
}
