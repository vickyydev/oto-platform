import { useEffect, useState } from "react";
import { markViewAsOffset, viewAsOf } from "@/lib/viewAsBanner";
import { ViewAsBannerView } from "./view-as-banner-view";

/** SCRUM-648 — the banner fed from Radar's `/api/me` (see lib/viewAsBanner.ts). */
export function ViewAsBanner({ me }: { me: unknown }) {
  const viewAs = viewAsOf(me);
  const live = viewAs !== null;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [live]);
  useEffect(() => {
    markViewAsOffset(document.documentElement, live);
    return () => markViewAsOffset(document.documentElement, false);
  }, [live]);
  return <ViewAsBannerView viewAs={viewAs} now={now} />;
}
