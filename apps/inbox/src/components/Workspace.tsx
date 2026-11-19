import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import type { InboxTab } from '@oto/shared/inbox';
import { ApiError } from '@/api/client';
import { assistantApi, assistantCapabilities } from '@/api/assistant';
import { inboxApi, type ConversationList as ListPage, type ConversationRow, type Dashboard as DashboardData, type InboxMe, type Message } from '@/api/inbox';
import { useSession } from '@/auth/SessionContext';
import { AccountMenu, AppBar } from '@/components/AppBar';
import { AssistantSettings } from '@/components/AssistantSettings';
import { EmptyState } from '@/components/atoms';
import { ChatPanel, type Thread } from '@/components/ChatPanel';
import { composerTemplate, type InsertedTemplate } from '@/components/Composer';
import { HandleConfirm } from '@/components/confirms';
import { NewContactDialog } from '@/components/ContactDialogs';
import { ConversationList } from '@/components/ConversationList';
import { FiltersDialog, TemplatesDialog } from '@/components/dialogs';
import { Rail } from '@/components/Rail';
import { SimulatorBody, SimulatorDialog } from '@/components/Simulator';
import { StatsRow } from '@/components/StatsRow';
import { TemplateSettings } from '@/components/TemplateSettings';
import { inboxAccessSignature, inboxFiltersWithinAccess, inboxItemWithinAccess, inboxMeWithinAccess, inboxSourcesWithinAccess, mergeSources, sourcesOfRows, type SourceOption } from '@/lib/inboxes';
import { useInboxAccess } from '@/hooks/useInboxAccess';
import { withReadyToBook } from '@/lib/list-state';
import { EMPTY_FILTERS, listQuery, type Filters } from '@/lib/query';
import { fastInboxRefresh, startFastInboxRefresh } from '@/lib/refresh';
import { useTheme } from '@/lib/theme';
import { inboxSearch, readInboxUrl, viewFromUrl, type AssistantTab, type SettingsPage } from '@/lib/url';
import { defaultTab, landingTab, writeMode } from '@/lib/view';

const LAUNCHER_URL = import.meta.env.VITE_LAUNCHER_URL?.trim();

/** How often an open Inbox re-reads what it shows, while the tab is in view. */
const REFRESH_MS = 30_000;
const PAGE = 50;
const PAGE_MAX = 100;

const EMPTY_THREAD: Thread = { detail: null, messages: [], olderCursor: null, loading: false, loadingOlder: false, error: null };

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * The list and the chat stand side by side from 768 px (tablet and desktop,
 * SCRUM-1016); below that a phone shows one of them, the prototype's
 * `showChatMobile` (:1047). An open chat counts as on screen only when it is.
 */
function useIsSideBySide(): boolean {
  const query = '(min-width: 768px)';
  const [wide, setWide] = useState(() => window.matchMedia(query).matches);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const on = () => setWide(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return wide;
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
 * The Inbox page (SCRUM-1016): the compact app bar, then the work filling the
 * rest of the screen — on a phone the list or the chat; from 768 px the list
 * and the chat side by side; from 1024 px the views column beside them; from
 * 1280 px a region for the customer and the next step. The page itself never
 * scrolls: only the list, the thread and a settings page do. The prototype's
 * three columns (WhatsAppDemo.tsx :1300-1673) are the parts, every figure and
 * line from the platform api. The prototype's own state — its role
 * switcher, phone preview, availability toggles and in-memory conversations —
 * is gone: the viewer is the signed-in account (`GET /inbox/me`).
 */
export function Workspace({ me }: { me: InboxMe }) {
  const { signOut, reload } = useSession();
  const { theme, setTheme } = useTheme();
  const sideBySide = useIsSideBySide();
  const [now, setNow] = useState(() => new Date());

  // The URL's view (P2, `lib/url.ts`), read once as the workspace opens: a
  // link names a tab, the unanswered queue, one conversation, a settings page
  // or the archive's filters.
  const homeTab = defaultTab(me.tabs);
  const assistantCaps = assistantCapabilities(me);
  const [arrival] = useState(() =>
    viewFromUrl(window.location.search, me.tabs, homeTab, {
      templates: me.capabilities.templates,
      assistant: assistantCaps.kb || assistantCaps.ai,
    }),
  );

  // A plain landing (test night 2026-10-21, U8): an agent opens on My Inbox
  // when they hold a thread, else Team. The list's first page says whether
  // they hold one (`tabCounts.mine`), so the tab starts on My Inbox and
  // falls back to Team if that count comes back empty (`landingTab`).
  const landing = useRef(arrival.plain && me.tabs.includes('mine'));
  const [tab, setTab] = useState<InboxTab>(landing.current ? 'mine' : arrival.tab);
  const [filters, setFilters] = useState<Filters>(() => ({
    ...EMPTY_FILTERS,
    unanswered: arrival.unanswered,
    archiveRange: arrival.archiveRange ?? EMPTY_FILTERS.archiveRange,
    resolvedBy: arrival.resolvedBy ?? EMPTY_FILTERS.resolvedBy,
  }));
  const [search, setSearch] = useState('');

  const [page, setPage] = useState<ListPage | null>(null);
  const [rows, setRows] = useState<ConversationRow[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(arrival.selectedId);
  const [showChatMobile, setShowChatMobile] = useState(arrival.showChat);
  const [thread, setThread] = useState<Thread>(EMPTY_THREAD);
  /**
   * A linked conversation that is not on the list's page — another tab, an
   * older one — read on its own so the link still opens it (P2).
   */
  const [pinned, setPinned] = useState<ConversationRow | null>(null);

  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  const [detailsOpen, setDetailsOpen] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [simulatorOpen, setSimulatorOpen] = useState(false);
  /** SCRUM-860: the "New contact" dialog, offered when the api lists a channel to put one on. */
  const [newContactOpen, setNewContactOpen] = useState(false);
  // Temporary testing aid (Tom, 2026-10-28): the simulator pinned beside the
  // inbox so a test message is one click away. Per-browser convenience only.
  const [simPane, setSimPane] = useState(() => {
    try { return localStorage.getItem('oto.simPane') !== '0'; } catch { return true; }
  });
  const toggleSimPane = (next: boolean) => {
    setSimPane(next);
    try { localStorage.setItem('oto.simPane', next ? '1' : '0'); } catch { /* per-browser only */ }
  };
  /** The settings page in place of the workspace card: templates (I3b) or the assistant (SCRUM-590 A3); in the URL as `?settings=` (U11). */
  const [settings, setSettings] = useState<SettingsPage | null>(arrival.settings);
  /** The assistant page's tab; null is its default, the first the viewer may see (F2). */
  const [assistantTab, setAssistantTab] = useState<AssistantTab | null>(arrival.assistantTab);
  const [inserted, setInserted] = useState<InsertedTemplate | null>(null);

  // "Mark as handled for everyone?", from the chat or a list row.
  const [confirmHandleId, setConfirmHandleId] = useState<string | null>(null);
  const [handling, setHandling] = useState(false);
  const [handleError, setHandleError] = useState<string | null>(null);

  const patchFilters = useCallback((next: Partial<Filters>) => setFilters((f) => ({ ...f, ...next })), []);

  // The numbers the Source chips offer (SCRUM-220 playbook): every number the
  // viewer may switch the assistant on (`GET /inbox/ai/channel-accounts`, read
  // once, only with inbox:ai:manage — it refuses everyone else), the
  // simulator's numbers where it runs, and every number a page of the list
  // names. Learned as the list is read: no call of its own, no polling.
  const [sources, setSources] = useState<SourceOption[]>(() =>
    mergeSources([], (me.simulator?.channelAccounts ?? []).map((a) => ({ id: a.id, channel: a.channel, name: a.displayName }))),
  );
  const currentAccess = useInboxAccess(page?.access, me.access, reload);
  const accessRef = useRef(currentAccess); accessRef.current = currentAccess;
  const learnSources = useCallback((more: SourceOption[]) => setSources((s) => inboxSourcesWithinAccess(mergeSources(s, more), accessRef.current)), []);
  const accessSignature = inboxAccessSignature(currentAccess);
  const visibleSources = inboxSourcesWithinAccess(sources, currentAccess);
  const currentMe = inboxMeWithinAccess(me, currentAccess);
  useEffect(() => {
    setSources(known => inboxSourcesWithinAccess(known, currentAccess));
    setFilters(held => inboxFiltersWithinAccess(held, currentAccess));
    setRows(held => held.filter(row => inboxItemWithinAccess(row, currentAccess)));
    setPinned(held => held && !inboxItemWithinAccess(held, currentAccess) ? null : held);
    if (thread.detail && !inboxItemWithinAccess(thread.detail, currentAccess)) {
      threadSeq.current++;
      setThread(EMPTY_THREAD); setSelectedId(null); setShowChatMobile(false);
      setDetailsOpen(false); setTemplatesOpen(false);
    }
    setDashboard(null);
    // Policy contents are normalized in the signature; object identity alone
    // must not clear/reload the workspace on every poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessSignature]);
  useEffect(() => {
    if (!me.capabilities.ai) return;
    let cancelled = false;
    assistantApi
      .channelAccounts()
      .then((r) => {
        if (!cancelled) learnSources(r.channelAccounts.map((a) => ({ id: a.id, channel: a.channel, name: a.displayName })));
      })
      .catch(() => {
        // The chips are a convenience: without the list, the rows still name their numbers.
      });
    return () => {
      cancelled = true;
    };
  }, [me.capabilities.ai, learnSources]);

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
      const accessAtRequest = accessSignature;
      if (!opts.refresh) setListLoading(true);
      try {
        const next = await inboxApi.conversations(listQuery(tab, filters, { limit: opts.limit ?? PAGE }));
        if (seq !== listSeq.current || accessAtRequest !== inboxAccessSignature(accessRef.current)) return;
        setPage(next);
        // SCRUM-996: the "Ready to book" group rides on the first page, also
        // for a paid chat further down the list than this page reaches.
        const listed = withReadyToBook(next.readyToBook, next.conversations);
        setRows(listed);
        learnSources(sourcesOfRows(listed));
        setListError(null);
        // The landing's one decision, off the first page's counts (U8).
        if (landing.current) {
          landing.current = false;
          const home = landingTab(me.tabs, next.tabCounts.mine);
          if (home !== tab) setTab(home);
        }
      } catch (err) {
        if (seq === listSeq.current) setListError(message(err, 'The conversations could not be read.'));
      } finally {
        if (seq === listSeq.current) setListLoading(false);
      }
    },
    [tab, filters, me.tabs, learnSources, accessSignature],
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
      learnSources(sourcesOfRows(next.conversations));
      setPage(next);
    } catch (err) {
      setListError(message(err, 'More conversations could not be read.'));
    } finally {
      setLoadingMore(false);
    }
  }, [page, loadingMore, tab, filters, learnSources]);

  // --- The dashboard ---------------------------------------------------------------
  const dashboardSeq = useRef(0);
  const loadDashboard = useCallback(async () => {
    if (!me.capabilities.dashboard) return;
    const seq = ++dashboardSeq.current, accessAtRequest = accessSignature;
    try {
      const next = await inboxApi.dashboard();
      if (seq !== dashboardSeq.current || accessAtRequest !== inboxAccessSignature(accessRef.current)) return;
      setDashboard(next);
      setDashboardError(null);
    } catch (err) {
      if (seq !== dashboardSeq.current || accessAtRequest !== inboxAccessSignature(accessRef.current)) return;
      setDashboardError(message(err, 'The dashboard could not be read.'));
    }
  }, [me.capabilities.dashboard, accessSignature]);
  useEffect(() => void loadDashboard(), [loadDashboard]);

  // --- The open conversation -------------------------------------------------------
  // Only a conversation the person chose, or linked to, is open: the prototype
  // opened the list's first row by itself (:1099-1100), which read someone
  // else's thread and cleared its unread badge (test night 2026-10-21, U8).
  // A tab or filter that drops the open conversation leaves the pane empty.
  const pinnedRow = pinned && thread.detail?.id === pinned.id ? thread.detail : pinned;
  const selected = rows.find((c) => c.id === selectedId) ?? (pinnedRow && pinnedRow.id === selectedId ? pinnedRow : null);
  const selectedKey = selected?.id ?? null;
  const visible = selected !== null && (sideBySide || showChatMobile);

  const threadSeq = useRef(0);
  const loadThread = useCallback(async (id: string, refresh: boolean) => {
    const seq = ++threadSeq.current;
    if (!refresh) setThread({ ...EMPTY_THREAD, loading: true });
    try {
      const [detail, newest] = await Promise.all([inboxApi.conversation(id), inboxApi.messages(id)]);
      if (seq !== threadSeq.current) return;
      if (!inboxItemWithinAccess(detail, accessRef.current)) return;
      setThread((t) => {
        const merged =
          refresh && t.detail?.id === id
            ? mergeNewest(t.messages, newest.messages, t.olderCursor, newest.olderCursor)
            : { messages: newest.messages, olderCursor: newest.olderCursor };
        return { ...t, detail, ...merged, loading: false, error: null };
      });
    } catch (err) {
      if (seq === threadSeq.current) {
        if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
          setThread({ ...EMPTY_THREAD, error: message(err, 'This conversation could not be read.') });
          setPinned(row => row?.id === id ? null : row);
          setRows(held => held.filter(row => row.id !== id));
          setSelectedId(held => held === id ? null : held);
        } else setThread((t) => ({ ...t, loading: false, error: message(err, 'This conversation could not be read.') }));
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
    const seq = threadSeq.current;
    setThread((t) => ({ ...t, loadingOlder: true }));
    try {
      const older = await inboxApi.messages(id, before);
      if (seq !== threadSeq.current) return;
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
      if (seq !== threadSeq.current) return;
      if (err instanceof ApiError && (err.status === 403 || err.status === 404)) {
        threadSeq.current++; setThread(EMPTY_THREAD); setPinned(row => row?.id === id ? null : row);
        setRows(held => held.filter(row => row.id !== id)); setSelectedId(held => held === id ? null : held);
      } else setThread((t) => ({ ...t, loadingOlder: false, error: message(err, 'Earlier messages could not be read.') }));
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

  // Test replies arrive without switching chats: one fast timer for the
  // simulator, the selected test-line inbox (even empty), or its open chat.
  const fastRefresh = fastInboxRefresh(me, simPane, filters.channelAccountId, selected?.channelAccountId);
  useEffect(() => {
    return startFastInboxRefresh(fastRefresh, () => document.visibilityState === 'visible', () => {
      if (selectedKey) void loadThread(selectedKey, true);
      void loadList({ refresh: true, limit: Math.min(PAGE_MAX, Math.max(PAGE, rowCount)) });
    });
  }, [fastRefresh, selectedKey, loadThread, loadList, rowCount]);

  // After a write: the list, the dashboard and the open thread, read again.
  const refresh = useCallback(async () => {
    await Promise.all([
      loadList({ refresh: true, limit: Math.min(PAGE_MAX, Math.max(PAGE, rowCount)) }),
      loadDashboard(),
      selectedKey ? loadThread(selectedKey, true) : Promise.resolve(),
    ]);
  }, [loadList, loadDashboard, loadThread, selectedKey, rowCount]);

  // --- The address (P2) -------------------------------------------------------------
  // A linked conversation is read on its own; one the viewer cannot see, or
  // that is not there, drops back to the list — the api's refusal is the only
  // check that matters, and it is the same one the list makes.
  const latest = useRef({ rows, selectedId });
  useEffect(() => {
    latest.current = { rows, selectedId };
  }, [rows, selectedId]);
  const pinSeq = useRef(0);
  const pin = useCallback(async (id: string) => {
    const seq = ++pinSeq.current;
    try {
      const detail = await inboxApi.conversation(id);
      if (seq === pinSeq.current && inboxItemWithinAccess(detail, accessRef.current)) setPinned(detail);
    } catch {
      if (seq !== pinSeq.current || latest.current.selectedId !== id) return;
      setSelectedId(null);
      setShowChatMobile(false);
    }
  }, []);
  useEffect(() => {
    if (arrival.selectedId) void pin(arrival.selectedId);
  }, [arrival.selectedId, pin]);

  // State into the address. A chosen conversation, tab or settings page is a
  // new history entry (so Back returns to the list); everything else replaces
  // the current one.
  const historyMode = useRef<'push' | 'replace'>('replace');
  useEffect(() => {
    const next =
      window.location.pathname +
      inboxSearch(
        {
          tab,
          unanswered: filters.unanswered,
          selectedId,
          settings,
          assistantTab,
          archiveRange: filters.archiveRange,
          resolvedBy: filters.resolvedBy,
        },
        homeTab,
      );
    const mode = historyMode.current;
    historyMode.current = 'replace';
    if (next === window.location.pathname + window.location.search) return;
    if (mode === 'push') window.history.pushState({ otoInbox: true }, '', next);
    else window.history.replaceState(window.history.state, '', next);
  }, [tab, filters.unanswered, filters.archiveRange, filters.resolvedBy, selectedId, settings, assistantTab, homeTab]);

  // Back and forward: the address into state.
  const allowTemplates = me.capabilities.templates;
  const allowAssistant = assistantCaps.kb || assistantCaps.ai;
  useEffect(() => {
    const onPop = () => {
      const view = viewFromUrl(window.location.search, me.tabs, homeTab, { templates: allowTemplates, assistant: allowAssistant });
      setTab(view.tab);
      setFilters((f) => {
        const archiveRange = view.archiveRange ?? f.archiveRange;
        const resolvedBy = view.resolvedBy ?? f.resolvedBy;
        if (f.unanswered === view.unanswered && f.archiveRange === archiveRange && f.resolvedBy === resolvedBy) return f;
        return { ...f, unanswered: view.unanswered, archiveRange, resolvedBy };
      });
      setSelectedId(view.selectedId);
      setShowChatMobile(view.showChat);
      setSettings(view.settings);
      setAssistantTab(view.assistantTab);
      if (view.selectedId && !latest.current.rows.some((c) => c.id === view.selectedId)) void pin(view.selectedId);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [me.tabs, homeTab, pin, allowTemplates, allowAssistant]);

  // A settings page in place of the workspace, and the way back (U11).
  const chooseSettings = (page: SettingsPage | null) => {
    historyMode.current = 'push';
    setSettings((v) => (v === page ? null : page));
    // A page freshly opened, or left, starts over on its default tab.
    setAssistantTab(null);
  };

  const select = (id: string) => {
    if (id !== selectedId) historyMode.current = 'push';
    setSelectedId(id);
    setShowChatMobile(true);
  };

  /** SCRUM-860: open a conversation that may not be on the list's page (a contact just made, a duplicate's thread). */
  const openConversation = (id: string) => {
    select(id);
    if (!latest.current.rows.some((c) => c.id === id)) void pin(id);
  };

  // The phone's back arrow: when the thread was opened from the list, it is
  // the browser's Back, so the two never disagree about where "back" is.
  const closeChat = () => {
    if ((window.history.state as { otoInbox?: boolean } | null)?.otoInbox && readInboxUrl(window.location.search).conversationId) {
      window.history.back();
      return;
    }
    setSelectedId(null);
    setShowChatMobile(false);
  };

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
    if (t !== tab) historyMode.current = 'push';
    setTab(t);
    // A new tab is a new list: nothing open until a row is chosen.
    setSelectedId(null);
    setShowChatMobile(false);
  };

  // The "Needs reply" figure's toggle (the prototype's Unanswered card,
  // :1367-1375): the list's one unanswered control (SCRUM-1016). From the
  // archive it brings the open list back, as the card did.
  const toggleUnanswered = () => {
    if (tab === 'handled') chooseTab(defaultTab(me.tabs.filter((t) => t !== 'handled')));
    patchFilters({ unanswered: !filters.unanswered });
  };

  const stats = (variant: 'bar' | 'card') => (
    <StatsRow
      variant={variant}
      data={dashboard}
      error={dashboardError}
      figures={me.capabilities.dashboard}
      unansweredOnly={filters.unanswered}
      onToggleUnanswered={toggleUnanswered}
    />
  );

  // A chat open on a phone is its own full screen (Chat.dc.html): its header
  // has the way back, so the app bar steps aside below 768 px.
  const phoneChat = showChatMobile && selected !== null;
  // The region for the customer and the next step (Desktop.dc.html), reserved
  // from 1280 px while a chat is open; the simulator panel takes that width,
  // so beside it the region waits for a wider screen.
  const simulatorShown = Boolean(currentMe.simulator) && simPane;
  const customerPanel = selected !== null;
  const columns = !customerPanel
    ? 'lg:grid-cols-[216px_minmax(300px,360px)_minmax(0,1fr)]'
    : simulatorShown
      ? 'lg:grid-cols-[216px_minmax(300px,360px)_minmax(0,1fr)] min-[1760px]:grid-cols-[216px_360px_minmax(0,1fr)_300px]'
      : 'lg:grid-cols-[216px_minmax(300px,360px)_minmax(0,1fr)] xl:grid-cols-[216px_360px_minmax(0,1fr)_300px]';

  return (
    <div className="flex h-[100dvh] overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className={phoneChat ? 'hidden md:block' : undefined}>
          <AppBar
            search={search}
            onSearch={setSearch}
            onNewContact={currentMe.contactChannels && currentMe.contactChannels.length > 0 ? () => setNewContactOpen(true) : undefined}
            account={
              <AccountMenu
                me={currentMe}
                theme={theme}
                onTheme={setTheme}
                settings={settings}
                onSettings={(key) => (key === 'simulator' ? setSimulatorOpen(true) : chooseSettings(key))}
                showSimulator={!simPane}
                onShowSimulator={() => toggleSimPane(true)}
                launcherUrl={LAUNCHER_URL || undefined}
                onSignOut={() => void signOut()}
              />
            }
          >
            {stats('bar')}
          </AppBar>
        </div>

        {settings !== null && (
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto max-w-[1400px] px-4 py-5 sm:px-6">
              {settings === 'templates' && <TemplateSettings me={currentMe} onBack={() => chooseSettings(null)} />}
              {settings === 'assistant' && (
                <AssistantSettings key={accessSignature} me={currentMe} tab={assistantTab} onBack={() => chooseSettings(null)} onTab={setAssistantTab} />
              )}
            </div>
          </div>
        )}

        {/* The work: kept mounted under a settings page, as the card was. */}
        <main
          className={`${settings !== null ? 'hidden ' : ''}grid min-h-0 flex-1 grid-cols-1 overflow-hidden md:grid-cols-[minmax(300px,360px)_minmax(0,1fr)] ${columns}`}
        >
          <Rail
            me={currentMe}
            tab={tab}
            counts={page?.tabCounts ?? null}
            filters={filters}
            sources={visibleSources}
            onTab={chooseTab}
            onFilters={patchFilters}
          />

          <section
            className={`min-h-0 min-w-0 flex-col border-line md:border-r ${showChatMobile ? 'hidden md:flex' : 'flex'}`}
            aria-label="Conversations"
          >
            <ConversationList
              me={currentMe}
              tab={tab}
              strip={stats('card')}
              page={page}
              rows={rows}
              loading={listLoading}
              loadingMore={loadingMore}
              error={listError}
              filters={filters}
              selectedId={selected?.id ?? null}
              now={now}
              sources={visibleSources}
              onFilters={patchFilters}
              onTab={chooseTab}
              onOpenFilters={() => setFiltersOpen(true)}
              onSelect={select}
              onAskHandle={askHandle}
              onMore={() => void loadMore()}
            />
          </section>

          <section
            className={`min-h-0 min-w-0 flex-col bg-ground ${showChatMobile ? 'flex' : 'hidden md:flex'}`}
            aria-label="Conversation"
          >
            {selected ? (
              <ChatPanel
                row={selected}
                thread={thread}
                me={currentMe}
                now={now}
                detailsOpen={detailsOpen}
                onBack={closeChat}
                onLoadOlder={() => void loadOlder()}
                onOpenDetails={() => setDetailsOpen(true)}
                onCloseDetails={() => setDetailsOpen(false)}
                onOpenTemplates={() => setTemplatesOpen(true)}
                onAskHandle={() => askHandle(selected.id)}
                onChanged={refresh}
                inserted={inserted}
              />
            ) : (
              <EmptyState icon={MessageSquare} title="Pick a conversation" subtitle="Choose one from the list to read it." />
            )}
          </section>

          {customerPanel && (
            <aside
              aria-label="About this conversation"
              data-region="customer-panel"
              className={`hidden min-h-0 overflow-y-auto border-l border-line ${simulatorShown ? 'min-[1760px]:block' : 'xl:block'}`}
            />
          )}
        </main>
      </div>

      <TemplatesDialog
        open={templatesOpen}
        onClose={() => setTemplatesOpen(false)}
        language={selected?.language ?? null}
        me={currentMe}
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
      {currentMe.contactChannels && currentMe.contactChannels.length > 0 && (
        <NewContactDialog
          key={accessSignature}
          open={newContactOpen}
          onClose={() => setNewContactOpen(false)}
          channels={currentMe.contactChannels}
          onCreated={async (r) => {
            await refresh();
            if (r.visible) openConversation(r.conversationId);
          }}
          onOpen={openConversation}
        />
      )}
      {currentMe.simulator && (
        <SimulatorDialog
          key={accessSignature}
          open={simulatorOpen}
          onClose={() => setSimulatorOpen(false)}
          me={currentMe}
          onChanged={refresh}
          onReloadMe={reload}
        />
      )}
      <FiltersDialog
        open={filtersOpen}
        onClose={() => setFiltersOpen(false)}
        me={currentMe}
        filters={filters}
        sources={visibleSources}
        onChange={patchFilters}
        onClear={() => setFilters((f) => ({ ...EMPTY_FILTERS, q: f.q, archiveRange: f.archiveRange, resolvedBy: f.resolvedBy }))}
      />

      {simulatorShown && (
        <aside className="hidden w-[420px] shrink-0 overflow-y-auto border-l border-line bg-card p-4 xl:block">
          <div className="mb-3 flex items-center justify-between gap-3">
            <div>
              <div className="text-[13px] font-bold text-ink">Simulator · test only</div>
              <div className="text-[11.5px] text-ink-muted">Temporary side panel for testing. Nothing reaches a real customer.</div>
            </div>
            <button
              type="button"
              onClick={() => toggleSimPane(false)}
              className="min-h-11 shrink-0 rounded-full border border-field px-4 text-[13px] font-semibold text-ink-soft hover:bg-wash"
            >
              Hide
            </button>
          </div>
          <SimulatorBody key={accessSignature} me={currentMe} onChanged={refresh} onReloadMe={reload} />
        </aside>
      )}
    </div>
  );
}
