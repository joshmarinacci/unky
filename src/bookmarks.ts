/** Bookmark tree types and bookmark-specific helpers. Generic tree operations live in `tree.ts`. */

export type BookmarkLink = {
  id: string;
  type: 'bookmark';
  title: string;
  url: string;
  description?: string;
  favicon?: string;
};
export type BookmarkFolder = { id: string; type: 'folder'; title: string; children: BookmarkNode[] };
export type BookmarkNode = BookmarkLink | BookmarkFolder;

/** Parse stored or imported bookmarks, dropping anything malformed and filling missing IDs. */
export function normalizeBookmarkNodes(value: unknown): BookmarkNode[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): BookmarkNode[] => {
    if (!item || typeof item !== 'object') return [];
    const node = item as Record<string, unknown>;
    if (node.type === 'folder' && typeof node.title === 'string') {
      return [
        {
          id: typeof node.id === 'string' ? node.id : crypto.randomUUID(),
          type: 'folder',
          title: node.title,
          children: normalizeBookmarkNodes(node.children),
        },
      ];
    }
    if (typeof node.title === 'string' && typeof node.url === 'string') {
      return [
        {
          id: typeof node.id === 'string' ? node.id : crypto.randomUUID(),
          type: 'bookmark',
          title: node.title,
          url: node.url,
          description: typeof node.description === 'string' ? node.description : '',
          favicon: typeof node.favicon === 'string' ? node.favicon : undefined,
        },
      ];
    }
    return [];
  });
}

export function findBookmarkByUrl(nodes: BookmarkNode[], url: string): BookmarkLink | undefined {
  for (const node of nodes) {
    if (node.type === 'bookmark' && node.url === url) return node;
    if (node.type === 'folder') {
      const match = findBookmarkByUrl(node.children, url);
      if (match) return match;
    }
  }
  return undefined;
}

/** Bookmarks whose title, URL, or description matches; a matching folder keeps all its children. */
export function filterBookmarkNodes(nodes: BookmarkNode[], query: string): BookmarkNode[] {
  if (!query) return nodes;
  const normalized = query.toLowerCase();
  return nodes.flatMap<BookmarkNode>((node) => {
    if (node.type === 'bookmark')
      return `${node.title} ${node.url} ${node.description ?? ''}`.toLowerCase().includes(normalized) ? [node] : [];
    if (node.title.toLowerCase().includes(normalized)) return [node];
    const children = filterBookmarkNodes(node.children, query);
    return children.length ? [{ ...node, children }] : [];
  });
}
