/**
 * Typed bridge to the Rust side: every command the trusted browser UI calls, with its
 * arguments and result, and every event Rust emits to it, with its payload.
 *
 * Keep these in sync with the `#[tauri::command]` signatures under `src-tauri/src/` (Tauri
 * converts their snake_case arguments to camelCase) and the event constants in `events.rs`.
 * Commands that only website pages call (`sync_page_url`, `focus_browser_tab`, and so on) are
 * invoked by `src-tauri/page-scripts/` and are deliberately not listed here.
 */
import { invoke, type InvokeArgs } from '@tauri-apps/api/core';
import { listen, type Event, type UnlistenFn } from '@tauri-apps/api/event';
import type { BookmarkNode } from './bookmarks';
import type { AddressSuggestion, AddressSuggestionsState } from './addressSuggestions';

export type Tab = {
  id: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  active: boolean;
  zoom: number;
  private?: boolean;
  windowLabel?: string;
};
export type BrowserSnapshot = { tabs: Tab[]; activeTabId: string };
export type ExternalBrowser = { id: string; name: string };
export type SplitLayout = {
  firstTabId: string;
  secondTabId: string;
  orientation: 'horizontal' | 'vertical';
  firstPanePercent: number;
};
export type PageSecurityInfo = {
  secureHttps: boolean;
  location: string;
  camera: string;
  microphone: string;
  playingAudio: boolean;
};
export type HistoryEntry = { id: string; url: string; title: string; visitedAt: number; favicon?: string };
export type Download = {
  id: string;
  url: string;
  filename: string;
  path: string;
  status: 'downloading' | 'completed' | 'failed';
  bytesReceived: number;
};
export type FilterSettingsView = {
  enabled: boolean;
  sourceUrl: string;
  updatedAt: number | null;
  acceptedRules: number;
  exceptions: string[];
};
export type FilterUpdateProgress = {
  phase: 'downloading' | 'compiling' | 'complete';
  receivedBytes: number;
  totalBytes: number | null;
};
export type LaunchRequest = { url: string; private: boolean };
export type SessionTestPhase = 'exercise' | 'restore';
/** Screen rectangle a native popover anchors to, in CSS pixels. */
export type Anchor = { x: number; y: number; width: number; height: number };
export type SplitSide = 'left' | 'right' | 'top' | 'bottom';

type TabArgs = { tabId: string };

/** Command name -> `args` (omitted when the command takes none) and `result`. */
export type Commands = {
  // Tabs and windows
  get_browser_state: { result: BrowserSnapshot };
  create_tab: { args: { private?: boolean } | undefined; result: BrowserSnapshot };
  select_tab: { args: TabArgs; result: BrowserSnapshot };
  close_tab: { args: TabArgs; result: BrowserSnapshot };
  reopen_closed_tab: { result: BrowserSnapshot };
  reorder_tabs: { args: { tabIds: string[] }; result: BrowserSnapshot };
  cycle_tab: { args: { backwards: boolean; orderedTabIds?: string[] | null }; result: BrowserSnapshot };
  set_view_bounds: { args: Anchor; result: void };
  set_settings_open: { args: { open: boolean }; result: void };
  toggle_devtools: { result: void };
  sync_tab_position_menu: { args: { position: string }; result: void };
  sync_theme_menu: { args: { theme: string }; result: void };
  take_launch_request: { result: LaunchRequest | null };
  // Navigation and page tools
  navigate: { args: TabArgs & { url: string }; result: void };
  go_back: { args: TabArgs; result: void };
  go_forward: { args: TabArgs; result: void };
  reload: { args: TabArgs; result: void };
  stop_loading: { args: TabArgs; result: void };
  find_in_page: { args: TabArgs & { query: string; backwards: boolean }; result: number };
  get_tab_favicon: { args: TabArgs; result: string };
  save_full_page_screenshot: { args: TabArgs; result: boolean };
  get_external_browsers: { result: ExternalBrowser[] };
  open_in_external_browser: { args: { tabId?: string; browserId: string; url?: string }; result: void };
  set_page_context_menu_enabled: { args: { enabled: boolean }; result: void };
  // Also callable by pages (gated in Rust); the bookmark context menu calls them from the UI.
  open_link_in_new_tab: { args: { url: string; background?: boolean; otherSplit?: boolean }; result: void };
  open_link_in_new_window: { args: { url: string }; result: void };
  // Split view and tab dragging
  get_split_tabs: { result: SplitLayout | null };
  split_tab: { args: TabArgs & { targetTabId: string; side: SplitSide }; result: void };
  clear_tab_split: { result: void };
  resize_tab_split: { args: { firstPanePercent: number }; result: void };
  move_tab_to_new_window: { args: TabArgs; result: string };
  set_tab_dragging: {
    args: {
      dragging: boolean;
      tabId: string | null;
      targetTabId: string | null;
      dragType?: string | null;
      cancelled?: boolean;
    };
    result: void;
  };
  // Security popover
  get_page_security_info: { args: TabArgs; result: PageSecurityInfo };
  toggle_page_security_popover: { args: { anchor: Anchor; info: PageSecurityInfo }; result: boolean };
  update_page_security_popover: { args: { anchor: Anchor; info: PageSecurityInfo }; result: boolean };
  // Address suggestions popup
  control_address_suggestions_popover: {
    args: { action: 'show' | 'close'; anchor: Anchor; rows: AddressSuggestion[]; selectedIndex: number };
    result: void;
  };
  select_address_suggestion: { args: { url: string }; result: void };
  // History, bookmarks, browsing data
  get_history: { result: HistoryEntry[] };
  search_history: { args: { query: string }; result: HistoryEntry[] };
  clear_history: { result: void };
  clear_browsing_data: { result: void };
  load_bookmarks: { args: { legacyBookmarks: BookmarkNode[] }; result: BookmarkNode[] };
  save_bookmarks: { args: { bookmarks: BookmarkNode[] }; result: void };
  import_bookmarks_html: { args: { path: string }; result: BookmarkNode[] };
  export_bookmarks_html: { args: { path: string }; result: void };
  // Downloads
  get_downloads: { result: Download[] };
  control_downloads_popover: {
    args: { action: 'show' | 'toggle' | 'update' | 'close'; anchor: Anchor };
    result: boolean;
  };
  reveal_download: { args: { downloadId: string }; result: void };
  // Content filtering
  get_filter_settings: { result: FilterSettingsView };
  set_filtering_enabled: { args: { enabled: boolean }; result: FilterSettingsView };
  set_filter_site_exception: { args: { domain: string; enabled: boolean }; result: FilterSettingsView };
  update_filter_list: { result: FilterSettingsView };
  // macOS session integration test (`macos-session-test` builds only)
  session_test_phase: { result: SessionTestPhase };
  session_test_open_new_tab: { result: string };
  session_test_start_download: { result: void };
  report_session_test: { args: { success: boolean; details: string; snapshot: BrowserSnapshot }; result: void };
};

export type CommandName = keyof Commands;
type ArgsFor<K extends CommandName> = Commands[K] extends { args: infer A }
  ? undefined extends A
    ? [args?: A]
    : [args: A]
  : [];

/** Call a Rust command with checked arguments and a typed result. */
export function call<K extends CommandName>(command: K, ...args: ArgsFor<K>): Promise<Commands[K]['result']> {
  return invoke<Commands[K]['result']>(command, args[0] as InvokeArgs | undefined);
}

export const tabEvent = 'browser://tabs-changed';
export const splitEvent = 'browser://split-changed';
export const splitResizeEvent = 'browser://split-resize';
export const tabDragDropEvent = 'browser://tab-drag-drop';
export const pagePointerDownEvent = 'browser://page-pointer-down';
export const settingsEvent = 'browser://open-settings';
export const showHistoryEvent = 'browser://show-history';
export const showDownloadsEvent = 'browser://show-downloads';
export const showAllDownloadsEvent = 'browser://show-all-downloads';
export const showShortcutsEvent = 'browser://show-shortcuts';
export const shortcutEvent = 'browser://shortcut';
export const tabPositionMenuEvent = 'browser://tab-position-menu';
export const showBookmarksEvent = 'browser://show-bookmarks';
export const themeMenuEvent = 'browser://theme-menu';
export const historyEvent = 'browser://history-changed';
export const bookmarksEvent = 'browser://bookmarks-changed';
export const openUrlFromMenuEvent = 'browser://open-url-from-menu';
export const openTabInFolderEvent = 'browser://open-tab-in-folder';
export const importBookmarksEvent = 'browser://import-bookmarks';
export const exportBookmarksEvent = 'browser://export-bookmarks';
export const clearHistoryRequestEvent = 'browser://clear-history-request';
export const downloadsEvent = 'browser://downloads-changed';
export const captureStatusEvent = 'browser://capture-status';
export const captureProgressEvent = 'browser://capture-progress';
export const filterUpdateProgressEvent = 'browser://filter-update-progress';
export const launchRequestEvent = 'browser://launch-request';
export const addressSuggestionsEvent = 'browser://address-suggestions';

/** Event name -> payload. */
export type Events = {
  [tabEvent]: BrowserSnapshot;
  [splitEvent]: SplitLayout | null;
  [splitResizeEvent]: number;
  [tabDragDropEvent]: { tabId: string; targetTabId: string; target: SplitSide | 'new-window' };
  [pagePointerDownEvent]: null;
  [settingsEvent]: null;
  [showHistoryEvent]: null;
  [showDownloadsEvent]: null;
  [showAllDownloadsEvent]: null;
  [showShortcutsEvent]: null;
  [shortcutEvent]: string;
  [tabPositionMenuEvent]: { windowLabel: string; position: string };
  [showBookmarksEvent]: null;
  [themeMenuEvent]: string;
  [historyEvent]: HistoryEntry[];
  [bookmarksEvent]: BookmarkNode[];
  [openUrlFromMenuEvent]: string;
  [openTabInFolderEvent]: [tabId: string, folderId: string];
  [importBookmarksEvent]: null;
  [exportBookmarksEvent]: null;
  [clearHistoryRequestEvent]: null;
  [downloadsEvent]: Download[];
  [captureStatusEvent]: string;
  [captureProgressEvent]: { completed: number; total: number };
  [filterUpdateProgressEvent]: FilterUpdateProgress;
  [launchRequestEvent]: LaunchRequest;
  [addressSuggestionsEvent]: AddressSuggestionsState;
};
export type EventName = keyof Events;

/** Listen for a Rust event with a typed payload. Resolves to the unlisten function. */
export function onEvent<E extends EventName>(
  event: E,
  handler: (event: Event<Events[E]>) => void,
): Promise<UnlistenFn> {
  return listen<Events[E]>(event, handler);
}
