import { useCallback, useEffect, useRef, useState } from 'react';
import { Button as AriaButton, ListBox, ListBoxItem, Popover, Select, SelectValue, Tab, TabList, TabPanel, TabPanels, Tabs, Tree, TreeItem, TreeItemContent, useDragAndDrop } from 'react-aria-components';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, ChevronDown, ChevronRight, CircleDot, Clock3, Columns2, Download, ExternalLink, EyeOff, Folder, FolderPlus, Globe2, GripVertical, LoaderCircle, LockKeyhole, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Pencil, Plus, RotateCw, Search, Settings, Shield, Sparkles, Star, X } from 'lucide-react';
import { AppButton, AppInput } from './components/ui';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { Menu } from '@tauri-apps/api/menu';
import { LogicalPosition } from '@tauri-apps/api/dpi';
import SortableTreeDemo from './SortableTreeDemo';
import { DndContext, DragOverlay, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type DragMoveEvent, type DragStartEvent } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, useSortable } from '@dnd-kit/sortable';
import { flattenBookmarkNodes, locateBookmark, moveBookmarkToDropZone, resolveBookmarkDropZone } from './bookmarkTree';
import type { BookmarkDropZone, BookmarkFolder, BookmarkLink, BookmarkNode } from './bookmarkTree';

type Tab = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  active: boolean;
  zoom: number;
  private?: boolean;
};

type BrowserSnapshot = { tabs: Tab[]; activeTabId: string };
type ExternalBrowser = { id: string; name: string };
type SplitLayout = { firstTabId: string; secondTabId: string; orientation: 'horizontal' | 'vertical'; firstPanePercent: number };
type PageSecurityInfo = { secureHttps: boolean; location: string; camera: string; microphone: string; playingAudio: boolean };
type TabReference = { id: string; type: 'tab' };
type TabFolder = { id: string; type: 'folder'; title: string; collapsed: boolean; children: TabNode[] };
type TabNode = TabReference | TabFolder;
type HistoryEntry = { url: string; title: string; visitedAt: number };
type Download = { id: string; url: string; filename: string; path: string; status: 'downloading' | 'completed' | 'failed'; bytesReceived: number };
type Theme = 'system' | 'light' | 'dark';
type FilterSettingsView = { enabled: boolean; sourceUrl: string; updatedAt: number | null; acceptedRules: number; exceptions: string[] };
type FilterUpdateProgress = { phase: 'downloading' | 'compiling' | 'complete'; receivedBytes: number; totalBytes: number | null };
type LaunchRequest = { url: string; private: boolean };
type SessionTestPhase = 'exercise' | 'restore';
const tabEvent = 'browser://tabs-changed';
const settingsEvent = 'browser://open-settings';
const showHistoryEvent = 'browser://show-history';
const showDownloadsEvent = 'browser://show-downloads';
const shortcutEvent = 'browser://shortcut';
const historyEvent = 'browser://history-changed';
const downloadsEvent = 'browser://downloads-changed';
const filterUpdateProgressEvent = 'browser://filter-update-progress';
const launchRequestEvent = 'browser://launch-request';
const splitEvent = 'browser://split-changed';
const sidebarDefaultWidth = 240;
const sidebarMinWidth = 176;
const sidebarMaxWidth = 360;
const commandKey = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
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

function initialHistoryTabIds(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem('browser.historyTabs') ?? '[]');
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch { return []; }
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

function expandedTabFolderIds(nodes: TabNode[]): string[] {
  return nodes.flatMap(node => node.type === 'folder'
    ? [...(!node.collapsed ? [node.id] : []), ...expandedTabFolderIds(node.children)]
    : []);
}

function setTabFolderExpansion(nodes: TabNode[], expandedIds: Set<string>): TabNode[] {
  return nodes.map(node => node.type === 'folder'
    ? { ...node, collapsed: !expandedIds.has(node.id), children: setTabFolderExpansion(node.children, expandedIds) }
    : node);
}

function bookmarkFolderIds(nodes: BookmarkNode[]): string[] {
  return nodes.flatMap(node => node.type === 'folder' ? [node.id, ...bookmarkFolderIds(node.children)] : []);
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

function tabFolders(nodes: TabNode[]): TabFolder[] {
  return nodes.flatMap(node => node.type === 'folder' ? [node, ...tabFolders(node.children)] : []);
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

function BookmarkSortableRow({
  node, depth, expanded, dropZone, onToggle, onOpen, onEdit, onDelete, onNewFolder, onRename, onCancelRename, editingFolder, folderTitle, setFolderTitle, saveFolderTitle,
}: {
  node: BookmarkNode; depth: number; expanded: boolean; dropZone?: BookmarkDropZone; onToggle: () => void; onOpen: (url: string) => void;
  onEdit: (node: BookmarkLink) => void; onDelete: (node: BookmarkNode) => void; onNewFolder: (id: string) => void;
  onRename: (node: BookmarkFolder) => void; onCancelRename: () => void; editingFolder: boolean; folderTitle: string; setFolderTitle: (value: string) => void; saveFolderTitle: () => void;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useSortable({ id: node.id });
  const style = { opacity: isDragging ? .35 : 1 };
  const itemProps = { ...attributes, role: 'treeitem', 'aria-level': depth + 1, 'aria-expanded': node.type === 'folder' ? expanded : undefined };
  const itemClass = `bookmark-sortable-item ${dropZone ? `drop-${dropZone}` : ''}`;
  const stopDrag = (event: React.PointerEvent) => event.stopPropagation();
  if (node.type === 'folder') return <div ref={setNodeRef} style={style} className={itemClass} {...itemProps} {...listeners}>
    <div className="folder-row bookmark-dnd-folder" style={{ paddingLeft: depth * 14 }}>
      <button className="folder-toggle" aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.title}`} onPointerDown={stopDrag} onClick={event => { event.stopPropagation(); onToggle(); }}>{expanded ? <ChevronDown className="ui-icon" size={14} aria-hidden="true" /> : <ChevronRight className="ui-icon" size={14} aria-hidden="true" />}</button>
      <span className="bookmark-icon folder-icon" aria-hidden="true"><Folder className="ui-icon" size={14} /></span>
      {editingFolder ? <AppInput className="folder-title-input" aria-label="Folder name" autoFocus value={folderTitle} onPointerDown={stopDrag} onChange={event => setFolderTitle(event.target.value)} onBlur={saveFolderTitle} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); saveFolderTitle(); } if (event.key === 'Escape') { event.stopPropagation(); onCancelRename(); } }} /> : <span className="folder-title" title={node.title}>{node.title}</span>}
      {!node.children.length && expanded && <span className="tree-empty-hint">Empty folder</span>}
      <span className="folder-actions">
        <button type="button" className="folder-action" aria-label={`Create subfolder in ${node.title}`} title="New subfolder" onPointerDown={stopDrag} onClick={event => { event.stopPropagation(); onNewFolder(node.id); }}><FolderPlus className="ui-icon" size={14} aria-hidden="true" /></button>
        <button type="button" className="folder-action" aria-label={`Rename ${node.title}`} title="Rename folder" onPointerDown={stopDrag} onClick={event => { event.stopPropagation(); onRename(node); }}><Pencil className="ui-icon" size={14} aria-hidden="true" /></button>
        <button type="button" className="folder-action" aria-label={`Delete ${node.title}`} title="Delete folder and contents" onPointerDown={stopDrag} onClick={event => { event.stopPropagation(); onDelete(node); }}><X className="ui-icon" size={14} aria-hidden="true" /></button>
      </span>
    </div>
  </div>;
  return <div ref={setNodeRef} style={style} className={itemClass} {...itemProps} {...listeners}>
    <div className="bookmark-row bookmark-tree-row bookmark-dnd-link" style={{ paddingLeft: depth * 14 }} onClick={() => onOpen(node.url)}>
      <span className="bookmark-open"><span className="bookmark-icon"><Star className="ui-icon" size={14} aria-hidden="true" /></span><span><strong>{node.title}</strong><small>{node.url}</small></span></span>
      <button type="button" className="bookmark-edit" aria-label={`Edit ${node.title}`} onPointerDown={stopDrag} onClick={event => { event.stopPropagation(); onEdit(node); }}><Pencil className="ui-icon" size={14} aria-hidden="true" /></button>
      <button type="button" className="bookmark-delete" aria-label={`Delete ${node.title}`} onPointerDown={stopDrag} onClick={event => { event.stopPropagation(); onDelete(node); }}><X className="ui-icon" size={14} aria-hidden="true" /></button>
    </div>
  </div>;
}

function initialTheme(): Theme {
  const saved = localStorage.getItem('browser.theme');
  return saved === 'light' || saved === 'dark' ? saved : 'system';
}

export default function App() {
  if (new URLSearchParams(window.location.search).get('page') === 'tree') return <SortableTreeDemo />;
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activeTabId, setActiveTabId] = useState('');
  const [tabsLoaded, setTabsLoaded] = useState(false);
  const [tabNodes, setTabNodes] = useState<TabNode[]>(initialTabNodes);
  const [tabNameOverrides, setTabNameOverrides] = useState<Record<string, string>>(initialTabNameOverrides);
  const [tabFavicons, setTabFavicons] = useState<Record<string, string>>({});
  const [splitLayout, setSplitLayout] = useState<SplitLayout | null>(null);
  const [draggingTabId, setDraggingTabId] = useState('');
  const [tabNameDraft, setTabNameDraft] = useState('');
  const [editingTabId, setEditingTabId] = useState('');
  const [editingTabFolderId, setEditingTabFolderId] = useState('');
  const [tabFolderTitle, setTabFolderTitle] = useState('');
  const [tabContextMenu, setTabContextMenu] = useState<{ id: string; type: 'tab' | 'folder'; x: number; y: number } | null>(null);
  const [tabGroupPickerOpen, setTabGroupPickerOpen] = useState(false);
  const [address, setAddress] = useState('');
  const [message, setMessage] = useState('');
  const [isTauri, setIsTauri] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(initialSidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(initialSidebarCollapsed);
  const [resizingSidebar, setResizingSidebar] = useState(false);
  const [sidebarView, setSidebarView] = useState<'tabs' | 'bookmarks'>('tabs');
  const [bookmarks, setBookmarks] = useState<BookmarkNode[]>(initialBookmarks);
  const [bookmarkDragOrigin, setBookmarkDragOrigin] = useState<{ id: string; depth: number } | null>(null);
  const bookmarkSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 5 } }), useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }));
  const [bookmarkDropTarget, setBookmarkDropTarget] = useState<{ overId: string; zone: BookmarkDropZone } | null>(null);
  const bookmarkExpandTimer = useRef<{ id: string; timer: number } | null>(null);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historySearch, setHistorySearch] = useState('');
  const [historyTabIds, setHistoryTabIds] = useState<string[]>(initialHistoryTabIds);
  const [downloads, setDownloads] = useState<Download[]>([]);
  const [downloadsPopoverOpen, setDownloadsPopoverOpen] = useState(false);
  const [findOpen, setFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [findMatches, setFindMatches] = useState<number | null>(null);
  const [securityOpen, setSecurityOpen] = useState(false);
  const [securityInfo, setSecurityInfo] = useState<PageSecurityInfo | null>(null);
  const [bookmarkSearch, setBookmarkSearch] = useState('');
  const [bookmarkTitle, setBookmarkTitle] = useState('');
  const [bookmarkUrl, setBookmarkUrl] = useState('');
  const [editingBookmarkId, setEditingBookmarkId] = useState('');
  const [folderTitle, setFolderTitle] = useState('');
  const [editingFolderId, setEditingFolderId] = useState('');
  const [expandedFolderIds, setExpandedFolderIds] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [filterSettings, setFilterSettings] = useState<FilterSettingsView | null>(null);
  const [filterBusy, setFilterBusy] = useState(false);
  const [filterProgress, setFilterProgress] = useState<FilterUpdateProgress | null>(null);
  const [theme, setTheme] = useState<Theme>(initialTheme);
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
  const faviconRequests = useRef(new Set<string>());
  const sessionTestStarted = useRef(false);
  const activeTab = tabs.find(tab => tab.id === activeTabId);
  const activeSiteDomain = (() => {
    try { return activeTab?.url ? new URL(activeTab.url).hostname : ''; }
    catch { return ''; }
  })();
  const historyPageOpen = historyTabIds.includes(activeTabId);
  const tabContextMenuWidth = Math.min(200, sidebarWidth - 16);
  const currentBookmark = activeTab?.url ? findBookmarkByUrl(bookmarks, activeTab.url) : undefined;
  useEffect(() => () => { void externalBrowserMenuRef.current?.close(); }, []);
  const tabDragAndDrop = useDragAndDrop<TabNode>({
    getItems: keys => [...keys].map(key => ({ 'text/plain': String(key) })),
    onDragStart: event => {
      const key = [...event.keys].map(String).find(id => findTabNode(tabNodesRef.current, id)?.type === 'tab');
      if (!key) return;
      setDraggingTabId(key);
      void invoke('set_tab_dragging', { dragging: true, tabId: key, targetTabId: activeTabIdRef.current }).catch(error => setMessage(String(error)));
    },
    onDragEnd: () => {
      setDraggingTabId('');
      void invoke('set_tab_dragging', { dragging: false, tabId: null, targetTabId: null }).catch(error => setMessage(String(error)));
    },
    shouldAcceptItemDrop: target => target.dropPosition !== 'on' || findTabNode(tabNodesRef.current, String(target.key))?.type === 'folder',
    onMove: event => {
      if (event.dropOperation !== 'move') return;
      for (const key of event.keys) {
        const draggedId = String(key);
        if (event.target.dropPosition === 'on') moveTabNode(draggedId, undefined, String(event.target.key));
        else moveTabNode(draggedId, String(event.target.key), undefined, event.target.dropPosition);
      }
    },
  });
  useEffect(() => {
    if (!securityOpen) return;
    setSecurityInfo(null);
    if (!activeTabId || !activeTab?.url) return;
    let cancelled = false;
    const refresh = async () => {
      try {
        const info = await invoke<PageSecurityInfo>('get_page_security_info', { tabId: activeTabId });
        if (cancelled) return;
        setSecurityInfo(info);
        const button = securityButtonRef.current;
        if (!button) return;
        const rect = button.getBoundingClientRect();
        const shown = await invoke<boolean>('update_page_security_popover', {
          anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, info,
        });
        if (!cancelled) setSecurityOpen(shown);
      } catch {
        if (!cancelled) setSecurityInfo(null);
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1200);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [securityOpen, activeTabId, activeTab?.url]);

  useEffect(() => {
    if (!securityOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setSecurityOpen(false); };
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
    localStorage.setItem('browser.historyTabs', JSON.stringify(historyTabIds));
  }, [historyTabIds]);

  useEffect(() => {
    if (!tabsLoaded) return;
    const reconciled = reconcileTabNodes(tabNodesRef.current, tabs);
    if (JSON.stringify(reconciled) !== JSON.stringify(tabNodesRef.current)) {
      tabNodesRef.current = reconciled;
      setTabNodes(reconciled);
    }
    const openIds = new Set(tabs.map(tab => tab.id));
    setTabNameOverrides(names => Object.fromEntries(Object.entries(names).filter(([id]) => openIds.has(id))));
    setHistoryTabIds(ids => ids.filter(id => openIds.has(id)));
  }, [tabs, tabsLoaded]);

  useEffect(() => {
    if (!isTauri || !tabsLoaded) return;
    void invoke('set_settings_open', { open: settingsOpen || historyPageOpen })
      .catch(error => setMessage(String(error)));
  }, [isTauri, tabsLoaded, settingsOpen, historyPageOpen]);

  useEffect(() => {
    for (const tab of tabs) {
      // Wait until navigation finishes so the page's <link rel="icon"> is
      // present before querying the native WebView (e.g. Hacker News).
      if (tab.loading || !tab.url || !/^https?:/i.test(tab.url)) continue;
      const requestKey = `${tab.id}:${tab.url}`;
      if (faviconRequests.current.has(requestKey)) continue;
      faviconRequests.current.add(requestKey);
      window.setTimeout(() => {
        void invoke<string>('get_tab_favicon', { tabId: tab.id })
          .then(favicon => { if (favicon) setTabFavicons(current => ({ ...current, [tab.id]: favicon })); })
          .catch(() => { faviconRequests.current.delete(requestKey); });
      }, 100);
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
    tabsRef.current = snapshot.tabs;
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
      const unlistenShowHistory = await listen(showHistoryEvent, () => { void openHistoryPage(); });
      const unlistenShowDownloads = await listen(showDownloadsEvent, () => setDownloadsPopoverOpen(true));
      const unlistenHistory = await listen<HistoryEntry[]>(historyEvent, event => setHistory(event.payload));
      const unlistenDownloads = await listen<Download[]>(downloadsEvent, event => setDownloads(event.payload));
      const unlistenLaunchRequest = await listen<LaunchRequest>(launchRequestEvent, event => { void openLaunchRequest(event.payload); });
      const unlistenFilterProgress = await listen<FilterUpdateProgress>(filterUpdateProgressEvent, event => {
        if (event.payload.phase === 'complete') {
          setFilterProgress(null);
          return;
        }
        setFilterProgress(event.payload);
      });
      const unlistenSplit = await listen<SplitLayout | null>(splitEvent, event => setSplitLayout(event.payload));
      const unlistenSplitResize = await listen<number>('browser://split-resize', event => {
        void invoke('resize_tab_split', { firstPanePercent: event.payload }).catch(error => setMessage(String(error)));
      });
      const unlistenTabDragDrop = await listen<{ tabId: string; targetTabId: string; target: 'left' | 'right' | 'top' | 'bottom' | 'new-window' }>('browser://tab-drag-drop', event => {
        if (event.payload.target === 'new-window') void dropTabIntoNewWindow(event.payload.tabId);
        else void dropTabIntoSplit(event.payload.target, event.payload.tabId, event.payload.targetTabId);
      });
      void invoke<SplitLayout | null>('get_split_tabs').then(setSplitLayout).catch(error => setMessage(String(error)));
      void invoke<FilterSettingsView>('get_filter_settings').then(setFilterSettings).catch(error => setMessage(String(error)));
      const unlistenShortcuts = await listen<string>(shortcutEvent, event => {
        switch (event.payload) {
          case 'new-tab': void createTab(); break;
          case 'new-private-tab': void createTab(true); break;
          case 'open-in-browser': externalBrowserButtonRef.current?.click(); break;
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
        const launchRequest = await invoke<LaunchRequest | null>('take_launch_request');
        if (launchRequest) await openLaunchRequest(launchRequest);
        setHistory(await invoke<HistoryEntry[]>('get_history'));
        setDownloads(await invoke<Download[]>('get_downloads'));
      }
      catch (error) { setMessage(String(error)); }
      if (!cancelled) void runSessionIntegrationTest();
      if (cancelled) { unlisten(); unlistenSettings(); unlistenShowHistory(); unlistenShowDownloads(); unlistenShortcuts(); unlistenHistory(); unlistenDownloads(); unlistenSplit(); unlistenSplitResize(); unlistenTabDragDrop(); unlistenFilterProgress(); unlistenLaunchRequest(); }
      else {
        const originalUnlisten = unlisten;
        unlisten = () => { originalUnlisten(); unlistenSettings(); unlistenShowHistory(); unlistenShowDownloads(); unlistenShortcuts(); unlistenHistory(); unlistenDownloads(); unlistenSplit(); unlistenSplitResize(); unlistenTabDragDrop(); unlistenFilterProgress(); unlistenLaunchRequest(); };
      }
    })();
    return () => { cancelled = true; unlisten?.(); };
  }, [applySnapshot]);

  useEffect(() => {
    if (!downloadsPopoverOpen) return;
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
  }, [downloadsPopoverOpen]);

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
        const expectedFavicon = 'http://127.0.0.1:4179/favicon.svg';
        const nativeFavicon = await invoke<string>('get_tab_favicon', { tabId: snapshot.activeTabId });
        if (nativeFavicon !== expectedFavicon) {
          throw new Error(`Native WebView did not resolve the fixture favicon: ${nativeFavicon || 'missing'}`);
        }
        let renderedFavicon = '';
        for (let attempt = 0; attempt < 100; attempt += 1) {
          const row = Array.from(document.querySelectorAll<HTMLElement>('.tab-row'))
            .find(item => item.dataset.tabId === snapshot?.activeTabId);
          const image = row?.querySelector<HTMLImageElement>('.tab-favicon img');
          if (image?.complete && image.naturalWidth > 0) {
            renderedFavicon = image.src;
            break;
          }
          await new Promise(resolve => window.setTimeout(resolve, 50));
        }
        if (renderedFavicon !== expectedFavicon) {
          throw new Error(`Native tab favicon was not loaded after page navigation: ${renderedFavicon || 'missing'}`);
        }
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
      // Website tabs are native sibling WebViews above this shell WebView, so
      // CSS z-index cannot put the toolbar popover above them. Reserve its
      // right-side footprint until it closes, leaving the shell visible there.
      const popoverWidth = Math.min(360, Math.max(0, window.innerWidth - 24));
      const reservedWidth = downloadsPopoverOpen ? popoverWidth + 20 : 0;
      void invoke('set_view_bounds', {
        x: rect.left,
        y: rect.top,
        width: Math.max(1, rect.width - reservedWidth),
        height: rect.height,
      })
        .catch(error => setMessage(String(error)));
    };
    const observer = new ResizeObserver(updateBounds);
    observer.observe(view);
    updateBounds();
    window.addEventListener('resize', updateBounds);
    return () => { observer.disconnect(); window.removeEventListener('resize', updateBounds); };
  }, [isTauri, downloadsPopoverOpen]);

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
      if (key === 'n' && event.shiftKey) { event.preventDefault(); void createTab(true); }
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
  }

  async function openHistoryPage() {
    setSettingsOpen(false);
    const existingHistoryTabId = [...historyTabIds].reverse().find(id => tabs.some(tab => tab.id === id));
    if (existingHistoryTabId) {
      await selectTab(existingHistoryTabId);
    } else {
      try {
        await invoke('set_settings_open', { open: true });
        const snapshot = await invoke<BrowserSnapshot>('create_tab');
        applySnapshot(snapshot);
        setHistoryTabIds(ids => [...ids, snapshot.activeTabId]);
        setTabNameOverrides(names => ({ ...names, [snapshot.activeTabId]: 'history' }));
      } catch (error) {
        setMessage(String(error));
        void invoke('set_settings_open', { open: false }).catch(() => {});
        return;
      }
    }
    try { setHistory(await invoke<HistoryEntry[]>('get_history')); }
    catch (error) { setMessage(String(error)); }
  }

  async function leaveHistoryTab(tabId: string) {
    if (!historyTabIds.includes(tabId)) return;
    setHistoryTabIds(ids => ids.filter(id => id !== tabId));
    setTabNameOverrides(names => {
      const next = { ...names };
      delete next[tabId];
      return next;
    });
    try { await invoke('set_settings_open', { open: settingsOpen }); }
    catch (error) { setMessage(String(error)); }
  }

  async function createTab(privateMode = false) {
    try { applySnapshot(await invoke<BrowserSnapshot>('create_tab', { private: privateMode })); addressRef.current?.focus(); }
    catch (error) { setMessage(String(error)); }
  }

  async function openLaunchRequest(request: LaunchRequest) {
    try {
      const snapshot = await invoke<BrowserSnapshot>('create_tab', { private: request.private });
      applySnapshot(snapshot);
      await invoke('navigate', { tabId: snapshot.activeTabId, url: request.url });
    } catch (error) { setMessage(String(error)); }
  }

  async function clearBrowsingData() {
    try {
      await invoke('clear_browsing_data');
      setMessage('Website data clearing started; it may take a moment. History was cleared.');
    } catch (error) { setMessage(String(error)); }
  }

  async function changeFilteringEnabled(enabled: boolean) {
    setFilterBusy(true);
    try { setFilterSettings(await invoke<FilterSettingsView>('set_filtering_enabled', { enabled })); }
    catch (error) { setMessage(String(error)); }
    finally { setFilterBusy(false); }
  }

  async function updateFilterList() {
    setFilterBusy(true);
    setFilterProgress({ phase: 'downloading', receivedBytes: 0, totalBytes: null });
    try { setFilterSettings(await invoke<FilterSettingsView>('update_filter_list')); }
    catch (error) { setMessage(String(error)); }
    finally { setFilterBusy(false); setFilterProgress(null); }
  }

  async function changeSiteFilterException(enabled: boolean) {
    if (!activeSiteDomain) return;
    setFilterBusy(true);
    try { setFilterSettings(await invoke<FilterSettingsView>('set_filter_site_exception', { domain: activeSiteDomain, enabled })); }
    catch (error) { setMessage(String(error)); }
    finally { setFilterBusy(false); }
  }

  function findSplitCompanion(tabId: string) {
    const tabOrder = flattenTabIds(tabNodesRef.current);
    const sourceIndex = tabOrder.indexOf(tabId);
    const candidates = sourceIndex < 0
      ? tabOrder
      : [...tabOrder.slice(sourceIndex + 1), ...tabOrder.slice(0, sourceIndex).reverse()];
    return candidates
      .map(id => tabsRef.current.find(tab => tab.id === id))
      .find(tab => tab && tab.id !== tabId && tab.url && !tab.loading)?.id;
  }

  async function dropTabIntoSplit(side: 'left' | 'right' | 'top' | 'bottom', draggedTabId = draggingTabId, targetTabId = activeTabIdRef.current) {
    const tabId = draggedTabId;
    const targetId = tabId === targetTabId
      ? findSplitCompanion(tabId)
      : targetTabId;
    if (!tabId || !targetId) {
      setMessage('Open another loaded tab to create a split view.');
      return;
    }
    try {
      await invoke('split_tab', { tabId, targetTabId: targetId, side });
      const firstTabId = side === 'left' || side === 'top' ? tabId : targetId;
      setSplitLayout({
        firstTabId,
        secondTabId: firstTabId === tabId ? targetId : tabId,
        orientation: side === 'left' || side === 'right' ? 'horizontal' : 'vertical',
        firstPanePercent: 50,
      });
    } catch (error) { setMessage(String(error)); }
    setDraggingTabId('');
    void invoke('set_tab_dragging', { dragging: false, tabId: null, targetTabId: null }).catch(error => setMessage(String(error)));
  }

  async function dropTabIntoNewWindow(draggedTabId = draggingTabId) {
    const tabId = draggedTabId;
    if (!tabId) return;
    try {
      await invoke<string>('move_tab_to_new_window', { tabId });
      setMessage('Tab moved to a new window.');
    } catch (error) { setMessage(String(error)); }
    setDraggingTabId('');
    void invoke('set_tab_dragging', { dragging: false, tabId: null, targetTabId: null }).catch(error => setMessage(String(error)));
  }

  async function closeSplitView() {
    try {
      await invoke('clear_tab_split');
      setSplitLayout(null);
    } catch (error) { setMessage(String(error)); }
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
      await leaveHistoryTab(activeTabId);
      setMessage('');
      await invoke('navigate', { tabId: activeTabId, url: address });
      addressRef.current?.blur();
    } catch (error) { setMessage(String(error)); }
  }

  async function navigateTo(url: string) {
    setAddress(url);
    if (!activeTabId) return;
    try { await leaveHistoryTab(activeTabId); setMessage(''); await invoke('navigate', { tabId: activeTabId, url }); }
    catch (error) { setMessage(String(error)); }
  }

  async function runNavigationCommand(command: 'go_back' | 'go_forward' | 'reload' | 'stop_loading') {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    try { await invoke(command, { tabId }); }
    catch (error) { setMessage(String(error)); }
  }

  async function showExternalBrowsers(tabId = activeTabIdRef.current, position?: { x: number; y: number }) {
    const rect = externalBrowserButtonRef.current?.getBoundingClientRect();
    const targetTab = tabs.find(tab => tab.id === tabId);
    const anchor = position ?? (rect ? { x: rect.left, y: rect.bottom } : undefined);
    if (!targetTab?.url.match(/^https?:\/\//) || !anchor || externalBrowserMenuLoading.current) return;
    externalBrowserMenuLoading.current = true;
    try {
      const browsers = await invoke<ExternalBrowser[]>('get_external_browsers');
      await externalBrowserMenuRef.current?.close();
      const menu = await Menu.new({
        items: [
          { text: targetTab.private ? 'Opens using the other browser’s session' : 'Open page in…', enabled: false },
          ...browsers.map(browser => ({
            text: browser.name,
            action: () => {
              void invoke('open_in_external_browser', { tabId, browserId: browser.id })
                .catch(error => setMessage(String(error)));
            },
          })),
          ...(browsers.length ? [] : [{ text: 'No other browsers found', enabled: false }]),
        ],
      });
      externalBrowserMenuRef.current = menu;
      await menu.popup(new LogicalPosition(anchor.x, anchor.y));
    } catch (error) { setMessage(String(error)); }
    finally { externalBrowserMenuLoading.current = false; }
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

  function clearBookmarkExpandTimer() {
    if (bookmarkExpandTimer.current) window.clearTimeout(bookmarkExpandTimer.current.timer);
    bookmarkExpandTimer.current = null;
  }

  function endBookmarkDrag() {
    clearBookmarkExpandTimer();
    setBookmarkDropTarget(null);
    setBookmarkDragOrigin(null);
  }

  function bookmarkDropZoneFor({ active, over }: Pick<DragMoveEvent, 'active' | 'over'>): BookmarkDropZone | null {
    const rect = active.rect.current.translated;
    if (!over || !rect || over.id === active.id) return null;
    const target = locateBookmark(bookmarks, String(over.id));
    if (!target) throw new Error(`Bookmark drop target ${String(over.id)} was not found`);
    return resolveBookmarkDropZone(rect.top + rect.height / 2, over.rect.top, over.rect.height, target.node.type === 'folder');
  }

  function handleBookmarkDragStart({ active }: DragStartEvent) {
    const found = locateBookmark(bookmarks, String(active.id));
    if (found) setBookmarkDragOrigin({ id: String(active.id), depth: found.depth });
  }

  function handleBookmarkDragMove(event: DragMoveEvent) {
    const zone = bookmarkDropZoneFor(event);
    const overId = event.over ? String(event.over.id) : '';
    setBookmarkDropTarget(current => !zone ? null : current?.overId === overId && current.zone === zone ? current : { overId, zone });
    const hoveredCollapsedFolder = zone === 'inside' && !bookmarkExpanded.has(overId);
    if (!hoveredCollapsedFolder) { clearBookmarkExpandTimer(); return; }
    if (bookmarkExpandTimer.current?.id === overId) return;
    clearBookmarkExpandTimer();
    bookmarkExpandTimer.current = { id: overId, timer: window.setTimeout(() => {
      bookmarkExpandTimer.current = null;
      setExpandedFolderIds(ids => ids.includes(overId) ? ids : [...ids, overId]);
    }, 600) };
  }

  function handleBookmarkDragEnd(event: DragEndEvent) {
    const zone = bookmarkDropZoneFor(event);
    if (zone && bookmarkDragOrigin) {
      const result = moveBookmarkToDropZone(bookmarks, String(event.active.id), String(event.over!.id), zone, bookmarkDragOrigin.depth, event.delta.x);
      setBookmarks(result.nodes);
      if (result.parentId) setExpandedFolderIds(ids => ids.includes(result.parentId!) ? ids : [...ids, result.parentId!]);
    }
    endBookmarkDrag();
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
    if (folderId) storeTabTree(updateTabNode(tabNodesRef.current, folderId, node => node.type === 'folder' ? { ...node, collapsed: false } : node));
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
        return <TreeItem
          key={node.id}
          id={node.id}
          textValue={`Folder ${node.title}`}
          hasChildItems
          className="tab-tree-item"
          onContextMenu={event => { event.preventDefault(); setTabGroupPickerOpen(false); setTabContextMenu({ id: node.id, type: 'folder', x: Math.min(event.clientX, window.innerWidth - 165), y: Math.min(event.clientY, window.innerHeight - 90) }); }}
        >
          <TreeItemContent>{({ isExpanded }) => <div className="tab-folder-row" style={{ paddingLeft: depth * 14 }}>
            <AriaButton slot="chevron" className="tab-folder-toggle" aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${node.title}`}>{isExpanded ? <ChevronDown className="ui-icon" size={14} aria-hidden="true" /> : <ChevronRight className="ui-icon" size={14} aria-hidden="true" />}</AriaButton>
            <span className="tab-folder-icon" aria-hidden="true"><Folder className="ui-icon" size={14} /></span>
            {editingTabFolderId === node.id
              ? <AppInput className="tab-folder-name-input" aria-label="Tab folder name" autoFocus value={tabFolderTitle} onChange={event => setTabFolderTitle(event.target.value)} onBlur={() => saveTabFolderTitle(node.id)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); saveTabFolderTitle(node.id); } if (event.key === 'Escape') { setEditingTabFolderId(''); setTabFolderTitle(node.title); } }} />
              : <span className="tab-folder-title">{node.title}</span>}
            <span className="tree-drag-slot"><AriaButton slot="drag" className="tree-drag-handle" aria-label={`Move folder ${node.title}`}><GripVertical className="ui-icon" size={14} aria-hidden="true" /></AriaButton></span>
            {!node.children.length && expanded && <span className="tree-empty-hint">Drop tabs here</span>}
          </div>}</TreeItemContent>
          {renderTabNodes(node.children, depth + 1)}
        </TreeItem>;
      }
      const tab = tabs.find(item => item.id === node.id);
      if (!tab) return null;
      const title = tabNameOverrides[tab.id] || tab.title || 'New Tab';
      const icon = tabFavicons[tab.id];
      return <TreeItem
        key={node.id}
        id={node.id}
        textValue={title}
        className="tab-tree-item"
        aria-current={tab.id === activeTabId ? 'page' : undefined}
        onAction={() => void selectTab(tab.id)}
        onContextMenu={event => { event.preventDefault(); setTabGroupPickerOpen(false); setTabContextMenu({ id: tab.id, type: 'tab', x: Math.max(8, Math.min(event.clientX, sidebarWidth - tabContextMenuWidth - 8)), y: Math.min(event.clientY, window.innerHeight - 90) }); }}
      >
        <TreeItemContent><div className={`tab-row ${tab.id === activeTabId ? 'selected' : ''}`} style={{ paddingLeft: depth * 14 }} data-tab-id={tab.id}>
          <span className={`tab-favicon ${tab.loading ? 'is-loading' : ''}`}>{tab.loading ? <LoaderCircle className="ui-icon" size={14} aria-hidden="true" /> : icon ? <img src={icon} alt="" onError={() => setTabFavicons(current => { const next = { ...current }; delete next[tab.id]; return next; })} /> : tab.url ? <Globe2 className="ui-icon" size={14} aria-hidden="true" /> : <Sparkles className="ui-icon" size={14} aria-hidden="true" />}</span>
          {editingTabId === tab.id
            ? <AppInput className="tab-rename-input" aria-label="Tab name" value={tabNameDraft} autoFocus onChange={event => setTabNameDraft(event.target.value)} onBlur={() => saveTabName(tab.id)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); saveTabName(tab.id); } if (event.key === 'Escape') { event.stopPropagation(); setEditingTabId(''); } }} />
            : <span className="tab-title">{title}</span>}
          {tab.private && <span className="private-tab-indicator" title="Private tab" aria-label="Private tab"><EyeOff className="ui-icon" size={13} aria-hidden="true" /></span>}
          <span className="tree-drag-slot"><AriaButton slot="drag" className="tree-drag-handle" aria-label={`Move ${title}`}><GripVertical className="ui-icon" size={14} aria-hidden="true" /></AriaButton></span>
          <AppButton className="tab-close" aria-label={`Close ${title}`} onClick={() => void closeTab(tab.id)}><X className="ui-icon" size={14} aria-hidden="true" /></AppButton>
        </div></TreeItemContent>
      </TreeItem>;
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
    void invoke('set_settings_open', { open: historyPageOpen }).catch(error => setMessage(String(error)));
  }

  const bookmarkExpanded = new Set(bookmarkSearch.trim() ? bookmarkFolderIds(filterBookmarkNodes(bookmarks, bookmarkSearch.trim())) : expandedFolderIds);
  // A dragged folder collapses so its own children are not drop targets.
  if (bookmarkDragOrigin) bookmarkExpanded.delete(bookmarkDragOrigin.id);
  const draggedBookmark = bookmarkDragOrigin ? locateBookmark(bookmarks, bookmarkDragOrigin.id)?.node : undefined;
  const visibleBookmarkRows = flattenBookmarkNodes(filterBookmarkNodes(bookmarks, bookmarkSearch.trim()), bookmarkExpanded);

  return (
    <main className="browser-shell">
      <aside className={`sidebar ${sidebarCollapsed ? 'collapsed' : ''}`} style={{ width: sidebarCollapsed ? 48 : sidebarWidth, flexBasis: sidebarCollapsed ? 48 : sidebarWidth }}>
        <div className="brand-row">
          <div className="brand-mark" aria-hidden="true"><CircleDot className="ui-icon" size={17} /></div>
          <span className="brand-name">My Browser</span>
          <AppButton className="sidebar-collapse-button" type="button" aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!sidebarCollapsed} aria-controls="sidebar-content" onClick={() => setSidebarCollapsed(collapsed => !collapsed)}>{sidebarCollapsed ? <PanelLeftOpen className="ui-icon" size={16} aria-hidden="true" /> : <PanelLeftClose className="ui-icon" size={16} aria-hidden="true" />}</AppButton>
        </div>
        <div className="sidebar-content" id="sidebar-content">
        <Tabs className="sidebar-tabs" selectedKey={sidebarView} onSelectionChange={key => setSidebarView(key as typeof sidebarView)}>
          <TabList className="sidebar-switcher" aria-label="Sidebar views">
            <Tab id="tabs">Tabs</Tab>
            <Tab id="bookmarks">Bookmarks</Tab>
          </TabList>
          <TabPanels className="sidebar-panels">
          <TabPanel id={sidebarView} className="sidebar-panel">
        {sidebarView === 'tabs' ? <>
        <Tree
          className="tab-list tab-tree"
          aria-label="Open tabs"
          selectionMode="none"
          keyboardNavigationBehavior="tab"
          expandedKeys={new Set(expandedTabFolderIds(tabNodes))}
          onExpandedChange={keys => storeTabTree(setTabFolderExpansion(tabNodesRef.current, new Set([...keys].map(String))))}
          dragAndDropHooks={tabDragAndDrop.dragAndDropHooks}
        >
          {renderTabNodes(tabNodes)}
        </Tree>
        <div className="tab-actions">
          <AppButton className="new-tab" onClick={() => void createTab()}><Plus className="ui-icon" size={16} aria-hidden="true" /> New tab <kbd>{commandKey} T</kbd></AppButton>
          <AppButton className="new-tab-folder" title="Create tab folder" aria-label="Create tab folder" onClick={createTabFolder}><FolderPlus className="ui-icon" size={14} aria-hidden="true" /> Folder</AppButton>
        </div>
        <div className="tab-actions">
          <AppButton className="new-tab" title={`New private tab (${commandKey}+Shift+N)`} onClick={() => void createTab(true)}><EyeOff className="ui-icon" size={16} aria-hidden="true" /> New private tab</AppButton>
        </div>
        </> : sidebarView === 'bookmarks' ? <div className="bookmark-manager">
          <div className="bookmark-toolbar"><AppInput className="bookmark-search" aria-label="Search bookmarks" placeholder="Find a bookmark" value={bookmarkSearch} onChange={event => setBookmarkSearch(event.target.value)} /><AppButton className="new-folder-button" onClick={() => createBookmarkFolder()}><FolderPlus className="ui-icon" size={14} aria-hidden="true" /> Folder</AppButton></div>
          <form className="bookmark-form" onSubmit={saveBookmark}>
            <AppInput aria-label="Bookmark title" placeholder="Name" value={bookmarkTitle} onChange={event => setBookmarkTitle(event.target.value)} />
            <AppInput aria-label="Bookmark address" placeholder="https://example.com" value={bookmarkUrl} onChange={event => setBookmarkUrl(event.target.value)} />
            <AppButton type="submit">{editingBookmarkId ? 'Save changes' : 'Add bookmark'}</AppButton>
            {editingBookmarkId && <AppButton type="button" className="cancel-edit" onClick={() => { setEditingBookmarkId(''); setBookmarkTitle(''); setBookmarkUrl(''); }}>Cancel</AppButton>}
          </form>
          <DndContext sensors={bookmarkSensors} collisionDetection={closestCenter} onDragStart={handleBookmarkDragStart} onDragMove={handleBookmarkDragMove} onDragEnd={handleBookmarkDragEnd} onDragCancel={endBookmarkDrag}>
            <div className={`bookmark-list bookmark-tree bookmark-dnd-list ${bookmarkDragOrigin ? 'is-dragging' : ''}`} role="tree" aria-label="Saved bookmarks">
              {visibleBookmarkRows.length ? <SortableContext items={visibleBookmarkRows.map(item => item.node.id)} strategy={() => null}>
                {visibleBookmarkRows.map(({ node, depth }) => <BookmarkSortableRow
                  key={node.id} node={node} depth={depth} expanded={bookmarkExpanded.has(node.id)} dropZone={bookmarkDropTarget?.overId === node.id ? bookmarkDropTarget.zone : undefined}
                  onToggle={() => setExpandedFolderIds(ids => ids.includes(node.id) ? ids.filter(id => id !== node.id) : [...ids, node.id])}
                  onOpen={url => void openBookmark(url)} onEdit={editBookmark} onDelete={deleteBookmarkNode} onNewFolder={createBookmarkFolder}
                  onRename={folder => { setFolderTitle(folder.title); setEditingFolderId(folder.id); }}
                  onCancelRename={() => { setEditingFolderId(''); setFolderTitle(node.type === 'folder' ? node.title : ''); }}
                  editingFolder={node.type === 'folder' && editingFolderId === node.id} folderTitle={folderTitle} setFolderTitle={setFolderTitle}
                  saveFolderTitle={() => saveFolderTitle(node.id)}
                />)}
              </SortableContext> : <p className="bookmark-empty">{bookmarks.length === 0 ? 'Your saved pages will appear here.' : 'No matching bookmarks.'}</p>}
            </div>
            <DragOverlay dropAnimation={null}>{draggedBookmark ? <div className="bookmark-drag-overlay">{draggedBookmark.type === 'folder' ? <Folder className="ui-icon" size={14} aria-hidden="true" /> : <Star className="ui-icon" size={14} aria-hidden="true" />}<span>{draggedBookmark.title}</span></div> : null}</DragOverlay>
          </DndContext>
        </div> : null}
          </TabPanel>
          </TabPanels>
        </Tabs>
        {tabContextMenu && <>
          <div className="sidebar-context-dismiss" onClick={() => setTabContextMenu(null)} />
          <div className="sidebar-context-menu" style={{ left: tabContextMenu.x, top: tabContextMenu.y, width: tabContextMenu.type === 'tab' ? tabContextMenuWidth : undefined }} role="menu">
            <AppButton role="menuitem" onClick={() => {
              if (tabContextMenu.type === 'tab') {
                const tab = tabs.find(item => item.id === tabContextMenu.id);
                setTabNameDraft(tabNameOverrides[tabContextMenu.id] || tab?.title || '');
                setEditingTabId(tabContextMenu.id);
              } else {
                const folder = findTabNode(tabNodesRef.current, tabContextMenu.id);
                if (folder?.type === 'folder') { setTabFolderTitle(folder.title); setEditingTabFolderId(folder.id); }
              }
              setTabContextMenu(null);
            }}>Rename</AppButton>
            {tabContextMenu.type === 'tab' && <AppButton role="menuitem" aria-haspopup="menu" disabled={!isTauri || !tabs.find(tab => tab.id === tabContextMenu.id)?.url.match(/^https?:\/\//)} onClick={() => {
              const { id, x, y } = tabContextMenu;
              setTabContextMenu(null);
              void showExternalBrowsers(id, { x, y });
            }}>Open in another browser…</AppButton>}
            {tabContextMenu.type === 'tab' && <>
              {(['left', 'right', 'top', 'bottom'] as const).map(side => <AppButton key={side} role="menuitem" disabled={tabContextMenu.id === activeTabIdRef.current || !tabs.find(tab => tab.id === tabContextMenu.id)?.url.match(/^https?:\/\//)} onClick={() => {
                const tabId = tabContextMenu.id;
                setTabContextMenu(null);
                void dropTabIntoSplit(side, tabId);
              }}>Split {side}</AppButton>)}
              <AppButton role="menuitem" disabled={!tabs.find(tab => tab.id === tabContextMenu.id)?.url.match(/^https?:\/\//)} onClick={() => {
                const tab = tabs.find(item => item.id === tabContextMenu.id);
                if (tab) void invoke('reload', { tabId: tab.id }).catch(error => setMessage(String(error)));
                setTabContextMenu(null);
              }}>Reload page</AppButton>
              <AppButton role="menuitem" disabled={!tabs.find(tab => tab.id === tabContextMenu.id)?.url.match(/^https?:\/\//)} onClick={async () => {
                const tab = tabs.find(item => item.id === tabContextMenu.id);
                setTabContextMenu(null);
                if (!tab) return;
                try {
                  const snapshot = await invoke<BrowserSnapshot>('create_tab', { private: true });
                  applySnapshot(snapshot);
                  await invoke('navigate', { tabId: snapshot.activeTabId, url: tab.url });
                } catch (error) { setMessage(String(error)); }
              }}>Reload in private tab</AppButton>
              <AppButton role="menuitem" aria-haspopup="menu" aria-expanded={tabGroupPickerOpen} disabled={tabFolders(tabNodes).length === 0} onClick={() => setTabGroupPickerOpen(open => !open)}>Move tab to group…</AppButton>
              {tabGroupPickerOpen && tabFolders(tabNodes).map(folder => <AppButton key={folder.id} role="menuitem" className="context-submenu-item" onClick={() => {
                moveTabNode(tabContextMenu.id, undefined, folder.id);
                setTabGroupPickerOpen(false);
                setTabContextMenu(null);
              }}>{folder.title}</AppButton>)}
            </>}
            {tabContextMenu.type === 'folder' && <AppButton role="menuitem" onClick={() => { deleteTabFolder(tabContextMenu.id); setTabContextMenu(null); }}>Delete folder</AppButton>}
          </div>
        </>}
        <div className="sidebar-bottom">
          <AppButton className="profile-button"><span className="avatar">J</span><span className="profile-copy"><strong>Personal</strong><small>Local profile</small></span><MoreHorizontal className="ui-icon profile-menu" size={16} aria-hidden="true" /></AppButton>
        </div>
        </div>
        <div className={`sidebar-sizer ${resizingSidebar ? 'dragging' : ''}`} role="separator" aria-label="Resize tab sidebar" aria-orientation="vertical" aria-valuemin={sidebarMinWidth} aria-valuemax={sidebarMaxWidth} aria-valuenow={Math.round(sidebarWidth)} tabIndex={0} data-sidebar-sizer onPointerDown={event => { event.preventDefault(); setResizingSidebar(true); }} onDoubleClick={() => { setSidebarWidth(sidebarDefaultWidth); localStorage.removeItem('browser.sidebarWidth'); }} />
      </aside>

      <section className="browser-main">
        <header className="toolbar">
          <div className="nav-controls" aria-label="Page navigation">
            <AppButton className="icon-button" title="Go back" aria-label="Go back" disabled={!activeTab?.canGoBack} onClick={() => void runNavigationCommand('go_back')}><ArrowLeft className="ui-icon" size={17} aria-hidden="true" /></AppButton>
            <AppButton className="icon-button" title="Go forward" aria-label="Go forward" disabled={!activeTab?.canGoForward} onClick={() => void runNavigationCommand('go_forward')}><ArrowRight className="ui-icon" size={17} aria-hidden="true" /></AppButton>
            <AppButton className="icon-button reload-button" title={activeTab?.loading ? 'Stop loading' : 'Reload'} aria-label={activeTab?.loading ? 'Stop loading' : 'Reload'} onClick={() => void runNavigationCommand(activeTab?.loading ? 'stop_loading' : 'reload')}>{activeTab?.loading ? <X className="ui-icon" size={16} aria-hidden="true" /> : <RotateCw className="ui-icon" size={16} aria-hidden="true" />}</AppButton>
          </div>
          <form className="address-form" onSubmit={navigate}>
            <span className="security-icon" aria-hidden="true">{activeTab?.url.startsWith('https:') ? <LockKeyhole className="ui-icon" size={13} /> : <Globe2 className="ui-icon" size={13} />}</span>
            <AppInput ref={addressRef} aria-label="Search or enter address" autoComplete="off" spellCheck={false} placeholder="Search or enter address" value={address} onChange={event => setAddress(event.target.value)} onFocus={event => event.currentTarget.select()} />
            {activeTab?.url && <AppButton type="button" className="clear-address" title="Clear address" aria-label="Clear address" onClick={() => { setAddress(''); addressRef.current?.focus(); }}><X className="ui-icon" size={13} aria-hidden="true" /></AppButton>}
          </form>
          {findOpen ? <form className="find-form" aria-label="Find in page" onSubmit={event => { event.preventDefault(); void findInPage(findQuery); }}>
            <AppInput ref={findRef} aria-label="Find in page" placeholder="Find in page" value={findQuery} onChange={event => { setFindQuery(event.target.value); setFindMatches(null); }} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void findInPage(findQuery, event.shiftKey); } }} />
            {findMatches !== null && <span className="find-result" role="status" aria-live="polite">{findMatches} {findMatches === 1 ? 'match' : 'matches'}</span>}
            <AppButton type="submit" title="Find next" aria-label="Find next"><ArrowDown className="ui-icon" size={13} aria-hidden="true" /></AppButton><AppButton type="button" title="Find previous" aria-label="Find previous" onClick={() => void findInPage(findQuery, true)}><ArrowUp className="ui-icon" size={13} aria-hidden="true" /></AppButton>
            <AppButton type="button" title="Close find" aria-label="Close find" onClick={() => { setFindOpen(false); setFindQuery(''); setFindMatches(null); }}><X className="ui-icon" size={13} aria-hidden="true" /></AppButton>
          </form> : <AppButton className="toolbar-action" title={`Find in page (${commandKey}+F)`} aria-label="Find in page" onClick={openFindPanel}><Search className="ui-icon" size={17} aria-hidden="true" /></AppButton>}
          <AppButton className={`toolbar-action bookmark-toggle ${currentBookmark ? 'is-bookmarked' : ''}`} title={currentBookmark ? 'Page bookmarked' : 'Bookmark this page'} aria-label={currentBookmark ? 'Page bookmarked' : 'Bookmark this page'} aria-pressed={Boolean(currentBookmark)} disabled={!activeTab?.url} onClick={addCurrentPage}><Star className="ui-icon" size={17} aria-hidden="true" fill={currentBookmark ? 'currentColor' : 'none'} /></AppButton>
          <AppButton ref={externalBrowserButtonRef} className="toolbar-action" title="Open in another browser" aria-label="Open in another browser" aria-haspopup="menu" disabled={!isTauri || !activeTab?.url.match(/^https?:\/\//)} onClick={() => void showExternalBrowsers()}><ExternalLink className="ui-icon" size={17} aria-hidden="true" /></AppButton>
          <AppButton ref={securityButtonRef} className={`toolbar-action ${securityOpen ? 'security-active' : ''}`} title="Page security and permissions" aria-label="Page security and permissions" aria-expanded={securityOpen} disabled={!activeTab?.url} onClick={async () => {
            const rect = securityButtonRef.current?.getBoundingClientRect();
            if (!rect || !activeTab?.url) return;
            const info = securityInfo || { origin: new URL(activeTab.url).origin, secureHttps: activeTab.url.startsWith('https:'), location: 'unknown', camera: 'unknown', microphone: 'unknown', playingAudio: false };
            try {
              const shown = await invoke<boolean>('toggle_page_security_popover', {
                anchor: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, info,
              });
              setSecurityOpen(shown);
              if (!shown) setSecurityInfo(null);
            } catch (error) { setMessage(String(error)); }
          }}><Shield className="ui-icon" size={17} aria-hidden="true" /></AppButton>
          {splitLayout && <AppButton className="toolbar-action" title="Close split view" aria-label="Close split view" onClick={() => void closeSplitView()}><Columns2 className="ui-icon" size={17} aria-hidden="true" /></AppButton>}
          <AppButton className="toolbar-action" title="Settings" aria-label="Settings" onClick={() => { setSettingsOpen(true); void invoke('set_settings_open', { open: true }); }}><Settings className="ui-icon" size={17} aria-hidden="true" /></AppButton>
          <AppButton className="toolbar-action downloads-trigger" title="Recent downloads" aria-label={`Recent downloads${downloads.length ? `, ${downloads.length} items` : ''}`} aria-haspopup="dialog" aria-expanded={downloadsPopoverOpen} aria-controls="downloads-popover" onClick={() => setDownloadsPopoverOpen(open => !open)}><Download className="ui-icon" size={17} aria-hidden="true" />{downloads.length > 0 && <span className="download-count" aria-hidden="true">{downloads.length > 99 ? '99+' : downloads.length}</span>}</AppButton>
          {downloadsPopoverOpen && <section id="downloads-popover" className="downloads-popover" role="dialog" aria-label="Recent downloads">
                <header className="downloads-popover-heading"><div><h2>{downloads.length === 0 ? 'recent download history' : 'Downloads'}</h2>{downloads.length > 0 && <span>{downloads.length} {downloads.length === 1 ? 'item' : 'items'}</span>}</div></header>
                <ul className="downloads-popover-list">
                  {downloads.slice(0, 8).map(item => <li className="downloads-popover-row" key={item.id}>
                    <span className="downloads-popover-icon" aria-hidden="true"><Download className="ui-icon" size={16} /></span>
                    <div className="downloads-popover-copy"><strong title={item.filename}>{item.filename}</strong><small className={`download-status-${item.status}`}>{item.status === 'completed' ? 'Complete' : item.status === 'failed' ? 'Failed' : `Downloading · ${item.bytesReceived.toLocaleString()} bytes`}</small>{item.status === 'downloading' && <progress className="download-progress" aria-label={`Downloading ${item.filename}`} />}</div>
                    <AppButton className="download-reveal" disabled={item.status !== 'completed'} aria-label={`Reveal ${item.filename}`} title="Show in Finder" onClick={() => void invoke('reveal_download', { downloadId: item.id }).catch(error => setMessage(String(error)))}><ExternalLink className="ui-icon" size={14} aria-hidden="true" /></AppButton>
                  </li>)}
                </ul>
          </section>}
        </header>

        <div className="webview-slot" ref={viewRef}>
          {settingsOpen ? <section className="settings-page" aria-label="Settings">
            <header className="settings-heading"><div><p className="eyebrow">MY BROWSER</p><h1>Settings</h1></div><AppButton className="settings-close" onClick={closeSettings} aria-label="Close settings"><X className="ui-icon" size={17} aria-hidden="true" /></AppButton></header>
            <div className="settings-content">
              <h2>General</h2>
              <div className="settings-card"><div><strong>Bookmarks</strong><small>Saved locally in this browser profile.</small></div><AppButton onClick={() => { closeSettings(); setSidebarView('bookmarks'); }}>Manage bookmarks</AppButton></div>
              <h2>Appearance</h2>
              <div className="settings-card"><div><strong>Color scheme</strong><small>Choose the browser interface appearance.</small></div>
                <Select aria-label="Color scheme" selectedKey={theme} onSelectionChange={key => setTheme(key as Theme)} className="theme-select">
                  <AriaButton className="button-base theme-select-trigger" data-variant="secondary"><SelectValue /></AriaButton>
                  <Popover className="theme-select-popover"><ListBox>
                    <ListBoxItem id="system">System</ListBoxItem>
                    <ListBoxItem id="light">Light</ListBoxItem>
                    <ListBoxItem id="dark">Dark</ListBoxItem>
                  </ListBox></Popover>
                </Select>
              </div>
              <div className="settings-card"><div><strong>Sidebar width</strong><small>Resize the sidebar by dragging its right edge.</small></div><span>{Math.round(sidebarWidth)} px</span></div>
              <h2>Privacy</h2>
              <div className="settings-card"><div><strong>Private tab</strong><small>Open a tab with ephemeral website storage. Private tabs are excluded from history and session recovery.</small></div><AppButton onClick={() => void createTab(true)}>New private tab</AppButton></div>
              <div className="settings-card"><div><strong>Clear browsing data</strong><small>Clear website storage for this browser profile and remove browsing history.</small></div><AppButton onClick={() => void clearBrowsingData()}>Clear data</AppButton></div>
              <div className="settings-card"><div><strong>Content filtering</strong><small>{filterSettings?.enabled ? filterSettings.updatedAt ? 'EasyList based blocking is active for new and reloaded pages.' : 'The built-in starter rules are active until EasyList is updated.' : 'Ad and tracker blocking is disabled.'} Changes reload open website tabs.</small></div><AppButton disabled={filterBusy || !filterSettings} onClick={() => void changeFilteringEnabled(!filterSettings?.enabled)}>{filterSettings?.enabled ? 'Turn off' : 'Turn on'}</AppButton></div>
              <div className="settings-card"><div><strong>Filter list</strong><small>{filterSettings ? `${filterSettings.acceptedRules.toLocaleString()} supported rules · ${filterSettings.updatedAt ? `Updated ${new Date(filterSettings.updatedAt * 1000).toLocaleString()}` : 'Using the built-in starter set'}` : 'Loading filter status…'} The compiler skips unsupported EasyList syntax.</small>{filterBusy && <div className="filter-update-progress" role="status" aria-live="polite">
                <span>{filterProgress?.phase === 'compiling' ? 'Compiling rules…' : filterProgress?.totalBytes ? `Downloading EasyList… ${Math.min(100, Math.floor(filterProgress.receivedBytes * 100 / filterProgress.totalBytes))}%` : 'Connecting to EasyList…'}</span>
                {filterProgress?.phase === 'downloading' && filterProgress.totalBytes && <progress aria-label="EasyList download progress" max={100} value={Math.min(100, Math.floor(filterProgress.receivedBytes * 100 / filterProgress.totalBytes))} />}
                {filterProgress?.phase === 'downloading' && !filterProgress.totalBytes && <progress aria-label="EasyList download progress" />}
              </div>}</div><AppButton disabled={filterBusy} onClick={() => void updateFilterList()}>{filterBusy ? 'Updating…' : 'Update EasyList'}</AppButton></div>
              <div className="settings-card"><div><strong>Current site</strong><small>{activeSiteDomain ? `Allow requests on ${activeSiteDomain} by disabling filtering for this site.` : 'Open a website to manage its filter exception.'}</small></div><AppButton disabled={filterBusy || !activeSiteDomain} onClick={() => void changeSiteFilterException(!filterSettings?.exceptions.includes(activeSiteDomain))}>{filterSettings?.exceptions.includes(activeSiteDomain) ? 'Enable for site' : 'Disable for site'}</AppButton></div>
              {message && <p className="message" role="status">{message}</p>}
              <h2>About</h2>
              <div className="settings-card"><div><strong>My Browser</strong><small>macOS development build</small></div><span>0.1.0</span></div>
            </div>
          </section> : historyPageOpen ? <section className="history-page" aria-label="Browsing history">
            <header className="settings-heading"><div><p className="eyebrow">MY BROWSER</p><h1>History</h1></div><AppButton className="settings-close" onClick={() => void closeTab(activeTabId)} aria-label="Close history tab"><X className="ui-icon" size={17} aria-hidden="true" /></AppButton></header>
            <div className="history-content">
              <label className="history-search"><Search className="ui-icon" size={16} aria-hidden="true" /><AppInput aria-label="Search history" placeholder="Search history" value={historySearch} onChange={event => setHistorySearch(event.target.value)} /></label>
              <div className="history-list" aria-label="History entries">
                {history.filter(item => `${item.title} ${item.url}`.toLowerCase().includes(historySearch.trim().toLowerCase())).map((item, index) => <div className="history-entry" key={`${item.url}-${item.visitedAt}-${index}`}>
                  <span className="history-entry-icon" aria-hidden="true"><Clock3 className="ui-icon" size={15} /></span>
                  <AppButton className="history-entry-open" onClick={() => void openHistoryEntry(item.url)}><strong>{item.title || item.url}</strong><small>{item.url}</small></AppButton>
                  <time dateTime={new Date(item.visitedAt * 1000).toISOString()}>{new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(item.visitedAt * 1000)}</time>
                </div>)}
                {history.length === 0 && <p className="history-empty">Pages you visit will appear here.</p>}
                {history.length > 0 && !history.some(item => `${item.title} ${item.url}`.toLowerCase().includes(historySearch.trim().toLowerCase())) && <p className="history-empty">No matching pages.</p>}
              </div>
            </div>
          </section> : (!activeTab?.url || !isTauri) && <div className="start-page">
            <div className="start-orb"><Sparkles className="ui-icon" size={28} aria-hidden="true" /></div>
            <p className="eyebrow">A CLEARER PLACE TO BROWSE</p>
            <h1>Where to?</h1>
            <form className="start-search" onSubmit={navigate}><Search className="ui-icon" size={18} aria-hidden="true" /><AppInput aria-label="Search the web" placeholder="Search or enter a website" value={address} onChange={event => setAddress(event.target.value)} /><kbd>↵</kbd></form>
            {!isTauri && <p className="dev-note">Run the desktop app to open websites in the native browser view.</p>}
            {message && <p className="message" role="status">{message}</p>}
            <div className="quick-links"><AppButton onClick={() => void navigateTo('https://www.google.com')}>Google</AppButton><AppButton onClick={() => void navigateTo('https://wikipedia.org')}>Wikipedia</AppButton><AppButton onClick={() => void navigateTo('https://github.com')}>GitHub</AppButton></div>
          </div>}
          {message && activeTab?.url && <div className="toast" role="status">{message}</div>}
        </div>
      </section>
    </main>
  );
}
