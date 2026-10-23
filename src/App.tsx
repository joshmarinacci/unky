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
type TabReference = { id: string; type: 'tab' };
type TabFolder = { id: string; type: 'folder'; title: string; collapsed: boolean; children: TabNode[] };
type TabNode = TabReference | TabFolder;
type BookmarkLink = { id: string; type: 'bookmark'; title: string; url: string };
type BookmarkFolder = { id: string; type: 'folder'; title: string; children: BookmarkNode[] };
type BookmarkNode = BookmarkLink | BookmarkFolder;
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

function normalizeTabNodes(value: unknown): TabNode[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): TabNode[] => {
    if (!item || typeof item !== 'object') return [];
    const node = item as Record<string, unknown>;
    if (node.type === 'folder' && typeof node.title === 'string') {
      return [{
        id: typeof node.id === 'string' ? node.id : crypto.randomUUID(),
        type: 'folder',
        title: node.title,
        collapsed: node.collapsed === true,
        children: normalizeTabNodes(node.children),
      }];
    }
    if (node.type === 'tab' && typeof node.id === 'string') return [{ id: node.id, type: 'tab' }];
    return [];
  });
}

function initialTabNodes(): TabNode[] {
  try { return normalizeTabNodes(JSON.parse(localStorage.getItem('browser.tabTree') ?? '[]')); }
  catch { return []; }
}

function initialTabNameOverrides(): Record<string, string> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('browser.tabNames') ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  } catch { return {}; }
}

function reconcileTabNodes(nodes: TabNode[], tabs: Tab[]): TabNode[] {
  const validIds = new Set(tabs.map(tab => tab.id));
  const seenIds = new Set<string>();
  const visit = (items: TabNode[]): TabNode[] => items.flatMap((node): TabNode[] => {
    if (node.type === 'tab') {
      if (!validIds.has(node.id) || seenIds.has(node.id)) return [];
      seenIds.add(node.id);
      return [node];
    }
    return [{ ...node, children: visit(node.children) }];
  });
  const reconciled = visit(nodes);
  for (const tab of tabs) if (!seenIds.has(tab.id)) reconciled.push({ id: tab.id, type: 'tab' });
  return reconciled;
}

function flattenTabIds(nodes: TabNode[]): string[] {
  return nodes.flatMap(node => node.type === 'tab' ? [node.id] : flattenTabIds(node.children));
}

function findTabNode(nodes: TabNode[], id: string): TabNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.type === 'folder') {
      const found = findTabNode(node.children, id);
      if (found) return found;
    }
  }
  return undefined;
}

function updateTabNode(nodes: TabNode[], id: string, update: (node: TabNode) => TabNode): TabNode[] {
  return nodes.map(node => node.id === id ? update(node) : node.type === 'folder' ? { ...node, children: updateTabNode(node.children, id, update) } : node);
}

function removeTabNode(nodes: TabNode[], id: string): { nodes: TabNode[]; removed?: TabNode } {
  let removed: TabNode | undefined;
  const result = nodes.flatMap<TabNode>(node => {
    if (node.id === id) { removed = node; return []; }
    if (node.type === 'folder') {
      const nested = removeTabNode(node.children, id);
      if (nested.removed) removed = nested.removed;
      return [{ ...node, children: nested.nodes }];
    }
    return [node];
  });
  return { nodes: result, removed };
}

function containsTabNode(node: TabNode, id: string): boolean {
  return node.id === id || (node.type === 'folder' && node.children.some(child => containsTabNode(child, id)));
}

function insertTabNode(nodes: TabNode[], targetId: string, moving: TabNode, after: boolean): { nodes: TabNode[]; inserted: boolean } {
  const result: TabNode[] = [];
  for (const node of nodes) {
    if (node.id === targetId) return { nodes: [...result, ...(after ? [node, moving] : [moving, node]), ...nodes.slice(result.length + 1)], inserted: true };
    if (node.type === 'folder') {
      const nested = insertTabNode(node.children, targetId, moving, after);
      if (nested.inserted) return { nodes: [...result, { ...node, children: nested.nodes }, ...nodes.slice(result.length + 1)], inserted: true };
    }
    result.push(node);
  }
  return { nodes: result, inserted: false };
}

function appendTabNodeToFolder(nodes: TabNode[], folderId: string, moving: TabNode): { nodes: TabNode[]; inserted: boolean } {
  let inserted = false;
  const result = nodes.map(node => {
    if (node.id === folderId && node.type === 'folder') { inserted = true; return { ...node, children: [...node.children, moving], collapsed: false }; }
    if (!inserted && node.type === 'folder') {
      const nested = appendTabNodeToFolder(node.children, folderId, moving);
      if (nested.inserted) inserted = true;
      return nested.inserted ? { ...node, children: nested.nodes } : node;
    }
    return node;
  });
  return { nodes: result, inserted };
}

function unwrapTabFolder(nodes: TabNode[], folderId: string): { nodes: TabNode[]; unwrapped: boolean } {
  const rootIndex = nodes.findIndex(node => node.id === folderId && node.type === 'folder');
  if (rootIndex >= 0) {
    const folder = nodes[rootIndex] as TabFolder;
    return { nodes: [...nodes.slice(0, rootIndex), ...folder.children, ...nodes.slice(rootIndex + 1)], unwrapped: true };
  }
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (node.type !== 'folder') continue;
    const nested = unwrapTabFolder(node.children, folderId);
    if (nested.unwrapped) {
      const result = [...nodes];
      result[index] = { ...node, children: nested.nodes };
      return { nodes: result, unwrapped: true };
    }
  }
  return { nodes, unwrapped: false };
}

function normalizeBookmarkNodes(value: unknown): BookmarkNode[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): BookmarkNode[] => {
    if (!item || typeof item !== 'object') return [];
    const node = item as Record<string, unknown>;
    if (node.type === 'folder' && typeof node.title === 'string') {
      return [{
        id: typeof node.id === 'string' ? node.id : crypto.randomUUID(),
        type: 'folder',
        title: node.title,
        children: normalizeBookmarkNodes(node.children),
      }];
    }
    if (typeof node.title === 'string' && typeof node.url === 'string') {
      return [{
        id: typeof node.id === 'string' ? node.id : crypto.randomUUID(),
        type: 'bookmark',
        title: node.title,
        url: node.url,
      }];
    }
    return [];
  });
}

function initialBookmarks(): BookmarkNode[] {
  try {
    const saved = JSON.parse(localStorage.getItem('browser.bookmarks') ?? '[]');
    return normalizeBookmarkNodes(saved);
  } catch { return []; }
}

function findBookmarkByUrl(nodes: BookmarkNode[], url: string): BookmarkLink | undefined {
  for (const node of nodes) {
    if (node.type === 'bookmark' && node.url === url) return node;
    if (node.type === 'folder') {
      const match = findBookmarkByUrl(node.children, url);
      if (match) return match;
    }
  }
  return undefined;
}

function findBookmarkNode(nodes: BookmarkNode[], id: string): BookmarkNode | undefined {
  for (const node of nodes) {
    if (node.id === id) return node;
    if (node.type === 'folder') {
      const match = findBookmarkNode(node.children, id);
      if (match) return match;
    }
  }
  return undefined;
}

function updateBookmarkNode(nodes: BookmarkNode[], id: string, update: (node: BookmarkNode) => BookmarkNode): BookmarkNode[] {
  return nodes.map(node => {
    if (node.id === id) return update(node);
    return node.type === 'folder' ? { ...node, children: updateBookmarkNode(node.children, id, update) } : node;
  });
}

function removeBookmarkNode(nodes: BookmarkNode[], id: string): { nodes: BookmarkNode[]; removed?: BookmarkNode } {
  let removed: BookmarkNode | undefined;
  const remaining = nodes.flatMap<BookmarkNode>(node => {
    if (node.id === id) {
      removed = node;
      return [];
    }
    if (node.type === 'folder') {
      const nested = removeBookmarkNode(node.children, id);
      if (nested.removed) removed = nested.removed;
      return [{ ...node, children: nested.nodes }];
    }
    return [node];
  });
  return { nodes: remaining, removed };
}

function containsBookmarkNode(node: BookmarkNode, id: string): boolean {
  return node.id === id || (node.type === 'folder' && node.children.some(child => containsBookmarkNode(child, id)));
}

function insertBookmarkBefore(nodes: BookmarkNode[], targetId: string, moving: BookmarkNode): { nodes: BookmarkNode[]; inserted: boolean } {
  const result: BookmarkNode[] = [];
  for (const node of nodes) {
    if (node.id === targetId) return { nodes: [...result, moving, ...nodes.slice(result.length)], inserted: true };
    if (node.type === 'folder') {
      const nested = insertBookmarkBefore(node.children, targetId, moving);
      if (nested.inserted) return { nodes: [...result, { ...node, children: nested.nodes }, ...nodes.slice(result.length + 1)], inserted: true };
    }
    result.push(node);
  }
  return { nodes: result, inserted: false };
}

function insertBookmarkAfter(nodes: BookmarkNode[], targetId: string, moving: BookmarkNode): { nodes: BookmarkNode[]; inserted: boolean } {
  const result: BookmarkNode[] = [];
  for (const node of nodes) {
    if (node.id === targetId) return { nodes: [...result, node, moving, ...nodes.slice(result.length + 1)], inserted: true };
    if (node.type === 'folder') {
      const nested = insertBookmarkAfter(node.children, targetId, moving);
      if (nested.inserted) return { nodes: [...result, { ...node, children: nested.nodes }, ...nodes.slice(result.length + 1)], inserted: true };
    }
    result.push(node);
  }
  return { nodes: result, inserted: false };
}

function appendBookmarkToFolder(nodes: BookmarkNode[], folderId: string, moving: BookmarkNode): { nodes: BookmarkNode[]; inserted: boolean } {
  let inserted = false;
  const next = nodes.map(node => {
    if (node.id === folderId && node.type === 'folder') {
      inserted = true;
      return { ...node, children: [...node.children, moving] };
    }
    if (!inserted && node.type === 'folder') {
      const nested = appendBookmarkToFolder(node.children, folderId, moving);
      if (nested.inserted) inserted = true;
      return nested.inserted ? { ...node, children: nested.nodes } : node;
    }
    return node;
  });
  return { nodes: next, inserted };
}

function filterBookmarkNodes(nodes: BookmarkNode[], query: string): BookmarkNode[] {
  if (!query) return nodes;
  const normalized = query.toLowerCase();
  return nodes.flatMap<BookmarkNode>(node => {
    if (node.type === 'bookmark') return `${node.title} ${node.url}`.toLowerCase().includes(normalized) ? [node] : [];
    if (node.title.toLowerCase().includes(normalized)) return [node];
    const children = filterBookmarkNodes(node.children, query);
    return children.length ? [{ ...node, children }] : [];
  });
}

function initialTheme(): Theme {
  const saved = localStorage.getItem('browser.theme');
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [tabsLoaded, setTabsLoaded] = useState(false);
  const [tabNodes, setTabNodes] = useState<TabNode[]>(initialTabNodes);
  const [tabNameOverrides, setTabNameOverrides] = useState<Record<string, string>>(initialTabNameOverrides);
  const [tabFavicons, setTabFavicons] = useState<Record<string, string>>({});
  const [tabNameDraft, setTabNameDraft] = useState('');
  const [editingTabId, setEditingTabId] = useState('');
  const [editingTabFolderId, setEditingTabFolderId] = useState('');
  const [tabFolderTitle, setTabFolderTitle] = useState('');
  const [tabDropTargetId, setTabDropTargetId] = useState('');
  const [tabContextMenu, setTabContextMenu] = useState<{ id: string; type: 'tab' | 'folder'; x: number; y: number } | null>(null);
  const [address, setAddress] = useState('');
  const [message, setMessage] = useState('');
  const [isTauri, setIsTauri] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [sidebarView, setSidebarView] = useState<'tabs' | 'bookmarks' | 'history' | 'downloads'>('tabs');
  const [bookmarks, setBookmarks] = useState<BookmarkNode[]>(initialBookmarks);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatches, setFindMatches] = useState<number | null>(null);
  const [bookmarkSearch, setBookmarkSearch] = useState('');
  const [bookmarkTitle, setBookmarkTitle] = useState('');
  const [bookmarkUrl, setBookmarkUrl] = useState('');
  const [editingBookmarkId, setEditingBookmarkId] = useState('');
  const [folderTitle, setFolderTitle] = useState('');
  const [editingFolderId, setEditingFolderId] = useState('');
  const [expandedFolderIds, setExpandedFolderIds] = useState<string[]>([]);
  const [bookmarkDropTargetId, setBookmarkDropTargetId] = useState('');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const addressRef = useRef<HTMLInputElement>(null);
  const findRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const activeTabIdRef = useRef(activeTabId);
  const tabNodesRef = useRef(tabNodes);
  const faviconRequests = useRef(new Set<string>());
  const sessionTestStarted = useRef(false);
  const activeTab = tabs.find(tab => tab.id === activeTabId);
  const currentBookmark = activeTab?.url ? findBookmarkByUrl(bookmarks, activeTab.url) : undefined;
  const findInPage = useCallback(async (query: string, backwards = false) => {
    if (!activeTabId || !query.trim()) { setFindMatches(null); return; }
    try { setFindMatches(await invoke<number>('find_in_page', { tabId: activeTabId, query, backwards })); }
    catch (error) { setMessage(String(error)); }
  }, [activeTabId]);

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
    localStorage.setItem('browser.tabTree', JSON.stringify(tabNodes));
  }, [tabNodes]);

  useEffect(() => {
    localStorage.setItem('browser.tabNames', JSON.stringify(tabNameOverrides));
  }, [tabNameOverrides]);

  useEffect(() => {
    if (!tabsLoaded) return;
    const reconciled = reconcileTabNodes(tabNodesRef.current, tabs);
    if (JSON.stringify(reconciled) !== JSON.stringify(tabNodesRef.current)) {
      tabNodesRef.current = reconciled;
      setTabNodes(reconciled);
    }
    const openIds = new Set(tabs.map(tab => tab.id));
    setTabNameOverrides(names => Object.fromEntries(Object.entries(names).filter(([id]) => openIds.has(id))));
  }, [tabs, tabsLoaded]);

  useEffect(() => {
    for (const tab of tabs) {
      if (!tab.url || !/^https?:/i.test(tab.url)) continue;
      const requestKey = `${tab.id}:${tab.url}`;
      if (faviconRequests.current.has(requestKey)) continue;
      faviconRequests.current.add(requestKey);
      window.setTimeout(() => {
        void invoke<string>('get_tab_favicon', { tabId: tab.id })
          .then(favicon => { if (favicon) setTabFavicons(current => ({ ...current, [tab.id]: favicon })); })
          .catch(() => undefined);
      }, 400);
    }
  }, [tabs]);

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

  useEffect(() => {
    if (!findOpen) return;
    const frame = window.requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [findOpen]);

  useEffect(() => {
    if (!findOpen || !findQuery.trim()) {
      setFindMatches(null);
      return;
    }
    const timer = window.setTimeout(() => void findInPage(findQuery), 125);
    return () => window.clearTimeout(timer);
  }, [findOpen, findQuery, findInPage]);

  const applySnapshot = useCallback((snapshot: BrowserSnapshot) => {
    setTabs(snapshot.tabs);
    setActiveTabId(snapshot.activeTabId);
    activeTabIdRef.current = snapshot.activeTabId;
    setTabsLoaded(true);
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
          case 'find': openFindPanel(); break;
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
        if ((await invoke<number>('find_in_page', { tabId: snapshot.activeTabId, query: 'Native find marker', backwards: false })) < 1) {
          throw new Error('Native find failed to locate text in the WKWebView');
        }
        if ((await invoke<number>('find_in_page', { tabId: snapshot.activeTabId, query: 'missing integration phrase', backwards: false })) !== 0) {
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
      if (event.key === 'Escape' && findOpen) { setFindOpen(false); setFindQuery(''); setFindMatches(null); return; }
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === 'f') { event.preventDefault(); openFindPanel(); }
      if (key === 'l') { event.preventDefault(); addressRef.current?.focus(); addressRef.current?.select(); }
      if (key === 't') { event.preventDefault(); if (event.shiftKey) void reopenClosedTab(); else void createTab(); }
      if (key === 'w' && activeTabId) { event.preventDefault(); void closeTab(activeTabId); }
      if (key === 'r' && activeTabId) { event.preventDefault(); void runNavigationCommand('reload'); }
      if (event.ctrlKey && key === 'tab') { event.preventDefault(); void invoke<BrowserSnapshot>('cycle_tab', { backwards: event.shiftKey }).then(applySnapshot).catch(error => setMessage(String(error))); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

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
    const duplicate = findBookmarkByUrl(bookmarks, url);
    if (duplicate && duplicate.id !== editingBookmarkId) {
      setMessage('That address is already bookmarked.');
      return;
    }
    if (editingBookmarkId) {
      setBookmarks(items => updateBookmarkNode(items, editingBookmarkId, node => node.type === 'bookmark'
        ? { ...node, title: bookmarkTitle.trim() || url, url }
        : node));
    } else {
      setBookmarks(items => [{ id: crypto.randomUUID(), type: 'bookmark', title: bookmarkTitle.trim() || url, url }, ...items]);
    }
    setBookmarkTitle(''); setBookmarkUrl(''); setEditingBookmarkId('');
    setMessage('');
  }

  function openFindPanel() {
    setFindOpen(true);
    window.requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
  }

  function addCurrentPage() {
    if (!activeTab?.url) return;
    const existing = findBookmarkByUrl(bookmarks, activeTab.url);
    if (existing) {
      setMessage('This page is already bookmarked.');
      return;
    }
    setBookmarks(items => [{ id: crypto.randomUUID(), type: 'bookmark', title: activeTab.title || activeTab.url, url: activeTab.url }, ...items]);
    setMessage('Bookmark added.');
  }

  function editBookmark(bookmark: BookmarkLink) {
    setEditingBookmarkId(bookmark.id);
    setBookmarkTitle(bookmark.title);
    setBookmarkUrl(bookmark.url);
  }

  function createBookmarkFolder(parentId?: string) {
    const folder: BookmarkFolder = { id: crypto.randomUUID(), type: 'folder', title: 'New Folder', children: [] };
    setBookmarks(items => {
      if (!parentId) return [folder, ...items];
      return appendBookmarkToFolder(items, parentId, folder).nodes;
    });
    if (parentId) setExpandedFolderIds(ids => ids.includes(parentId) ? ids : [...ids, parentId]);
    setExpandedFolderIds(ids => ids.includes(folder.id) ? ids : [...ids, folder.id]);
    setFolderTitle(folder.title);
    setEditingFolderId(folder.id);
  }

  function saveFolderTitle(folderId: string) {
    const title = folderTitle.trim() || 'New Folder';
    setBookmarks(items => updateBookmarkNode(items, folderId, node => node.type === 'folder' ? { ...node, title } : node));
    setEditingFolderId('');
  }

  function deleteBookmarkNode(node: BookmarkNode) {
    if (node.type === 'folder' && !window.confirm(`Delete “${node.title}” and everything inside it?`)) return;
    setBookmarks(items => removeBookmarkNode(items, node.id).nodes);
  }

  function moveBookmarkNode(draggedId: string, targetId?: string, folderId?: string, position: 'before' | 'after' = 'before') {
    if (!draggedId || draggedId === targetId || draggedId === folderId) return;
    setBookmarks(items => {
      const moving = findBookmarkNode(items, draggedId);
      const destinationId = folderId ?? targetId;
      if (!moving || (destinationId && moving.type === 'folder' && containsBookmarkNode(moving, destinationId))) return items;
      const remaining = removeBookmarkNode(items, draggedId).nodes;
      if (folderId) return appendBookmarkToFolder(remaining, folderId, moving).nodes;
      if (targetId) {
        const inserted = position === 'after'
          ? insertBookmarkAfter(remaining, targetId, moving)
          : insertBookmarkBefore(remaining, targetId, moving);
        return inserted.inserted ? inserted.nodes : items;
      }
      return [...remaining, moving];
    });
  }

  function dropBookmark(event: React.DragEvent, targetId?: string, folderId?: string, position: 'before' | 'after' = 'before') {
    event.preventDefault();
    event.stopPropagation();
    moveBookmarkNode(event.dataTransfer.getData('text/plain'), targetId, folderId, position);
    setBookmarkDropTargetId('');
    if (folderId) setExpandedFolderIds(ids => ids.includes(folderId) ? ids : [...ids, folderId]);
  }

  function storeTabTree(nodes: TabNode[]) {
    tabNodesRef.current = nodes;
    setTabNodes(nodes);
  }

  function reorderTabsFromTree(nodes: TabNode[]) {
    storeTabTree(nodes);
    void invoke<BrowserSnapshot>('reorder_tabs', { tabIds: flattenTabIds(nodes) })
      .then(applySnapshot)
      .catch(error => setMessage(String(error)));
  }

  function createTabFolder() {
    const folder: TabFolder = { id: crypto.randomUUID(), type: 'folder', title: 'New Folder', collapsed: false, children: [] };
    storeTabTree([folder, ...tabNodesRef.current]);
    setEditingTabFolderId(folder.id);
    setTabFolderTitle(folder.title);
  }

  function saveTabFolderTitle(folderId: string) {
    const title = tabFolderTitle.trim() || 'New Folder';
    storeTabTree(updateTabNode(tabNodesRef.current, folderId, node => node.type === 'folder' ? { ...node, title } : node));
    setEditingTabFolderId('');
  }

  function deleteTabFolder(folderId: string) {
    const result = unwrapTabFolder(tabNodesRef.current, folderId);
    if (result.unwrapped) reorderTabsFromTree(result.nodes);
  }

  function moveTabNode(draggedId: string, targetId?: string, folderId?: string, position: 'before' | 'after' = 'before') {
    if (!draggedId || draggedId === targetId || draggedId === folderId) return;
    const moving = findTabNode(tabNodesRef.current, draggedId);
    const destinationId = folderId ?? targetId;
    if (!moving || (destinationId && moving.type === 'folder' && containsTabNode(moving, destinationId))) return;
    const remaining = removeTabNode(tabNodesRef.current, draggedId).nodes;
    let result: TabNode[];
    if (folderId) result = appendTabNodeToFolder(remaining, folderId, moving).nodes;
    else if (targetId) result = insertTabNode(remaining, targetId, moving, position === 'after').nodes;
    else result = [...remaining, moving];
    reorderTabsFromTree(result);
    setTabDropTargetId('');
    if (folderId) storeTabTree(updateTabNode(tabNodesRef.current, folderId, node => node.type === 'folder' ? { ...node, collapsed: false } : node));
  }

  function dropTab(event: React.DragEvent, targetId?: string, folderId?: string, position: 'before' | 'after' = 'before') {
    event.preventDefault();
    event.stopPropagation();
    moveTabNode(event.dataTransfer.getData('text/plain'), targetId, folderId, position);
    setTabDropTargetId('');
  }

  function saveTabName(tabId: string) {
    const title = tabNameDraft.trim();
    setTabNameOverrides(names => {
      const next = { ...names };
      if (title) next[tabId] = title;
      else delete next[tabId];
      return next;
    });
    setEditingTabId('');
  }

  function renderTabNodes(nodes: TabNode[], depth = 0): React.ReactNode {
    return nodes.map(node => {
      if (node.type === 'folder') {
        const expanded = !node.collapsed;
        return <div className="tab-folder" key={node.id}>
          <div
            className={`tab-folder-row ${tabDropTargetId === `before:${node.id}` ? 'drop-before' : ''} ${tabDropTargetId === `after:${node.id}` ? 'drop-after' : ''} ${tabDropTargetId === `folder:${node.id}` ? 'drop-inside' : ''}`}
            style={{ paddingLeft: depth * 14 }}
            draggable
            onContextMenu={event => { event.preventDefault(); setTabContextMenu({ id: node.id, type: 'folder', x: Math.min(event.clientX, window.innerWidth - 165), y: Math.min(event.clientY, window.innerHeight - 90) }); }}
            onDragStart={event => { event.dataTransfer.setData('text/plain', node.id); event.dataTransfer.effectAllowed = 'move'; }}
            onDragEnd={() => setTabDropTargetId('')}
            onDragEnter={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setTabDropTargetId(`folder:${node.id}`); }}
            onDragOver={event => {
              event.preventDefault(); event.dataTransfer.dropEffect = 'move';
              const bounds = event.currentTarget.getBoundingClientRect();
              const progress = (event.clientY - bounds.top) / bounds.height;
              setTabDropTargetId(progress < 0.25 ? `before:${node.id}` : progress > 0.75 ? `after:${node.id}` : `folder:${node.id}`);
            }}
            onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTabDropTargetId(''); }}
            onDrop={event => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const progress = (event.clientY - bounds.top) / bounds.height;
              if (progress < 0.25) dropTab(event, node.id, undefined, 'before');
              else if (progress > 0.75) dropTab(event, node.id, undefined, 'after');
              else dropTab(event, undefined, node.id);
            }}
          >
            <button className="tab-folder-toggle" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.title}`} onClick={() => storeTabTree(updateTabNode(tabNodesRef.current, node.id, item => item.type === 'folder' ? { ...item, collapsed: !item.collapsed } : item))}>{expanded ? '▾' : '▸'}</button>
            <span className="tab-folder-icon" aria-hidden="true">▰</span>
            {editingTabFolderId === node.id
              ? <input className="tab-folder-name-input" aria-label="Tab folder name" autoFocus value={tabFolderTitle} onChange={event => setTabFolderTitle(event.target.value)} onBlur={() => saveTabFolderTitle(node.id)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); saveTabFolderTitle(node.id); } if (event.key === 'Escape') { setEditingTabFolderId(''); setTabFolderTitle(node.title); } }} />
              : <span className="tab-folder-title">{node.title}</span>}
          </div>
          {expanded && <div className={`tab-folder-children ${tabDropTargetId === `folder:${node.id}` ? 'drop-inside' : ''}`}
            onDragEnter={event => { if (event.target === event.currentTarget || (event.target instanceof HTMLElement && event.target.classList.contains('tab-folder-empty'))) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setTabDropTargetId(`folder:${node.id}`); } }}
            onDragOver={event => { if (event.target === event.currentTarget || (event.target instanceof HTMLElement && event.target.classList.contains('tab-folder-empty'))) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setTabDropTargetId(`folder:${node.id}`); } }}
            onDrop={event => dropTab(event, undefined, node.id)}>
            {node.children.length ? renderTabNodes(node.children, depth + 1) : <div className="tab-folder-empty" style={{ paddingLeft: (depth + 1) * 14 + 30 }}>Drop tabs here</div>}
          </div>}
        </div>;
      }
      const tab = tabs.find(item => item.id === node.id);
      if (!tab) return null;
      const title = tabNameOverrides[tab.id] || tab.title || 'New Tab';
      const icon = tabFavicons[tab.id];
      return <div
        className={`tab-row ${tab.id === activeTabId ? 'selected' : ''} ${tabDropTargetId === `before:${node.id}` ? 'drop-before' : ''} ${tabDropTargetId === `after:${node.id}` ? 'drop-after' : ''}`}
        key={node.id}
        style={{ marginLeft: depth * 14 }}
        draggable
        onContextMenu={event => { event.preventDefault(); setTabContextMenu({ id: tab.id, type: 'tab', x: Math.min(event.clientX, window.innerWidth - 165), y: Math.min(event.clientY, window.innerHeight - 90) }); }}
        onDragStart={event => { event.dataTransfer.setData('text/plain', node.id); event.dataTransfer.effectAllowed = 'move'; }}
        onDragEnd={() => setTabDropTargetId('')}
        onDragEnter={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setTabDropTargetId(`before:${node.id}`); }}
        onDragOver={event => {
          event.preventDefault(); event.dataTransfer.dropEffect = 'move';
          const bounds = event.currentTarget.getBoundingClientRect();
          setTabDropTargetId(event.clientY < bounds.top + bounds.height / 2 ? `before:${node.id}` : `after:${node.id}`);
        }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTabDropTargetId(''); }}
        onDrop={event => {
          const bounds = event.currentTarget.getBoundingClientRect();
          dropTab(event, node.id, undefined, event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after');
        }}
      >
        {editingTabId === tab.id
          ? <input className="tab-rename-input" aria-label="Tab name" value={tabNameDraft} autoFocus onChange={event => setTabNameDraft(event.target.value)} onBlur={() => saveTabName(tab.id)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); saveTabName(tab.id); } if (event.key === 'Escape') setEditingTabId(''); }} />
          : <button className="tab-select" role="tab" aria-selected={tab.id === activeTabId} onClick={() => void selectTab(tab.id)} title={tab.url || 'New tab'}>
              <span className={`tab-favicon ${tab.loading ? 'is-loading' : ''}`}>{tab.loading ? '◌' : icon ? <img src={icon} alt="" onError={() => setTabFavicons(current => { const next = { ...current }; delete next[tab.id]; return next; })} /> : tab.url ? '◉' : '✳'}</span>
              <span className="tab-title">{title}</span>
            </button>}
        <button className="tab-close" aria-label={`Close ${title}`} onClick={() => void closeTab(tab.id)}>×</button>
      </div>;
    });
  }

  function renderBookmarkNodes(nodes: BookmarkNode[], depth = 0): React.ReactNode {
    return nodes.map(node => {
      if (node.type === 'folder') {
        const expanded = expandedFolderIds.includes(node.id) || Boolean(bookmarkSearch.trim());
        return <div className="bookmark-node folder-node" key={node.id}>
          <div
            className={`folder-row ${bookmarkDropTargetId === `before:${node.id}` ? 'drop-before' : ''} ${bookmarkDropTargetId === `after:${node.id}` ? 'drop-after' : ''} ${bookmarkDropTargetId === `folder:${node.id}` ? 'drop-inside' : ''}`}
            style={{ paddingLeft: depth * 14 }}
            draggable
            onDragStart={event => { event.dataTransfer.setData('text/plain', node.id); event.dataTransfer.effectAllowed = 'move'; }}
            onDragEnd={() => setBookmarkDropTargetId('')}
            onDragEnter={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setBookmarkDropTargetId(`folder:${node.id}`); }}
            onDragOver={event => {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              const bounds = event.currentTarget.getBoundingClientRect();
              const progress = (event.clientY - bounds.top) / bounds.height;
              setBookmarkDropTargetId(progress < 0.25 ? `before:${node.id}` : progress > 0.75 ? `after:${node.id}` : `folder:${node.id}`);
            }}
            onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setBookmarkDropTargetId(''); }}
            onDrop={event => {
              const bounds = event.currentTarget.getBoundingClientRect();
              const progress = (event.clientY - bounds.top) / bounds.height;
              if (progress < 0.25) dropBookmark(event, node.id, undefined, 'before');
              else if (progress > 0.75) dropBookmark(event, node.id, undefined, 'after');
              else dropBookmark(event, undefined, node.id);
            }}
          >
            <button className="folder-toggle" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.title}`} onClick={() => setExpandedFolderIds(ids => expanded ? ids.filter(id => id !== node.id) : [...ids, node.id])}>{expanded ? '▾' : '▸'}</button>
            <span className="bookmark-icon folder-icon" aria-hidden="true">▰</span>
            {editingFolderId === node.id ? <input className="folder-title-input" aria-label="Folder name" autoFocus value={folderTitle} onChange={event => setFolderTitle(event.target.value)} onBlur={() => saveFolderTitle(node.id)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); saveFolderTitle(node.id); } if (event.key === 'Escape') { setEditingFolderId(''); setFolderTitle(node.title); } }} /> : <span className="folder-title" title={node.title}>{node.title}</span>}
            <div className="folder-actions">
              <button className="folder-action" aria-label={`Create subfolder in ${node.title}`} title="New subfolder" onClick={() => createBookmarkFolder(node.id)}>＋</button>
              <button className="folder-action" aria-label={`Rename ${node.title}`} title="Rename folder" onClick={() => { setFolderTitle(node.title); setEditingFolderId(node.id); }}>✎</button>
              <button className="folder-action" aria-label={`Delete ${node.title}`} title="Delete folder and contents" onClick={() => deleteBookmarkNode(node)}>×</button>
            </div>
          </div>
          {expanded && <div className={`folder-children ${bookmarkDropTargetId === `folder:${node.id}` ? 'drop-inside' : ''}`}
            onDragEnter={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setBookmarkDropTargetId(`folder:${node.id}`); }}
            onDragOver={event => {
              if (event.target === event.currentTarget || (event.target instanceof HTMLElement && event.target.classList.contains('folder-empty'))) {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'move';
                setBookmarkDropTargetId(`folder:${node.id}`);
              }
            }}
            onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setBookmarkDropTargetId(''); }}
            onDrop={event => dropBookmark(event, undefined, node.id)}>
            {node.children.length ? renderBookmarkNodes(node.children, depth + 1) : <div className="folder-empty" style={{ paddingLeft: (depth + 1) * 14 + 30 }}>Drop bookmarks here</div>}
          </div>}
        </div>;
      }
      return <div
        className={`bookmark-row bookmark-tree-row ${bookmarkDropTargetId === `before:${node.id}` ? 'drop-before' : ''} ${bookmarkDropTargetId === `after:${node.id}` ? 'drop-after' : ''}`}
        key={node.id}
        style={{ paddingLeft: depth * 14 }}
        draggable
        onDragStart={event => { event.dataTransfer.setData('text/plain', node.id); event.dataTransfer.effectAllowed = 'move'; }}
        onDragEnd={() => setBookmarkDropTargetId('')}
        onDragEnter={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setBookmarkDropTargetId(`before:${node.id}`); }}
        onDragOver={event => {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
          const bounds = event.currentTarget.getBoundingClientRect();
          setBookmarkDropTargetId(event.clientY < bounds.top + bounds.height / 2 ? `before:${node.id}` : `after:${node.id}`);
        }}
        onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setBookmarkDropTargetId(''); }}
        onDrop={event => {
          const bounds = event.currentTarget.getBoundingClientRect();
          dropBookmark(event, node.id, undefined, event.clientY < bounds.top + bounds.height / 2 ? 'before' : 'after');
        }}
      >
        <button className="bookmark-open" title={node.url} onClick={() => void openBookmark(node.url)}><span className="bookmark-icon">☆</span><span><strong>{node.title}</strong><small>{node.url}</small></span></button>
        <button className="bookmark-edit" aria-label={`Edit ${node.title}`} onClick={() => editBookmark(node)}>✎</button>
        <button className="bookmark-delete" aria-label={`Delete ${node.title}`} onClick={() => deleteBookmarkNode(node)}>×</button>
      </div>;
    });
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
        <div className={`tab-list tab-tree ${tabDropTargetId === 'root' ? 'drop-root' : ''}`} role="tablist" aria-label="Open tabs"
          onDragEnter={event => { if (event.target === event.currentTarget) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setTabDropTargetId('root'); } }}
          onDragOver={event => { if (event.target === event.currentTarget) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setTabDropTargetId('root'); } }}
          onDrop={event => { if (event.target === event.currentTarget) dropTab(event); }}>
          {renderTabNodes(tabNodes)}
        </div>
        <div className="tab-actions">
          <button className="new-tab" onClick={() => void createTab()}><span>＋</span> New tab <kbd>⌘ T</kbd></button>
          <button className="new-tab-folder" title="Create tab folder" aria-label="Create tab folder" onClick={createTabFolder}>＋ Folder</button>
        </div>
        </> : sidebarView === 'bookmarks' ? <div className="bookmark-manager">
          <div className="bookmark-toolbar"><input className="bookmark-search" aria-label="Search bookmarks" placeholder="Find a bookmark" value={bookmarkSearch} onChange={event => setBookmarkSearch(event.target.value)} /><button className="new-folder-button" onClick={() => createBookmarkFolder()}>＋ Folder</button></div>
          <form className="bookmark-form" onSubmit={saveBookmark}>
            <input aria-label="Bookmark title" placeholder="Name" value={bookmarkTitle} onChange={event => setBookmarkTitle(event.target.value)} />
            <input aria-label="Bookmark address" placeholder="https://example.com" value={bookmarkUrl} onChange={event => setBookmarkUrl(event.target.value)} />
            <button type="submit">{editingBookmarkId ? 'Save changes' : 'Add bookmark'}</button>
            {editingBookmarkId && <button type="button" className="cancel-edit" onClick={() => { setEditingBookmarkId(''); setBookmarkTitle(''); setBookmarkUrl(''); }}>Cancel</button>}
          </form>
          <div className={`bookmark-list bookmark-tree ${bookmarkDropTargetId === 'root' ? 'drop-root' : ''}`}
            aria-label="Saved bookmarks"
            onDragEnter={event => { if (event.target === event.currentTarget) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setBookmarkDropTargetId('root'); } }}
            onDragOver={event => { if (event.target === event.currentTarget) { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; setBookmarkDropTargetId('root'); } }}
            onDrop={event => { if (event.target === event.currentTarget) dropBookmark(event); }}>
            {renderBookmarkNodes(filterBookmarkNodes(bookmarks, bookmarkSearch.trim()))}
            {bookmarks.length === 0 && <p className="bookmark-empty">Your saved pages will appear here.</p>}
            {bookmarks.length > 0 && !filterBookmarkNodes(bookmarks, bookmarkSearch.trim()).length && <p className="bookmark-empty">No matching bookmarks.</p>}
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
        {tabContextMenu && <>
          <div className="sidebar-context-dismiss" onClick={() => setTabContextMenu(null)} />
          <div className="sidebar-context-menu" style={{ left: tabContextMenu.x, top: tabContextMenu.y }} role="menu">
            <button role="menuitem" onClick={() => {
              if (tabContextMenu.type === 'tab') {
                const tab = tabs.find(item => item.id === tabContextMenu.id);
                setTabNameDraft(tabNameOverrides[tabContextMenu.id] || tab?.title || '');
                setEditingTabId(tabContextMenu.id);
              } else {
                const folder = findTabNode(tabNodesRef.current, tabContextMenu.id);
                if (folder?.type === 'folder') { setTabFolderTitle(folder.title); setEditingTabFolderId(folder.id); }
              }
              setTabContextMenu(null);
            }}>Rename</button>
            {tabContextMenu.type === 'folder' && <button role="menuitem" onClick={() => { deleteTabFolder(tabContextMenu.id); setTabContextMenu(null); }}>Delete folder</button>}
          </div>
        </>}
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
          {findOpen ? <form className="find-form" aria-label="Find in page" onSubmit={event => { event.preventDefault(); void findInPage(findQuery); }}>
            <input ref={findRef} aria-label="Find in page" placeholder="Find in page" value={findQuery} onChange={event => { setFindQuery(event.target.value); setFindMatches(null); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void findInPage(findQuery, event.shiftKey); } }} />
            {findMatches !== null && <span className="find-result" role="status" aria-live="polite">{findMatches} {findMatches === 1 ? 'match' : 'matches'}</span>}
            <button type="submit" title="Find next">↓</button><button type="button" title="Find previous" onClick={() => void findInPage(findQuery, true)}>↑</button>
            <button type="button" title="Close find" onClick={() => { setFindOpen(false); setFindQuery(''); setFindMatches(null); }}>×</button>
          </form> : <button className="toolbar-action" title="Find in page (⌘F)" aria-label="Find in page" onClick={openFindPanel}>⌕</button>}
          <button className={`toolbar-action bookmark-toggle ${currentBookmark ? 'is-bookmarked' : ''}`} title={currentBookmark ? 'Page bookmarked' : 'Bookmark this page'} aria-label={currentBookmark ? 'Page bookmarked' : 'Bookmark this page'} aria-pressed={Boolean(currentBookmark)} disabled={!activeTab?.url} onClick={addCurrentPage}><span>{currentBookmark ? '★' : '☆'}</span></button>
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
      </section>
    </main>
  );
}
