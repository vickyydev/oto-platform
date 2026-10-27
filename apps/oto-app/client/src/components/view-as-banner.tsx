import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/use-auth";
import { markViewAsOffset, viewAsOf } from "@/lib/viewAsBanner";
import { ViewAsBannerView } from "./view-as-banner-view";

/** SCRUM-648 — the banner fed from `/api/user` (see lib/viewAsBanner.ts). */
export function ViewAsBanner() {
  const { user } = useAuth();
  const viewAs = viewAsOf(user);
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
