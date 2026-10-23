import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

type Tab = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  active: boolean;
  zoom: number;
};

type BrowserSnapshot = { tabs: Tab[]; activeTabId: string };
type Bookmark = { id: string; title: string; url: string };
type HistoryEntry = { url: string; title: string; visitedAt: number };
type Download = { id: string; url: string; filename: string; path: string; status: 'downloading' | 'completed' | 'failed'; bytesReceived: number };
type Theme = 'system' | 'light' | 'dark';
type SessionTestPhase = 'exercise' | 'restore';
const tabEvent = 'browser://tabs-changed';
const settingsEvent = 'browser://open-settings';
const shortcutEvent = 'browser://shortcut';
const historyEvent = 'browser://history-changed';
const downloadsEvent = 'browser://downloads-changed';
const sidebarDefaultWidth = 224;
const sidebarMinWidth = 176;
const sidebarMaxWidth = 360;
const sessionTestUrls = [
  'http://127.0.0.1:4179/index.html?session=first',
  'http://127.0.0.1:4179/index.html?session=second',
];

function assertSessionTestState(snapshot: BrowserSnapshot, expectedUrls: string[], activeUrl: string) {
  const actualUrls = snapshot.tabs.map(tab => tab.url);
  if (JSON.stringify(actualUrls) !== JSON.stringify(expectedUrls)) {
    throw new Error(`Expected tab order ${JSON.stringify(expectedUrls)}, got ${JSON.stringify(actualUrls)}`);
  }
  const active = snapshot.tabs.find(tab => tab.id === snapshot.activeTabId);
  if (!active || active.url !== activeUrl) {
    throw new Error(`Expected active tab ${activeUrl}, got ${active?.url ?? 'none'}`);
  }
}

function initialSidebarWidth() {
  const saved = Number(localStorage.getItem('browser.sidebarWidth'));
  return Number.isFinite(saved) && saved >= sidebarMinWidth && saved <= sidebarMaxWidth
    ? saved
    : sidebarDefaultWidth;
}

function initialSidebarCollapsed() {
  return localStorage.getItem('browser.sidebarCollapsed') === 'true';
}

function initialBookmarks(): Bookmark[] {
  try {
    const saved = JSON.parse(localStorage.getItem('browser.bookmarks') ?? '[]');
    return Array.isArray(saved) ? saved.filter(item => item && typeof item.title === 'string' && typeof item.url === 'string') : [];
  } catch { return []; }
}

function initialTheme(): Theme {
  const saved = localStorage.getItem('browser.theme');
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [address, setAddress] = useState('');
  const [message, setMessage] = useState('');
  const [isTauri, setIsTauri] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [sidebarView, setSidebarView] = useState<'tabs' | 'bookmarks' | 'history' | 'downloads'>('tabs');
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(initialBookmarks);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findResult, setFindResult] = useState<boolean | null>(null);
  const [bookmarkSearch, setBookmarkSearch] = useState('');
  const [bookmarkTitle, setBookmarkTitle] = useState('');
  const [bookmarkUrl, setBookmarkUrl] = useState('');
  const [editingBookmarkId, setEditingBookmarkId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const addressRef = useRef<HTMLInputElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const activeTabIdRef = useRef(activeTabId);
  const sessionTestStarted = useRef(false);
  const activeTab = tabs.find(tab => tab.id === activeTabId);

  useEffect(() => {
    localStorage.setItem('browser.sidebarWidth', String(sidebarWidth));
  }, [sidebarWidth]);

  useEffect(() => {
    localStorage.setItem('browser.sidebarCollapsed', String(sidebarCollapsed));
  }, [sidebarCollapsed]);

  useEffect(() => {
    localStorage.setItem('browser.bookmarks', JSON.stringify(bookmarks));
  }, [bookmarks]);

  useEffect(() => {
    localStorage.setItem('browser.theme', theme);
    const preference = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'system' ? (preference.matches ? 'light' : 'dark') : theme;
    };
    apply();
    preference.addEventListener('change', apply);
    return () => preference.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    if (!resizingSidebar) return;
    const resize = (event: PointerEvent) => {
      const width = Math.max(sidebarMinWidth, Math.min(sidebarMaxWidth, event.clientX));
      setSidebarWidth(width);
      localStorage.setItem('browser.sidebarWidth', String(width));
    };
    const stop = () => setResizingSidebar(false);
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stop, { once: true });
    return () => {
      window.removeEventListener('pointermove', resize);
      window.removeEventListener('pointerup', stop);
    };
  }, [resizingSidebar]);

  const applySnapshot = useCallback((snapshot: BrowserSnapshot) => {
    setTabs(snapshot.tabs);
    setActiveTabId(snapshot.activeTabId);
    activeTabIdRef.current = snapshot.activeTabId;
    const active = snapshot.tabs.find(tab => tab.id === snapshot.activeTabId);
    setAddress(active?.url ?? '');
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const available = Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
      setIsTauri(available);
      if (!available) return;
      unlisten = await listen<BrowserSnapshot>(tabEvent, event => applySnapshot(event.payload));
      const unlistenSettings = await listen(settingsEvent, () => { setSettingsOpen(true); void invoke('set_settings_open', { open: true }); });
      const unlistenHistory = await listen<HistoryEntry[]>(historyEvent, event => setHistory(event.payload));
      const unlistenDownloads = await listen<Download[]>(downloadsEvent, event => setDownloads(event.payload));
      const unlistenShortcuts = await listen<string>(shortcutEvent, event => {
        switch (event.payload) {
          case 'new-tab': void createTab(); break;
          case 'close-tab': if (activeTabIdRef.current) void closeTab(activeTabIdRef.current); break;
          case 'reopen-closed-tab': void reopenClosedTab(); break;
          case 'focus-address': addressRef.current?.focus(); addressRef.current?.select(); break;
          case 'reload': void runNavigationCommand('reload'); break;
          case 'go-back': void runNavigationCommand('go_back'); break;
          case 'go-forward': void runNavigationCommand('go_forward'); break;
          case 'find': setFindOpen(true); window.setTimeout(() => findRef.current?.focus(), 0); break;
          case 'next-tab': void invoke<BrowserSnapshot>('cycle_tab', { backwards: false }).then(applySnapshot).catch(error => setMessage(String(error))); break;
          case 'previous-tab': void invoke<BrowserSnapshot>('cycle_tab', { backwards: true }).then(applySnapshot).catch(error => setMessage(String(error))); break;
        }
      });
      try {
        applySnapshot(await invoke<BrowserSnapshot>('get_browser_state'));
        setHistory(await invoke<HistoryEntry[]>('get_history'));
        setDownloads(await invoke<Download[]>('get_downloads'));
      }
      catch (error) { setMessage(String(error)); }
      if (!cancelled) void runSessionIntegrationTest();
      if (cancelled) { unlisten(); unlistenSettings(); unlistenShortcuts(); unlistenHistory(); unlistenDownloads(); }
      else {
        const originalUnlisten = unlisten;
        unlisten = () => { originalUnlisten(); unlistenSettings(); unlistenShortcuts(); unlistenHistory(); unlistenDownloads(); };
      }
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, [applySnapshot]);

  async function runSessionIntegrationTest() {
    if (sessionTestStarted.current) return;
    sessionTestStarted.current = true;
    let snapshot: BrowserSnapshot | undefined;
    try {
      const phase = await invoke<SessionTestPhase>('session_test_phase');
      if (phase !== 'exercise' && phase !== 'restore') return;
      snapshot = await invoke<BrowserSnapshot>('get_browser_state');
      if (phase === 'exercise') {
        assertSessionTestState(snapshot, sessionTestUrls, sessionTestUrls[1]);
        const survivor = await invoke<BrowserSnapshot>('close_tab', { tabId: snapshot.activeTabId });
        assertSessionTestState(survivor, [sessionTestUrls[0]], sessionTestUrls[0]);
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 't',
          metaKey: true,
          shiftKey: true,
          bubbles: true,
        }));
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await new Promise(resolve => window.setTimeout(resolve, 100));
          snapshot = await invoke<BrowserSnapshot>('get_browser_state');
          if (snapshot.tabs.length === 2 && snapshot.activeTabId !== survivor.activeTabId) break;
        }
        assertSessionTestState(snapshot, sessionTestUrls, sessionTestUrls[1]);
        const reopened = snapshot.tabs.find(tab => tab.id === snapshot?.activeTabId);
        if (reopened?.zoom !== 1.5) throw new Error(`Expected reopened tab zoom 1.5, got ${reopened?.zoom}`);
        if (!await invoke<boolean>('find_in_page', { tabId: snapshot.activeTabId, query: 'Native find marker', backwards: false })) {
          throw new Error('Native find failed to locate text in the WKWebView');
        }
        if (await invoke<boolean>('find_in_page', { tabId: snapshot.activeTabId, query: 'missing integration phrase', backwards: false })) {
          throw new Error('Native find reported a match for missing text');
        }
        const linkHook = await invoke<string>('session_test_open_new_tab');
        const parsedLinkHook: unknown = JSON.parse(linkHook);
        const hookState: { hook: boolean; tauri: string; result: string } = typeof parsedLinkHook === 'string'
          ? JSON.parse(parsedLinkHook)
          : parsedLinkHook as { hook: boolean; tauri: string; result: string };
        if (!hookState.hook || hookState.tauri !== 'function' || hookState.result !== 'opened') {
          throw new Error(`The native page link handler failed: ${linkHook}`);
        }
        for (let attempt = 0; attempt < 50; attempt += 1) {
          await new Promise(resolve => window.setTimeout(resolve, 100));
          snapshot = await invoke<BrowserSnapshot>('get_browser_state');
          if (snapshot.tabs.some(tab => tab.url.includes('session=from-link'))) break;
        }
        if (!snapshot.tabs.some(tab => tab.url === 'http://127.0.0.1:4179/index.html?session=from-link')) {
          throw new Error('A target=_blank link did not open in a new native tab');
        }
        const previousSnapshot = await invoke<BrowserSnapshot>('cycle_tab', { backwards: true });
        snapshot = previousSnapshot;
        if (previousSnapshot.tabs.find(tab => tab.id === previousSnapshot.activeTabId)?.url !== sessionTestUrls[1]) {
          throw new Error('Previous-tab cycling did not select the prior tab');
        }
        const nextSnapshot = await invoke<BrowserSnapshot>('cycle_tab', { backwards: false });
        snapshot = nextSnapshot;
        if (nextSnapshot.tabs.find(tab => tab.id === nextSnapshot.activeTabId)?.url !== 'http://127.0.0.1:4179/index.html?session=from-link') {
          throw new Error('Next-tab cycling did not wrap to the link tab');
        }
        const history = await invoke<HistoryEntry[]>('get_history');
        if (!history.some(item => item.url.includes('session=from-link'))) throw new Error('Visited link tab was not added to history');
        snapshot = await invoke<BrowserSnapshot>('close_tab', { tabId: snapshot.activeTabId });
        await invoke('session_test_start_download');
        let downloads: Download[] = [];
        for (let attempt = 0; attempt < 100; attempt += 1) {
          await new Promise(resolve => window.setTimeout(resolve, 100));
          downloads = await invoke<Download[]>('get_downloads');
          if (downloads.some(item => item.status === 'completed')) break;
        }
        const completed = downloads.find(item => item.filename === 'download.txt' && item.status === 'completed');
        if (!completed || completed.bytesReceived === 0) throw new Error(`Native download failed or had no bytes: ${JSON.stringify(downloads)}`);
        await invoke('reveal_download', { downloadId: completed.id });
      } else {
        assertSessionTestState(snapshot, sessionTestUrls, sessionTestUrls[1]);
        if (snapshot.tabs[0]?.zoom !== 1.25 || snapshot.tabs[1]?.zoom !== 1.5) {
          throw new Error('Restored tabs did not preserve their zoom values');
        }
        const history = await invoke<HistoryEntry[]>('get_history');
        if (!history.some(item => item.url.includes('session=from-link'))) throw new Error('History did not persist across app restart');
      }
      await invoke('report_session_test', {
        success: true,
        details: `${phase} phase passed`,
        snapshot,
      });
    } catch (error) {
      if (!snapshot) return;
      await invoke('report_session_test', {
        success: false,
        details: String(error),
        snapshot,
      }).catch(() => undefined);
    }
  }

  useEffect(() => {
    if (!isTauri || !viewRef.current) return;
    const view = viewRef.current;
    const updateBounds = () => {
      const rect = view.getBoundingClientRect();
      void invoke('set_view_bounds', { x: rect.left, y: rect.top, width: rect.width, height: rect.height })
        .catch(error => setMessage(String(error)));
    };
    const observer = new ResizeObserver(updateBounds);
    observer.observe(view);
    updateBounds();
    window.addEventListener('resize', updateBounds);
    return () => { observer.disconnect(); window.removeEventListener('resize', updateBounds); };
  }, [isTauri]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' && event.target instanceof HTMLElement && event.target.dataset.sidebarSizer) {
        event.preventDefault();
        setSidebarWidth(width => Math.max(sidebarMinWidth, width - 12));
      }
      if (event.key === 'ArrowRight' && event.target instanceof HTMLElement && event.target.dataset.sidebarSizer) {
        event.preventDefault();
        setSidebarWidth(width => Math.min(sidebarMaxWidth, width + 12));
      }
      if (event.key === 'Escape' && findOpen) { setFindOpen(false); setFindQuery(''); setFindResult(null); return; }
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'f') { event.preventDefault(); setFindOpen(true); window.setTimeout(() => findRef.current?.focus(), 0); }
      if (key === 'l') { event.preventDefault(); addressRef.current?.focus(); addressRef.current?.select(); }
      if (key === 't') { event.preventDefault(); if (event.shiftKey) void reopenClosedTab(); else void createTab(); }
      if (key === 'w' && activeTabId) { event.preventDefault(); void closeTab(activeTabId); }
      if (key === 'r' && activeTabId) { event.preventDefault(); void runNavigationCommand('reload'); }
      if (event.ctrlKey && key === 'tab') { event.preventDefault(); void invoke<BrowserSnapshot>('cycle_tab', { backwards: event.shiftKey }).then(applySnapshot).catch(error => setMessage(String(error))); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  async function findInPage(backwards = false) {
    if (!activeTabId || !findQuery.trim()) { setFindResult(null); return; }
    try { setFindResult(await invoke<boolean>('find_in_page', { tabId: activeTabId, query: findQuery, backwards })); }
    catch (error) { setMessage(String(error)); }
  }

  async function openHistoryEntry(url: string) {
    if (!activeTabId) {
      try { const snapshot = await invoke<BrowserSnapshot>('create_tab'); applySnapshot(snapshot); await invoke('navigate', { tabId: snapshot.activeTabId, url }); }
      catch (error) { setMessage(String(error)); }
    } else void navigateTo(url);
    setSidebarView('tabs');
  }

  async function createTab() {
    try { applySnapshot(await invoke<BrowserSnapshot>('create_tab')); addressRef.current?.focus(); }
    catch (error) { setMessage(String(error)); }
  }

  async function selectTab(id: string) {
    try { applySnapshot(await invoke<BrowserSnapshot>('select_tab', { tabId: id })); }
    catch (error) { setMessage(String(error)); }
  }

  async function closeTab(id: string) {
    try { applySnapshot(await invoke<BrowserSnapshot>('close_tab', { tabId: id })); }
    catch (error) { setMessage(String(error)); }
  }

  async function reopenClosedTab() {
    try { applySnapshot(await invoke<BrowserSnapshot>('reopen_closed_tab')); }
    catch (error) { setMessage(String(error)); }
  }

  async function navigate(event: React.FormEvent) {
    event.preventDefault();
    if (!activeTabId) return;
    try {
      setMessage('');
      await invoke('navigate', { tabId: activeTabId, url: address });
      addressRef.current?.blur();
    } catch (error) { setMessage(String(error)); }
  }

  async function navigateTo(url: string) {
    setAddress(url);
    if (!activeTabId) return;
    try { setMessage(''); await invoke('navigate', { tabId: activeTabId, url }); }
    catch (error) { setMessage(String(error)); }
  }

  async function runNavigationCommand(command: 'go_back' | 'go_forward' | 'reload' | 'stop_loading') {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    try { await invoke(command, { tabId }); }
    catch (error) { setMessage(String(error)); }
  }

  function saveBookmark(event: React.FormEvent) {
    event.preventDefault();
    const url = bookmarkUrl.trim();
    if (!url) return;
    if (editingBookmarkId) {
      setBookmarks(items => items.map(item => item.id === editingBookmarkId ? { ...item, title: bookmarkTitle.trim() || url, url } : item));
    } else {
      setBookmarks(items => [{ id: crypto.randomUUID(), title: bookmarkTitle.trim() || url, url }, ...items]);
    }
    setBookmarkTitle(''); setBookmarkUrl(''); setEditingBookmarkId('');
  }

  function addCurrentPage() {
    if (!activeTab?.url) return;
    setBookmarkTitle(activeTab.title || activeTab.url);
    setBookmarkUrl(activeTab.url);
    setEditingBookmarkId('');
    setSidebarView('bookmarks');
  }

  async function openBookmark(url: string) {
    if (!activeTabId) {
      try { const snapshot = await invoke<BrowserSnapshot>('create_tab'); applySnapshot(snapshot); await invoke('navigate', { tabId: snapshot.activeTabId, url }); }
      catch (error) { setMessage(String(error)); }
      return;
    }
    void navigateTo(url);
    setSidebarView('tabs');
  }

  function closeSettings() {
    setSettingsOpen(false);
    void invoke('set_settings_open', { open: false }).catch(error => setMessage(String(error)));
  }

  return (
    <main className="browser-shell">
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`} style={{ width: sidebarCollapsed ? 48 : sidebarWidth, flexBasis: sidebarCollapsed ? 48 : sidebarWidth }}>
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">◉</div>
          <span className="brand-name">My Browser</span>
          <button className="sidebar-collapse-button" type="button" aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!sidebarCollapsed} aria-controls="sidebar-content" onClick={() => setSidebarCollapsed(collapsed => !collapsed)}>{sidebarCollapsed ? '›' : '‹'}</button>
        </div>
        <div className="sidebar-content" id="sidebar-content">
        <div className="sidebar-switcher" role="tablist" aria-label="Sidebar views">
          <button role="tab" aria-selected={sidebarView === 'tabs'} className={sidebarView === 'tabs' ? 'active' : ''} onClick={() => setSidebarView('tabs')}>Tabs</button>
          <button role="tab" aria-selected={sidebarView === 'bookmarks'} className={sidebarView === 'bookmarks' ? 'active' : ''} onClick={() => setSidebarView('bookmarks')}>Bookmarks</button>
          <button role="tab" aria-selected={sidebarView === 'history'} className={sidebarView === 'history' ? 'active' : ''} onClick={() => setSidebarView('history')}>History</button>
          <button role="tab" aria-selected={sidebarView === 'downloads'} className={sidebarView === 'downloads' ? 'active' : ''} onClick={() => setSidebarView('downloads')}>Downloads</button>
        </div>
        {sidebarView === 'tabs' ? <>
        <div className="tab-list" role="tablist" aria-label="Open tabs">
          {tabs.map(tab => (
            <div className={`tab-row ${tab.id === activeTabId ? 'selected' : ''}`} key={tab.id}>
              <button className="tab-select" role="tab" aria-selected={tab.id === activeTabId} onClick={() => void selectTab(tab.id)} title={tab.url || 'New tab'}>
                <span className={`tab-favicon ${tab.loading ? 'is-loading' : ''}`}>{tab.loading ? '◌' : tab.url ? '◉' : '✳'}</span>
                <span className="tab-title">{tab.title || 'New Tab'}</span>
              </button>
              <button className="tab-close" aria-label={`Close ${tab.title || 'New Tab'}`} onClick={() => void closeTab(tab.id)}>×</button>
            </div>
          ))}
        </div>
        <button className="new-tab" onClick={() => void createTab()}><span>＋</span> New tab <kbd>⌘ T</kbd></button>
        </> : sidebarView === 'bookmarks' ? <div className="bookmark-manager">
          <input className="bookmark-search" aria-label="Search bookmarks" placeholder="Find a bookmark" value={bookmarkSearch} onChange={event => setBookmarkSearch(event.target.value)} />
          <form className="bookmark-form" onSubmit={saveBookmark}>
            <input aria-label="Bookmark title" placeholder="Name" value={bookmarkTitle} onChange={event => setBookmarkTitle(event.target.value)} />
            <input aria-label="Bookmark address" placeholder="https://example.com" value={bookmarkUrl} onChange={event => setBookmarkUrl(event.target.value)} />
            <button type="submit">{editingBookmarkId ? 'Save changes' : 'Add bookmark'}</button>
            {editingBookmarkId && <button type="button" className="cancel-edit" onClick={() => { setEditingBookmarkId(''); setBookmarkTitle(''); setBookmarkUrl(''); }}>Cancel</button>}
          </form>
          <div className="bookmark-list" aria-label="Saved bookmarks">
            {bookmarks.filter(item => `${item.title} ${item.url}`.toLowerCase().includes(bookmarkSearch.toLowerCase())).map(item => <div className="bookmark-row" key={item.id}>
              <button className="bookmark-open" onClick={() => void openBookmark(item.url)}><span className="bookmark-icon">☆</span><span><strong>{item.title}</strong><small>{item.url}</small></span></button>
              <button className="bookmark-edit" aria-label={`Edit ${item.title}`} onClick={() => { setEditingBookmarkId(item.id); setBookmarkTitle(item.title); setBookmarkUrl(item.url); }}>✎</button>
              <button className="bookmark-delete" aria-label={`Delete ${item.title}`} onClick={() => setBookmarks(items => items.filter(bookmark => bookmark.id !== item.id))}>×</button>
            </div>)}
            {bookmarks.length === 0 && <p className="bookmark-empty">Your saved pages will appear here.</p>}
          </div>
        </div> : sidebarView === 'history' ? <div className="bookmark-manager">
          <div className="bookmark-list" aria-label="Browsing history">
            {history.map((item, index) => <div className="bookmark-row" key={`${item.url}-${item.visitedAt}-${index}`}>
              <button className="bookmark-open" onClick={() => void openHistoryEntry(item.url)}><span className="bookmark-icon">◷</span><span><strong>{item.title || item.url}</strong><small>{item.url}</small></span></button>
            </div>)}
            {history.length === 0 && <p className="bookmark-empty">Pages you visit will appear here.</p>}
          </div>
        </div> : <div className="bookmark-manager">
          <div className="bookmark-list" aria-label="Downloads">
            {downloads.map(item => <div className="bookmark-row download-row" key={item.id}>
              <div className="bookmark-open"><span className="bookmark-icon">↓</span><span><strong>{item.filename}</strong><small>{item.status === 'completed' ? 'Complete' : item.status === 'failed' ? 'Failed' : `Downloading · ${item.bytesReceived.toLocaleString()} bytes`}</small>
                {item.status === 'downloading' && <progress className="download-progress" max={1} />}</span></div>
              <button className="bookmark-edit" disabled={item.status !== 'completed'} aria-label={`Reveal ${item.filename}`} onClick={() => void invoke('reveal_download', { downloadId: item.id }).catch(error => setMessage(String(error)))}>↗</button>
            </div>)}
            {downloads.length === 0 && <p className="bookmark-empty">Downloaded files will appear here.</p>}
          </div>
        </div>}
        <div className="sidebar-bottom">
          <button className="profile-button"><span className="avatar">J</span><span className="profile-copy"><strong>Personal</strong><small>Local profile</small></span><span className="profile-menu">···</span></button>
        </div>
        </div>
        <div className={`sidebar-sizer ${resizingSidebar ? 'dragging' : ''}`} role="separator" aria-label="Resize tab sidebar" aria-orientation="vertical" aria-valuemin={sidebarMinWidth} aria-valuemax={sidebarMaxWidth} aria-valuenow={Math.round(sidebarWidth)} tabIndex={0} data-sidebar-sizer onPointerDown={event => { event.preventDefault(); setResizingSidebar(true); }} onDoubleClick={() => { setSidebarWidth(sidebarDefaultWidth); localStorage.removeItem('browser.sidebarWidth'); }} />
      </aside>

      <section className="browser-main">
        <header className="toolbar">
          <div className="nav-controls" aria-label="Page navigation">
            <button className="icon-button" title="Go back" aria-label="Go back" disabled={!activeTab?.canGoBack} onClick={() => void runNavigationCommand('go_back')}>‹</button>
            <button className="icon-button" title="Go forward" aria-label="Go forward" disabled={!activeTab?.canGoForward} onClick={() => void runNavigationCommand('go_forward')}>›</button>
            <button className="icon-button reload-button" title={activeTab?.loading ? 'Stop loading' : 'Reload'} aria-label={activeTab?.loading ? 'Stop loading' : 'Reload'} onClick={() => void runNavigationCommand(activeTab?.loading ? 'stop_loading' : 'reload')}>{activeTab?.loading ? '×' : '↻'}</button>
          </div>
          <form className="address-form" onSubmit={navigate}>
            <span className="security-icon" aria-hidden="true">{activeTab?.url.startsWith('https:') ? '▣' : '◌'}</span>
            <input ref={addressRef} aria-label="Search or enter address" autoComplete="off" spellCheck={false} placeholder="Search or enter address" value={address} onChange={event => setAddress(event.target.value)} onFocus={event => event.currentTarget.select()} />
            {activeTab?.url && <button type="button" className="clear-address" title="Clear address" onClick={() => { setAddress(''); addressRef.current?.focus(); }}>×</button>}
          </form>
          {findOpen ? <form className="find-form" aria-label="Find in page" onSubmit={event => { event.preventDefault(); void findInPage(false); }}>
            <input ref={findRef} aria-label="Find in page" placeholder="Find in page" value={findQuery} onChange={event => { setFindQuery(event.target.value); setFindResult(null); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void findInPage(event.shiftKey); } }} />
            {findResult !== null && <span className="find-result" role="status">{findResult ? 'Match' : 'No match'}</span>}
            <button type="submit" title="Find next">↓</button><button type="button" title="Find previous" onClick={() => void findInPage(true)}>↑</button>
            <button type="button" title="Close find" onClick={() => { setFindOpen(false); setFindQuery(''); setFindResult(null); }}>×</button>
          </form> : <button className="toolbar-action" title="Find in page (⌘F)" aria-label="Find in page" onClick={() => { setFindOpen(true); window.setTimeout(() => findRef.current?.focus(), 0); }}>⌕</button>}
          <button className="toolbar-action" title="Bookmark this page" aria-label="Bookmark this page" disabled={!activeTab?.url} onClick={addCurrentPage}><span>☆</span></button>
          <button className="toolbar-action" title="Privacy filtering is not enabled yet" aria-label="Privacy filtering is not enabled yet" disabled><span>◈</span></button>
          <button className="toolbar-action" title="Settings" aria-label="Settings" onClick={() => { setSettingsOpen(true); void invoke('set_settings_open', { open: true }); }}>⚙</button>
        </header>

        <div className="webview-slot" ref={viewRef}>
          {settingsOpen ? <section className="settings-page" aria-label="Settings">
            <header className="settings-heading"><div><p className="eyebrow">MY BROWSER</p><h1>Settings</h1></div><button className="settings-close" onClick={closeSettings} aria-label="Close settings">×</button></header>
            <div className="settings-content">
              <h2>General</h2>
              <div className="settings-card"><div><strong>Bookmarks</strong><small>Saved locally in this browser profile.</small></div><button onClick={() => { closeSettings(); setSidebarView('bookmarks'); }}>Manage bookmarks</button></div>
              <h2>Appearance</h2>
              <div className="settings-card"><div><strong>Color scheme</strong><small>Choose the browser interface appearance.</small></div><select aria-label="Color scheme" value={theme} onChange={event => setTheme(event.target.value as Theme)}><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></div>
              <div className="settings-card"><div><strong>Sidebar width</strong><small>Resize the sidebar by dragging its right edge.</small></div><span>{Math.round(sidebarWidth)} px</span></div>
              <h2>Privacy</h2>
              <div className="settings-card"><div><strong>Content filtering</strong><small>Filtering is not enabled for normal browsing yet.</small></div><span className="settings-badge">Not enabled</span></div>
              <h2>About</h2>
              <div className="settings-card"><div><strong>My Browser</strong><small>macOS development build</small></div><span>0.1.0</span></div>
            </div>
          </section> : (!activeTab?.url || !isTauri) && <div className="start-page">
            <div className="start-orb">✳</div>
            <p className="eyebrow">A CLEARER PLACE TO BROWSE</p>
            <h1>Where to?</h1>
            <form className="start-search" onSubmit={navigate}><span>⌕</span><input aria-label="Search the web" placeholder="Search or enter a website" value={address} onChange={event => setAddress(event.target.value)} /><kbd>↵</kbd></form>
            {!isTauri && <p className="dev-note">Run the desktop app to open websites in the native browser view.</p>}
            {message && <p className="message" role="status">{message}</p>}
            <div className="quick-links"><button onClick={() => void navigateTo('https://www.google.com')}>Google</button><button onClick={() => void navigateTo('https://wikipedia.org')}>Wikipedia</button><button onClick={() => void navigateTo('https://github.com')}>GitHub</button></div>
          </div>}
          {message && activeTab?.url && <div className="toast" role="status">{message}</div>}
        </div>
        <footer className="statusbar"><span>{activeTab?.loading ? 'Loading page…' : activeTab?.url ? 'Ready' : 'Ready when you are'}</span><span className="protection-status"><i /> Filtering not enabled</span></footer>
      </section>
    </main>
  );
}
