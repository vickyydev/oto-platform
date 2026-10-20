import { useCallback, useEffect, useRef, useState } from 'react';
import { Archive, Bot, FileText, FlaskConical, LogOut, MessageSquare, Sparkles } from 'lucide-react';
import type { InboxTab } from '@oto/shared/inbox';
import { ApiError } from '@/api/client';
import { assistantCapabilities } from '@/api/assistant';
import { inboxApi, type ConversationList as ListPage, type ConversationRow, type Dashboard as DashboardData, type InboxMe, type Message } from '@/api/inbox';
import { useSession } from '@/auth/SessionContext';
import { AssistantSettings } from '@/components/AssistantSettings';
import { EmptyState } from '@/components/atoms';
import { ChatPanel, type Thread } from '@/components/ChatPanel';
import { composerTemplate, type InsertedTemplate } from '@/components/Composer';
import { HandleConfirm } from '@/components/confirms';
import { ConversationList } from '@/components/ConversationList';
import { Dashboard } from '@/components/Dashboard';
import { DetailsDialog, FiltersDialog, TemplatesDialog } from '@/components/dialogs';
import { Rail, viewerRoleLabel } from '@/components/Rail';
import { SimulatorDialog } from '@/components/Simulator';
import { TemplateSettings } from '@/components/TemplateSettings';
import { EMPTY_FILTERS, listQuery, type Filters } from '@/lib/query';
import { defaultTab, writeMode } from '@/lib/view';

const LAUNCHER_URL = import.meta.env.VITE_LAUNCHER_URL?.trim();

/** How often an open Inbox re-reads what it shows, while the tab is in view. */
const REFRESH_MS = 30_000;
const PAGE = 50;
const PAGE_MAX = 100;

const EMPTY_THREAD: Thread = { detail: null, messages: [], olderCursor: null, loading: false, loadingOlder: false, error: null };

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/** The three columns collapse to list-then-thread below `lg` (the prototype's `showChatMobile`, :1047). */
function useIsDesktop(): boolean {
  const query = '(min-width: 1024px)';
  const [desktop, setDesktop] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setDesktop(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return desktop;
}

/**
 * Newer messages onto what is loaded: keep the older pages the reader opened,
 * and append the newest page past the last one already shown. If the newest
 * page no longer meets what is loaded (a long gap), it replaces it.
 */
function mergeNewest(loaded: Message[], newest: Message[], loadedCursor: string | null, newestCursor: string | null) {
  const first = newest[0];
  const at = first ? loaded.findIndex((m) => m.id === first.id) : -1;
  if (at < 0) return { messages: newest, olderCursor: newestCursor };
  return { messages: [...loaded.slice(0, at), ...newest], olderCursor: loadedCursor };
}

/**
 * The Inbox page: the header card with the dashboard, then the one rounded
 * workspace card in three columns (WhatsAppDemo.tsx :1300-1673), every figure
 * and line from the platform api. The prototype's own state — its role
 * switcher, phone preview, availability toggles and in-memory conversations —
 * is gone: the viewer is the signed-in account (`GET /inbox/me`).
 */
export function Workspace({ me }: { me: InboxMe }) {
  const { signOut, reload } = useSession();
  const desktop = useIsDesktop();
  const [now, setNow] = useState(() => new Date());

  const [tab, setTab] = useState<InboxTab>(() => defaultTab(me.tabs));
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [search, setSearch] = useState('');

  const [page, setPage] = useState<ListPage | null>(null);
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showChatMobile, setShowChatMobile] = useState(false);
  const [thread, setThread] = useState<Thread>(EMPTY_THREAD);

  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [simulatorOpen, setSimulatorOpen] = useState(false);
  /** The settings page in place of the workspace card: templates (I3b) or the assistant (SCRUM-590 A3). */
  const [settings, setSettings] = useState<'templates' | 'assistant' | null>(null);
  const assistantCaps = assistantCapabilities(me);
  const [inserted, setInserted] = useState<InsertedTemplate | null>(null);

  // "Mark as handled for everyone?", from the chat or a list row.
  const [confirmHandleId, setConfirmHandleId] = useState<string | null>(null);
  const [handling, setHandling] = useState(false);
  const [handleError, setHandleError] = useState<string | null>(null);

  const patchFilters = useCallback((next: Partial<Filters>) => setFilters((f) => ({ ...f, ...next })), []);

  // The search box types freely; the list asks the api a quarter-second later.
  useEffect(() => {
    const t = window.setTimeout(() => setFilters((f) => (f.q === search ? f : { ...f, q: search })), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  // --- The list -------------------------------------------------------------------
  const listSeq = useRef(0);
  const loadList = useCallback(
    async (opts: { refresh?: boolean; limit?: number } = {}) => {
      const seq = ++listSeq.current;
      if (!opts.refresh) setListLoading(true);
      try {
        const next = await inboxApi.conversations(listQuery(tab, filters, { limit: opts.limit ?? PAGE }));
        if (seq !== listSeq.current) return;
        setPage(next);
        setRows(next.conversations);
        setListError(null);
      } catch (err) {
        if (seq === listSeq.current) setListError(message(err, 'The conversations could not be read.'));
      } finally {
        if (seq === listSeq.current) setListLoading(false);
      }
    },
    [tab, filters],
  );

  useEffect(() => {
    setRows([]);
    setPage(null);
    void loadList();
  }, [loadList]);

  const loadMore = useCallback(async () => {
    if (!page?.nextCursor || loadingMore) return;
    setLoadingMore(true);
    const seq = listSeq.current;
    try {
      const next = await inboxApi.conversations(listQuery(tab, filters, { cursor: page.nextCursor, limit: PAGE }));
      if (seq !== listSeq.current) return;
      setRows((r) => [...r, ...next.conversations.filter((c) => !r.some((x) => x.id === c.id))]);
      setPage(next);
    } catch (err) {
      setListError(message(err, 'More conversations could not be read.'));
    } finally {
      setLoadingMore(false);
    }
  }, [page, loadingMore, tab, filters]);

  // --- The dashboard ---------------------------------------------------------------
  const loadDashboard = useCallback(async () => {
    if (!me.capabilities.dashboard) return;
    try {
      setDashboard(await inboxApi.dashboard());
      setDashboardError(null);
    } catch (err) {
      setDashboardError(message(err, 'The dashboard could not be read.'));
    }
  }, [me.capabilities.dashboard]);
  useEffect(() => void loadDashboard(), [loadDashboard]);

  // --- The open conversation -------------------------------------------------------
  // Selection follows the visible list (:1099-1100): a tab or filter that drops
  // the open conversation opens the first one instead.
  const selected = rows.find((c) => c.id === selectedId) ?? rows[0] ?? null;
  const selectedKey = selected?.id ?? null;
  const visible = selected !== null && (desktop || showChatMobile);

  const threadSeq = useRef(0);
  const loadThread = useCallback(async (id: string, refresh: boolean) => {
    const seq = ++threadSeq.current;
    if (!refresh) setThread({ ...EMPTY_THREAD, loading: true });
    try {
      const [detail, newest] = await Promise.all([inboxApi.conversation(id), inboxApi.messages(id)]);
      if (seq !== threadSeq.current) return;
      setThread((t) => {
        const merged =
          refresh && t.detail?.id === id
            ? mergeNewest(t.messages, newest.messages, t.olderCursor, newest.olderCursor)
            : { messages: newest.messages, olderCursor: newest.olderCursor };
        return { ...t, detail, ...merged, loading: false, error: null };
      });
    } catch (err) {
      if (seq === threadSeq.current) {
        setThread((t) => ({ ...t, loading: false, error: message(err, 'This conversation could not be read.') }));
      }
    }
  }, []);

  useEffect(() => {
    if (selectedKey === null) {
      setThread(EMPTY_THREAD);
      return;
    }
    void loadThread(selectedKey, false);
  }, [selectedKey, loadThread]);

  const loadOlder = useCallback(async () => {
    const id = selectedKey;
    const before = thread.olderCursor;
    if (!id || !before || thread.loadingOlder) return;
    setThread((t) => ({ ...t, loadingOlder: true }));
    try {
      const older = await inboxApi.messages(id, before);
      setThread((t) =>
        t.detail?.id === id
          ? {
              ...t,
              messages: [...older.messages.filter((m) => !t.messages.some((x) => x.id === m.id)), ...t.messages],
              olderCursor: older.olderCursor,
              loadingOlder: false,
            }
          : t,
      );
    } catch (err) {
      setThread((t) => ({ ...t, loadingOlder: false, error: message(err, 'Earlier messages could not be read.') }));
    }
  }, [selectedKey, thread.olderCursor, thread.loadingOlder]);

  // Reading a thread moves the viewer's unread marker (`POST …/read`) — only
  // once it is actually on screen, and only when there is something unread.
  const newestLoaded = thread.detail?.id === selectedKey ? thread.messages[thread.messages.length - 1]?.id : undefined;
  const unread = selected?.unread ?? 0;
  useEffect(() => {
    if (!visible || !selectedKey || !newestLoaded || unread === 0) return;
    let cancelled = false;
    inboxApi
      .markRead(selectedKey, { messageId: newestLoaded })
      .then(() => {
        if (!cancelled) setRows((r) => r.map((c) => (c.id === selectedKey ? { ...c, unread: 0 } : c)));
      })
      .catch(() => {
        // The marker is a convenience: a refused one leaves the count showing,
        // and the next read tries again.
      });
    return () => {
      cancelled = true;
    };
  }, [visible, selectedKey, newestLoaded, unread]);

  // --- Staying current -------------------------------------------------------------
  const rowCount = rows.length;
  useEffect(() => {
    const tick = () => {
      setNow(new Date());
      if (document.visibilityState !== 'visible') return;
      void loadList({ refresh: true, limit: Math.min(PAGE_MAX, Math.max(PAGE, rowCount)) });
      void loadDashboard();
      if (selectedKey) void loadThread(selectedKey, true);
    };
    const t = window.setInterval(tick, REFRESH_MS);
    return () => window.clearInterval(t);
  }, [loadList, loadDashboard, loadThread, selectedKey, rowCount]);

  // After a write: the list, the dashboard and the open thread, read again.
  const refresh = useCallback(async () => {
    await Promise.all([
      loadList({ refresh: true, limit: Math.min(PAGE_MAX, Math.max(PAGE, rowCount)) }),
      loadDashboard(),
      selectedKey ? loadThread(selectedKey, true) : Promise.resolve(),
    ]);
  }, [loadList, loadDashboard, loadThread, selectedKey, rowCount]);

  const askHandle = (id: string) => {
    setHandleError(null);
    setConfirmHandleId(id);
  };
  const confirmHandle = async () => {
    if (!confirmHandleId) return;
    setHandling(true);
    setHandleError(null);
    try {
      await inboxApi.handle(confirmHandleId);
      setConfirmHandleId(null);
      await refresh();
    } catch (err) {
      setHandleError(message(err, 'The conversation could not be marked as handled.'));
    } finally {
      setHandling(false);
    }
  };

  const chooseTab = (t: InboxTab) => {
    setTab(t);
    setShowChatMobile(false);
  };

  // The header's Handled toggle (:1350-1360): into the archive and back.
  const toggleHandled = () =>
    chooseTab(tab === 'handled' ? (me.tabs.find((t) => t !== 'handled') ?? 'team') : 'handled');

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 px-4 py-5 sm:px-6">
      {/* HEADER */}
      <header className="rounded-2xl border border-slate-200 bg-white p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-500">
              <Sparkles className="h-3.5 w-3.5" />
              Unified Customer Inbox
            </div>
            <h1 className="mt-1 text-xl font-semibold tracking-tight text-slate-900">All channels, one queue, role-based access</h1>
            <p className="mt-1 text-[13px] text-slate-500">
              WhatsApp · Instagram · Facebook, routed to the right team. {me.name ?? 'You'} · {viewerRoleLabel(me)}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {me.tabs.includes('handled') && (
              <button
                type="button"
                onClick={toggleHandled}
                aria-pressed={tab === 'handled'}
                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[12px] font-medium transition ${
                  tab === 'handled'
                    ? 'border-slate-900 bg-slate-900 text-white shadow-sm'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900'
                }`}
              >
                <Archive className="h-3.5 w-3.5" />
                Handled
              </button>
            )}
            {me.capabilities.templates && (
              <button
                type="button"
                onClick={() => setSettings((v) => (v === 'templates' ? null : 'templates'))}
                aria-pressed={settings === 'templates'}
                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[12px] font-medium transition ${
                  settings === 'templates'
                    ? 'border-slate-900 bg-slate-900 text-white shadow-sm'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900'
                }`}
              >
                <FileText className="h-3.5 w-3.5" />
                Templates
              </button>
            )}
            {(assistantCaps.kb || assistantCaps.ai) && (
              <button
                type="button"
                onClick={() => setSettings((v) => (v === 'assistant' ? null : 'assistant'))}
                aria-pressed={settings === 'assistant'}
                className={`inline-flex items-center gap-1.5 rounded-xl border px-3 py-2 text-[12px] font-medium transition ${
                  settings === 'assistant'
                    ? 'border-slate-900 bg-slate-900 text-white shadow-sm'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300 hover:text-slate-900'
                }`}
              >
                <Bot className="h-3.5 w-3.5" />
                Assistant
              </button>
            )}
            {me.simulator && (
              <button
                type="button"
                onClick={() => setSimulatorOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-xl border border-indigo-200 bg-indigo-50 px-3 py-2 text-[12px] font-medium text-indigo-700 hover:border-indigo-300"
              >
                <FlaskConical className="h-3.5 w-3.5" />
                Simulator
              </button>
            )}
            {LAUNCHER_URL && (
              <a
                href={LAUNCHER_URL}
                className="inline-flex items-center rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] font-medium text-slate-600 hover:border-slate-300 hover:text-slate-900"
              >
                Back to the suite
              </a>
            )}
            <button
              type="button"
              onClick={() => void signOut()}
              className="inline-flex items-center gap-1.5 rounded-xl border border-slate-200 bg-white px-3 py-2 text-[12px] font-medium text-slate-600 hover:border-slate-300 hover:text-slate-900"
            >
              <LogOut className="h-3.5 w-3.5" />
              Sign out
            </button>
          </div>
        </div>
        {me.capabilities.dashboard && (
          <Dashboard
            data={dashboard}
            error={dashboardError}
            unansweredOnly={filters.unanswered}
            onToggleUnanswered={() => {
              if (tab === 'handled') chooseTab(defaultTab(me.tabs.filter((t) => t !== 'handled')));
              patchFilters({ unanswered: !filters.unanswered });
            }}
          />
        )}
      </header>

      {settings === 'templates' && <TemplateSettings me={me} />}
      {settings === 'assistant' && <AssistantSettings me={me} />}

      {/* WORKSPACE */}
      <div className={`${settings !== null ? 'hidden ' : ''}overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-[0_12px_40px_-16px_rgba(15,23,42,0.18)]`}>
        <div className="grid h-[calc(100dvh-2rem)] min-h-[520px] grid-cols-1 lg:h-[min(82vh,860px)] lg:grid-cols-[220px_360px_minmax(0,1fr)]">
          <Rail me={me} tab={tab} counts={page?.tabCounts ?? null} filters={filters} onTab={chooseTab} onFilters={patchFilters} />

          <section
            className={`min-h-0 min-w-0 flex-col border-r border-slate-200 ${showChatMobile ? 'hidden lg:flex' : 'flex'}`}
            aria-label="Conversations"
          >
            <ConversationList
              me={me}
              tab={tab}
              page={page}
              rows={rows}
              loading={listLoading}
              loadingMore={loadingMore}
              error={listError}
              filters={filters}
              search={search}
              selectedId={selected?.id ?? null}
              now={now}
              onSearch={setSearch}
              onFilters={patchFilters}
              onTab={chooseTab}
              onOpenFilters={() => setFiltersOpen(true)}
              onSelect={(id) => {
                setSelectedId(id);
                setShowChatMobile(true);
              }}
              onAskHandle={askHandle}
              onMore={() => void loadMore()}
            />
          </section>

          <section
            className={`min-h-0 min-w-0 flex-col bg-slate-50/40 ${showChatMobile ? 'flex' : 'hidden lg:flex'}`}
            aria-label="Conversation"
          >
            {selected ? (
              <ChatPanel
                row={selected}
                thread={thread}
                me={me}
                now={now}
                onBack={() => setShowChatMobile(false)}
                onLoadOlder={() => void loadOlder()}
                onOpenDetails={() => setDetailsOpen(true)}
                onOpenTemplates={() => setTemplatesOpen(true)}
                onAskHandle={() => askHandle(selected.id)}
                onChanged={refresh}
                inserted={inserted}
              />
            ) : (
              <EmptyState icon={MessageSquare} title="Select a conversation" subtitle="Pick one from the list to view the thread." />
            )}
          </section>
        </div>
      </div>

      {selected && (
        <DetailsDialog
          open={detailsOpen}
          onClose={() => setDetailsOpen(false)}
          row={selected}
          detail={thread.detail}
          me={me}
          now={now}
        />
      )}
      <TemplatesDialog
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        language={selected?.language ?? null}
        me={me}
        onInsert={
          selected && selected.canReply && selected.status !== 'handled' && writeMode(me) === 'live'
            ? (t) => {
                setInserted({ nonce: Date.now(), conversationId: selected.id, template: composerTemplate(t) });
                setTemplatesOpen(false);
              }
            : undefined
        }
      />
      <HandleConfirm
        open={confirmHandleId !== null}
        busy={handling}
        error={handleError}
        onCancel={() => setConfirmHandleId(null)}
        onConfirm={() => void confirmHandle()}
      />
      {me.simulator && (
        <SimulatorDialog
          open={simulatorOpen}
          onClose={() => setSimulatorOpen(false)}
          me={me}
          onChanged={refresh}
          onReloadMe={reload}
        />
      )}
      <FiltersDialog
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        me={me}
        filters={filters}
        onChange={patchFilters}
        onClear={() => setFilters((f) => ({ ...EMPTY_FILTERS, q: f.q, archiveRange: f.archiveRange, resolvedBy: f.resolvedBy }))}
      />
    </div>
  );
}
