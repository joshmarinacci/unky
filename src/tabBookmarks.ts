/** Turn open tabs and sidebar tab folders into bookmarks. Pure, so it is unit-tested directly. */

import type { BookmarkFolder, BookmarkLink, BookmarkNode } from './bookmarks';
import { flattenTabIds, type TabFolder, type TabNode } from './tabTree';

/** What a tab contributes to a bookmark. `title` is the name the sidebar shows, including a rename. */
export type BookmarkableTab = { id: string; url: string; title: string; private?: boolean; favicon?: string };

/** Only websites are bookmarked; blank tabs and built-in pages have no address worth keeping. */
export function isBookmarkableUrl(url: string): boolean {
  return /^https?:\/\//i.test(url);
}

export function tabToBookmark(tab: BookmarkableTab, newId: () => string): BookmarkLink | undefined {
  if (!isBookmarkableUrl(tab.url)) return undefined;
  return {
    id: newId(),
    type: 'bookmark',
    title: tab.title.trim() || tab.url,
    url: tab.url,
    ...(tab.favicon ? { favicon: tab.favicon } : {}),
  };
}

export type TabLookup = { tabs: ReadonlyMap<string, BookmarkableTab>; pinnedIds: ReadonlySet<string> };

/**
 * Bookmark nodes for tab-tree nodes, keeping folder structure. Pinned tabs (which the sidebar shows
 * in the dock, not in folders), private tabs, tabs without a website address, and folders left
 * empty are dropped.
 */
function tabNodesToBookmarks(nodes: TabNode[], lookup: TabLookup, newId: () => string): BookmarkNode[] {
  return nodes.flatMap((node): BookmarkNode[] => {
    if (node.type === 'folder') {
      const folder = tabFolderToBookmarkFolder(node, lookup, newId);
      return folder ? [folder] : [];
    }
    const tab = lookup.tabs.get(node.id);
    if (!tab || tab.private || lookup.pinnedIds.has(node.id)) return [];
    const bookmark = tabToBookmark(tab, newId);
    return bookmark ? [bookmark] : [];
  });
}

/** A bookmark folder with the tab folder's name and contents, or undefined when nothing in it can be bookmarked. */
export function tabFolderToBookmarkFolder(
  folder: TabFolder,
  lookup: TabLookup,
  newId: () => string,
): BookmarkFolder | undefined {
  const children = tabNodesToBookmarks(folder.children, lookup, newId);
  return children.length ? { id: newId(), type: 'folder', title: folder.title, children } : undefined;
}

export function countBookmarks(nodes: BookmarkNode[]): number {
  return nodes.reduce((count, node) => count + (node.type === 'folder' ? countBookmarks(node.children) : 1), 0);
}

export type TabBankruptcy = {
  /** Every website tab, in sidebar order and keeping folders; undefined when there is none. */
  folder: BookmarkFolder | undefined;
  /** Tabs to close: everything except pinned and private tabs, including blank tabs and built-in pages. */
  closeIds: string[];
};

/** Save the window's tabs to one bookmark folder and pick the tabs to close. */
export function tabBankruptcy(nodes: TabNode[], lookup: TabLookup, title: string, newId: () => string): TabBankruptcy {
  const children = tabNodesToBookmarks(nodes, lookup, newId);
  const treeIds = flattenTabIds(nodes);
  // The tree normally lists every open tab; any it misses are still closed, after the rest.
  const orderedIds = [...new Set([...treeIds, ...lookup.tabs.keys()])];
  return {
    folder: children.length ? { id: newId(), type: 'folder', title, children } : undefined,
    closeIds: orderedIds.filter((id) => {
      const tab = lookup.tabs.get(id);
      return tab && !tab.private && !lookup.pinnedIds.has(id);
    }),
  };
}
