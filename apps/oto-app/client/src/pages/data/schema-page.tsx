import { useState, useRef, useCallback, useEffect } from "react";
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";

// Intentionally does NOT use DataAdminLayout — the canvas must fill the
// viewport so scroll on the canvas never conflicts with page scroll.
import { DataAdminSidebar } from "./sidebar";
import { useAuth } from "@/hooks/use-auth";
import { Link } from "wouter";
import { Database, LogOut, ExternalLink, GitFork } from "lucide-react";

export default function SchemaPage() {
  const { user, logoutMutation } = useAuth();
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const fitScale = useRef(1);
  const imgNaturalW = useRef(0);
  const imgNaturalH = useRef(0);
  const dragging = useRef(false);
  const last = useRef({ x: 0, y: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  const computeFitScale = useCallback(() => {
    const el = containerRef.current;
    if (!el || !imgNaturalW.current || !imgNaturalH.current) return;
    fitScale.current = Math.min(
      el.clientWidth / imgNaturalW.current,
      el.clientHeight / imgNaturalH.current,
    );
  }, []);

  // Read the SVG's declared width/height attributes (not rendered size) via fetch,
  // then compute fit scale and initialise.
  useEffect(() => {
    fetch("/data-admin-schema.svg")
      .then((r) => r.text())
      .then((text) => {
        const match = text.match(/<svg[^>]*\swidth="([^"]+)"[^>]*\sheight="([^"]+)"/);
        if (!match) return;
        imgNaturalW.current = parseFloat(match[1]);
        imgNaturalH.current = parseFloat(match[2]);
        computeFitScale();
        setScale(fitScale.current);
      });
  }, [computeFitScale]);

  const clampOffset = useCallback((ox: number, oy: number, s: number) => {
    const el = containerRef.current;
    if (!el) return { x: ox, y: oy };
    const { width, height } = el.getBoundingClientRect();
    const scaledW = imgNaturalW.current * s;
    const scaledH = imgNaturalH.current * s;
    return {
      x: Math.min(0, Math.max(width - scaledW, ox)),
      y: Math.min(0, Math.max(height - scaledH, oy)),
    };
  }, []);

  const zoomAt = useCallback((delta: number, cx: number, cy: number) => {
    setScale((s) => {
      const next = Math.min(4, Math.max(fitScale.current, s + delta));
      if (next === s) return s;
      setOffset((o) => {
        if (next === fitScale.current) return { x: 0, y: 0 };
        return clampOffset(
          cx - (cx - o.x) * (next / s),
          cy - (cy - o.y) * (next / s),
          next,
        );
      });
      return next;
    });
  }, [clampOffset]);

  const zoomCenter = useCallback((delta: number) => {
    const el = containerRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    zoomAt(delta, width / 2, height / 2);
  }, [zoomAt]);

  const reset = useCallback(() => {
    setScale(fitScale.current);
    setOffset({ x: 0, y: 0 });
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(e.deltaY < 0 ? 0.12 : -0.12, e.clientX - rect.left, e.clientY - rect.top);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAt]);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if (scale <= fitScale.current) return;
    dragging.current = true;
    last.current = { x: e.clientX, y: e.clientY };
  }, [scale]);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - last.current.x;
    const dy = e.clientY - last.current.y;
    last.current = { x: e.clientX, y: e.clientY };
    setOffset((o) => clampOffset(o.x + dx, o.y + dy, scale));
  }, [clampOffset, scale]);

  const onMouseUp = useCallback(() => { dragging.current = false; }, []);

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background font-sans">
      <aside className="w-60 flex-shrink-0 bg-sidebar border-r border-sidebar-border flex flex-col">
        <div className="flex items-center gap-2 px-4 py-4 border-b border-sidebar-border">
          <Database className="h-5 w-5 text-sidebar-primary" />
          <span className="font-semibold text-sidebar-foreground text-sm tracking-wide">Data Admin</span>
        </div>
        <DataAdminSidebar />
        <div className="mt-auto border-t border-sidebar-border p-3 space-y-1">
          <Link href="/data/schema">
            <Button variant="ghost" className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground">
              <GitFork className="h-4 w-4 mr-2" />Schema diagram
            </Button>
          </Link>
          <Link href="/">
            <Button variant="ghost" className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground">
              <ExternalLink className="h-4 w-4 mr-2" />Back to app
            </Button>
          </Link>
          <Button variant="ghost" className="w-full justify-start text-sidebar-foreground/70 hover:text-sidebar-foreground"
            onClick={() => logoutMutation.mutate()} disabled={logoutMutation.isPending}>
            <LogOut className="h-4 w-4 mr-2" />{logoutMutation.isPending ? "Logging out…" : "Logout"}
          </Button>
          <p className="px-2 pt-1 text-sm text-sidebar-foreground/50 truncate">{user?.email}</p>
        </div>
      </aside>

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <header className="flex items-center justify-between px-6 py-3 border-b border-border bg-background/95 flex-shrink-0">
          <div>
            <h1 className="text-xl font-semibold text-foreground">Schema Diagram</h1>
            <p className="text-xs text-muted-foreground">Scroll to zoom · drag to pan</p>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="outline" size="sm" onClick={() => zoomCenter(0.15)}>
              <ZoomIn className="h-4 w-4" />
            </Button>
            <span className="text-sm text-muted-foreground w-12 text-center tabular-nums">
              {Math.round(scale / fitScale.current * 100)}%
            </span>
            <Button variant="outline" size="sm" onClick={() => zoomCenter(-0.15)} disabled={scale <= fitScale.current}>
              <ZoomOut className="h-4 w-4" />
            </Button>
            <Button variant="outline" size="sm" onClick={reset} className="ml-1">
              <Maximize2 className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <div
          ref={containerRef}
          className="flex-1 overflow-hidden bg-card"
          style={{ cursor: scale <= fitScale.current ? "default" : dragging.current ? "grabbing" : "grab" }}
          onMouseDown={onMouseDown}
          onMouseMove={onMouseMove}
          onMouseUp={onMouseUp}
          onMouseLeave={onMouseUp}
        >
          <img
            src="/data-admin-schema.svg"
            alt="Data model schema diagram"
            draggable={false}
            style={{
              display: "block",
              transformOrigin: "top left",
              transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
              transition: dragging.current ? "none" : "transform 0.05s ease-out",
              userSelect: "none",
            }}
          />
        </div>
      </div>
    </div>
  );
}
