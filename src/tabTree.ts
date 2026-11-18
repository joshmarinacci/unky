/** The sidebar tab tree: tabs grouped into collapsible folders. Generic operations live in `tree.ts`. */

import { appendToFolder, updateNode } from './tree';

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
