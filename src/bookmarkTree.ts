export type BookmarkLink = { id: string; type: 'bookmark'; title: string; url: string };
export type BookmarkFolder = { id: string; type: 'folder'; title: string; children: BookmarkNode[] };
export type BookmarkNode = BookmarkLink | BookmarkFolder;
export type FlatBookmark = { node: BookmarkNode; depth: number; parentId: string | null };

export function flattenBookmarkNodes(nodes: BookmarkNode[], expanded: Set<string>, depth = 0, parentId: string | null = null): FlatBookmark[] {
  return nodes.flatMap(node => [{ node, depth, parentId }, ...(node.type === 'folder' && expanded.has(node.id) ? flattenBookmarkNodes(node.children, expanded, depth + 1, node.id) : [])]);
}

export function locateBookmark(nodes: BookmarkNode[], id: string, parentId: string | null = null, depth = 0): FlatBookmark | undefined {
  for (const node of nodes) {
    if (node.id === id) return { node, parentId, depth };
    if (node.type === 'folder') {
      const found = locateBookmark(node.children, id, node.id, depth + 1);
      if (found) return found;
    }
  }
}

export function resolveBookmarkDropDepth(originDepth: number, targetDepth: number, horizontalDelta: number): number {
  const requestedDepth = Math.max(0, originDepth + Math.round(horizontalDelta / 14));
  return targetDepth < originDepth && horizontalDelta < 20 ? targetDepth : requestedDepth;
}

function updateNode(nodes: BookmarkNode[], id: string, update: (node: BookmarkNode) => BookmarkNode): BookmarkNode[] {
  return nodes.map(node => node.id === id ? update(node) : node.type === 'folder' ? { ...node, children: updateNode(node.children, id, update) } : node);
}

function removeNode(nodes: BookmarkNode[], id: string): { nodes: BookmarkNode[]; removed?: BookmarkNode } {
  let removed: BookmarkNode | undefined;
  const remaining = nodes.flatMap<BookmarkNode>(node => {
    if (node.id === id) { removed = node; return []; }
    if (node.type === 'folder') {
      const nested = removeNode(node.children, id);
      if (nested.removed) removed = nested.removed;
      return [{ ...node, children: nested.nodes }];
    }
    return [node];
  });
  return { nodes: remaining, removed };
}

function contains(node: BookmarkNode, id: string): boolean {
  return node.id === id || (node.type === 'folder' && node.children.some(child => contains(child, id)));
}

function moveArray<T>(items: T[], from: number, to: number): T[] {
  if (from < 0 || to < 0 || from >= items.length || to >= items.length || from === to) return items;
  const next = [...items];
  const [item] = next.splice(from, 1);
  next.splice(to, 0, item);
  return next;
}

export function moveBookmarkToDepth(nodes: BookmarkNode[], activeId: string, overId: string, depth: number, after: boolean): { nodes: BookmarkNode[]; parentId: string | null } {
  const active = locateBookmark(nodes, activeId), over = locateBookmark(nodes, overId);
  if (!active || !over || contains(active.node, overId)) return { nodes, parentId: active?.parentId ?? null };
  const targetDepth = Math.max(0, Math.min(depth, over.depth + (over.node.type === 'folder' ? 1 : 0)));
  if (active.parentId === over.parentId && targetDepth === active.depth) {
    const parentNode = active.parentId ? locateBookmark(nodes, active.parentId)?.node : undefined;
    const siblings = parentNode?.type === 'folder' ? parentNode.children : nodes;
    const from = siblings.findIndex(node => node.id === activeId), overIndex = siblings.findIndex(node => node.id === overId);
    const to = overIndex + Number(after) - Number(from < overIndex);
    const next = moveArray(siblings, from, Math.max(0, Math.min(siblings.length - 1, to)));
    return { nodes: active.parentId ? updateNode(nodes, active.parentId, node => node.type === 'folder' ? { ...node, children: next } : node) : next, parentId: active.parentId };
  }
  const remaining = removeNode(nodes, activeId).nodes;
  let anchorId: string | null = null;
  let parentId: string | null = null;
  if (targetDepth === over.depth + 1 && over.node.type === 'folder') {
    parentId = over.node.id;
  } else {
    let anchor: FlatBookmark | undefined = over;
    while (anchor && anchor.depth > targetDepth) anchor = anchor.parentId ? locateBookmark(remaining, anchor.parentId) : undefined;
    if (!anchor) return { nodes, parentId: active.parentId };
    anchorId = anchor.node.id;
    parentId = anchor.parentId;
  }
  let siblings: BookmarkNode[];
  if (parentId) {
    const parent = locateBookmark(remaining, parentId)?.node;
    if (!parent || parent.type !== 'folder') return { nodes, parentId: active.parentId };
    siblings = parent.children;
  } else siblings = remaining;
  const index = anchorId ? siblings.findIndex(node => node.id === anchorId) : siblings.length;
  const insertAt = index < 0 ? siblings.length : Math.min(siblings.length, index + Number(after));
  const next = [...siblings.slice(0, insertAt), active.node, ...siblings.slice(insertAt)];
  return { nodes: parentId ? updateNode(remaining, parentId, node => node.type === 'folder' ? { ...node, children: next } : node) : next, parentId };
}
