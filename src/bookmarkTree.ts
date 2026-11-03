export type BookmarkLink = { id: string; type: 'bookmark'; title: string; url: string; description?: string };
export type BookmarkFolder = { id: string; type: 'folder'; title: string; children: BookmarkNode[] };
export type BookmarkNode = BookmarkLink | BookmarkFolder;

/** Any tree whose folders have `type: 'folder'` and `children`; shared by the bookmark and tab trees. */
export type TreeNode = { id: string; type: string };
export type FolderOf<N extends TreeNode> = N & { type: 'folder'; children: N[] };
export type FlatNode<N extends TreeNode> = { node: N; depth: number; parentId: string | null };
export type FlatBookmark = FlatNode<BookmarkNode>;

function isFolder<N extends TreeNode>(node: N): node is FolderOf<N> {
  return node.type === 'folder' && 'children' in node;
}

function withChildren<N extends TreeNode>(folder: FolderOf<N>, children: N[]): N {
  return { ...folder, children };
}

export function flattenBookmarkNodes<N extends TreeNode>(nodes: N[], expanded: Set<string>, depth = 0, parentId: string | null = null): FlatNode<N>[] {
  return nodes.flatMap(node => [{ node, depth, parentId }, ...(isFolder(node) && expanded.has(node.id) ? flattenBookmarkNodes(node.children, expanded, depth + 1, node.id) : [])]);
}

export function locateBookmark<N extends TreeNode>(nodes: N[], id: string, parentId: string | null = null, depth = 0): FlatNode<N> | undefined {
  for (const node of nodes) {
    if (node.id === id) return { node, parentId, depth };
    if (isFolder(node)) {
      const found = locateBookmark(node.children, id, node.id, depth + 1);
      if (found) return found;
    }
  }
}

export function resolveBookmarkDropDepth(originDepth: number, targetDepth: number, horizontalDelta: number): number {
  const requestedDepth = Math.max(0, originDepth + Math.round(horizontalDelta / 14));
  return targetDepth < originDepth && horizontalDelta < 20 ? targetDepth : requestedDepth;
}

export type BookmarkDropZone = 'before' | 'inside' | 'after';

/** Classify where the dragged item's center sits within the hovered row. Folder rows have a middle band that nests. */
export function resolveBookmarkDropZone(pointerY: number, rowTop: number, rowHeight: number, isFolderRow: boolean): BookmarkDropZone {
  const ratio = rowHeight > 0 ? (pointerY - rowTop) / rowHeight : 0.5;
  if (!isFolderRow) return ratio < 0.5 ? 'before' : 'after';
  return ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside';
}

/** Move an item according to the drop zone: `inside` appends to the hovered folder, otherwise it lands before/after the row. */
export function moveBookmarkToDropZone<N extends TreeNode>(nodes: N[], activeId: string, overId: string, zone: BookmarkDropZone, originDepth: number, horizontalDelta: number): { nodes: N[]; parentId: string | null } {
  const over = locateBookmark(nodes, overId);
  if (!over) throw new Error(`Drop target ${overId} was not found`);
  if (zone === 'inside' && isFolder(over.node)) return moveBookmarkToDepth(nodes, activeId, overId, over.depth + 1, true);
  const depth = resolveBookmarkDropDepth(originDepth, over.depth, horizontalDelta);
  return moveBookmarkToDepth(nodes, activeId, overId, depth, zone !== 'before');
}

function updateNode<N extends TreeNode>(nodes: N[], id: string, update: (node: N) => N): N[] {
  return nodes.map(node => node.id === id ? update(node) : isFolder(node) ? withChildren(node, updateNode(node.children, id, update)) : node);
}

function removeNode<N extends TreeNode>(nodes: N[], id: string): { nodes: N[]; removed?: N } {
  let removed: N | undefined;
  const remaining = nodes.flatMap<N>(node => {
    if (node.id === id) { removed = node; return []; }
    if (isFolder(node)) {
      const nested = removeNode(node.children, id);
      if (nested.removed) removed = nested.removed;
      return [withChildren(node, nested.nodes)];
    }
    return [node];
  });
  return { nodes: remaining, removed };
}

function contains<N extends TreeNode>(node: N, id: string): boolean {
  return node.id === id || (isFolder(node) && node.children.some(child => contains(child, id)));
}

function moveArray<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function moveBookmarkToDepth<N extends TreeNode>(nodes: N[], activeId: string, overId: string, depth: number, after: boolean): { nodes: N[]; parentId: string | null } {
  const active = locateBookmark(nodes, activeId), over = locateBookmark(nodes, overId);
  if (!active || !over || contains(active.node, overId)) return { nodes, parentId: active?.parentId ?? null };
  const targetDepth = Math.max(0, Math.min(depth, over.depth + (isFolder(over.node) ? 1 : 0)));
  if (active.parentId === over.parentId && targetDepth === active.depth) {
    const parentNode = active.parentId ? locateBookmark(nodes, active.parentId)?.node : undefined;
    const siblings = parentNode && isFolder(parentNode) ? parentNode.children : nodes;
    const from = siblings.findIndex(node => node.id === activeId), overIndex = siblings.findIndex(node => node.id === overId);
    const to = overIndex + Number(after) - Number(from < overIndex);
    const next = moveArray(siblings, from, Math.max(0, Math.min(siblings.length - 1, to)));
    return { nodes: active.parentId ? updateNode(nodes, active.parentId, node => isFolder(node) ? withChildren(node, next) : node) : next, parentId: active.parentId };
  }
  const remaining = removeNode(nodes, activeId).nodes;
  let anchorId: string | null = null;
  let parentId: string | null = null;
  if (targetDepth === over.depth + 1 && isFolder(over.node)) {
    parentId = over.node.id;
  } else {
    let anchor: FlatNode<N> | undefined = over;
    while (anchor && anchor.depth > targetDepth) anchor = anchor.parentId ? locateBookmark(remaining, anchor.parentId) : undefined;
    if (!anchor) return { nodes, parentId: active.parentId };
    anchorId = anchor.node.id;
    parentId = anchor.parentId;
  }
  let siblings: N[];
  if (parentId) {
    const parent = locateBookmark(remaining, parentId)?.node;
    if (!parent || !isFolder(parent)) return { nodes, parentId: active.parentId };
    siblings = parent.children;
  } else siblings = remaining;
  const index = anchorId ? siblings.findIndex(node => node.id === anchorId) : siblings.length;
  const insertAt = index < 0 ? siblings.length : Math.min(siblings.length, index + Number(after));
  const next = [...siblings.slice(0, insertAt), active.node, ...siblings.slice(insertAt)];
  return { nodes: parentId ? updateNode(remaining, parentId, node => isFolder(node) ? withChildren(node, next) : node) : next, parentId };
}
