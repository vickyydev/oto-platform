import { useEffect, useState } from 'react';
import { useOperator } from '@/auth/OperatorContext';
import { ImpersonationBannerView, markViewAsOffset } from './ImpersonationBannerView';

/** SCRUM-648 — the banner fed from the session's /me (see ImpersonationBannerView). */
export function ImpersonationBanner() {
  const { viewAs } = useOperator();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!viewAs) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [viewAs]);
  useEffect(() => {
    markViewAsOffset(document.documentElement, viewAs !== null);
    return () => markViewAsOffset(document.documentElement, false);
  }, [viewAs]);
  return <ImpersonationBannerView viewAs={viewAs} now={now} />;
}
