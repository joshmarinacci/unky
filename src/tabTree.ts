/** The sidebar tab tree: tabs grouped into collapsible folders. Generic operations live in `tree.ts`. */

import { groupSplitTabRows } from './splitTabRows';
import { appendToFolder, flattenTree, updateNode } from './tree';

export type TabReference = { id: string; type: 'tab' };
export type TabFolder = { id: string; type: 'folder'; title: string; collapsed: boolean; children: TabNode[] };
export type TabNode = TabReference | TabFolder;

/** Parse a stored tab tree, dropping anything malformed and filling missing folder IDs. */
export function normalizeTabNodes(value: unknown): TabNode[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): TabNode[] => {
    if (!item || typeof item !== 'object') return [];
    const node = item as Record<string, unknown>;
    if (node.type === 'folder' && typeof node.title === 'string') {
      return [
        {
          id: typeof node.id === 'string' ? node.id : crypto.randomUUID(),
          type: 'folder',
          title: node.title,
          collapsed: node.collapsed === true,
          children: normalizeTabNodes(node.children),
        },
      ];
    }
    if (node.type === 'tab' && typeof node.id === 'string') return [{ id: node.id, type: 'tab' }];
    return [];
  });
}

/** Drop closed and duplicate tabs from the tree, then append open tabs it doesn't list yet. */
export function reconcileTabNodes(nodes: TabNode[], tabs: ReadonlyArray<{ id: string }>): TabNode[] {
  const validIds = new Set(tabs.map((tab) => tab.id));
  const seenIds = new Set<string>();
  const visit = (items: TabNode[]): TabNode[] =>
    items.flatMap((node): TabNode[] => {
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

/** Tab IDs in tree order. */
export function flattenTabIds(nodes: TabNode[]): string[] {
  return nodes.flatMap((node) => (node.type === 'tab' ? [node.id] : flattenTabIds(node.children)));
}

export function expandedTabFolderIds(nodes: TabNode[]): string[] {
  return nodes.flatMap((node) =>
    node.type === 'folder' ? [...(!node.collapsed ? [node.id] : []), ...expandedTabFolderIds(node.children)] : [],
  );
}

export function tabFolders(nodes: TabNode[]): TabFolder[] {
  return nodes.flatMap((node) => (node.type === 'folder' ? [node, ...tabFolders(node.children)] : []));
}

/** Insert `moving` next to `targetId`, searching nested folders. */
export function insertTabNode(
  nodes: TabNode[],
  targetId: string,
  moving: TabNode,
  after: boolean,
): { nodes: TabNode[]; inserted: boolean } {
  const result: TabNode[] = [];
  for (const node of nodes) {
    if (node.id === targetId)
      return {
        nodes: [...result, ...(after ? [node, moving] : [moving, node]), ...nodes.slice(result.length + 1)],
        inserted: true,
      };
    if (node.type === 'folder') {
      const nested = insertTabNode(node.children, targetId, moving, after);
      if (nested.inserted)
        return {
          nodes: [...result, { ...node, children: nested.nodes }, ...nodes.slice(result.length + 1)],
          inserted: true,
        };
    }
    result.push(node);
  }
  return { nodes: result, inserted: false };
}

/** The list of nodes (root or a folder's children) that directly contains `id`. */
function siblingsOf(nodes: TabNode[], id: string): TabNode[] | undefined {
  if (nodes.some((node) => node.id === id)) return nodes;
  for (const node of nodes) {
    if (node.type !== 'folder') continue;
    const found = siblingsOf(node.children, id);
    if (found) return found;
  }
  return undefined;
}

/**
 * The tab a link-opened tab should follow: the source tab itself, or the last of the tabs directly
 * after it that were also opened from it, so several links open in click order (as in Safari and
 * Chrome). Undefined when the source isn't in the tree, for example because it is pinned.
 */
export function linkTabAnchor(
  nodes: TabNode[],
  tabId: string,
  sourceId: string,
  openers: ReadonlyMap<string, string>,
): string | undefined {
  if (tabId === sourceId) return undefined;
  const siblings = siblingsOf(nodes, sourceId);
  if (!siblings) return undefined;
  let anchor = sourceId;
  for (const node of siblings.slice(siblings.findIndex((item) => item.id === sourceId) + 1)) {
    if (node.id === tabId) continue;
    if (node.type !== 'tab' || openers.get(node.id) !== sourceId) break;
    anchor = node.id;
  }
  return anchor;
}

/** Append `moving` to a folder and expand that folder so the tab stays visible. */
export function appendTabNodeToFolder(
  nodes: TabNode[],
  folderId: string,
  moving: TabNode,
): { nodes: TabNode[]; inserted: boolean } {
  const appended = appendToFolder(nodes, folderId, moving);
  if (!appended.inserted) return appended;
  return {
    nodes: updateNode(appended.nodes, folderId, (node) =>
      node.type === 'folder' ? { ...node, collapsed: false } : node,
    ),
    inserted: true,
  };
}

/** Replace a folder with its children, keeping their position in the tree. */
export function unwrapTabFolder(nodes: TabNode[], folderId: string): { nodes: TabNode[]; unwrapped: boolean } {
  const rootIndex = nodes.findIndex((node) => node.id === folderId && node.type === 'folder');
  if (rootIndex >= 0) {
    const folder = nodes[rootIndex] as TabFolder;
    return {
      nodes: [...nodes.slice(0, rootIndex), ...folder.children, ...nodes.slice(rootIndex + 1)],
      unwrapped: true,
    };
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

type SplitPair = { firstTabId: string; secondTabId: string };

function cycleOrder(
  nodes: TabNode[],
  pinnedIds: readonly string[],
  openIds: ReadonlySet<string>,
  split: SplitPair | null,
  includeCollapsed: boolean,
): string[] {
  const pinned = new Set(pinnedIds);
  const unpinned = (items: TabNode[]): TabNode[] =>
    items.flatMap<TabNode>((node) =>
      node.type === 'tab' ? (pinned.has(node.id) ? [] : [node]) : [{ ...node, children: unpinned(node.children) }],
    );
  const tree = unpinned(nodes);
  const all = flattenTree(tree, new Set(tabFolders(tree).map((folder) => folder.id)));
  const visible = includeCollapsed ? all : flattenTree(tree, new Set(expandedTabFolderIds(tree)));
  const sidebarSplit = split && !pinned.has(split.firstTabId) && !pinned.has(split.secondTabId) ? split : null;
  const treeIds = groupSplitTabRows(visible, all, sidebarSplit).flatMap((row) =>
    row.type === 'single' ? [row.row.node.id] : [row.first.node.id, row.second.node.id],
  );
  return [...new Set([...pinnedIds, ...treeIds])].filter((id) => openIds.has(id));
}

/**
 * Every tab ID in the order the sidebar lists them: pinned tabs first, then the tree (including tabs
 * in collapsed folders) with a split pair kept together where the sidebar draws it, at the first of
 * the two tabs. Only tabs open in this window are included.
 */
export function tabCycleOrder(
  nodes: TabNode[],
  pinnedIds: readonly string[],
  openIds: ReadonlySet<string>,
  split: SplitPair | null,
): string[] {
  return cycleOrder(nodes, pinnedIds, openIds, split, true);
}

/**
 * The tabs the sidebar actually shows, in order, for next/previous-tab and ⌘1–⌘9: like
 * `tabCycleOrder` but without tabs hidden inside collapsed folders. A split pair whose row is
 * visible keeps both tabs, matching the sidebar, which draws the pair wherever either tab shows.
 */
export function visibleTabCycleOrder(
  nodes: TabNode[],
  pinnedIds: readonly string[],
  openIds: ReadonlySet<string>,
  split: SplitPair | null,
): string[] {
  return cycleOrder(nodes, pinnedIds, openIds, split, false);
}

/**
 * The tab next/previous-tab moves to: the nearest visible tab after (or before) the active one,
 * wrapping around. `fullOrder` places an active tab that is itself hidden in a collapsed folder,
 * so cycling continues from where it sits. Returns undefined when no other visible tab exists.
 */
export function nextVisibleTab(
  fullOrder: readonly string[],
  visibleOrder: readonly string[],
  activeId: string | null,
  backwards: boolean,
): string | undefined {
  const visible = new Set(visibleOrder);
  const start = activeId ? fullOrder.indexOf(activeId) : -1;
  if (start < 0) return backwards ? visibleOrder.at(-1) : visibleOrder[0];
  const step = backwards ? -1 : 1;
  for (let offset = 1; offset < fullOrder.length; offset += 1) {
    const id = fullOrder[(((start + step * offset) % fullOrder.length) + fullOrder.length) % fullOrder.length];
    if (visible.has(id)) return id === activeId ? undefined : id;
  }
  return undefined;
}

/** The tab ⌘1–⌘8 (position 1–8) or ⌘9 (`'last'`) selects, or undefined when there is none. */
export function tabAtShortcutPosition(order: readonly string[], position: number | 'last'): string | undefined {
  return position === 'last' ? order.at(-1) : order[position - 1];
}
