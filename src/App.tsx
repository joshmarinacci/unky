import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Button as AriaButton,
  Input,
  SearchField,
  Tab,
  TabList,
  TabPanel,
  TabPanels,
  Tabs,
} from 'react-aria-components';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Columns2,
  Download,
  ExternalLink,
  EyeOff,
  Folder,
  FolderPlus,
  Globe2,
  LoaderCircle,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Plus,
  RotateCw,
  Search,
  Settings,
  Shield,
  Sparkles,
  Star,
  Terminal,
  X,
} from 'lucide-react';
import { AppButton, AppInput } from './components/ui';
import { DownloadsPage } from './pages/DownloadsPage';
import { HistoryPage } from './pages/HistoryPage';
import { AppearanceSettings, GeneralSettings, PrivacySettings, SettingsPage } from './pages/SettingsPage';
import { ShortcutsPage } from './pages/ShortcutsPage';
import { SourcePage } from './pages/SourcePage';
import {
  canViewSource,
  parseStoredSourceTabs,
  serializeSourceTabs,
  sourceTabTitle,
  sourceTabUrl,
  viewSourceUrl,
  type SourceTabState,
} from './viewSource';
import { commandKey, isApplePlatform } from './platform';
import { BookmarkSortableRow } from './components/BookmarkSortableRow';
import {
  PinnedTabsDock,
  SortablePinnedTab,
  SortableRow,
  pinnedTabsEndId,
  tabCollisionDetection,
} from './components/sortableTabRows';
import { readStored, usePersistedState } from './hooks/usePersistedState';
import { bookmarkReducer, initialBookmarkState } from './bookmarkState';
import { tabTreeReducer, type TabTreeAction } from './tabTreeState';
import { useLatest } from './hooks/useLatest';
import {
  isTheme,
  parseAccentColor,
  parseCustomPageContextMenu,
  parseSidebarCollapsed,
  parseSidebarSide,
  parseSidebarWidth,
  parseStringArray,
  parseStringRecord,
  parseTabNodes,
  parseTabPosition,
  parseTheme,
  sidebarDefaultWidth,
  sidebarMaxWidth,
  sidebarMinWidth,
  storageKeys,
  type AccentColor,
  type SidebarSide,
  type Theme,
} from './storedPreferences';
import {
  call,
  onEvent,
  bookmarksEvent,
  captureProgressEvent,
  captureStatusEvent,
  clearHistoryRequestEvent,
  downloadsEvent,
  exportBookmarksEvent,
  filterUpdateProgressEvent,
  historyEvent,
  importBookmarksEvent,
  launchRequestEvent,
  openTabInFolderEvent,
  openUrlFromMenuEvent,
  pagePointerDownEvent,
  settingsEvent,
  shortcutEvent,
  showAllDownloadsEvent,
  showDownloadsEvent,
  showHistoryEvent,
  showShortcutsEvent,
  showBookmarksEvent,
  themeMenuEvent,
  splitEvent,
  splitResizeEvent,
  tabDragDropEvent,
  tabEvent,
  tabPositionMenuEvent,
  type BrowserSnapshot,
  type Download as DownloadItem,
  type FilterSettingsView,
  type FilterUpdateProgress,
  type HistoryEntry,
  type LaunchRequest,
  type PageSecurityInfo,
  type SplitLayout,
  type Tab as BrowserTab,
} from './ipc';
import { Menu } from '@tauri-apps/api/menu';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import { open as openFileDialog, save as saveFileDialog } from '@tauri-apps/plugin-dialog';
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates } from '@dnd-kit/sortable';
import { findNode, flattenTree, folderIds, locateNode, resolveDropZone } from './tree';
import type { FlatNode, DropZone } from './tree';
import { filterBookmarkNodes, findBookmarkByUrl, normalizeBookmarkNodes } from './bookmarks';
import type { BookmarkFolder, BookmarkLink, BookmarkNode } from './bookmarks';
import {
  appendTabNodeToFolder,
  expandedTabFolderIds,
  flattenTabIds,
  insertTabNode,
  nextVisibleTab,
  reconcileTabNodes,
  tabAtShortcutPosition,
  tabCycleOrder,
  tabFolders,
  visibleTabCycleOrder,
} from './tabTree';
import type { TabFolder, TabNode } from './tabTree';
import { groupSplitTabRows } from './splitTabRows';
import { isContextMenuKey, rovingTabStop, selectInputText } from './tabUiActions';
import { shortcutForKey, shortcutFromMenu, type ShortcutAction } from './shortcuts';
import { filterSiteDomain, siteDomain } from './siteDomain';
import { folderMenuEntries, tabMenuEntries, type TabContextMenuTarget } from './tabContextMenu';
import { flattenMenuEntries, popupNativeMenu, type MenuEntry } from './nativeMenu';
import { internalPageUrl, parseInternalPageUrl, type InternalPage } from './internalPages';
import { TreeKeyboardNavigation } from './components/TreeKeyboardNavigation';
import { snapshotBelongsToWindow } from './browserSnapshot';
import { findAddressSuggestions, moveAddressSuggestionSelection } from './addressSuggestions';
import { isTabPosition, reorderTabIds, tabAxisForPosition, resolveTabDragPreview, type TabPosition } from './tabLayout';

type Tab = BrowserTab;
type Download = DownloadItem;
const sessionTestUrls = [
  'http://127.0.0.1:4179/index.html?session=first',
  'http://127.0.0.1:4179/index.html?session=second',
];

function assertSessionTestState(snapshot: BrowserSnapshot, expectedUrls: string[], activeUrl: string) {
  const actualUrls = snapshot.tabs.map((tab) => tab.url);
  if (JSON.stringify(actualUrls) !== JSON.stringify(expectedUrls)) {
    throw new Error(`Expected tab order ${JSON.stringify(expectedUrls)}, got ${JSON.stringify(actualUrls)}`);
  }
  const active = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);
  if (!active || active.url !== activeUrl) {
    throw new Error(`Expected active tab ${activeUrl}, got ${active?.url ?? 'none'}`);
  }
}

function initialBookmarks(): BookmarkNode[] {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKeys.bookmarks) ?? '[]');
    return normalizeBookmarkNodes(saved);
  } catch {
    return [];
  }
}

function readSidebarSide(stored: string | null): SidebarSide {
  return parseSidebarSide(
    stored,
    readStored(storageKeys.tabPosition, (tabPosition) => tabPosition),
  );
}

export default function App() {
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [tabsLoaded, setTabsLoaded] = useState(false);
  const [tabNodes, setTabNodes] = useState(() => readStored(storageKeys.tabTree, parseTabNodes));
  const [pinnedTabIds, setPinnedTabIds] = useState(() => readStored(storageKeys.pinnedTabs, parseStringArray));
  const [tabNameOverrides, setTabNameOverrides] = useState(() => readStored(storageKeys.tabNames, parseStringRecord));
  const [tabFavicons, setTabFavicons] = useState<Record<string, string>>({});
  const [splitLayout, setSplitLayout] = useState<SplitLayout | null>(null);
  const [draggingTabId, setDraggingTabId] = useState('');
  const [tabNameDraft, setTabNameDraft] = useState('');
  const [editingTabId, setEditingTabId] = useState('');
  const [editingTabFolderId, setEditingTabFolderId] = useState('');
  const [tabFolderTitle, setTabFolderTitle] = useState('');
  const [address, setAddress] = useState('');
  const [addressSuggestionsOpen, setAddressSuggestionsOpen] = useState(false);
  const [activeAddressSuggestion, setActiveAddressSuggestion] = useState(0);
  const [message, setMessage] = useState('');
  const [captureProgress, setCaptureProgress] = useState<{ completed: number; total: number } | null>(null);
  const [isTauri, setIsTauri] = useState(() =>
    Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__),
  );
  const [sidebarWidth, setSidebarWidth] = useState(() => readStored(storageKeys.sidebarWidth, parseSidebarWidth));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() =>
    readStored(storageKeys.sidebarCollapsed, parseSidebarCollapsed),
  );
  const [tabPosition, setTabPosition] = useState<TabPosition>(() =>
    readStored(storageKeys.tabPosition, parseTabPosition),
  );
  const [sidebarSide, setSidebarSide] = useState<SidebarSide>(() =>
    readStored(storageKeys.sidebarSide, readSidebarSide),
  );
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [sidebarView, setSidebarView] = useState<'tabs' | 'bookmarks'>('tabs');
  const [bookmarkState, dispatchBookmarks] = useReducer(bookmarkReducer, undefined, () =>
    initialBookmarkState(initialBookmarks()),
  );
  const { nodes: bookmarks, expandedFolderIds, loaded: bookmarksLoaded } = bookmarkState;
  const [bookmarkDragOrigin, setBookmarkDragOrigin] = useState<{ id: string; depth: number } | null>(null);
  const bookmarkSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const [bookmarkDropTarget, setBookmarkDropTarget] = useState<{ overId: string; zone: DropZone } | null>(null);
  const bookmarkExpandTimer = useRef<{ id: string; timer: number } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historySearch, setHistorySearch] = useState('');
  const [historyTabIds, setHistoryTabIds] = useState(() => readStored(storageKeys.historyTabs, parseStringArray));
  const [settingsSourceTabId, setSettingsSourceTabId] = useState('');
  const [settingsTabIds, setSettingsTabIds] = useState(() => readStored(storageKeys.settingsTabs, parseStringArray));
  const settingsTabIdsRef = useRef(settingsTabIds);
  const [shortcutsTabIds, setShortcutsTabIds] = useState<string[]>([]);
  /** View Source tabs and their HTML. Only the addresses are saved; a restart downloads them again. */
  const [sourceTabs, setSourceTabs] = useState(() => readStored(storageKeys.sourceTabs, parseStoredSourceTabs));
  /** Saved source tabs still waiting to be downloaded again after a restart. */
  const restoringSourceTabs = useRef(sourceTabs);
  const shortcutsTabIdsRef = useRef<string[]>([]);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [downloadsTabIds, setDownloadsTabIds] = useState<string[]>([]);
  const [downloadsPopoverOpen, setDownloadsPopoverOpen] = useState(false);
  const nativeDownloadsPopover = isTauri && /Mac/.test(navigator.platform);
  const downloadsButtonRef = useRef<HTMLButtonElement>(null);
  const controlDownloadsPopover = useCallback(async (action: 'show' | 'toggle' | 'update' | 'close') => {
    const rect = downloadsButtonRef.current?.getBoundingClientRect();
    if (!rect) return false;
    return call('control_downloads_popover', {
      action,
      anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
  }, []);
  const openDownloadsPopover = useCallback(
    async (toggle = true) => {
      if (/Mac/.test(navigator.platform) && '__TAURI_INTERNALS__' in window) {
        try {
          setDownloadsPopoverOpen(await controlDownloadsPopover(toggle ? 'toggle' : 'show'));
        } catch (error) {
          setMessage(String(error));
        }
      } else setDownloadsPopoverOpen((open) => (toggle ? !open : true));
    },
    [controlDownloadsPopover],
  );
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatches, setFindMatches] = useState<number | null>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [securityState, setSecurityState] = useState<{ tabId: string; url: string; info: PageSecurityInfo } | null>(
    null,
  );
  const [bookmarkSearch, setBookmarkSearch] = useState('');
  const [focusedBookmarkId, setFocusedBookmarkId] = useState('');
  const [focusedTabNodeId, setFocusedTabNodeId] = useState('');
  const [addingBookmark, setAddingBookmark] = useState(false);
  const [addingBookmarkFolderId, setAddingBookmarkFolderId] = useState<string | null>(null);
  const [editingBookmarkId, setEditingBookmarkId] = useState('');
  const [editBookmarkTitle, setEditBookmarkTitle] = useState('');
  const [editBookmarkUrl, setEditBookmarkUrl] = useState('');
  const [editBookmarkDescription, setEditBookmarkDescription] = useState('');
  const bookmarkContextMenuRef = useRef<Menu | null>(null);
  const [folderTitle, setFolderTitle] = useState('');
  const [editingFolderId, setEditingFolderId] = useState('');
  const [filterSettings, setFilterSettings] = useState<FilterSettingsView | null>(null);
  const [filterBusy, setFilterBusy] = useState(false);
  const [filterProgress, setFilterProgress] = useState<FilterUpdateProgress | null>(null);
  const [theme, setTheme] = useState<Theme>(() => readStored(storageKeys.theme, parseTheme));
  const [accentColor, setAccentColor] = useState<AccentColor>(() =>
    readStored(storageKeys.accentColor, parseAccentColor),
  );
  const [customPageContextMenuEnabled, setCustomPageContextMenuEnabled] = useState(() =>
    readStored(storageKeys.customPageContextMenu, parseCustomPageContextMenu),
  );
  // Preferences written back to localStorage whenever they change.
  usePersistedState(storageKeys.tabTree, tabNodes);
  usePersistedState(storageKeys.pinnedTabs, pinnedTabIds);
  usePersistedState(storageKeys.tabNames, tabNameOverrides);
  usePersistedState(storageKeys.sidebarWidth, sidebarWidth, String);
  usePersistedState(storageKeys.sidebarCollapsed, sidebarCollapsed, String);
  usePersistedState(storageKeys.tabPosition, tabPosition, String);
  usePersistedState(storageKeys.sidebarSide, sidebarSide, String);
  usePersistedState(storageKeys.historyTabs, historyTabIds);
  usePersistedState(storageKeys.settingsTabs, settingsTabIds);
  usePersistedState(storageKeys.sourceTabs, sourceTabs, serializeSourceTabs);
  usePersistedState(storageKeys.theme, theme, String);
  usePersistedState(storageKeys.accentColor, accentColor, String);
  usePersistedState(storageKeys.customPageContextMenu, customPageContextMenuEnabled, String);
  const addressRef = useRef<HTMLInputElement>(null);
  const securityButtonRef = useRef<HTMLButtonElement>(null);
  const externalBrowserButtonRef = useRef<HTMLButtonElement>(null);
  const externalBrowserMenuRef = useRef<Menu | null>(null);
  const externalBrowserMenuLoading = useRef(false);
  const findRef = useRef<HTMLInputElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const activeTabIdRef = useRef(activeTabId);
  const tabsRef = useRef(tabs);
  const tabNodesRef = useRef(tabNodes);
  const pinnedTabIdsRef = useRef(pinnedTabIds);
  /** Desktop-test builds only: the tab menu that would be showing natively. */
  const testTabMenuRef = useRef<MenuEntry[] | null>(null);
  pinnedTabIdsRef.current = pinnedTabIds;
  const openTabIdSet = () => new Set(tabsRef.current.map((tab) => tab.id));
  /** Tabs the sidebar shows, in order, skipping collapsed folders: used for tab cycling and ⌘1–⌘9. */
  const visibleTabOrder = () =>
    visibleTabCycleOrder(tabNodesRef.current, pinnedTabIdsRef.current, openTabIdSet(), splitLayout);
  const cycleTabs = (backwards: boolean) => {
    const fullOrder = tabCycleOrder(tabNodesRef.current, pinnedTabIdsRef.current, openTabIdSet(), splitLayout);
    if (!fullOrder.length) {
      // The tab tree has not caught up with the native tabs yet; let Rust cycle in its own order.
      return call('cycle_tab', { backwards, orderedTabIds: null })
        .then(applySnapshot)
        .catch((error) => setMessage(String(error)));
    }
    const target = nextVisibleTab(fullOrder, visibleTabOrder(), activeTabIdRef.current, backwards);
    return target ? selectTab(target) : Promise.resolve();
  };
  const faviconRequests = useRef(new Set<string>());
  const sessionTestStarted = useRef(false);
  const activeTab = tabs.find((tab) => tab.id === activeTabId);
  const splitStartPageStyle: React.CSSProperties | undefined = (() => {
    if (!activeTab || activeTab.url || !splitLayout) return undefined;
    const blankIsFirst = splitLayout.firstTabId === activeTab.id;
    if (!blankIsFirst && splitLayout.secondTabId !== activeTab.id) return undefined;
    const first = splitLayout.firstPanePercent / 100;
    if (splitLayout.orientation === 'horizontal') {
      return blankIsFirst
        ? { left: 0, top: 0, width: `calc((100% - 6px) * ${first})`, height: '100%' }
        : {
            left: `calc((100% - 6px) * ${first} + 6px)`,
            top: 0,
            width: `calc((100% - 6px) * ${1 - first})`,
            height: '100%',
          };
    }
    return blankIsFirst
      ? { left: 0, top: 0, width: '100%', height: `calc((100% - 6px) * ${first})` }
      : {
          left: 0,
          top: `calc((100% - 6px) * ${first} + 6px)`,
          width: '100%',
          height: `calc((100% - 6px) * ${1 - first})`,
        };
  })();
  const activeTabTitle = activeTab ? tabNameOverrides[activeTab.id] || activeTab.title : '';
  const securityInfo =
    securityOpen && securityState?.tabId === activeTabId && securityState.url === activeTab?.url
      ? securityState.info
      : null;
  const shownFindMatches = findOpen && findQuery.trim() ? findMatches : null;
  useEffect(() => {
    if (!(window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) return;
    const title = activeTabTitle && activeTabTitle !== 'New Tab' ? `${activeTabTitle} — Unky` : 'Unky';
    void getCurrentWindow()
      .setTitle(title)
      .catch((error) => setMessage(String(error)));
  }, [activeTabTitle]);
  const historyPageOpen = historyTabIds.includes(activeTabId);
  const settingsPageOpen = settingsTabIds.includes(activeTabId);
  const siteForFilter = filterSiteDomain(
    activeTab?.url,
    settingsPageOpen,
    tabs.find((tab) => tab.id === settingsSourceTabId)?.url,
  );
  const shortcutsPageOpen = shortcutsTabIds.includes(activeTabId);
  const downloadsPageOpen = downloadsTabIds.includes(activeTabId);
  const activeSourceTab = sourceTabs[activeTabId];
  const sourcePageOpen = activeSourceTab !== undefined;
  const currentBookmark = activeTab?.url ? findBookmarkByUrl(bookmarks, activeTab.url) : undefined;
  const nativeAddressSuggestions = isTauri && /Mac/.test(navigator.platform);
  // Memoized because the native popover effect below depends on the list's identity.
  const addressSuggestions = useMemo(
    () => findAddressSuggestions(address, bookmarks, history),
    [address, bookmarks, history],
  );
  useEffect(() => {
    if (!nativeAddressSuggestions) return;
    const update = () => {
      const rect = addressRef.current?.getBoundingClientRect();
      if (!rect) return;
      const rows = addressSuggestionsOpen ? addressSuggestions : [];
      void call('control_address_suggestions_popover', {
        action: rows.length ? 'show' : 'close',
        anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        rows,
        selectedIndex: activeAddressSuggestion,
      }).catch((error) => setMessage(String(error)));
    };
    update();
    if (!addressSuggestionsOpen) return;
    let disposed = false;
    let unlistenMoved: (() => void) | undefined;
    let unlistenResized: (() => void) | undefined;
    void getCurrentWindow()
      .onMoved(update)
      .then((stop) => {
        if (disposed) stop();
        else unlistenMoved = stop;
      });
    void getCurrentWindow()
      .onResized(update)
      .then((stop) => {
        if (disposed) stop();
        else unlistenResized = stop;
      });
    return () => {
      disposed = true;
      unlistenMoved?.();
      unlistenResized?.();
    };
  }, [nativeAddressSuggestions, addressSuggestions, addressSuggestionsOpen, activeAddressSuggestion]);
  useEffect(
    () => () => {
      void externalBrowserMenuRef.current?.close();
    },
    [],
  );
  const tabSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    // Space starts a keyboard drag so Enter stays free to select the tab.
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space'] },
    }),
  );
  const [tabDragOrigin, setTabDragOrigin] = useState<{
    id: string;
    depth: number;
    type: TabNode['type'];
    container: 'tabs' | 'pinned';
    grabX: number;
    grabY: number;
    width: number;
    height: number;
  } | null>(null);
  const [tabDropTarget, setTabDropTarget] = useState<{
    container: 'tabs' | 'pinned';
    overId: string;
    zone: DropZone;
  } | null>(null);
  const [tabDragPreview, setTabDragPreview] = useState<'split' | 'invalid' | null>(null);
  const tabExpandTimer = useRef<{ id: string; timer: number } | null>(null);
  useEffect(() => {
    if (!securityOpen || !activeTabId || !activeTab?.url) return;
    const url = activeTab.url;
    let cancelled = false;
    const refresh = async () => {
      try {
        const info = await call('get_page_security_info', { tabId: activeTabId });
        if (cancelled) return;
        setSecurityState({ tabId: activeTabId, url, info });
        const button = securityButtonRef.current;
        if (!button) return;
        const rect = button.getBoundingClientRect();
        const shown = await call('update_page_security_popover', {
          anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          info,
        });
        if (!cancelled) setSecurityOpen(shown);
      } catch {
        if (!cancelled) setSecurityState(null);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [securityOpen, activeTabId, activeTab?.url]);

  useEffect(() => {
    if (!securityOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSecurityOpen(false);
    };
    const closeOutside = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.security-control')) setSecurityOpen(false);
    };
    document.addEventListener('keydown', closeOnEscape);
    document.addEventListener('pointerdown', closeOutside);
    return () => {
      document.removeEventListener('keydown', closeOnEscape);
      document.removeEventListener('pointerdown', closeOutside);
    };
  }, [securityOpen]);
  const findInPage = useCallback(
    async (query: string, backwards = false) => {
      if (!activeTabId || !query.trim()) {
        setFindMatches(null);
        return;
      }
      try {
        setFindMatches(await call('find_in_page', { tabId: activeTabId, query, backwards }));
      } catch (error) {
        setMessage(String(error));
      }
    },
    [activeTabId],
  );

  useEffect(() => {
    if (isTauri) {
      void call('sync_tab_position_menu', { position: tabPosition }).catch((error) => setMessage(String(error)));
    }
  }, [tabPosition, isTauri]);

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onEvent(tabPositionMenuEvent, (event) => {
      if (event.payload.windowLabel !== getCurrentWindow().label || !isTabPosition(event.payload.position)) return;
      setTabPosition(event.payload.position);
      if (event.payload.position === 'left' || event.payload.position === 'right')
        setSidebarSide(event.payload.position);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => setMessage(String(error)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isTauri]);

  useEffect(() => {
    if (isTauri) {
      if (!bookmarksLoaded) return;
      void call('save_bookmarks', { bookmarks }).catch((error) => setMessage(String(error)));
      return;
    }
    localStorage.setItem(storageKeys.bookmarks, JSON.stringify(bookmarks));
  }, [bookmarks, bookmarksLoaded, isTauri]);

  /** The built-in page a tab shows, which the address bar names with its `unky://` address. */
  function internalPageOfTab(tabId: string | undefined): InternalPage | null {
    if (!tabId) return null;
    if (settingsTabIds.includes(tabId)) return 'settings';
    if (historyTabIds.includes(tabId)) return 'history';
    if (downloadsTabIds.includes(tabId)) return 'downloads';
    if (shortcutsTabIds.includes(tabId)) return 'shortcuts';
    return null;
  }
  /** The address bar text for a built-in page or source tab, or null for a website. */
  function builtInAddressOfTab(tabId: string | undefined): string | null {
    const source = tabId ? sourceTabs[tabId] : undefined;
    if (source) return viewSourceUrl(sourceTabUrl(source));
    const internalPage = internalPageOfTab(tabId);
    return internalPage ? internalPageUrl(internalPage) : null;
  }
  const builtInAddressOfTabRef = useLatest(builtInAddressOfTab);
  const applySnapshot = useCallback(
    (snapshot: BrowserSnapshot) => {
      if (!snapshotBelongsToWindow(snapshot.tabs, getCurrentWindow().label)) return;
      setTabs(snapshot.tabs);
      tabsRef.current = snapshot.tabs;
      setActiveTabId(snapshot.activeTabId);
      activeTabIdRef.current = snapshot.activeTabId;
      setTabsLoaded(true);
      const active = snapshot.tabs.find((tab) => tab.id === snapshot.activeTabId);
      setAddress(builtInAddressOfTabRef.current(active?.id) ?? active?.url ?? '');
    },
    [builtInAddressOfTabRef],
  );

  // Event listeners below subscribe once; they call handlers through this ref so they
  // always use the current render's versions.
  /** Run a browser shortcut, whether it came from the key handler or a native menu accelerator. */
  function runShortcut(action: ShortcutAction) {
    switch (action) {
      case 'new-tab':
        void createTab();
        break;
      case 'new-private-tab':
        void createTab(true);
        break;
      case 'new-window':
        void call('new_browser_window').catch((error) => setMessage(String(error)));
        break;
      case 'close-window':
        void call('close_browser_window').catch((error) => setMessage(String(error)));
        break;
      case 'print':
        void runNavigationCommand('print_page');
        break;
      case 'bookmark-page':
        addCurrentPage();
        break;
      case 'toggle-sidebar':
        setSidebarCollapsed((collapsed) => !collapsed);
        break;
      case 'toggle-devtools':
        void call('toggle_devtools').catch((error) => setMessage(String(error)));
        break;
      case 'view-source':
        void openViewSource();
        break;
      case 'reload-ignoring-cache':
        void runNavigationCommand('reload_ignoring_cache');
        break;
      case 'find-next':
      case 'find-previous':
        // Like Safari, ⌘G with no search yet opens the find bar.
        if (findOpen && findQuery.trim()) void findInPage(findQuery, action === 'find-previous');
        else openFindPanel();
        break;
      case 'open-in-browser':
        externalBrowserButtonRef.current?.click();
        break;
      case 'close-tab':
        if (activeTabIdRef.current) void closeTab(activeTabIdRef.current);
        break;
      case 'reopen-closed-tab':
        void reopenClosedTab();
        break;
      case 'focus-address':
        addressRef.current?.focus();
        addressRef.current?.select();
        break;
      case 'reload':
        void runNavigationCommand('reload');
        break;
      case 'go-back':
        void runNavigationCommand('go_back');
        break;
      case 'go-forward':
        void runNavigationCommand('go_forward');
        break;
      case 'find':
        openFindPanel();
        break;
      case 'next-tab':
        void cycleTabs(false);
        break;
      case 'stop-loading':
        void runNavigationCommand('stop_loading');
        break;
      case 'select-last-tab':
      case 'select-tab-1':
      case 'select-tab-2':
      case 'select-tab-3':
      case 'select-tab-4':
      case 'select-tab-5':
      case 'select-tab-6':
      case 'select-tab-7':
      case 'select-tab-8': {
        const position = action === 'select-last-tab' ? 'last' : Number(action.slice('select-tab-'.length));
        const tabId = tabAtShortcutPosition(visibleTabOrder(), position);
        if (tabId && tabId !== activeTabIdRef.current) void selectTab(tabId);
        break;
      }
      case 'previous-tab':
        void cycleTabs(true);
        break;
      case 'capture-full-page': {
        const tabId = activeTabIdRef.current;
        if (!tabId) break;
        setMessage('Capturing full page…');
        void call('save_full_page_screenshot', { tabId })
          .then((saved) => setMessage(saved ? 'Full page screenshot saved.' : 'Screenshot cancelled.'))
          .catch((error) => setMessage(String(error)));
        break;
      }
    }
  }

  const browserActions = useLatest({
    openTabContextMenu,
    showBookmarksManager,
    closeTab,
    createTab,
    cycleTabs,
    dropTabIntoNewWindow,
    dropTabIntoSplit,
    openAllDownloadsPage,
    openDownloadsPopover,
    openHistoryPage,
    openLaunchRequest,
    openSettingsPage,
    openShortcutsPage,
    openUrlFromMenu,
    reopenClosedTab,
    reorderTabsFromTree,
    runShortcut,
    storeTabTree,
  });
  useEffect(() => {
    if (import.meta.env.MODE !== 'desktop-test') return;
    const testWindow = window as typeof window & {
      __unkyTestOpenTabContextMenu?: (tabId: string) => void;
      __unkyTestTabMenu?: () => { label: string; path: string[]; enabled: boolean; accelerator?: string }[] | null;
      __unkyTestActivateTabMenuItem?: (label: string) => boolean;
      __unkyTestCloseTabMenu?: () => void;
      __unkyTestSeedTabFolders?: () => void;
    };
    testWindow.__unkyTestOpenTabContextMenu = (tabId) => {
      if (tabId) browserActions.current.openTabContextMenu({ id: tabId, type: 'tab', x: 100, y: 100 });
    };
    testWindow.__unkyTestTabMenu = () =>
      testTabMenuRef.current &&
      flattenMenuEntries(testTabMenuRef.current).map(({ label, path, enabled, accelerator }) => ({
        label,
        path,
        enabled,
        accelerator,
      }));
    testWindow.__unkyTestActivateTabMenuItem = (label) => {
      const item = flattenMenuEntries(testTabMenuRef.current ?? []).find(
        (entry) => entry.label === label && entry.enabled,
      );
      if (!item) return false;
      testTabMenuRef.current = null;
      item.action();
      return true;
    };
    testWindow.__unkyTestCloseTabMenu = () => {
      testTabMenuRef.current = null;
    };
    testWindow.__unkyTestSeedTabFolders = () => {
      browserActions.current.storeTabTree([
        { id: 'desktop-test-folder', type: 'folder', title: 'Desktop Test Folder', collapsed: false, children: [] },
      ]);
    };
    return () => {
      delete testWindow.__unkyTestOpenTabContextMenu;
      delete testWindow.__unkyTestTabMenu;
      delete testWindow.__unkyTestActivateTabMenuItem;
      delete testWindow.__unkyTestCloseTabMenu;
      delete testWindow.__unkyTestSeedTabFolders;
    };
  }, [browserActions]);
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void onEvent(openTabInFolderEvent, async (event) => {
      const [tabId, folderId] = event.payload;
      try {
        applySnapshot(await call('get_browser_state'));
        const inserted = appendTabNodeToFolder(tabNodesRef.current, folderId, { id: tabId, type: 'tab' });
        if (inserted.inserted) browserActions.current.reorderTabsFromTree(inserted.nodes);
      } catch (error) {
        setMessage(String(error));
      }
    }).then((listener) => {
      if (cancelled) listener();
      else unlisten = listener;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [isTauri, applySnapshot, browserActions]);

  useEffect(() => {
    if (!tabsLoaded) return;
    const reconciled = reconcileTabNodes(tabNodesRef.current, tabs);
    if (JSON.stringify(reconciled) !== JSON.stringify(tabNodesRef.current)) {
      tabNodesRef.current = reconciled;
      setTabNodes(reconciled);
    }
    const openIds = new Set(tabs.map((tab) => tab.id));
    setTabNameOverrides((names) => Object.fromEntries(Object.entries(names).filter(([id]) => openIds.has(id))));
    setHistoryTabIds((ids) => ids.filter((id) => openIds.has(id)));
    setSettingsTabIds((ids) => {
      const next = ids.filter((id) => openIds.has(id));
      settingsTabIdsRef.current = next;
      return next;
    });
    setShortcutsTabIds((ids) => {
      const next = ids.filter((id) => openIds.has(id));
      shortcutsTabIdsRef.current = next;
      return next;
    });
    setSourceTabs((sources) =>
      Object.keys(sources).every((id) => openIds.has(id))
        ? sources
        : Object.fromEntries(Object.entries(sources).filter(([id]) => openIds.has(id))),
    );
  }, [tabs, tabsLoaded]);

  // Source tabs saved before a restart: download each address again.
  useEffect(() => {
    if (!isTauri) return;
    const pending = Object.entries(restoringSourceTabs.current);
    restoringSourceTabs.current = {};
    for (const [tabId, state] of pending) {
      const url = sourceTabUrl(state);
      const settle = (next: SourceTabState) =>
        setSourceTabs((sources) => (sources[tabId]?.status === 'loading' ? { ...sources, [tabId]: next } : sources));
      void call('restore_page_source', { url })
        .then((page) => settle({ status: 'ready', page }))
        .catch((error) => settle({ status: 'error', url, message: String(error) }));
    }
  }, [isTauri]);

  useEffect(() => {
    if (!isTauri || !tabsLoaded) return;
    void call('set_settings_open', {
      open: settingsPageOpen || historyPageOpen || shortcutsPageOpen || downloadsPageOpen || sourcePageOpen,
    }).catch((error) => setMessage(String(error)));
  }, [isTauri, tabsLoaded, settingsPageOpen, historyPageOpen, shortcutsPageOpen, downloadsPageOpen, sourcePageOpen]);

  useEffect(() => {
    for (const tab of tabs) {
      // Wait until navigation finishes so the page's <link rel="icon"> is
      // present before querying the native WebView (e.g. Hacker News).
      if (tab.loading || !tab.url || !/^https?:/i.test(tab.url)) continue;
      const requestKey = `${tab.id}:${tab.url}`;
      if (faviconRequests.current.has(requestKey)) continue;
      faviconRequests.current.add(requestKey);
      window.setTimeout(() => {
        void call('get_tab_favicon', { tabId: tab.id })
          .then((favicon) => {
            if (favicon) setTabFavicons((current) => ({ ...current, [tab.id]: favicon }));
          })
          .catch(() => {
            faviconRequests.current.delete(requestKey);
          });
      }, 100);
    }
  }, [tabs]);

  useEffect(() => {
    const preference = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      document.documentElement.dataset.theme = theme === 'system' ? (preference.matches ? 'light' : 'dark') : theme;
    };
    apply();
    preference.addEventListener('change', apply);
    return () => preference.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    document.documentElement.dataset.accent = accentColor;
  }, [accentColor]);

  // The View > Appearance menu and native window chrome follow the theme in every browser window.
  useEffect(() => {
    if (isTauri) void call('sync_theme_menu', { theme }).catch((error) => setMessage(String(error)));
  }, [theme, isTauri]);

  useEffect(() => {
    if (!isTauri) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void onEvent(themeMenuEvent, (event) => {
      if (isTheme(event.payload)) setTheme(event.payload);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch((error) => setMessage(String(error)));
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [isTauri]);

  useEffect(() => {
    if (isTauri && tabsLoaded) {
      void call('set_page_context_menu_enabled', { enabled: customPageContextMenuEnabled }).catch((error) =>
        setMessage(String(error)),
      );
    }
  }, [customPageContextMenuEnabled, isTauri, tabsLoaded]);

  useEffect(() => {
    if (!resizingSidebar) return;
    const resize = (event: PointerEvent) => {
      const pointerWidth = sidebarSide === 'right' ? window.innerWidth - event.clientX : event.clientX;
      const width = Math.max(sidebarMinWidth, Math.min(sidebarMaxWidth, pointerWidth));
      setSidebarWidth(width);
    };
    const stop = () => setResizingSidebar(false);
    window.addEventListener('pointermove', resize);
    window.addEventListener('pointerup', stop, { once: true });
    return () => {
      window.removeEventListener('pointermove', resize);
      window.removeEventListener('pointerup', stop);
    };
  }, [resizingSidebar, sidebarSide]);

  useEffect(() => {
    if (!findOpen) return;
    const frame = window.requestAnimationFrame(() => {
      findRef.current?.focus();
      findRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [findOpen]);

  useEffect(() => {
    if (!findOpen || !findQuery.trim()) return;
    const timer = window.setTimeout(() => void findInPage(findQuery), 125);
    return () => window.clearTimeout(timer);
  }, [findOpen, findQuery, findInPage]);

  useEffect(() => {
    if (import.meta.env.MODE !== 'desktop-test') return;
    const testWindow = window as typeof window & {
      __unkyTestResetTabUi?: () => void;
      __unkyTestSyncTabSnapshot?: (snapshot: BrowserSnapshot) => void;
      __unkyTestSetTabPosition?: (position: unknown) => void;
    };
    testWindow.__unkyTestResetTabUi = () => {
      setSidebarView('tabs');
      setSidebarCollapsed(false);
      setPinnedTabIds([]);
      setTabPosition('left');
      setSidebarSide('left');
      testTabMenuRef.current = null;
      storeTabTree(reconcileTabNodes([], tabsRef.current));
    };
    testWindow.__unkyTestSyncTabSnapshot = (snapshot) => {
      applySnapshot(snapshot);
      setPinnedTabIds([]);
      storeTabTree(reconcileTabNodes([], snapshot.tabs));
    };
    testWindow.__unkyTestSetTabPosition = (position) => {
      if (!isTabPosition(position)) return;
      setTabPosition(position);
      if (position === 'left' || position === 'right') setSidebarSide(position);
    };
    return () => {
      delete testWindow.__unkyTestResetTabUi;
      delete testWindow.__unkyTestSyncTabSnapshot;
      delete testWindow.__unkyTestSetTabPosition;
    };
  }, [applySnapshot]);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      const available = Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
      setIsTauri(available);
      if (!available) {
        dispatchBookmarks({ type: 'loaded' });
        return;
      }
      unlisten = await onEvent(tabEvent, (event) => applySnapshot(event.payload));
      const unlistenPagePointerDown = await onEvent(pagePointerDownEvent, () => addressRef.current?.blur());
      const unlistenSettings = await onEvent(settingsEvent, () => {
        void browserActions.current.openSettingsPage();
      });
      const unlistenShowHistory = await onEvent(showHistoryEvent, () => {
        void browserActions.current.openHistoryPage();
      });
      const unlistenShowDownloads = await onEvent(
        showDownloadsEvent,
        () => void browserActions.current.openDownloadsPopover(false),
      );
      const unlistenShowAllDownloads = await onEvent(showAllDownloadsEvent, () => {
        void browserActions.current.openAllDownloadsPage();
      });
      const unlistenShowShortcuts = await onEvent(showShortcutsEvent, () => {
        void browserActions.current.openShortcutsPage();
      });
      const unlistenShowBookmarks = await onEvent(showBookmarksEvent, () => {
        browserActions.current.showBookmarksManager();
      });
      const unlistenHistory = await onEvent(historyEvent, (event) => setHistory(event.payload));
      const unlistenBookmarks = await onEvent(bookmarksEvent, (event) =>
        dispatchBookmarks({ type: 'replaced', nodes: event.payload }),
      );
      const unlistenOpenUrlFromMenu = await onEvent(openUrlFromMenuEvent, (event) => {
        void browserActions.current.openUrlFromMenu(event.payload);
      });
      const unlistenImportBookmarks = await onEvent(importBookmarksEvent, () => {
        void importBookmarksHtml();
      });
      const unlistenExportBookmarks = await onEvent(exportBookmarksEvent, () => {
        void exportBookmarksHtml();
      });
      const unlistenClearHistory = await onEvent(clearHistoryRequestEvent, () => {
        void clearHistory();
      });
      const unlistenDownloads = await onEvent(downloadsEvent, (event) => setDownloads(event.payload));
      const unlistenCaptureStatus = await onEvent(captureStatusEvent, (event) => {
        setMessage(event.payload);
        if (event.payload !== 'Capturing full page…') setCaptureProgress(null);
      });
      const unlistenCaptureProgress = await onEvent(captureProgressEvent, (event) => setCaptureProgress(event.payload));
      const unlistenLaunchRequest = await onEvent(launchRequestEvent, (event) => {
        void browserActions.current.openLaunchRequest(event.payload);
      });
      const unlistenFilterProgress = await onEvent(filterUpdateProgressEvent, (event) => {
        if (event.payload.phase === 'complete') {
          setFilterProgress(null);
          return;
        }
        setFilterProgress(event.payload);
      });
      const unlistenSplit = await onEvent(splitEvent, (event) => setSplitLayout(event.payload));
      const unlistenSplitResize = await onEvent(splitResizeEvent, (event) => {
        void call('resize_tab_split', { firstPanePercent: event.payload }).catch((error) => setMessage(String(error)));
      });
      const unlistenTabDragDrop = await onEvent(tabDragDropEvent, (event) => {
        if (event.payload.target === 'new-window')
          void browserActions.current.dropTabIntoNewWindow(event.payload.tabId);
        else
          void browserActions.current.dropTabIntoSplit(
            event.payload.target,
            event.payload.tabId,
            event.payload.targetTabId,
          );
      });
      void call('get_split_tabs')
        .then(setSplitLayout)
        .catch((error) => setMessage(String(error)));
      void call('get_filter_settings')
        .then(setFilterSettings)
        .catch((error) => setMessage(String(error)));
      const unlistenShortcuts = await onEvent(shortcutEvent, (event) => {
        const action = shortcutFromMenu(event.payload);
        if (action) browserActions.current.runShortcut(action);
      });
      try {
        const databaseBookmarks = await call('load_bookmarks', {
          legacyBookmarks: initialBookmarks(),
        });
        dispatchBookmarks({ type: 'loaded', nodes: databaseBookmarks });
        localStorage.removeItem(storageKeys.bookmarks);
        applySnapshot(await call('get_browser_state'));
        const launchRequest = await call('take_launch_request');
        if (launchRequest) await browserActions.current.openLaunchRequest(launchRequest);
        setHistory(await call('get_history'));
        setDownloads(await call('get_downloads'));
      } catch (error) {
        dispatchBookmarks({ type: 'loaded' });
        setMessage(String(error));
      }
      if (!cancelled) void runSessionIntegrationTest();
      if (cancelled) {
        unlisten();
        unlistenPagePointerDown();
        unlistenSettings();
        unlistenShowHistory();
        unlistenShowDownloads();
        unlistenShowAllDownloads();
        unlistenShowShortcuts();
        unlistenShowBookmarks();
        unlistenShortcuts();
        unlistenHistory();
        unlistenBookmarks();
        unlistenOpenUrlFromMenu();
        unlistenImportBookmarks();
        unlistenExportBookmarks();
        unlistenClearHistory();
        unlistenDownloads();
        unlistenCaptureStatus();
        unlistenCaptureProgress();
        unlistenSplit();
        unlistenSplitResize();
        unlistenTabDragDrop();
        unlistenFilterProgress();
        unlistenLaunchRequest();
      } else {
        const originalUnlisten = unlisten;
        unlisten = () => {
          originalUnlisten();
          unlistenPagePointerDown();
          unlistenSettings();
          unlistenShowHistory();
          unlistenShowDownloads();
          unlistenShowAllDownloads();
          unlistenShowShortcuts();
          unlistenShowBookmarks();
          unlistenShortcuts();
          unlistenHistory();
          unlistenBookmarks();
          unlistenOpenUrlFromMenu();
          unlistenImportBookmarks();
          unlistenExportBookmarks();
          unlistenClearHistory();
          unlistenDownloads();
          unlistenCaptureStatus();
          unlistenCaptureProgress();
          unlistenSplit();
          unlistenSplitResize();
          unlistenTabDragDrop();
          unlistenFilterProgress();
          unlistenLaunchRequest();
        };
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [applySnapshot, browserActions]);

  useEffect(() => {
    if (!nativeDownloadsPopover) return;
    if (!downloadsPopoverOpen) {
      void controlDownloadsPopover('close').catch((error) => setMessage(String(error)));
      return;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const shown = await controlDownloadsPopover('update');
        if (!cancelled) setDownloadsPopoverOpen(shown);
      } catch (error) {
        if (!cancelled) setMessage(String(error));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [nativeDownloadsPopover, downloadsPopoverOpen, downloads, controlDownloadsPopover]);

  useEffect(() => {
    if (!downloadsPopoverOpen || nativeDownloadsPopover) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (document.querySelector('.downloads-trigger')?.contains(target)) return;
      if (document.querySelector('.downloads-popover')?.contains(target)) return;
      setDownloadsPopoverOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setDownloadsPopoverOpen(false);
    };
    document.addEventListener('pointerdown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [downloadsPopoverOpen, nativeDownloadsPopover]);

  async function runSessionIntegrationTest() {
    if (sessionTestStarted.current) return;
    sessionTestStarted.current = true;
    let snapshot: BrowserSnapshot | undefined;
    try {
      const phase = await call('session_test_phase');
      if (phase !== 'exercise' && phase !== 'restore') return;
      snapshot = await call('get_browser_state');
      if (phase === 'exercise') {
        assertSessionTestState(snapshot, sessionTestUrls, sessionTestUrls[1]);
        const expectedFavicon = 'http://127.0.0.1:4179/favicon.svg';
        const nativeFavicon = await call('get_tab_favicon', { tabId: snapshot.activeTabId });
        if (nativeFavicon !== expectedFavicon) {
          throw new Error(`Native WebView did not resolve the fixture favicon: ${nativeFavicon || 'missing'}`);
        }
        let renderedFavicon = '';
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const row = Array.from(document.querySelectorAll<HTMLElement>('.tab-row')).find(
            (item) => item.dataset.tabId === snapshot?.activeTabId,
          );
          const image = row?.querySelector<HTMLImageElement>('.tab-favicon img');
          if (image?.complete && image.naturalWidth > 0) {
            renderedFavicon = image.src;
            break;
          }
          await new Promise((resolve) => window.setTimeout(resolve, 50));
        }
        if (renderedFavicon !== expectedFavicon) {
          throw new Error(`Native tab favicon was not loaded after page navigation: ${renderedFavicon || 'missing'}`);
        }
        const survivor = await call('close_tab', { tabId: snapshot.activeTabId });
        assertSessionTestState(survivor, [sessionTestUrls[0]], sessionTestUrls[0]);
        window.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 't',
            metaKey: true,
            shiftKey: true,
            bubbles: true,
          }),
        );
        for (let attempt = 0; attempt < 40; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 100));
          snapshot = await call('get_browser_state');
          if (snapshot.tabs.length === 2 && snapshot.activeTabId !== survivor.activeTabId) break;
        }
        assertSessionTestState(snapshot, sessionTestUrls, sessionTestUrls[1]);
        const reopened = snapshot.tabs.find((tab) => tab.id === snapshot?.activeTabId);
        if (reopened?.zoom !== 1.5) throw new Error(`Expected reopened tab zoom 1.5, got ${reopened?.zoom}`);
        if (
          (await call('find_in_page', {
            tabId: snapshot.activeTabId,
            query: 'Native find marker',
            backwards: false,
          })) < 1
        ) {
          throw new Error('Native find failed to locate text in the WKWebView');
        }
        if (
          (await call('find_in_page', {
            tabId: snapshot.activeTabId,
            query: 'missing integration phrase',
            backwards: false,
          })) !== 0
        ) {
          throw new Error('Native find reported a match for missing text');
        }
        const linkHook = await call('session_test_open_new_tab');
        const parsedLinkHook: unknown = JSON.parse(linkHook);
        const hookState: { hook: boolean; tauri: string; result: string } =
          typeof parsedLinkHook === 'string'
            ? JSON.parse(parsedLinkHook)
            : (parsedLinkHook as { hook: boolean; tauri: string; result: string });
        if (!hookState.hook || hookState.tauri !== 'function' || hookState.result !== 'opened') {
          throw new Error(`The native page link handler failed: ${linkHook}`);
        }
        for (let attempt = 0; attempt < 50; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 100));
          snapshot = await call('get_browser_state');
          if (snapshot.tabs.some((tab) => tab.url.includes('session=from-link'))) break;
        }
        if (!snapshot.tabs.some((tab) => tab.url === 'http://127.0.0.1:4179/index.html?session=from-link')) {
          throw new Error('A target=_blank link did not open in a new native tab');
        }
        const previousSnapshot = await call('cycle_tab', { backwards: true });
        snapshot = previousSnapshot;
        if (previousSnapshot.tabs.find((tab) => tab.id === previousSnapshot.activeTabId)?.url !== sessionTestUrls[1]) {
          throw new Error('Previous-tab cycling did not select the prior tab');
        }
        const nextSnapshot = await call('cycle_tab', { backwards: false });
        snapshot = nextSnapshot;
        if (
          nextSnapshot.tabs.find((tab) => tab.id === nextSnapshot.activeTabId)?.url !==
          'http://127.0.0.1:4179/index.html?session=from-link'
        ) {
          throw new Error('Next-tab cycling did not wrap to the link tab');
        }
        const history = await call('get_history');
        if (!history.some((item) => item.url.includes('session=from-link')))
          throw new Error('Visited link tab was not added to history');
        snapshot = await call('close_tab', { tabId: snapshot.activeTabId });
        await call('session_test_start_download');
        let downloads: Download[] = [];
        for (let attempt = 0; attempt < 100; attempt += 1) {
          await new Promise((resolve) => window.setTimeout(resolve, 100));
          downloads = await call('get_downloads');
          if (downloads.some((item) => item.status === 'completed')) break;
        }
        const completed = downloads.find((item) => item.filename === 'download.txt' && item.status === 'completed');
        if (!completed || completed.bytesReceived === 0)
          throw new Error(`Native download failed or had no bytes: ${JSON.stringify(downloads)}`);
        await call('reveal_download', { downloadId: completed.id });
      } else {
        assertSessionTestState(snapshot, sessionTestUrls, sessionTestUrls[1]);
        if (snapshot.tabs[0]?.zoom !== 1.25 || snapshot.tabs[1]?.zoom !== 1.5) {
          throw new Error('Restored tabs did not preserve their zoom values');
        }
        const history = await call('get_history');
        if (!history.some((item) => item.url.includes('session=from-link')))
          throw new Error('History did not persist across app restart');
      }
      await call('report_session_test', {
        success: true,
        details: `${phase} phase passed`,
        snapshot,
      });
    } catch (error) {
      if (!snapshot) return;
      await call('report_session_test', {
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
      // Website tabs are native sibling WebViews above this shell WebView, so
      // CSS z-index cannot put the toolbar popover above them. Reserve its
      // right-side footprint until it closes, leaving the shell visible there.
      const popoverWidth = Math.min(360, Math.max(0, window.innerWidth - 24));
      const reservedWidth = downloadsPopoverOpen && !nativeDownloadsPopover ? popoverWidth + 20 : 0;
      void call('set_view_bounds', {
        x: rect.left,
        y: rect.top,
        width: Math.max(1, rect.width - reservedWidth),
        height: rect.height,
      }).catch((error) => setMessage(String(error)));
    };
    const observer = new ResizeObserver(updateBounds);
    observer.observe(view);
    updateBounds();
    window.addEventListener('resize', updateBounds);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateBounds);
    };
  }, [isTauri, downloadsPopoverOpen, nativeDownloadsPopover]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowLeft' && event.target instanceof HTMLElement && event.target.dataset.sidebarSizer) {
        event.preventDefault();
        setSidebarWidth((width) => Math.max(sidebarMinWidth, width - 12));
      }
      if (event.key === 'ArrowRight' && event.target instanceof HTMLElement && event.target.dataset.sidebarSizer) {
        event.preventDefault();
        setSidebarWidth((width) => Math.min(sidebarMaxWidth, width + 12));
      }
      if (event.key === 'Escape' && findOpen) {
        setFindOpen(false);
        setFindQuery('');
        setFindMatches(null);
        return;
      }
      const action = shortcutForKey(event, isApplePlatform);
      if (!action) return;
      event.preventDefault();
      runShortcut(action);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  async function openHistoryEntry(url: string) {
    if (!activeTabId) {
      try {
        const snapshot = await call('create_tab');
        applySnapshot(snapshot);
        await call('navigate', { tabId: snapshot.activeTabId, url });
      } catch (error) {
        setMessage(String(error));
      }
    } else void navigateTo(url);
  }

  async function openUrlFromMenu(url: string) {
    const tabId = activeTabIdRef.current;
    try {
      if (tabId) await call('navigate', { tabId, url });
      else {
        const snapshot = await call('create_tab');
        applySnapshot(snapshot);
        await call('navigate', { tabId: snapshot.activeTabId, url });
      }
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function importBookmarksHtml() {
    try {
      const path = await openFileDialog({
        multiple: false,
        directory: false,
        filters: [{ name: 'Netscape Bookmarks', extensions: ['html', 'htm'] }],
      });
      if (typeof path !== 'string') return;
      dispatchBookmarks({ type: 'replaced', nodes: await call('import_bookmarks_html', { path }) });
      setMessage('Bookmarks imported.');
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function exportBookmarksHtml() {
    try {
      const path = await saveFileDialog({
        defaultPath: 'bookmarks.html',
        filters: [{ name: 'Netscape Bookmarks', extensions: ['html'] }],
      });
      if (!path) return;
      await call('export_bookmarks_html', { path });
      setMessage('Bookmarks exported.');
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function clearHistory() {
    if (!window.confirm('Clear all browsing history? Bookmarks will stay.')) return;
    try {
      await call('clear_history');
      setHistory([]);
      setMessage('Browsing history cleared.');
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function openHistoryPage() {
    const existingHistoryTabId = [...historyTabIds].reverse().find((id) => tabs.some((tab) => tab.id === id));
    if (existingHistoryTabId) {
      await selectTab(existingHistoryTabId);
    } else {
      try {
        await call('set_settings_open', { open: true });
        const snapshot = await call('create_tab');
        applySnapshot(snapshot);
        setHistoryTabIds((ids) => [...ids, snapshot.activeTabId]);
        setTabNameOverrides((names) => ({ ...names, [snapshot.activeTabId]: 'history' }));
        setAddress(internalPageUrl('history'));
      } catch (error) {
        setMessage(String(error));
        void call('set_settings_open', { open: false }).catch(() => {});
        return;
      }
    }
    try {
      setHistory(await call('get_history'));
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function openAllDownloadsPage() {
    setDownloadsPopoverOpen(false);
    const existing = [...downloadsTabIds].reverse().find((id) => tabs.some((tab) => tab.id === id));
    if (existing) {
      await selectTab(existing);
      return;
    }
    try {
      await call('set_settings_open', { open: true });
      const snapshot = await call('create_tab');
      applySnapshot(snapshot);
      setDownloadsTabIds((ids) => [...ids, snapshot.activeTabId]);
      setTabNameOverrides((names) => ({ ...names, [snapshot.activeTabId]: 'Downloads' }));
      setAddress(internalPageUrl('downloads'));
    } catch (error) {
      setMessage(String(error));
    }
  }

  useEffect(() => {
    if (!isTauri) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void call('search_history', { query: historySearch })
        .then((entries) => {
          if (!cancelled) setHistory(entries);
        })
        .catch((error) => {
          if (!cancelled) setMessage(String(error));
        });
    }, 120);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [historySearch, isTauri]);

  async function openShortcutsPage() {
    const existingId = [...shortcutsTabIdsRef.current]
      .reverse()
      .find((id) => tabsRef.current.some((tab) => tab.id === id));
    if (existingId) {
      await selectTab(existingId);
      return;
    }
    try {
      const snapshot = await call('create_tab');
      applySnapshot(snapshot);
      setShortcutsTabIds((ids) => {
        const next = [...ids, snapshot.activeTabId];
        shortcutsTabIdsRef.current = next;
        return next;
      });
      setTabNameOverrides((names) => ({ ...names, [snapshot.activeTabId]: 'Keyboard Shortcuts' }));
      setAddress(internalPageUrl('shortcuts'));
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function openSettingsPage() {
    // Remember the website being viewed so Settings can manage its filter exception.
    const sourceTab = tabsRef.current.find((tab) => tab.id === activeTabIdRef.current);
    if (sourceTab && siteDomain(sourceTab.url)) setSettingsSourceTabId(sourceTab.id);
    const existingId = [...settingsTabIdsRef.current]
      .reverse()
      .find((id) => tabsRef.current.some((tab) => tab.id === id));
    if (existingId) {
      await selectTab(existingId);
      return;
    }
    try {
      await call('set_settings_open', { open: true });
      const snapshot = await call('create_tab');
      applySnapshot(snapshot);
      setSettingsTabIds((ids) => {
        const next = [...ids, snapshot.activeTabId];
        settingsTabIdsRef.current = next;
        return next;
      });
      setTabNameOverrides((names) => ({ ...names, [snapshot.activeTabId]: 'Settings' }));
      setAddress(internalPageUrl('settings'));
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function leaveHistoryTab(tabId: string) {
    const wasInternalPage =
      historyTabIds.includes(tabId) ||
      settingsTabIds.includes(tabId) ||
      shortcutsTabIds.includes(tabId) ||
      downloadsTabIds.includes(tabId) ||
      tabId in sourceTabs;
    if (!wasInternalPage) return;
    forgetSourceTab(tabId);
    setHistoryTabIds((ids) => ids.filter((id) => id !== tabId));
    setSettingsTabIds((ids) => {
      const next = ids.filter((id) => id !== tabId);
      settingsTabIdsRef.current = next;
      return next;
    });
    setShortcutsTabIds((ids) => {
      const next = ids.filter((id) => id !== tabId);
      shortcutsTabIdsRef.current = next;
      return next;
    });
    setDownloadsTabIds((ids) => ids.filter((id) => id !== tabId));
    setTabNameOverrides((names) => {
      const next = { ...names };
      delete next[tabId];
      return next;
    });
    try {
      await call('set_settings_open', { open: settingsPageOpen || shortcutsPageOpen });
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function createTab(privateMode = false) {
    try {
      applySnapshot(await call('create_tab', { private: privateMode }));
      addressRef.current?.focus();
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function openLaunchRequest(request: LaunchRequest) {
    try {
      const snapshot = await call('create_tab', { private: request.private });
      applySnapshot(snapshot);
      await call('navigate', { tabId: snapshot.activeTabId, url: request.url });
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function clearBrowsingData() {
    if (!window.confirm('Clear all website data and browsing history? Bookmarks will stay.')) return;
    try {
      await call('clear_browsing_data');
      setMessage('Website data clearing started; it may take a moment. History was cleared.');
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function changeFilteringEnabled(enabled: boolean) {
    setFilterBusy(true);
    try {
      setFilterSettings(await call('set_filtering_enabled', { enabled }));
    } catch (error) {
      setMessage(String(error));
    } finally {
      setFilterBusy(false);
    }
  }

  async function updateFilterList() {
    setFilterBusy(true);
    setFilterProgress({ phase: 'downloading', receivedBytes: 0, totalBytes: null });
    try {
      setFilterSettings(await call('update_filter_list'));
    } catch (error) {
      setMessage(String(error));
    } finally {
      setFilterBusy(false);
      setFilterProgress(null);
    }
  }

  async function changeSiteFilterException(enabled: boolean) {
    if (!siteForFilter) return;
    setFilterBusy(true);
    try {
      setFilterSettings(await call('set_filter_site_exception', { domain: siteForFilter, enabled }));
    } catch (error) {
      setMessage(String(error));
    } finally {
      setFilterBusy(false);
    }
  }

  async function dropTabIntoSplit(
    side: 'left' | 'right' | 'top' | 'bottom',
    draggedTabId = draggingTabId,
    targetTabId = activeTabIdRef.current,
  ) {
    const tabId = draggedTabId;
    if (!tabId) {
      setMessage('Choose a loaded tab to create a split view.');
      return;
    }
    try {
      let targetId = targetTabId;
      if (tabId === targetTabId) {
        const snapshot = await call('create_tab');
        applySnapshot(snapshot);
        targetId = snapshot.activeTabId;
      }
      await call('split_tab', { tabId, targetTabId: targetId, side });
      const firstTabId = side === 'left' || side === 'top' ? tabId : targetId;
      setSplitLayout({
        firstTabId,
        secondTabId: firstTabId === tabId ? targetId : tabId,
        orientation: side === 'left' || side === 'right' ? 'horizontal' : 'vertical',
        firstPanePercent: 50,
      });
    } catch (error) {
      setMessage(String(error));
    }
    setDraggingTabId('');
    void call('set_tab_dragging', { dragging: false, tabId: null, targetTabId: null }).catch((error) =>
      setMessage(String(error)),
    );
  }

  async function dropTabIntoNewWindow(draggedTabId = draggingTabId) {
    const tabId = draggedTabId;
    if (!tabId) return;
    try {
      await call('move_tab_to_new_window', { tabId });
      setMessage('Tab moved to a new window.');
    } catch (error) {
      setMessage(String(error));
    }
    setDraggingTabId('');
    void call('set_tab_dragging', { dragging: false, tabId: null, targetTabId: null }).catch((error) =>
      setMessage(String(error)),
    );
  }

  async function closeSplitView() {
    try {
      await call('clear_tab_split');
      setSplitLayout(null);
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function selectTab(id: string) {
    try {
      applySnapshot(await call('select_tab', { tabId: id }));
    } catch (error) {
      setMessage(String(error));
    }
  }

  function forgetSourceTab(tabId: string) {
    setSourceTabs((tabs) => {
      if (!(tabId in tabs)) return tabs;
      const next = { ...tabs };
      delete next[tabId];
      return next;
    });
  }

  /** ⌥⌘U: show the active page's HTML in a new tab below it. */
  async function openViewSource() {
    const page = tabsRef.current.find((tab) => tab.id === activeTabIdRef.current);
    if (!page || sourceTabs[page.id] || !canViewSource(page.url)) {
      setMessage('This tab has no page source to show.');
      return;
    }
    const { id: pageTabId, url, title } = page;
    let sourceTabId: string;
    try {
      const snapshot = await call('create_tab');
      sourceTabId = snapshot.activeTabId;
      setSourceTabs((tabs) => ({ ...tabs, [sourceTabId]: { status: 'loading', url } }));
      applySnapshot(snapshot);
      reorderTabsFromTree(insertTabNode(tabNodesRef.current, pageTabId, { id: sourceTabId, type: 'tab' }, true).nodes);
      setTabNameOverrides((names) => ({ ...names, [sourceTabId]: sourceTabTitle(title, url) }));
      setAddress(viewSourceUrl(url));
    } catch (error) {
      setMessage(String(error));
      return;
    }
    try {
      const source = await call('get_page_source', { tabId: pageTabId });
      setSourceTabs((tabs) =>
        sourceTabId in tabs ? { ...tabs, [sourceTabId]: { status: 'ready', page: source } } : tabs,
      );
    } catch (error) {
      setSourceTabs((tabs) =>
        sourceTabId in tabs ? { ...tabs, [sourceTabId]: { status: 'error', url, message: String(error) } } : tabs,
      );
    }
  }

  async function closeTab(id: string) {
    forgetSourceTab(id);
    try {
      applySnapshot(await call('close_tab', { tabId: id }));
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function duplicateTab(id: string) {
    const source = tabsRef.current.find((tab) => tab.id === id);
    if (!source) return;
    try {
      const snapshot = await call('create_tab', { private: source.private });
      applySnapshot(snapshot);
      if (source.url) await call('navigate', { tabId: snapshot.activeTabId, url: source.url });
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function reopenClosedTab() {
    try {
      applySnapshot(await call('reopen_closed_tab'));
    } catch (error) {
      setMessage(String(error));
    }
  }

  /** Open the built-in page an address names, as typing `chrome://settings` does in Chrome. */
  function openInternalPage(page: InternalPage) {
    addressRef.current?.blur();
    switch (page) {
      case 'settings':
        return openSettingsPage();
      case 'history':
        return openHistoryPage();
      case 'downloads':
        return openAllDownloadsPage();
      case 'shortcuts':
        return openShortcutsPage();
      case 'bookmarks':
        showBookmarksManager();
        return;
    }
  }

  /** Expand the sidebar to the bookmarks manager. */
  function showBookmarksManager() {
    setSidebarCollapsed(false);
    setSidebarView('bookmarks');
  }

  async function navigate(event: React.FormEvent) {
    event.preventDefault();
    if (!activeTabId) return;
    setAddressSuggestionsOpen(false);
    const internalPage = parseInternalPageUrl(address);
    if (internalPage) {
      // Restore the current tab's address; the page opens in its own tab.
      setAddress(builtInAddressOfTab(activeTabId) ?? activeTab?.url ?? '');
      await openInternalPage(internalPage);
      return;
    }
    try {
      await leaveHistoryTab(activeTabId);
      setMessage('');
      await call('navigate', { tabId: activeTabId, url: address });
      addressRef.current?.blur();
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function navigateTo(url: string) {
    setAddress(url);
    setAddressSuggestionsOpen(false);
    if (!activeTabId) return;
    const internalPage = parseInternalPageUrl(url);
    if (internalPage) {
      await openInternalPage(internalPage);
      return;
    }
    try {
      await leaveHistoryTab(activeTabId);
      setMessage('');
      await call('navigate', { tabId: activeTabId, url });
      addressRef.current?.blur();
    } catch (error) {
      setMessage(String(error));
    }
  }

  function chooseAddressSuggestion(url: string) {
    setAddress(url);
    setAddressSuggestionsOpen(false);
    void navigateTo(url);
  }

  async function runNavigationCommand(
    command: 'go_back' | 'go_forward' | 'reload' | 'reload_ignoring_cache' | 'stop_loading' | 'print_page',
  ) {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    try {
      await call(command, { tabId });
    } catch (error) {
      setMessage(String(error));
    }
  }

  async function showExternalBrowsers(tabId = activeTabIdRef.current, position?: { x: number; y: number }) {
    const rect = externalBrowserButtonRef.current?.getBoundingClientRect();
    const targetTab = tabs.find((tab) => tab.id === tabId);
    const anchor = position ?? (rect ? { x: rect.left, y: rect.bottom } : undefined);
    if (!targetTab?.url.match(/^https?:\/\//) || !anchor || externalBrowserMenuLoading.current) return;
    externalBrowserMenuLoading.current = true;
    try {
      const browsers = await call('get_external_browsers');
      await externalBrowserMenuRef.current?.close();
      const menu = await Menu.new({
        items: [
          { text: targetTab.private ? 'Opens using the other browser’s session' : 'Open page in…', enabled: false },
          ...browsers.map((browser) => ({
            text: browser.name,
            action: () => {
              void call('open_in_external_browser', { tabId, browserId: browser.id }).catch((error) =>
                setMessage(String(error)),
              );
            },
          })),
          ...(browsers.length ? [] : [{ text: 'No other browsers found', enabled: false }]),
        ],
      });
      externalBrowserMenuRef.current = menu;
      await menu.popup(new LogicalPosition(anchor.x, anchor.y));
    } catch (error) {
      setMessage(String(error));
    } finally {
      externalBrowserMenuLoading.current = false;
    }
  }

  function saveBookmarkEdit(event: React.FormEvent) {
    event.preventDefault();
    const url = editBookmarkUrl.trim();
    if (!url) return;
    const duplicate = findBookmarkByUrl(bookmarks, url);
    if (duplicate && (addingBookmark || duplicate.id !== editingBookmarkId)) {
      setMessage('That address is already bookmarked.');
      return;
    }
    const title = editBookmarkTitle.trim() || url;
    const description = editBookmarkDescription.trim();
    if (addingBookmark) {
      if (addingBookmarkFolderId && locateNode(bookmarks, addingBookmarkFolderId)?.node.type !== 'folder') {
        setMessage('The destination folder no longer exists.');
        return;
      }
      const bookmark: BookmarkLink = {
        id: crypto.randomUUID(),
        type: 'bookmark',
        title,
        url,
        description,
        favicon: activeTab && activeTab.url === url ? tabFavicons[activeTab.id] : undefined,
      };
      dispatchBookmarks({ type: 'added', node: bookmark, parentId: addingBookmarkFolderId });
    } else dispatchBookmarks({ type: 'bookmarkEdited', id: editingBookmarkId, title, url, description });
    cancelBookmarkEdit();
    setMessage('');
  }

  function cancelBookmarkEdit() {
    setEditingBookmarkId('');
    setAddingBookmark(false);
    setAddingBookmarkFolderId(null);
  }

  function startAddBookmark(parentId?: string) {
    setAddingBookmarkFolderId(parentId ?? null);
    if (parentId) {
      dispatchBookmarks({ type: 'folderExpanded', id: parentId });
      setBookmarkSearch('');
    }
    setEditingBookmarkId('');
    setEditBookmarkTitle('');
    setEditBookmarkUrl('');
    setEditBookmarkDescription('');
    setAddingBookmark(true);
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
    dispatchBookmarks({
      type: 'added',
      node: {
        id: crypto.randomUUID(),
        type: 'bookmark',
        title: activeTab.title || activeTab.url,
        url: activeTab.url,
        favicon: tabFavicons[activeTab.id],
      },
    });
    setMessage('Bookmark added.');
  }

  function editBookmark(bookmark: BookmarkLink) {
    setAddingBookmark(false);
    setAddingBookmarkFolderId(null);
    setEditingBookmarkId(bookmark.id);
    setEditBookmarkTitle(bookmark.title);
    setEditBookmarkUrl(bookmark.url);
    setEditBookmarkDescription(bookmark.description ?? '');
  }

  async function openBookmarkContextMenu(event: React.MouseEvent, bookmark: BookmarkNode) {
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea')) return;
    event.preventDefault();
    event.stopPropagation();
    const position = new LogicalPosition(event.clientX, event.clientY);
    try {
      await bookmarkContextMenuRef.current?.close();
      if (bookmark.type === 'folder') {
        const menu = await Menu.new({
          items: [
            { text: 'New Bookmark', action: () => startAddBookmark(bookmark.id) },
            {
              text: 'New Folder',
              action: () => {
                setBookmarkSearch('');
                createBookmarkFolder(bookmark.id);
              },
            },
            {
              text: 'Rename',
              action: () => {
                setFolderTitle(bookmark.title);
                setEditingFolderId(bookmark.id);
              },
            },
            { text: 'Delete Folder', action: () => deleteBookmarkNode(bookmark) },
          ],
        });
        bookmarkContextMenuRef.current = menu;
        await menu.popup(position);
        return;
      }
      const open = (command: 'open_link_in_new_tab' | 'open_link_in_new_window') => {
        void call(command, { url: bookmark.url }).catch((error) => setMessage(String(error)));
      };
      const menu = await Menu.new({
        items: [
          { text: 'Open Link in New Tab', action: () => open('open_link_in_new_tab') },
          { text: 'Open Link in New Window', action: () => open('open_link_in_new_window') },
          { text: 'Edit', action: () => editBookmark(bookmark) },
        ],
      });
      bookmarkContextMenuRef.current = menu;
      await menu.popup(position);
    } catch (error) {
      setMessage(String(error));
    }
  }

  function createBookmarkFolder(parentId?: string) {
    const folder: BookmarkFolder = { id: crypto.randomUUID(), type: 'folder', title: 'New Folder', children: [] };
    dispatchBookmarks({ type: 'added', node: folder, parentId });
    setFolderTitle(folder.title);
    setEditingFolderId(folder.id);
  }

  function saveFolderTitle(folderId: string) {
    const title = folderTitle.trim() || 'New Folder';
    dispatchBookmarks({ type: 'folderRenamed', id: folderId, title });
    setEditingFolderId('');
  }

  function deleteBookmarkNode(node: BookmarkNode) {
    if (node.type === 'folder' && !window.confirm(`Delete “${node.title}” and everything inside it?`)) return;
    dispatchBookmarks({ type: 'removed', id: node.id });
  }

  function clearBookmarkExpandTimer() {
    if (bookmarkExpandTimer.current) window.clearTimeout(bookmarkExpandTimer.current.timer);
    bookmarkExpandTimer.current = null;
  }

  function endBookmarkDrag() {
    clearBookmarkExpandTimer();
    setBookmarkDropTarget(null);
    setBookmarkDragOrigin(null);
  }

  function bookmarkDropZoneFor({ active, over }: Pick<DragMoveEvent, 'active' | 'over'>): DropZone | null {
    const rect = active.rect.current.translated;
    if (!over || !rect || over.id === active.id) return null;
    const target = locateNode(bookmarks, String(over.id));
    if (!target) throw new Error(`Bookmark drop target ${String(over.id)} was not found`);
    return resolveDropZone(rect.top + rect.height / 2, over.rect.top, over.rect.height, target.node.type === 'folder');
  }

  function handleBookmarkDragStart({ active }: DragStartEvent) {
    const found = locateNode(bookmarks, String(active.id));
    if (found) setBookmarkDragOrigin({ id: String(active.id), depth: found.depth });
  }

  function handleBookmarkDragMove(event: DragMoveEvent) {
    const zone = bookmarkDropZoneFor(event);
    const overId = event.over ? String(event.over.id) : '';
    setBookmarkDropTarget((current) =>
      !zone ? null : current?.overId === overId && current.zone === zone ? current : { overId, zone },
    );
    const hoveredCollapsedFolder = zone === 'inside' && !bookmarkExpanded.has(overId);
    if (!hoveredCollapsedFolder) {
      clearBookmarkExpandTimer();
      return;
    }
    if (bookmarkExpandTimer.current?.id === overId) return;
    clearBookmarkExpandTimer();
    bookmarkExpandTimer.current = {
      id: overId,
      timer: window.setTimeout(() => {
        bookmarkExpandTimer.current = null;
        dispatchBookmarks({ type: 'folderExpanded', id: overId });
      }, 600),
    };
  }

  function handleBookmarkDragEnd(event: DragEndEvent) {
    const zone = bookmarkDropZoneFor(event);
    if (zone && bookmarkDragOrigin) {
      dispatchBookmarks({
        type: 'moved',
        activeId: String(event.active.id),
        overId: String(event.over!.id),
        zone,
        originDepth: bookmarkDragOrigin.depth,
        horizontalDelta: event.delta.x,
      });
    }
    endBookmarkDrag();
  }

  function storeTabTree(nodes: TabNode[]) {
    tabNodesRef.current = nodes;
    setTabNodes(nodes);
  }

  function reorderTabsFromTree(nodes: TabNode[]) {
    storeTabTree(nodes);
    void call('reorder_tabs', { tabIds: flattenTabIds(nodes) })
      .then(applySnapshot)
      .catch((error) => setMessage(String(error)));
  }

  /** Apply a tab-tree edit. Edits that can change tab order also send the new order to Rust. */
  function updateTabTree(action: TabTreeAction, { reorder = false } = {}) {
    const next = tabTreeReducer(tabNodesRef.current, action);
    if (next === tabNodesRef.current) return;
    if (reorder) reorderTabsFromTree(next);
    else storeTabTree(next);
  }

  function createTabFolder() {
    const folder: TabFolder = {
      id: crypto.randomUUID(),
      type: 'folder',
      title: 'New Folder',
      collapsed: false,
      children: [],
    };
    updateTabTree({ type: 'folderCreated', folder });
    setEditingTabFolderId(folder.id);
    setTabFolderTitle(folder.title);
  }

  /** Wrap the tab in a new group where it sits, then rename the group so the user can title it. */
  function moveTabToNewFolder(tabId: string) {
    const folder: TabFolder = {
      id: crypto.randomUUID(),
      type: 'folder',
      title: 'New Group',
      collapsed: false,
      children: [],
    };
    // A pinned tab is shown outside the tree, so unpin it to make the new group visible.
    setPinnedTabIds((ids) => ids.filter((id) => id !== tabId));
    // The tab keeps its place in the order, so nothing needs to reach Rust.
    updateTabTree({ type: 'tabWrappedInFolder', tabId, folder });
    startTabRename(folder.id, 'folder');
  }

  function saveTabFolderTitle(folderId: string) {
    const title = tabFolderTitle.trim() || 'New Folder';
    updateTabTree({ type: 'folderRenamed', id: folderId, title });
    setEditingTabFolderId('');
  }

  function deleteTabFolder(folderId: string) {
    updateTabTree({ type: 'folderUnwrapped', id: folderId }, { reorder: true });
  }

  function clearTabExpandTimer() {
    if (tabExpandTimer.current) window.clearTimeout(tabExpandTimer.current.timer);
    tabExpandTimer.current = null;
  }

  function finishTabDrag(cancelled: boolean) {
    // Folders get the native invalid preview but can never split into a page or window.
    if (tabDragOrigin)
      void call('set_tab_dragging', {
        dragging: false,
        tabId: null,
        targetTabId: null,
        cancelled: cancelled || tabDragOrigin.type === 'folder',
      }).catch((error) => setMessage(String(error)));
    clearTabExpandTimer();
    setDraggingTabId('');
    setTabDropTarget(null);
    setTabDragPreview(null);
    setTabDragOrigin(null);
  }

  function tabDragPoint({ activatorEvent, delta }: Pick<DragMoveEvent, 'activatorEvent' | 'delta'>) {
    if (!('clientX' in activatorEvent) || !('clientY' in activatorEvent)) return null;
    return { x: Number(activatorEvent.clientX) + delta.x, y: Number(activatorEvent.clientY) + delta.y };
  }

  // The website page can sit on any side of the tab strip, so use its actual content bounds.
  function tabPointerOverPage({ activatorEvent, delta }: Pick<DragMoveEvent, 'activatorEvent' | 'delta'>): boolean {
    const point = tabDragPoint({ activatorEvent, delta });
    const rect = viewRef.current?.getBoundingClientRect();
    return Boolean(
      point && rect && point.x >= rect.left && point.x <= rect.right && point.y >= rect.top && point.y <= rect.bottom,
    );
  }

  function tabDropZoneFor(event: Pick<DragMoveEvent, 'active' | 'over' | 'activatorEvent' | 'delta'>): DropZone | null {
    const rect = event.active.rect.current.translated;
    if (
      !event.over ||
      !rect ||
      event.over.data.current?.container !== 'tabs' ||
      event.over.id === event.active.id ||
      tabPointerOverPage(event)
    )
      return null;
    const targetId = String(event.over.data.current.nodeId ?? event.over.id);
    const target = locateNode(tabNodesRef.current, targetId);
    if (!target) throw new Error(`Tab drop target ${String(event.over.id)} was not found`);
    const horizontal = tabAxisForPosition(tabPosition) === 'horizontal';
    return horizontal
      ? resolveDropZone(
          rect.left + rect.width / 2,
          event.over.rect.left,
          event.over.rect.width,
          target.node.type === 'folder',
        )
      : resolveDropZone(
          rect.top + rect.height / 2,
          event.over.rect.top,
          event.over.rect.height,
          target.node.type === 'folder',
        );
  }

  function handleTabDragStart({ active, activatorEvent }: DragStartEvent) {
    const nodeId = String(active.data.current?.nodeId ?? active.id);
    const container = active.data.current?.container === 'pinned' ? 'pinned' : 'tabs';
    const found = locateNode(tabNodesRef.current, nodeId);
    if (!found) throw new Error(`Dragged tab node ${String(active.id)} was not found`);
    const source =
      activatorEvent.target instanceof HTMLElement
        ? activatorEvent.target.closest<HTMLElement>('.tab-sortable-item, .pinned-tab-button')
        : null;
    const sourceRect = source?.getBoundingClientRect() ?? active.rect.current.initial;
    const pointer =
      'clientX' in activatorEvent && 'clientY' in activatorEvent
        ? { x: Number(activatorEvent.clientX), y: Number(activatorEvent.clientY) }
        : null;
    setTabDragOrigin({
      id: found.node.id,
      depth: found.depth,
      type: found.node.type,
      container,
      grabX: pointer && sourceRect ? pointer.x - sourceRect.left : 0,
      grabY: pointer && sourceRect ? pointer.y - sourceRect.top : 0,
      width: sourceRect?.width ?? (container === 'pinned' ? 36 : 220),
      height: sourceRect?.height ?? 36,
    });
    setTabDragPreview(null);
    if (found.node.type === 'tab') setDraggingTabId(found.node.id);
    void call('set_tab_dragging', {
      dragging: true,
      tabId: found.node.type === 'tab' ? found.node.id : null,
      targetTabId: activeTabIdRef.current,
      dragType: found.node.type,
    }).catch((error) => setMessage(String(error)));
  }

  function handleTabDragMove(event: DragMoveEvent) {
    const overPage = tabPointerOverPage(event);
    const preview = resolveTabDragPreview(tabDragOrigin?.type === 'folder', overPage);
    setTabDragPreview((current) => (current === preview ? current : preview));
    if (overPage) {
      setTabDropTarget(null);
      clearTabExpandTimer();
      return;
    }
    const container = event.over?.data.current?.container;
    const overId = String(event.over?.data.current?.nodeId ?? event.over?.id ?? '');
    if (container === 'pinned') {
      const folder = tabDragOrigin?.type === 'folder';
      const horizontal = tabAxisForPosition(tabPosition) === 'horizontal';
      const pointer = tabDragPoint(event);
      const rect = event.over?.rect;
      const coordinate = pointer && (horizontal ? pointer.x : pointer.y);
      const start = rect && (horizontal ? rect.left : rect.top);
      const size = rect && (horizontal ? rect.width : rect.height);
      const zone: DropZone =
        !event.over ||
        event.over.id === pinnedTabsEndId ||
        coordinate === null ||
        coordinate === undefined ||
        start === undefined ||
        size === undefined
          ? 'after'
          : coordinate >= start + size / 2
            ? 'after'
            : 'before';
      setTabDropTarget(folder ? null : { container: 'pinned', overId, zone });
      clearTabExpandTimer();
      return;
    }
    const zone = tabDropZoneFor(event);
    setTabDropTarget((current) =>
      !zone
        ? null
        : current?.container === 'tabs' && current.overId === overId && current.zone === zone
          ? current
          : { container: 'tabs', overId, zone },
    );
    const over = zone === 'inside' ? findNode(tabNodesRef.current, overId) : undefined;
    if (!over || over.type !== 'folder' || !over.collapsed) {
      clearTabExpandTimer();
      return;
    }
    if (tabExpandTimer.current?.id === overId) return;
    clearTabExpandTimer();
    tabExpandTimer.current = {
      id: overId,
      timer: window.setTimeout(() => {
        tabExpandTimer.current = null;
        updateTabTree({ type: 'folderExpanded', id: overId });
      }, 600),
    };
  }

  function handleTabDragEnd(event: DragEndEvent) {
    const overPage = tabPointerOverPage(event);
    const activeId = String(event.active.data.current?.nodeId ?? event.active.id);
    const activeContainer = event.active.data.current?.container === 'pinned' ? 'pinned' : 'tabs';
    const targetContainer = event.over?.data.current?.container;
    if (!overPage && event.over && tabDragOrigin) {
      if (targetContainer === 'pinned' && tabDragOrigin.type === 'tab') {
        const horizontal = tabAxisForPosition(tabPosition) === 'horizontal';
        const rect = event.over.rect;
        const point = tabDragPoint(event);
        const coordinate = point && (horizontal ? point.x : point.y);
        const start = horizontal ? rect.left : rect.top;
        const size = horizontal ? rect.width : rect.height;
        const after =
          event.over.id === pinnedTabsEndId ||
          coordinate === null ||
          coordinate === undefined ||
          coordinate >= start + size / 2;
        const targetId = event.over.data.current?.nodeId ? String(event.over.data.current.nodeId) : null;
        const current = pinnedTabIdsRef.current;
        const base = current.includes(activeId) ? current : [...current, activeId];
        const next = reorderTabIds(base, activeId, targetId, after);
        if (JSON.stringify(next) !== JSON.stringify(current)) setPinnedTabIds(next);
      } else if (targetContainer === 'tabs') {
        const zone = tabDropZoneFor(event);
        if (zone) {
          const targetId = String(event.over.data.current?.nodeId ?? event.over.id);
          const horizontal = tabAxisForPosition(tabPosition) === 'horizontal';
          const indentDelta = horizontal ? event.delta.y : event.delta.x;
          if (activeContainer === 'pinned') setPinnedTabIds((ids) => ids.filter((id) => id !== activeId));
          updateTabTree(
            { type: 'dropped', activeId, overId: targetId, zone, originDepth: tabDragOrigin.depth, indentDelta },
            { reorder: true },
          );
        }
      }
    }
    finishTabDrag(!overPage || tabDragOrigin?.type === 'folder');
  }

  function toggleTabFolder(folderId: string) {
    updateTabTree({ type: 'folderToggled', id: folderId });
  }

  function moveTabNode(
    draggedId: string,
    targetId?: string,
    folderId?: string,
    position: 'before' | 'after' = 'before',
  ) {
    updateTabTree({ type: 'moved', id: draggedId, targetId, folderId, position }, { reorder: true });
  }

  function saveTabName(tabId: string) {
    const title = tabNameDraft.trim();
    setTabNameOverrides((names) => {
      const next = { ...names };
      if (title) next[tabId] = title;
      else delete next[tabId];
      return next;
    });
    setEditingTabId('');
  }

  function renderTabIcon(tab: Tab): React.ReactNode {
    const icon = tabFavicons[tab.id];
    return (
      <span className={`tab-favicon ${tab.loading ? 'is-loading' : ''}`}>
        {tab.loading ? (
          <LoaderCircle className="ui-icon" size={14} aria-hidden="true" />
        ) : icon ? (
          <img
            src={icon}
            alt=""
            onError={() =>
              setTabFavicons((current) => {
                const next = { ...current };
                delete next[tab.id];
                return next;
              })
            }
          />
        ) : tab.url ? (
          <Globe2 className="ui-icon" size={14} aria-hidden="true" />
        ) : (
          <Sparkles className="ui-icon" size={14} aria-hidden="true" />
        )}
      </span>
    );
  }

  // Same menu as the full-width rows, opened to the right of the narrow rail.
  function openRailContextMenu(event: React.MouseEvent, id: string, type: 'tab' | 'folder') {
    event.preventDefault();
    openTabContextMenu({ id, type, x: event.clientX, y: event.clientY });
  }

  function renderRailItem({ node }: FlatNode<TabNode>): React.ReactNode {
    if (node.type === 'folder') {
      return (
        <button
          key={node.id}
          type="button"
          className="rail-button"
          title={node.title}
          data-tab-node-id={node.id}
          aria-label={`${node.collapsed ? 'Expand' : 'Collapse'} folder ${node.title}`}
          onClick={() => toggleTabFolder(node.id)}
          onContextMenu={(event) => openRailContextMenu(event, node.id, 'folder')}
        >
          <Folder className="ui-icon" size={16} aria-hidden="true" />
        </button>
      );
    }
    const tab = tabs.find((item) => item.id === node.id);
    if (!tab) return null;
    const title = tabNameOverrides[tab.id] || tab.title || 'New Tab';
    return (
      <button
        key={node.id}
        type="button"
        className={`rail-button ${tab.id === activeTabId ? 'selected' : ''}`}
        title={title}
        aria-label={title}
        data-tab-node-id={tab.id}
        aria-current={tab.id === activeTabId ? 'page' : undefined}
        onClick={() => void selectTab(tab.id)}
        onContextMenu={(event) => openRailContextMenu(event, tab.id, 'tab')}
      >
        {renderTabIcon(tab)}
      </button>
    );
  }

  function renderPinnedTab(tab: Tab, compact = false, dropZone?: DropZone): React.ReactNode {
    const title = tabNameOverrides[tab.id] || tab.title || 'New Tab';
    if (editingTabId === tab.id)
      return (
        <div key={tab.id} className="pinned-tab-edit" title={`Rename ${title}`}>
          <AppInput
            className="tab-rename-input"
            aria-label="Tab name"
            autoFocus
            value={tabNameDraft}
            onFocus={(event) => selectInputText(event.currentTarget)}
            onChange={(event) => setTabNameDraft(event.target.value)}
            onBlur={() => saveTabName(tab.id)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === 'Enter') {
                event.preventDefault();
                saveTabName(tab.id);
              }
              if (event.key === 'Escape') setEditingTabId('');
            }}
          />
        </div>
      );
    return (
      <SortablePinnedTab
        key={tab.id}
        id={compact ? `rail-pin:${tab.id}` : `pinned:${tab.id}`}
        tabId={tab.id}
        title={title}
        selected={tab.id === activeTabId}
        compact={compact}
        dropZone={dropZone}
        onClick={() => void selectTab(tab.id)}
        onContextMenu={(event) => openRailContextMenu(event, tab.id, 'tab')}
      >
        {renderTabIcon(tab)}
      </SortablePinnedTab>
    );
  }

  function renderTabRow({ node, depth }: FlatNode<TabNode>, compact = false): React.ReactNode {
    const dropZone =
      tabDropTarget?.container === 'tabs' && tabDropTarget.overId === node.id ? tabDropTarget.zone : undefined;
    const stopDrag = (event: React.PointerEvent) => event.stopPropagation();
    if (node.type === 'folder') {
      const expanded = !node.collapsed && tabDragOrigin?.id !== node.id;
      return (
        <SortableRow
          key={node.id}
          id={node.id}
          depth={depth}
          expanded={expanded}
          dropZone={dropZone}
          style={horizontalTabStrip ? { marginTop: depth * 10 } : undefined}
          disabled={editingTabFolderId === node.id}
          className="tab-sortable-item"
          label={`Folder ${node.title}`}
          tabbable={node.id === tabbableTabNodeId}
          onContextMenu={(event) => {
            event.preventDefault();
            openTabContextMenu({ id: node.id, type: 'folder', x: event.clientX, y: event.clientY });
          }}
        >
          <div
            className="tab-folder-row"
            style={{ paddingLeft: tabAxisForPosition(tabPosition) === 'horizontal' ? 6 : depth * 14 }}
            onClick={() => toggleTabFolder(node.id)}
          >
            <button
              type="button"
              className="tab-folder-toggle"
              aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.title}`}
              onPointerDown={stopDrag}
              onClick={(event) => {
                event.stopPropagation();
                toggleTabFolder(node.id);
              }}
            >
              {expanded ? (
                <ChevronDown className="ui-icon" size={14} aria-hidden="true" />
              ) : (
                <ChevronRight className="ui-icon" size={14} aria-hidden="true" />
              )}
            </button>
            <span className="tab-folder-icon" aria-hidden="true">
              <Folder className="ui-icon" size={14} />
            </span>
            {editingTabFolderId === node.id ? (
              <AppInput
                className="tab-folder-name-input"
                aria-label="Tab folder name"
                autoFocus
                value={tabFolderTitle}
                onFocus={(event) => selectInputText(event.currentTarget)}
                onPointerDown={stopDrag}
                onChange={(event) => setTabFolderTitle(event.target.value)}
                onBlur={() => saveTabFolderTitle(node.id)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    saveTabFolderTitle(node.id);
                  }
                  if (event.key === 'Escape') {
                    setEditingTabFolderId('');
                    setTabFolderTitle(node.title);
                  }
                }}
              />
            ) : (
              <span className="tab-folder-title">{node.title}</span>
            )}
            {!node.children.length && expanded && <span className="tree-empty-hint">Drop tabs here</span>}
          </div>
        </SortableRow>
      );
    }
    const tab = tabs.find((item) => item.id === node.id);
    if (!tab) return null;
    const title = tabNameOverrides[tab.id] || tab.title || 'New Tab';
    return (
      <SortableRow
        key={node.id}
        id={node.id}
        depth={depth}
        dropZone={dropZone}
        style={horizontalTabStrip ? { marginTop: depth * 10 } : undefined}
        disabled={editingTabId === tab.id}
        className="tab-sortable-item"
        label={title}
        tabbable={node.id === tabbableTabNodeId}
        current={tab.id === activeTabId}
        onActivate={() => void selectTab(tab.id)}
        onContextMenu={(event) => {
          event.preventDefault();
          openTabContextMenu({ id: tab.id, type: 'tab', x: event.clientX, y: event.clientY });
        }}
      >
        <div
          className={`tab-row ${depth > 0 ? 'nested-tab-row' : ''} ${tab.id === activeTabId ? 'selected' : ''}`}
          style={
            compact || depth === 0 || tabAxisForPosition(tabPosition) === 'horizontal'
              ? undefined
              : { marginLeft: depth * 14 + 7, width: `calc(100% - ${depth * 14 + 7}px)` }
          }
          data-tab-id={tab.id}
          title={title}
          onClick={() => void selectTab(tab.id)}
        >
          {renderTabIcon(tab)}
          {pinnedTabIds.includes(tab.id) && (
            <Pin className="ui-icon tab-pin-indicator" size={12} aria-label="Pinned tab" />
          )}
          {editingTabId === tab.id ? (
            <AppInput
              className="tab-rename-input"
              aria-label="Tab name"
              value={tabNameDraft}
              autoFocus
              onFocus={(event) => selectInputText(event.currentTarget)}
              onPointerDown={stopDrag}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => setTabNameDraft(event.target.value)}
              onBlur={() => saveTabName(tab.id)}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Enter') {
                  event.preventDefault();
                  saveTabName(tab.id);
                }
                if (event.key === 'Escape') {
                  setEditingTabId('');
                }
              }}
            />
          ) : (
            <span className="tab-title" onDoubleClick={() => startTabRename(tab.id, 'tab')}>
              {title}
            </span>
          )}
          {tab.private && (
            <span className="private-tab-indicator" title="Private tab" aria-label="Private tab">
              <EyeOff className="ui-icon" size={13} aria-hidden="true" />
            </span>
          )}
          <button
            type="button"
            className="tab-close"
            aria-label={`Close ${title}`}
            onPointerDown={stopDrag}
            onClick={(event) => {
              event.stopPropagation();
              void closeTab(tab.id);
            }}
          >
            <X className="ui-icon" size={14} aria-hidden="true" />
          </button>
        </div>
      </SortableRow>
    );
  }

  async function openBookmark(url: string) {
    if (!activeTabId) {
      try {
        const snapshot = await call('create_tab');
        applySnapshot(snapshot);
        await call('navigate', { tabId: snapshot.activeTabId, url });
      } catch (error) {
        setMessage(String(error));
      }
      return;
    }
    void navigateTo(url);
  }

  function closeSettings() {
    if (activeTabId) void closeTab(activeTabId);
  }

  const bookmarkExpanded = new Set(
    bookmarkSearch.trim() ? folderIds(filterBookmarkNodes(bookmarks, bookmarkSearch.trim())) : expandedFolderIds,
  );
  // A dragged folder collapses so its own children are not drop targets.
  if (bookmarkDragOrigin) bookmarkExpanded.delete(bookmarkDragOrigin.id);
  const draggedBookmark = bookmarkDragOrigin ? locateNode(bookmarks, bookmarkDragOrigin.id)?.node : undefined;
  // A dragged folder collapses so its own children are not drop targets.
  const expandedTabFolders = new Set(expandedTabFolderIds(tabNodes));
  if (tabDragOrigin) expandedTabFolders.delete(tabDragOrigin.id);
  const unpinnedTabNodes = (nodes: TabNode[]): TabNode[] =>
    nodes.flatMap<TabNode>((node) => {
      if (node.type === 'tab') return pinnedTabIds.includes(node.id) ? [] : [node];
      return [{ ...node, children: unpinnedTabNodes(node.children) }];
    });
  const unpinnedTree = unpinnedTabNodes(tabNodes);
  const visibleTabRows = flattenTree(unpinnedTree, expandedTabFolders);
  const allTabRows = flattenTree(unpinnedTree, new Set(tabFolders(unpinnedTree).map((folder) => folder.id)));
  const visibleSplitLayout =
    splitLayout && !pinnedTabIds.includes(splitLayout.firstTabId) && !pinnedTabIds.includes(splitLayout.secondTabId)
      ? splitLayout
      : null;
  const sidebarTabRows = groupSplitTabRows(visibleTabRows, allTabRows, visibleSplitLayout);
  const displayedTabRows = sidebarTabRows.flatMap((row) =>
    row.type === 'single' ? [row.row] : [row.first, row.second],
  );
  const pinnedTabs = pinnedTabIds.flatMap((id) => {
    const tab = tabs.find((item) => item.id === id);
    return tab ? [tab] : [];
  });
  const draggedTabNode = tabDragOrigin ? findNode(tabNodes, tabDragOrigin.id) : undefined;
  const bookmarkEditForm = (
    <form
      className="bookmark-form bookmark-inline-form"
      onSubmit={saveBookmarkEdit}
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          cancelBookmarkEdit();
        }
      }}
    >
      {addingBookmarkFolderId && (
        <small>New bookmark in {locateNode(bookmarks, addingBookmarkFolderId)?.node.title ?? 'folder'}</small>
      )}
      <AppInput
        aria-label="Bookmark title"
        placeholder="Name"
        autoFocus
        value={editBookmarkTitle}
        onChange={(event) => setEditBookmarkTitle(event.target.value)}
      />
      <AppInput
        aria-label="Bookmark address"
        placeholder="https://example.com"
        value={editBookmarkUrl}
        onChange={(event) => setEditBookmarkUrl(event.target.value)}
      />
      <AppInput
        aria-label="Bookmark description"
        placeholder="Description"
        value={editBookmarkDescription}
        onChange={(event) => setEditBookmarkDescription(event.target.value)}
      />
      <div className="bookmark-inline-actions">
        <AppButton type="submit">{addingBookmark ? 'Add' : 'Save'}</AppButton>
        <AppButton type="button" className="cancel-edit" onClick={cancelBookmarkEdit}>
          Cancel
        </AppButton>
      </div>
    </form>
  );
  const visibleBookmarkRows = flattenTree(filterBookmarkNodes(bookmarks, bookmarkSearch.trim()), bookmarkExpanded);
  // Each tree keeps one row in the tab order: the last focused row, else the active tab, else the first row.
  const tabbableBookmarkId = rovingTabStop(
    visibleBookmarkRows.map((row) => row.node.id),
    focusedBookmarkId,
  );
  const tabbableTabNodeId = rovingTabStop(
    displayedTabRows.map((row) => row.node.id),
    focusedTabNodeId,
    activeTabId,
  );
  const horizontalTabStrip = tabAxisForPosition(tabPosition) === 'horizontal';

  function renderTabManager() {
    return (
      <DndContext
        sensors={tabSensors}
        collisionDetection={tabCollisionDetection}
        onDragStart={handleTabDragStart}
        onDragMove={handleTabDragMove}
        onDragEnd={handleTabDragEnd}
        onDragCancel={() => finishTabDrag(true)}
      >
        <div className="bookmark-toolbar tab-toolbar">
          <AppButton className="new-folder-button" title={`New tab (${commandKey}+T)`} onClick={() => void createTab()}>
            <Plus className="ui-icon" size={14} aria-hidden="true" /> Tab
          </AppButton>
          <AppButton
            className="new-folder-button"
            title="Create tab folder"
            aria-label="Create tab folder"
            onClick={createTabFolder}
          >
            <FolderPlus className="ui-icon" size={14} aria-hidden="true" /> Folder
          </AppButton>
        </div>
        <PinnedTabsDock active={tabDropTarget?.container === 'pinned'} empty={pinnedTabs.length === 0}>
          <SortableContext items={pinnedTabs.map((tab) => `pinned:${tab.id}`)} strategy={() => null}>
            {pinnedTabs.map((tab) =>
              renderPinnedTab(
                tab,
                false,
                tabDropTarget?.container === 'pinned' && tabDropTarget.overId === tab.id
                  ? tabDropTarget.zone
                  : undefined,
              ),
            )}
          </SortableContext>
        </PinnedTabsDock>
        <div
          className={`tab-list tab-tree ${horizontalTabStrip ? 'horizontal' : 'vertical'} ${tabDragOrigin ? 'is-dragging' : ''}`}
          role="tree"
          aria-orientation={horizontalTabStrip ? 'horizontal' : 'vertical'}
          aria-label="Open tabs"
        >
          <TreeKeyboardNavigation
            orientation={horizontalTabStrip ? 'horizontal' : 'vertical'}
            disabled={Boolean(tabDragOrigin)}
            onToggle={(item) => {
              if (item.dataset.tabNodeId) toggleTabFolder(item.dataset.tabNodeId);
            }}
            onFocusItem={(item) => setFocusedTabNodeId(item.dataset.tabNodeId ?? '')}
          >
            <SortableContext items={displayedTabRows.map((row) => row.node.id)} strategy={() => null}>
              {sidebarTabRows.map((row) =>
                row.type === 'single' ? (
                  renderTabRow(row.row)
                ) : (
                  <div
                    key={`split-${row.first.node.id}-${row.second.node.id}`}
                    className={`tab-split-row ${[row.first.node.id, row.second.node.id].includes(activeTabId) ? 'split-active' : ''}`}
                    style={horizontalTabStrip ? { marginTop: row.depth * 10 } : { marginLeft: row.depth * 14 }}
                    role="group"
                    aria-label="Split view"
                    data-split-first={row.first.node.id}
                    data-split-second={row.second.node.id}
                  >
                    {renderTabRow({ ...row.first, depth: row.depth }, true)}
                    {renderTabRow({ ...row.second, depth: row.depth }, true)}
                  </div>
                ),
              )}
            </SortableContext>
          </TreeKeyboardNavigation>
        </div>
        <div className="tab-actions">
          <AppButton
            className="new-tab"
            title={`New private tab (${commandKey}+Shift+N)`}
            onClick={() => void createTab(true)}
          >
            <EyeOff className="ui-icon" size={16} aria-hidden="true" /> New private tab
          </AppButton>
        </div>
        <DragOverlay dropAnimation={null}>
          {draggedTabNode && tabDragOrigin && tabDragPreview !== 'split'
            ? (() => {
                const dockShape = tabDropTarget
                  ? tabDropTarget.container === 'pinned'
                  : tabDragOrigin.container === 'pinned';
                const width = dockShape ? 36 : horizontalTabStrip ? 170 : tabDragOrigin.width;
                const height = dockShape ? 36 : horizontalTabStrip ? 40 : tabDragOrigin.height;
                const resized = width !== tabDragOrigin.width || height !== tabDragOrigin.height;
                const tab =
                  draggedTabNode.type === 'tab' ? tabs.find((item) => item.id === draggedTabNode.id) : undefined;
                const title =
                  draggedTabNode.type === 'folder'
                    ? draggedTabNode.title
                    : tabNameOverrides[draggedTabNode.id] || tab?.title || 'New Tab';
                return (
                  <div
                    className={`tab-drag-morph${tabDragPreview === 'invalid' ? ' invalid' : ''}`}
                    style={{
                      width,
                      height,
                      transform: resized
                        ? `translate(${tabDragOrigin.grabX - width / 2}px, ${tabDragOrigin.grabY - height / 2}px)`
                        : undefined,
                    }}
                  >
                    <div className="tab-drag-card" style={{ opacity: dockShape ? 0 : 1 }}>
                      {draggedTabNode.type === 'folder' ? (
                        <Folder className="ui-icon" size={14} aria-hidden="true" />
                      ) : tab ? (
                        renderTabIcon(tab)
                      ) : (
                        <Globe2 className="ui-icon" size={14} aria-hidden="true" />
                      )}
                      <span>{title}</span>
                    </div>
                    {tab && (
                      <div className="tab-drag-icon" style={{ opacity: dockShape ? 1 : 0 }}>
                        {renderTabIcon(tab)}
                      </div>
                    )}
                  </div>
                );
              })()
            : null}
        </DragOverlay>
      </DndContext>
    );
  }

  function startTabRename(id: string, type: 'tab' | 'folder') {
    // The rename field lives in the full tab list, so open it first from the icon rail.
    if (sidebarCollapsed) {
      setSidebarCollapsed(false);
      setSidebarView('tabs');
    }
    if (type === 'tab') {
      const tab = tabs.find((item) => item.id === id);
      setTabNameDraft(tabNameOverrides[id] || tab?.title || '');
      setEditingTabId(id);
      return;
    }
    const folder = findNode(tabNodesRef.current, id);
    if (folder?.type === 'folder') {
      setTabFolderTitle(folder.title);
      setEditingTabFolderId(folder.id);
    }
  }

  async function createTabBelow(targetId: string) {
    try {
      const snapshot = await call('create_tab');
      applySnapshot(snapshot);
      reorderTabsFromTree(
        insertTabNode(tabNodesRef.current, targetId, { id: snapshot.activeTabId, type: 'tab' }, true).nodes,
      );
    } catch (error) {
      setMessage(String(error));
    }
  }

  /** Open the tab or folder menu under the focused sidebar row (Menu key or Shift+F10). */
  function openTabContextMenuFromKeyboard(event: React.KeyboardEvent) {
    if (!isContextMenuKey(event) || !(event.target instanceof HTMLElement)) return;
    const row = event.target.closest<HTMLElement>('[data-tab-node-id], [data-tab-id]');
    const id = row?.dataset.tabNodeId ?? row?.dataset.tabId;
    if (!row || !id) return;
    event.preventDefault();
    const rect = row.getBoundingClientRect();
    const type = findNode(tabNodesRef.current, id)?.type === 'folder' ? 'folder' : 'tab';
    openTabContextMenu({ id, type, x: rect.left + 12, y: rect.bottom });
  }

  function tabContextMenuEntries(target: TabContextMenuTarget): MenuEntry[] {
    if (target.type === 'folder')
      return folderMenuEntries({
        onRename: () => startTabRename(target.id, 'folder'),
        onDeleteFolder: () => deleteTabFolder(target.id),
      });
    const tab = tabs.find((item) => item.id === target.id);
    return tabMenuEntries({
      pinned: pinnedTabIds.includes(target.id),
      isWebsite: Boolean(tab?.url.match(/^https?:\/\//)),
      inSplit: Boolean(splitLayout && (splitLayout.firstTabId === target.id || splitLayout.secondTabId === target.id)),
      folders: tabFolders(tabNodes).map((folder) => ({ id: folder.id, title: folder.title })),
      onRename: () => startTabRename(target.id, 'tab'),
      onTogglePin: () =>
        setPinnedTabIds((ids) =>
          ids.includes(target.id) ? ids.filter((id) => id !== target.id) : [...ids, target.id],
        ),
      onReload: () => void call('reload', { tabId: target.id }).catch((error) => setMessage(String(error))),
      onNewTabBelow: () => void createTabBelow(target.id),
      onDuplicate: () => void duplicateTab(target.id),
      onSplit: (side) =>
        void dropTabIntoSplit(
          side,
          target.id,
          target.id === activeTabIdRef.current ? target.id : activeTabIdRef.current,
        ),
      onUnsplit: () => void closeSplitView(),
      onMoveToNewFolder: () => moveTabToNewFolder(target.id),
      onMoveToFolder: (folderId) => moveTabNode(target.id, undefined, folderId),
      onCloseTab: () => void closeTab(target.id),
    });
  }

  /**
   * Show the tab or folder menu as a native popup so it can overlap the page WebViews and extend
   * past the window. Desktop-test builds keep the entries for the WebDriver bridge instead, since
   * the native menu's modal loop would block the test.
   */
  function openTabContextMenu(target: TabContextMenuTarget) {
    const entries = tabContextMenuEntries(target);
    if (import.meta.env.MODE === 'desktop-test') {
      testTabMenuRef.current = entries;
      return;
    }
    void popupNativeMenu(entries, target.x, target.y).catch((error) => setMessage(String(error)));
  }

  function renderBookmarkManager() {
    return (
      <div className="bookmark-manager">
        <div className="bookmark-toolbar">
          <SearchField
            className="bookmark-search-field"
            aria-label="Search bookmarks"
            value={bookmarkSearch}
            onChange={setBookmarkSearch}
          >
            <Input className="bookmark-search" type="search" placeholder="Find a bookmark" />
            <AriaButton className="bookmark-search-clear" aria-label="Clear bookmarks search">
              <X className="ui-icon" size={14} aria-hidden="true" />
            </AriaButton>
          </SearchField>
          <AppButton className="new-folder-button" onClick={() => startAddBookmark()}>
            <Plus className="ui-icon" size={14} aria-hidden="true" /> Bookmark
          </AppButton>
          <AppButton className="new-folder-button" onClick={() => createBookmarkFolder()}>
            <FolderPlus className="ui-icon" size={14} aria-hidden="true" /> Folder
          </AppButton>
        </div>
        {addingBookmark && bookmarkEditForm}
        <DndContext
          sensors={bookmarkSensors}
          collisionDetection={closestCenter}
          onDragStart={handleBookmarkDragStart}
          onDragMove={handleBookmarkDragMove}
          onDragEnd={handleBookmarkDragEnd}
          onDragCancel={endBookmarkDrag}
        >
          <div
            className={`bookmark-list bookmark-tree bookmark-dnd-list ${bookmarkDragOrigin ? 'is-dragging' : ''}`}
            role="tree"
            aria-label="Saved bookmarks"
          >
            {visibleBookmarkRows.length ? (
              <TreeKeyboardNavigation
                disabled={Boolean(bookmarkDragOrigin)}
                onToggle={(item) => {
                  if (item.dataset.bookmarkId)
                    dispatchBookmarks({ type: 'folderToggled', id: item.dataset.bookmarkId });
                }}
                onFocusItem={(item) => setFocusedBookmarkId(item.dataset.bookmarkId ?? '')}
              >
                <SortableContext items={visibleBookmarkRows.map((item) => item.node.id)} strategy={() => null}>
                  {visibleBookmarkRows.map(({ node, depth }) => (
                    <BookmarkSortableRow
                      key={node.id}
                      node={node}
                      depth={depth}
                      expanded={bookmarkExpanded.has(node.id)}
                      dropZone={bookmarkDropTarget?.overId === node.id ? bookmarkDropTarget.zone : undefined}
                      editing={editingBookmarkId === node.id}
                      onToggle={() => dispatchBookmarks({ type: 'folderToggled', id: node.id })}
                      onOpen={(url) => void openBookmark(url)}
                      onEdit={editBookmark}
                      onDelete={deleteBookmarkNode}
                      onNewFolder={createBookmarkFolder}
                      onContextMenu={(event, bookmark) => void openBookmarkContextMenu(event, bookmark)}
                      onRename={(folder) => {
                        setFolderTitle(folder.title);
                        setEditingFolderId(folder.id);
                      }}
                      onCancelRename={() => {
                        setEditingFolderId('');
                        setFolderTitle(node.type === 'folder' ? node.title : '');
                      }}
                      editingFolder={node.type === 'folder' && editingFolderId === node.id}
                      folderTitle={folderTitle}
                      setFolderTitle={setFolderTitle}
                      saveFolderTitle={() => saveFolderTitle(node.id)}
                      editForm={bookmarkEditForm}
                      tabbable={node.id === tabbableBookmarkId}
                    />
                  ))}
                </SortableContext>
              </TreeKeyboardNavigation>
            ) : (
              <p className="bookmark-empty">
                {bookmarks.length === 0 ? 'Your saved pages will appear here.' : 'No matching bookmarks.'}
              </p>
            )}
          </div>
          <DragOverlay dropAnimation={null}>
            {draggedBookmark ? (
              <div className="bookmark-drag-overlay">
                {draggedBookmark.type === 'folder' ? (
                  <Folder className="ui-icon" size={14} aria-hidden="true" />
                ) : (
                  <Star className="ui-icon" size={14} aria-hidden="true" />
                )}
                <span>{draggedBookmark.title}</span>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      </div>
    );
  }

  return (
    <main
      className="browser-shell"
      data-tab-position={tabPosition}
      data-sidebar-side={sidebarSide}
      data-sidebar-collapsed={sidebarCollapsed}
    >
      {horizontalTabStrip && (
        <div className={`detached-tab-strip ${tabPosition}`} role="region" aria-label="Open tabs">
          <div className="detached-tab-manager">{renderTabManager()}</div>
        </div>
      )}
      <aside
        className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''} ${horizontalTabStrip ? 'tabs-detached' : ''}`}
        onKeyDown={openTabContextMenuFromKeyboard}
        data-sidebar-side={sidebarSide}
        style={{
          width: sidebarCollapsed ? 48 : sidebarWidth,
          flexBasis: sidebarCollapsed ? 48 : sidebarWidth,
          height: '100%',
        }}
      >
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true">
            <CircleDot className="ui-icon" size={17} />
          </div>
          <span className="brand-name">Unky</span>
          <AppButton
            className="sidebar-collapse-button"
            type="button"
            aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-expanded={!sidebarCollapsed}
            aria-controls="sidebar-content"
            onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
          >
            {sidebarCollapsed ? (
              <PanelLeftOpen className="ui-icon" size={16} aria-hidden="true" />
            ) : (
              <PanelLeftClose className="ui-icon" size={16} aria-hidden="true" />
            )}
          </AppButton>
        </div>
        {sidebarCollapsed && !horizontalTabStrip && (
          <div className="sidebar-rail">
            <button
              type="button"
              className="rail-button"
              title={`New tab (${commandKey}+T)`}
              aria-label="New tab"
              onClick={() => void createTab()}
            >
              <Plus className="ui-icon" size={16} aria-hidden="true" />
            </button>
            {pinnedTabs.length > 0 && (
              <div className="pinned-tabs-row pinned-tabs-row-rail" role="group" aria-label="Pinned tabs">
                {pinnedTabs.map((tab) => renderPinnedTab(tab, true))}
              </div>
            )}
            <div className="rail-tabs">
              {sidebarTabRows.map((row) =>
                row.type === 'single' ? (
                  renderRailItem(row.row)
                ) : (
                  <div
                    className="rail-split-row"
                    role="group"
                    aria-label="Split view"
                    key={`split-${row.first.node.id}-${row.second.node.id}`}
                  >
                    {renderRailItem(row.first)}
                    {renderRailItem(row.second)}
                  </div>
                ),
              )}
            </div>
            <button
              type="button"
              className="rail-button"
              title="Toggle developer console"
              aria-label="Toggle developer console"
              onClick={() => void call('toggle_devtools').catch((error) => setMessage(String(error)))}
            >
              <Terminal className="ui-icon" size={16} aria-hidden="true" />
            </button>
          </div>
        )}
        <div className="sidebar-content" id="sidebar-content">
          {horizontalTabStrip ? (
            renderBookmarkManager()
          ) : (
            <Tabs
              className="sidebar-tabs"
              selectedKey={sidebarView}
              onSelectionChange={(key) => setSidebarView(key as typeof sidebarView)}
            >
              <TabList className="sidebar-switcher" aria-label="Sidebar views">
                <Tab id="tabs">Tabs</Tab>
                <Tab id="bookmarks">Bookmarks</Tab>
              </TabList>
              <TabPanels className="sidebar-panels">
                <TabPanel id={sidebarView} className="sidebar-panel">
                  {sidebarView === 'tabs' ? renderTabManager() : renderBookmarkManager()}
                </TabPanel>
              </TabPanels>
            </Tabs>
          )}
        </div>
        <div
          className={`sidebar-sizer ${resizingSidebar ? 'dragging' : ''}`}
          role="separator"
          aria-label="Resize tab sidebar"
          aria-orientation="vertical"
          aria-valuemin={sidebarMinWidth}
          aria-valuemax={sidebarMaxWidth}
          aria-valuenow={Math.round(sidebarWidth)}
          tabIndex={0}
          data-sidebar-sizer
          onPointerDown={(event) => {
            event.preventDefault();
            setResizingSidebar(true);
          }}
          onDoubleClick={() => {
            setSidebarWidth(sidebarDefaultWidth);
          }}
        />
      </aside>

      <section className="browser-main">
        <header className="toolbar">
          <div className="nav-controls" aria-label="Page navigation">
            <AppButton
              className="icon-button"
              title="Go back"
              aria-label="Go back"
              disabled={!activeTab?.canGoBack}
              onClick={() => void runNavigationCommand('go_back')}
            >
              <ArrowLeft className="ui-icon" size={17} aria-hidden="true" />
            </AppButton>
            <AppButton
              className="icon-button"
              title="Go forward"
              aria-label="Go forward"
              disabled={!activeTab?.canGoForward}
              onClick={() => void runNavigationCommand('go_forward')}
            >
              <ArrowRight className="ui-icon" size={17} aria-hidden="true" />
            </AppButton>
            <AppButton
              className="icon-button reload-button"
              title={activeTab?.loading ? 'Stop loading' : 'Reload'}
              aria-label={activeTab?.loading ? 'Stop loading' : 'Reload'}
              onClick={() => void runNavigationCommand(activeTab?.loading ? 'stop_loading' : 'reload')}
            >
              {activeTab?.loading ? (
                <X className="ui-icon" size={16} aria-hidden="true" />
              ) : (
                <RotateCw className="ui-icon" size={16} aria-hidden="true" />
              )}
            </AppButton>
          </div>
          <form className="address-form" onSubmit={navigate}>
            <AppButton
              ref={securityButtonRef}
              className={`toolbar-action ${securityOpen ? 'security-active' : ''}`}
              title="Page security and permissions"
              aria-label="Page security and permissions"
              aria-expanded={securityOpen}
              disabled={!activeTab?.url}
              onClick={async () => {
                const rect = securityButtonRef.current?.getBoundingClientRect();
                if (!rect || !activeTab?.url) return;
                const info = securityInfo || {
                  origin: new URL(activeTab.url).origin,
                  secureHttps: activeTab.url.startsWith('https:'),
                  location: 'unknown',
                  camera: 'unknown',
                  microphone: 'unknown',
                  playingAudio: false,
                };
                try {
                  const shown = await call('toggle_page_security_popover', {
                    anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
                    info,
                  });
                  setSecurityOpen(shown);
                  if (!shown) setSecurityState(null);
                } catch (error) {
                  setMessage(String(error));
                }
              }}
            >
              <Shield className="ui-icon" size={15} aria-hidden="true" />
            </AppButton>
            <AppInput
              ref={addressRef}
              aria-label="Search or enter address"
              aria-autocomplete="list"
              aria-controls="address-suggestions"
              aria-activedescendant={
                addressSuggestionsOpen && addressSuggestions.length
                  ? `address-suggestion-${activeAddressSuggestion}`
                  : undefined
              }
              aria-expanded={addressSuggestionsOpen && addressSuggestions.length > 0}
              autoComplete="off"
              spellCheck={false}
              placeholder="Search or enter address"
              value={address}
              onChange={(event) => {
                setAddress(event.target.value);
                setAddressSuggestionsOpen(true);
                setActiveAddressSuggestion(0);
              }}
              onFocus={(event) => event.currentTarget.select()}
              onBlur={() => window.setTimeout(() => setAddressSuggestionsOpen(false), 100)}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown' && addressSuggestionsOpen && addressSuggestions.length) {
                  event.preventDefault();
                  setActiveAddressSuggestion((index) =>
                    moveAddressSuggestionSelection(index, addressSuggestions.length, 1),
                  );
                } else if (event.key === 'ArrowUp' && addressSuggestionsOpen && addressSuggestions.length) {
                  event.preventDefault();
                  setActiveAddressSuggestion((index) =>
                    moveAddressSuggestionSelection(index, addressSuggestions.length, -1),
                  );
                } else if (event.key === 'Escape' && addressSuggestionsOpen) {
                  event.preventDefault();
                  setAddressSuggestionsOpen(false);
                } else if (
                  event.key === 'Enter' &&
                  addressSuggestionsOpen &&
                  addressSuggestions[activeAddressSuggestion]
                ) {
                  event.preventDefault();
                  chooseAddressSuggestion(addressSuggestions[activeAddressSuggestion].url);
                }
              }}
            />
            {addressSuggestionsOpen && addressSuggestions.length > 0 && !nativeAddressSuggestions && (
              <div
                className="address-suggestions"
                id="address-suggestions"
                role="listbox"
                aria-label="Bookmarks and history suggestions"
              >
                {addressSuggestions.map((suggestion, index) => (
                  <AppButton
                    key={`${suggestion.source}-${suggestion.url}`}
                    id={`address-suggestion-${index}`}
                    type="button"
                    role="option"
                    aria-selected={index === activeAddressSuggestion}
                    className={`address-suggestion${index === activeAddressSuggestion ? ' is-active' : ''}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => chooseAddressSuggestion(suggestion.url)}
                  >
                    <span className="address-suggestion-copy">
                      <strong>{suggestion.title}</strong>
                      <small>{suggestion.url}</small>
                    </span>
                    <span className="address-suggestion-source">{suggestion.source}</span>
                  </AppButton>
                ))}
              </div>
            )}
            <AppButton
              className={`toolbar-action bookmark-toggle ${currentBookmark ? 'is-bookmarked' : ''}`}
              title={currentBookmark ? 'Page bookmarked' : 'Bookmark this page'}
              aria-label={currentBookmark ? 'Page bookmarked' : 'Bookmark this page'}
              aria-pressed={Boolean(currentBookmark)}
              disabled={!activeTab?.url}
              onClick={addCurrentPage}
            >
              <Star className="ui-icon" size={15} aria-hidden="true" fill={currentBookmark ? 'currentColor' : 'none'} />
            </AppButton>
          </form>
          {findOpen ? (
            <form
              className="find-form"
              aria-label="Find in page"
              onSubmit={(event) => {
                event.preventDefault();
                void findInPage(findQuery);
              }}
            >
              <AppInput
                ref={findRef}
                aria-label="Find in page"
                placeholder="Find in page"
                value={findQuery}
                onChange={(event) => {
                  setFindQuery(event.target.value);
                  setFindMatches(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void findInPage(findQuery, event.shiftKey);
                  }
                }}
              />
              {shownFindMatches !== null && (
                <span className="find-result" role="status" aria-live="polite">
                  {shownFindMatches} {shownFindMatches === 1 ? 'match' : 'matches'}
                </span>
              )}
              <AppButton type="submit" title="Find next" aria-label="Find next">
                <ArrowDown className="ui-icon" size={13} aria-hidden="true" />
              </AppButton>
              <AppButton
                type="button"
                title="Find previous"
                aria-label="Find previous"
                onClick={() => void findInPage(findQuery, true)}
              >
                <ArrowUp className="ui-icon" size={13} aria-hidden="true" />
              </AppButton>
              <AppButton
                type="button"
                title="Close find"
                aria-label="Close find"
                onClick={() => {
                  setFindOpen(false);
                  setFindQuery('');
                  setFindMatches(null);
                }}
              >
                <X className="ui-icon" size={13} aria-hidden="true" />
              </AppButton>
            </form>
          ) : (
            <AppButton
              className="toolbar-action"
              title={`Find in page (${commandKey}+F)`}
              aria-label="Find in page"
              onClick={openFindPanel}
            >
              <Search className="ui-icon" size={17} aria-hidden="true" />
            </AppButton>
          )}
          <AppButton
            ref={externalBrowserButtonRef}
            className="toolbar-action"
            title="Open in another browser"
            aria-label="Open in another browser"
            aria-haspopup="menu"
            disabled={!isTauri || !activeTab?.url.match(/^https?:\/\//)}
            onClick={() => void showExternalBrowsers()}
          >
            <ExternalLink className="ui-icon" size={17} aria-hidden="true" />
          </AppButton>
          {splitLayout && (
            <AppButton
              className="toolbar-action"
              title="Close split view"
              aria-label="Close split view"
              onClick={() => void closeSplitView()}
            >
              <Columns2 className="ui-icon" size={17} aria-hidden="true" />
            </AppButton>
          )}
          <AppButton
            className="toolbar-action"
            title="Settings"
            aria-label="Settings"
            onClick={() => void openSettingsPage()}
          >
            <Settings className="ui-icon" size={17} aria-hidden="true" />
          </AppButton>
          <AppButton
            ref={downloadsButtonRef}
            className="toolbar-action downloads-trigger"
            title="Recent downloads"
            aria-label={`Recent downloads${downloads.length ? `, ${downloads.length} items` : ''}`}
            aria-haspopup="dialog"
            aria-expanded={downloadsPopoverOpen}
            aria-controls={nativeDownloadsPopover ? undefined : 'downloads-popover'}
            onClick={() => void openDownloadsPopover()}
          >
            <Download className="ui-icon" size={17} aria-hidden="true" />
            {downloads.length > 0 && (
              <span className="download-count" aria-hidden="true">
                {downloads.length > 99 ? '99+' : downloads.length}
              </span>
            )}
          </AppButton>
          {downloadsPopoverOpen && !nativeDownloadsPopover && (
            <section id="downloads-popover" className="downloads-popover" role="dialog" aria-label="Recent downloads">
              <header className="downloads-popover-heading">
                <div>
                  <h2>{downloads.length === 0 ? 'recent download history' : 'Downloads'}</h2>
                  {downloads.length > 0 && (
                    <span>
                      {downloads.length} {downloads.length === 1 ? 'item' : 'items'}
                    </span>
                  )}
                </div>
              </header>
              <ul className="downloads-popover-list">
                {downloads.slice(0, 8).map((item) => (
                  <li className="downloads-popover-row" key={item.id}>
                    <span className="downloads-popover-icon" aria-hidden="true">
                      <Download className="ui-icon" size={16} />
                    </span>
                    <div className="downloads-popover-copy">
                      <strong title={item.filename}>{item.filename}</strong>
                      <small className={`download-status-${item.status}`}>
                        {item.status === 'completed'
                          ? 'Complete'
                          : item.status === 'failed'
                            ? 'Failed'
                            : `Downloading · ${item.bytesReceived.toLocaleString()} bytes`}
                      </small>
                      {item.status === 'downloading' && (
                        <progress className="download-progress" aria-label={`Downloading ${item.filename}`} />
                      )}
                    </div>
                    <AppButton
                      className="download-reveal"
                      disabled={item.status !== 'completed'}
                      aria-label={`Reveal ${item.filename}`}
                      title="Show in Finder"
                      onClick={() =>
                        void call('reveal_download', { downloadId: item.id }).catch((error) =>
                          setMessage(String(error)),
                        )
                      }
                    >
                      <ExternalLink className="ui-icon" size={14} aria-hidden="true" />
                    </AppButton>
                  </li>
                ))}
              </ul>
              <footer className="downloads-popover-footer">
                <AppButton onClick={() => void openAllDownloadsPage()}>View All Downloads</AppButton>
              </footer>
            </section>
          )}
        </header>

        <div className="webview-slot" ref={viewRef}>
          {downloadsPageOpen ? (
            <DownloadsPage downloads={downloads} onClose={() => void closeTab(activeTabId)} setMessage={setMessage} />
          ) : settingsPageOpen ? (
            <SettingsPage message={message} onClose={closeSettings}>
              <AppearanceSettings
                theme={theme}
                setTheme={setTheme}
                accentColor={accentColor}
                setAccentColor={setAccentColor}
                tabPosition={tabPosition}
                setTabPosition={setTabPosition}
                sidebarSide={sidebarSide}
                setSidebarSide={setSidebarSide}
                sidebarWidth={sidebarWidth}
              />
              <GeneralSettings
                onManageBookmarks={() => {
                  closeSettings();
                  showBookmarksManager();
                }}
                pageContextMenu={customPageContextMenuEnabled}
                onPageContextMenuChange={setCustomPageContextMenuEnabled}
              />
              <PrivacySettings
                onNewPrivateTab={() => void createTab(true)}
                onClearData={() => void clearBrowsingData()}
                filtering={{
                  settings: filterSettings,
                  busy: filterBusy,
                  progress: filterProgress,
                  siteDomain: siteForFilter,
                  setEnabled: changeFilteringEnabled,
                  setSiteException: changeSiteFilterException,
                  updateList: updateFilterList,
                }}
              />
            </SettingsPage>
          ) : shortcutsPageOpen ? (
            <ShortcutsPage onClose={() => void closeTab(activeTabId)} />
          ) : activeSourceTab ? (
            <SourcePage state={activeSourceTab} onClose={() => void closeTab(activeTabId)} />
          ) : historyPageOpen ? (
            <HistoryPage
              history={history}
              historySearch={historySearch}
              setHistorySearch={setHistorySearch}
              openHistoryEntry={openHistoryEntry}
              onClose={() => void closeTab(activeTabId)}
            />
          ) : (
            (!activeTab?.url || !isTauri) && (
              <div
                className={`start-page${splitStartPageStyle ? ' start-page-in-split' : ''}`}
                style={splitStartPageStyle}
              >
                <div className="start-brand">
                  <span className="start-mark" aria-hidden="true">
                    u
                  </span>
                  <p className="eyebrow">A curious browser for curious people</p>
                </div>
                <h1>Where to?</h1>
                <p className="start-intro">A little less clutter. A little more room to explore.</p>
                <form className="start-search" onSubmit={navigate}>
                  <Search className="ui-icon" size={18} aria-hidden="true" />
                  <AppInput
                    aria-label="Search the web"
                    placeholder="Search or enter a website"
                    value={address}
                    onChange={(event) => setAddress(event.target.value)}
                  />
                  <kbd>↵</kbd>
                </form>
                {!isTauri && (
                  <p className="dev-note">Run the desktop app to open websites in the native browser view.</p>
                )}
                {message && (
                  <p className="message" role="status">
                    {message}
                  </p>
                )}
                <div className="quick-links" aria-label="Suggested sites">
                  <AppButton onClick={() => void navigateTo('https://www.google.com')}>Google</AppButton>
                  <AppButton onClick={() => void navigateTo('https://wikipedia.org')}>Wikipedia</AppButton>
                  <AppButton onClick={() => void navigateTo('https://github.com')}>GitHub</AppButton>
                </div>
              </div>
            )
          )}
          {message && activeTab?.url && (
            <div className={`toast${captureProgress ? ' toast-with-progress' : ''}`} role="status">
              <span>{message}</span>
              {captureProgress && (
                <div className="capture-progress-row">
                  <div
                    className="capture-progress-track"
                    role="progressbar"
                    aria-label="Full page screenshot progress"
                    aria-valuemin={0}
                    aria-valuemax={captureProgress.total}
                    aria-valuenow={captureProgress.completed}
                  >
                    <div
                      className="capture-progress-fill"
                      style={{
                        width: `${captureProgress.total ? Math.round((captureProgress.completed / captureProgress.total) * 100) : 0}%`,
                      }}
                    />
                  </div>
                  <span className="capture-progress-percent">
                    {captureProgress.total ? Math.round((captureProgress.completed / captureProgress.total) * 100) : 0}%
                  </span>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
